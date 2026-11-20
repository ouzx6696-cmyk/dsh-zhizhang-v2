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
 * for a library item in the current writing context.
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
): LibraryMountRule | null {
  let best: LibraryMountRule | null = null;
  for (const mount of mounts) {
    if (mount.itemKind !== itemKind || mount.itemId !== itemId) continue;
    const matches =
      (mount.targetType === "chapter" && mount.targetId === contextIds.chapterId) ||
      (mount.targetType === "act" && contextIds.actId !== null && mount.targetId === contextIds.actId) ||
      (mount.targetType === "volume" && contextIds.volumeId !== null && mount.targetId === contextIds.volumeId) ||
      (mount.targetType === "project" && mount.targetId === contextIds.projectId);
    if (!matches) continue;
    if (!best || TARGET_PRECEDENCE[mount.targetType] > TARGET_PRECEDENCE[best.targetType]) {
      best = mount;
    }
  }
  return best;
}

/**
 * Deterministic zero-token technique recommender for Fanqie chapters.
 * Scores approved cards by explicit mount precedence, pacing alignment,
 * golden-three-chapter boost, and keyword/tag overlap with outline/instruction.
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
}): TechniqueMatchResult[] {
  const effectiveCards = resolveScopedItems(params.cards).filter((card) => card.status === "approved");
  const textCorpus = (params.outlineText ?? "").toLowerCase();
  const isGoldenOpening = params.chapterIndex !== undefined && params.chapterIndex < 3;
  const results: TechniqueMatchResult[] = [];

  for (const card of effectiveCards) {
    const mount = resolveEffectiveMount(params.mounts, "technique", card.id, params.contextIds);
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
