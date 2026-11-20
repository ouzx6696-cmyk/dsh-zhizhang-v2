import { ContractError } from "../../contracts/errors.ts";
import { PACING } from "./editorial.ts";

export const TECHNIQUE_CATEGORIES = [
  "opening",
  "hook",
  "conflict",
  "dialogue",
  "atmosphere",
  "foreshadow",
  "pacing",
  "cliffhanger",
  "narrative",
] as const;
export type TechniqueCategory = (typeof TECHNIQUE_CATEGORIES)[number];

export const WRITING_STAGE_BINDINGS = ["plan", "write", "review", "refine", "deslop"] as const;
export type WritingStageBinding = (typeof WRITING_STAGE_BINDINGS)[number];

export interface TechniqueCardForRank {
  readonly id: string;
  readonly scope: "global" | "project";
  readonly overrideOfId: string | null;
  readonly title: string;
  readonly category: string;
  readonly pacing: string;
  readonly sceneTags: readonly string[];
  readonly triggerWhen: string;
  readonly executionSteps: string;
  readonly constraints: string;
  readonly antiPatterns: string;
  readonly priority: number;
  readonly status: "proposed" | "approved" | "archived";
  readonly assetKind?: "technique" | "skill";
  readonly stageBindings?: readonly WritingStageBinding[];
}

export interface LibraryMountRule {
  readonly targetType: "project" | "volume" | "act" | "chapter";
  readonly targetId: string;
  readonly itemKind: "deconstruction" | "technique";
  readonly itemId: string;
  readonly mode: "include" | "exclude" | "pin";
  readonly weight: number;
}

export interface TechniqueMatchResult {
  readonly card: TechniqueCardForRank;
  readonly score: number;
  readonly mountedMode: "include" | "exclude" | "pin" | null;
  readonly mountTarget: "project" | "volume" | "act" | "chapter" | null;
  readonly reasons: readonly string[];
}

const TARGET_PRECEDENCE: Readonly<Record<LibraryMountRule["targetType"], number>> = {
  chapter: 4,
  act: 3,
  volume: 2,
  project: 1,
};

/** Validates and normalizes tag arrays without throwing on clean empty input. */
export function normalizeTags(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
  }
  if (typeof raw === "string") {
    return [...new Set(raw.split(/[,，\n、]+/u).map((item) => item.trim()).filter(Boolean))];
  }
  throw new ContractError("input.invalid", { field: "tags", reason: "expected-string-or-list" });
}

/** Validates and normalizes stage bindings, defaulting empty inputs to `["write"]`. */
export function normalizeStageBindings(raw: unknown): WritingStageBinding[] {
  if (raw === undefined || raw === null || raw === "") return ["write"];
  let tokens: string[];
  if (Array.isArray(raw)) {
    tokens = raw.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  } else if (typeof raw === "string") {
    tokens = raw.split(/[,，\n、\s]+/u).map((item) => item.trim().toLowerCase()).filter(Boolean);
  } else {
    throw new ContractError("input.invalid", { field: "stageBindings", reason: "expected-string-or-list" });
  }
  if (tokens.length === 0) return ["write"];
  const valid = new Set<string>(WRITING_STAGE_BINDINGS);
  const result: WritingStageBinding[] = [];
  for (const token of tokens) {
    if (!valid.has(token)) {
      throw new ContractError("input.invalid", { field: "stageBindings", reason: "unknown-stage-binding" });
    }
    if (!result.includes(token as WritingStageBinding)) {
      result.push(token as WritingStageBinding);
    }
  }
  return result;
}

/** Validates optional pacing tier against Fanqie `PACING` vocabulary. */
export function validatePacingLabel(pacing: unknown): string {
  if (pacing === undefined || pacing === null || pacing === "") return "";
  if (typeof pacing !== "string") {
    throw new ContractError("input.invalid", { field: "pacing", reason: "string-required" });
  }
  const trimmed = pacing.trim();
  if (trimmed && !Object.hasOwn(PACING, trimmed)) {
    throw new ContractError("input.invalid", { field: "pacing", reason: "unknown-pacing-tier" });
  }
  return trimmed;
}

/**
 * Resolves effective cards by applying project-level overrides over global cards.
 * Global cards superseded by a project override are replaced cleanly.
 */
export function resolveScopedItems<
  T extends { readonly id: string; readonly scope: "global" | "project"; readonly overrideOfId: string | null },
>(items: readonly T[]): T[] {
  const overriddenGlobals = new Set(
    items.filter((item) => item.scope === "project" && item.overrideOfId).map((item) => item.overrideOfId!),
  );
  return items.filter((item) => item.scope === "project" || !overriddenGlobals.has(item.id));
}

/**
 * Resolves the highest-precedence mount rule (`chapter > act > volume > project`)
 * for a library item (or its overridden base card ID) in the current writing context.
 */
export function resolveEffectiveMount(
  mounts: readonly LibraryMountRule[],
  itemKind: LibraryMountRule["itemKind"],
  itemId: string,
  contextIds: {
    readonly projectId: string;
    readonly volumeId: string | null;
    readonly actId: string | null;
    readonly chapterId: string;
  },
  fallbackItemId: string | null = null,
): LibraryMountRule | null {
  let best: LibraryMountRule | null = null;
  let bestPrecedence = -1;
  let bestDirect = false;
  for (const mount of mounts) {
    if (mount.itemKind !== itemKind) continue;
    const isDirect = mount.itemId === itemId;
    const isFallback = Boolean(fallbackItemId && mount.itemId === fallbackItemId);
    if (!isDirect && !isFallback) continue;
    const matches =
      (mount.targetType === "chapter" && mount.targetId === contextIds.chapterId) ||
      (mount.targetType === "act" && contextIds.actId !== null && mount.targetId === contextIds.actId) ||
      (mount.targetType === "volume" && contextIds.volumeId !== null && mount.targetId === contextIds.volumeId) ||
      (mount.targetType === "project" && mount.targetId === contextIds.projectId);
    if (!matches) continue;
    const precedence = TARGET_PRECEDENCE[mount.targetType];
    if (precedence > bestPrecedence || (precedence === bestPrecedence && isDirect && !bestDirect)) {
      best = mount;
      bestPrecedence = precedence;
      bestDirect = isDirect;
    }
  }
  return best;
}

/**
 * Deterministic zero-token technique recommender for Fanqie chapters.
 * Scores approved cards by explicit mount precedence (including inherited
 * override mounts), stage binding, pacing alignment, golden-three boost,
 * and keyword/tag overlap with outline/instruction.
 */
export function rankTechniquesForChapter(params: {
  readonly cards: readonly TechniqueCardForRank[];
  readonly mounts: readonly LibraryMountRule[];
  readonly contextIds: {
    readonly projectId: string;
    readonly volumeId: string | null;
    readonly actId: string | null;
    readonly chapterId: string;
  };
  readonly pacing?: string;
  readonly outlineText?: string;
  readonly chapterIndex?: number;
  readonly stage?: WritingStageBinding;
}): TechniqueMatchResult[] {
  const effectiveCards = resolveScopedItems(params.cards).filter((card) => {
    if (card.status !== "approved") return false;
    if (!params.stage) return true;
    const bindings = card.stageBindings && card.stageBindings.length > 0 ? card.stageBindings : ["write"];
    return bindings.includes(params.stage);
  });
  const textCorpus = (params.outlineText ?? "").toLowerCase();
  const isGoldenOpening = params.chapterIndex !== undefined && params.chapterIndex < 3;
  const results: TechniqueMatchResult[] = [];

  for (const card of effectiveCards) {
    const mount = resolveEffectiveMount(
      params.mounts,
      "technique",
      card.id,
      params.contextIds,
      card.overrideOfId,
    );
    if (mount?.mode === "exclude") continue;

    let score = card.priority;
    const reasons: string[] = [];

    if (mount) {
      const mountBoost = mount.mode === "pin" ? 500 : 250 + TARGET_PRECEDENCE[mount.targetType] * 30;
      score += mountBoost + Math.min(100, mount.weight);
      reasons.push(mount.mode === "pin" ? `置顶挂载（${mount.targetType}）` : `已挂载（${mount.targetType}）`);
    }

    if (params.pacing && card.pacing && card.pacing === params.pacing) {
      score += 80;
      reasons.push(`匹配节奏「${params.pacing}」`);
    }

    if (isGoldenOpening && (card.category === "opening" || card.category === "hook")) {
      score += 60;
      reasons.push("黄金三章开篇强化");
    }

    const matchedTags = card.sceneTags.filter((tag) => tag.length >= 2 && textCorpus.includes(tag.toLowerCase()));
    if (matchedTags.length > 0) {
      score += matchedTags.length * 45;
      reasons.push(`命中标签：${matchedTags.slice(0, 3).join("、")}`);
    }

    if (card.triggerWhen && textCorpus) {
      const hints = card.triggerWhen.split(/[\s,，、/]+/u).filter((token) => token.length >= 2);
      const hits = hints.filter((token) => textCorpus.includes(token.toLowerCase()));
      if (hits.length > 0) {
        score += Math.min(60, hits.length * 20);
        reasons.push("匹配触发场景");
      }
    }

    results.push({
      card,
      score,
      mountedMode: mount?.mode ?? null,
      mountTarget: mount?.targetType ?? null,
      reasons,
    });
  }

  return results.sort((a, b) => b.score - a.score || a.card.title.localeCompare(b.card.title));
}
