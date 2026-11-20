import { ContractError } from "../../contracts/errors.ts";
import { anchor, type Anchor, type ValidityInterval } from "../shared/anchors.ts";
import type { SettingFact } from "./editorial.ts";

export const LORE_CATEGORIES = [
  "character",
  "item",
  "location",
  "faction",
  "world_rule",
  "foreshadow",
  "agreement",
] as const;
export type LoreCategoryId = (typeof LORE_CATEGORIES)[number];

export const FORESHADOW_STATUSES = [
  "proposed",
  "planted",
  "hinted",
  "resolved",
  "abandoned",
] as const;
export type ForeshadowState = (typeof FORESHADOW_STATUSES)[number];

/** Normal lifecycle transitions for foreshadows (FQ-08). */
export const FORESHADOW_TRANSITIONS = {
  proposed: ["planted", "abandoned"],
  planted: ["hinted", "resolved", "abandoned"],
  hinted: ["hinted", "resolved", "abandoned"],
  resolved: [],
  abandoned: [],
} as const satisfies Readonly<Record<ForeshadowState, readonly ForeshadowState[]>>;

/** Reopen-only transitions requiring explicit `{ reopen: true }` (FQ-08). */
export const FORESHADOW_REOPEN_TRANSITIONS = {
  proposed: [],
  planted: [],
  hinted: [],
  resolved: ["planted"],
  abandoned: ["planted"],
} as const satisfies Readonly<Record<ForeshadowState, readonly ForeshadowState[]>>;

export interface LoreForeshadowEntry {
  readonly id: string;
  readonly factId: string | null;
  readonly title: string;
  readonly plantedChapterId: string | null;
  readonly plantedPoint: number;
  readonly targetChapterId: string | null;
  readonly resolvedChapterId: string | null;
  readonly status: ForeshadowState;
  readonly hintedChapterIds?: readonly string[];
}

export interface ChapterOutlineFacts {
  readonly chapterId: string;
  readonly lockedFacts: string;
}

export interface LoreConflictOptions {
  /** Chapter gap threshold before an unresolved foreshadow is flagged stale (default: 20). */
  readonly staleGap?: number;
  /**
   * 0-based chapter index representing the current writing frontier (e.g.
   * active chapter or last drafted chapter). Defaults to `chapterOrder.length - 1`.
   */
  readonly referenceChapterIndex?: number;
  /** Optional chapterId convenience alternative to `referenceChapterIndex`. */
  readonly referenceChapterId?: string;
}

export interface MergeFactVersionOptions {
  /** Explicitly replace `effectiveFrom` with `incoming.effectiveFrom` instead of inheriting `prev.effectiveFrom`. */
  readonly overrideEffectiveFrom?: boolean;
  /** Explicitly replace `aliases` with `incoming.aliases` instead of merging with `prev.aliases`. */
  readonly overrideAliases?: boolean;
  /** Explicitly clear an inherited `effectiveTo` anchor when un-retiring a fact. */
  readonly clearEffectiveTo?: boolean;
}

export interface LoreConflictReport {
  readonly kind:
    | "expiry-before-known"
    | "inverted-validity-interval"
    | "known-before-effective"
    | "outline-fact-mismatch"
    | "stale-foreshadow"
    | "foreshadow-order-flip";
  readonly severity: "warning" | "error";
  readonly targetId: string;
  readonly chapterId?: string;
  readonly message: string;
}

/** Validates a dynamic lore category word, mapping legacy `fact` defaults to `world_rule`. */
export function normalizeLoreCategory(value: unknown, kind: "fact" | "agreement"): LoreCategoryId {
  if (kind === "agreement") return "agreement";
  if (typeof value === "string" && (LORE_CATEGORIES as readonly string[]).includes(value)) {
    return value as LoreCategoryId;
  }
  return "world_rule";
}

/** Validates a foreshadow lifecycle state word. */
export function assertForeshadowStatus(status: unknown): ForeshadowState {
  if (typeof status !== "string" || !(FORESHADOW_STATUSES as readonly string[]).includes(status)) {
    throw new ContractError("input.invalid", { field: "status", reason: "unknown-foreshadow-status" });
  }
  return status as ForeshadowState;
}

/**
 * Enforces the foreshadow lifecycle state machine (FQ-08).
 * `resolved` and `abandoned` may only transition back to `planted` when `{ reopen: true }`.
 */
export function assertForeshadowTransition(
  from: ForeshadowState,
  to: ForeshadowState,
  options?: { readonly reopen?: boolean },
): void {
  assertForeshadowStatus(from);
  assertForeshadowStatus(to);
  if ((FORESHADOW_TRANSITIONS[from] as readonly string[]).includes(to)) {
    return;
  }
  const canReopen = (FORESHADOW_REOPEN_TRANSITIONS[from] as readonly string[]).includes(to);
  if (options?.reopen === true && canReopen) {
    return;
  }
  throw new ContractError("gate.denied", {
    action: "foreshadow.transition",
    from,
    to,
    reason: canReopen ? "reopen-required" : `${from} → ${to}`,
  });
}

function buildOrderPositions(order: readonly string[]): Map<string, number> {
  const positions = new Map<string, number>();
  for (let i = 0; i < order.length; i += 1) {
    const id = order[i];
    if (!positions.has(id)) positions.set(id, i);
  }
  return positions;
}

function normalizeAliases(list: readonly string[] | undefined): string[] | undefined {
  if (list === undefined) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const trimmed = String(raw).trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Merges a new version of a setting fact with its previous approved version (FQ-01 / Res#13).
 *
 * - `knownFrom` merges all character keys and ALWAYS keeps the earlier anchor per
 *   character under `order`, so existing knowledge timelines are never silently pushed later.
 * - `effectiveFrom` defaults to `prev.effectiveFrom` unless `options?.overrideEffectiveFrom === true`.
 * - `effectiveTo` and `aliases` are preserved cleanly across versions.
 */
export function mergeFactVersion(
  prev: SettingFact | undefined,
  incoming: SettingFact,
  order: readonly string[],
  options?: MergeFactVersionOptions,
): SettingFact {
  if (!prev) {
    const normalizedAliases = normalizeAliases(incoming.aliases);
    return {
      id: incoming.id,
      note: incoming.note,
      source: incoming.source,
      kind: incoming.kind,
      locked: incoming.locked,
      effectiveFrom: incoming.effectiveFrom,
      ...(incoming.effectiveTo ? { effectiveTo: incoming.effectiveTo } : {}),
      knownFrom: { ...incoming.knownFrom },
      ...(normalizedAliases !== undefined ? { aliases: normalizedAliases } : {}),
    };
  }

  const positions = buildOrderPositions(order);
  const precedesFast = (a: Anchor, b: Anchor): boolean => {
    const posA = positions.get(a.chapterId) ?? order.length;
    const posB = positions.get(b.chapterId) ?? order.length;
    return posA === posB ? a.point < b.point : posA < posB;
  };

  const mergedKnown: Record<string, Anchor> = {};
  for (const [character, anchorPoint] of Object.entries(prev.knownFrom)) {
    mergedKnown[character] = anchorPoint;
  }
  for (const [character, incomingPoint] of Object.entries(incoming.knownFrom)) {
    const existingPoint = Object.hasOwn(mergedKnown, character) ? mergedKnown[character] : undefined;
    if (!existingPoint || precedesFast(incomingPoint, existingPoint)) {
      mergedKnown[character] = incomingPoint;
    }
  }

  const effectiveFrom = options?.overrideEffectiveFrom === true ? incoming.effectiveFrom : prev.effectiveFrom;
  const effectiveTo = options?.clearEffectiveTo === true
    ? undefined
    : (incoming.effectiveTo ?? prev.effectiveTo);

  let mergedAliases: string[] | undefined;
  if (options?.overrideAliases === true) {
    mergedAliases = normalizeAliases(incoming.aliases);
  } else if (prev.aliases !== undefined || incoming.aliases !== undefined) {
    mergedAliases = normalizeAliases([...(prev.aliases ?? []), ...(incoming.aliases ?? [])]);
  }

  return {
    id: incoming.id,
    note: incoming.note.trim() ? incoming.note : prev.note,
    source: incoming.source.trim() ? incoming.source : prev.source,
    kind: incoming.kind,
    locked: incoming.locked,
    effectiveFrom,
    ...(effectiveTo ? { effectiveTo } : {}),
    knownFrom: mergedKnown,
    ...(mergedAliases !== undefined ? { aliases: mergedAliases } : {}),
  };
}

/**
 * Explicitly revokes a character's `knownFrom` entry on a setting fact (Res#13),
 * used for intentional knowledge removal (e.g. amnesia) without compromising
 * `mergeFactVersion`'s monotonic earlier-anchor invariant.
 */
export function revokeKnownCharacter(fact: SettingFact, character: string): SettingFact {
  const target = character.trim();
  if (!target) {
    throw new ContractError("input.invalid", { field: "character", reason: "required" });
  }
  const nextKnown: Record<string, Anchor> = {};
  for (const [key, val] of Object.entries(fact.knownFrom)) {
    if (key === character || key === target) continue;
    nextKnown[key] = val;
  }
  return {
    id: fact.id,
    note: fact.note,
    source: fact.source,
    kind: fact.kind,
    locked: fact.locked,
    effectiveFrom: fact.effectiveFrom,
    ...(fact.effectiveTo ? { effectiveTo: fact.effectiveTo } : {}),
    knownFrom: nextKnown,
    ...(fact.aliases !== undefined ? { aliases: [...fact.aliases] } : {}),
  };
}

const ASCII_FACT_ID_RE = /^[A-Za-z0-9_-]{2,}$/u;
const ASCII_TOKEN_RE = /[A-Za-z0-9_-]+/gu;

function compileFactBoundaryRegex(factId: string): RegExp {
  const escaped = factId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "u");
}

/**
 * Pure continuity & worldbook conflict detector across approved settings,
 * foreshadow lifecycles, and chapter outlines.
 */
export function detectLoreConflicts(
  facts: readonly SettingFact[],
  foreshadows: readonly LoreForeshadowEntry[],
  chapterOrder: readonly string[],
  outlines: readonly ChapterOutlineFacts[],
  options?: LoreConflictOptions,
): LoreConflictReport[] {
  const conflicts: LoreConflictReport[] = [];
  const positions = buildOrderPositions(chapterOrder);

  const orderPos = (chapterId: string): number => positions.get(chapterId) ?? chapterOrder.length;
  const precedesFast = (a: Anchor, b: Anchor): boolean => {
    const posA = orderPos(a.chapterId);
    const posB = orderPos(b.chapterId);
    return posA === posB ? a.point < b.point : posA < posB;
  };
  const isEffectiveFast = (entry: ValidityInterval, at: Anchor): boolean => {
    const afterStart = !precedesFast(at, entry.effectiveFrom);
    const beforeEnd = entry.effectiveTo ? precedesFast(at, entry.effectiveTo) : true;
    return afterStart && beforeEnd;
  };

  // 1. Check setting validity interval & character knownFrom ordering
  for (const fact of facts) {
    if (fact.effectiveTo && !precedesFast(fact.effectiveFrom, fact.effectiveTo)) {
      conflicts.push({
        kind: "inverted-validity-interval",
        severity: "error",
        targetId: fact.id,
        chapterId: fact.effectiveTo.chapterId,
        message: `设定 ${fact.id} 的失效时点早于或等于生效时点`,
      });
    }
    for (const [character, knownAt] of Object.entries(fact.knownFrom)) {
      if (precedesFast(knownAt, fact.effectiveFrom)) {
        conflicts.push({
          kind: "known-before-effective",
          severity: "warning",
          targetId: fact.id,
          chapterId: knownAt.chapterId,
          message: `${character} 在设定 ${fact.id} 生效之前已提前知情`,
        });
      }
      if (fact.effectiveTo && !precedesFast(knownAt, fact.effectiveTo)) {
        conflicts.push({
          kind: "expiry-before-known",
          severity: "error",
          targetId: fact.id,
          chapterId: fact.effectiveTo.chapterId,
          message: `设定 ${fact.id} 在 ${character} 知情时点之前（或同点）已失效`,
        });
      }
    }
  }

  // 2. Check chapter outline lockedFacts referencing expired or not-yet-effective fact IDs (FQ-18 O(O + F))
  const asciiFactsById = new Map<string, SettingFact[]>();
  const nonAsciiFactsById = new Map<string, SettingFact[]>();
  for (const fact of facts) {
    if (fact.id.length < 2) continue;
    const targetMap = ASCII_FACT_ID_RE.test(fact.id) ? asciiFactsById : nonAsciiFactsById;
    const bucket = targetMap.get(fact.id);
    if (bucket) bucket.push(fact);
    else targetMap.set(fact.id, [fact]);
  }
  const compiledNonAscii: Array<{ readonly factId: string; readonly regex: RegExp; readonly versions: readonly SettingFact[] }> = [];
  for (const [factId, versions] of nonAsciiFactsById) {
    compiledNonAscii.push({ factId, regex: compileFactBoundaryRegex(factId), versions });
  }

  for (const outline of outlines) {
    if (!outline.lockedFacts.trim()) continue;
    const at = anchor(outline.chapterId, 1);

    if (asciiFactsById.size > 0) {
      const tokens = new Set<string>();
      for (const match of outline.lockedFacts.matchAll(ASCII_TOKEN_RE)) {
        if (match[0].length >= 2) tokens.add(match[0]);
      }
      for (const token of tokens) {
        const versions = asciiFactsById.get(token);
        if (!versions) continue;
        const anyActive = versions.some((entry) => isEffectiveFast(entry, at));
        if (!anyActive) {
          conflicts.push({
            kind: "outline-fact-mismatch",
            severity: "warning",
            targetId: token,
            chapterId: outline.chapterId,
            message: `章纲锁定事实提及「${token}」，但该设定在当前章尚未生效或已失效`,
          });
        }
      }
    }

    for (const entry of compiledNonAscii) {
      if (!outline.lockedFacts.includes(entry.factId) || !entry.regex.test(outline.lockedFacts)) continue;
      const anyActive = entry.versions.some((fact) => isEffectiveFast(fact, at));
      if (!anyActive) {
        conflicts.push({
          kind: "outline-fact-mismatch",
          severity: "warning",
          targetId: entry.factId,
          chapterId: outline.chapterId,
          message: `章纲锁定事实提及「${entry.factId}」，但该设定在当前章尚未生效或已失效`,
        });
      }
    }
  }

  // 3. Check foreshadow temporal consistency and overdue / stale tails (FQ-21)
  const staleGap =
    options?.staleGap !== undefined && Number.isFinite(options.staleGap) && options.staleGap >= 1
      ? Math.floor(options.staleGap)
      : 20;
  const maxOrderIdx = Math.max(0, chapterOrder.length - 1);
  let refIdx = maxOrderIdx;
  if (options?.referenceChapterIndex !== undefined && Number.isFinite(options.referenceChapterIndex)) {
    refIdx = Math.max(0, Math.min(maxOrderIdx, Math.floor(options.referenceChapterIndex)));
  } else if (options?.referenceChapterId && positions.has(options.referenceChapterId)) {
    refIdx = positions.get(options.referenceChapterId)!;
  }

  for (const fs of foreshadows) {
    if (fs.status === "abandoned") continue;
    const plantedIdx = fs.plantedChapterId ? positions.get(fs.plantedChapterId) : undefined;
    const resolvedIdx = fs.resolvedChapterId ? positions.get(fs.resolvedChapterId) : undefined;
    const targetIdx = fs.targetChapterId ? positions.get(fs.targetChapterId) : undefined;

    let flipped = false;
    if (plantedIdx !== undefined && resolvedIdx !== undefined && resolvedIdx < plantedIdx) {
      flipped = true;
      conflicts.push({
        kind: "foreshadow-order-flip",
        severity: "error",
        targetId: fs.id,
        chapterId: fs.resolvedChapterId ?? undefined,
        message: `伏笔「${fs.title}」的回收章位于埋设章之前`,
      });
    }
    if (!flipped && plantedIdx !== undefined && targetIdx !== undefined && targetIdx < plantedIdx) {
      conflicts.push({
        kind: "foreshadow-order-flip",
        severity: "error",
        targetId: fs.id,
        chapterId: fs.targetChapterId ?? undefined,
        message: `伏笔「${fs.title}」的预定回收章位于埋设章之前`,
      });
    }

    if ((fs.status === "planted" || fs.status === "hinted") && plantedIdx !== undefined) {
      const span = refIdx - plantedIdx;
      const isOverdue = targetIdx !== undefined && refIdx > targetIdx;
      const isGapStale = span >= staleGap;
      if (isOverdue || isGapStale) {
        const overdueBy = targetIdx !== undefined ? refIdx - targetIdx : 0;
        conflicts.push({
          kind: "stale-foreshadow",
          severity: "warning",
          targetId: fs.id,
          chapterId: fs.targetChapterId ?? fs.plantedChapterId ?? undefined,
          message: isOverdue
            ? `伏笔「${fs.title}」已超过预定回收章 ${overdueBy} 章（距埋设已跨越 ${Math.max(0, span)} 章）仍未回收`
            : `伏笔「${fs.title}」已跨越 ${span} 章仍未回收`,
        });
      }
    }
  }

  return conflicts;
}
