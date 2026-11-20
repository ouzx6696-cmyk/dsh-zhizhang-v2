import { ContractError } from "../../contracts/errors.ts";
import { anchor, isEffective, precedes } from "../shared/anchors.ts";
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

export interface LoreForeshadowEntry {
  readonly id: string;
  readonly factId: string | null;
  readonly title: string;
  readonly plantedChapterId: string | null;
  readonly plantedPoint: number;
  readonly targetChapterId: string | null;
  readonly resolvedChapterId: string | null;
  readonly status: ForeshadowState;
}

export interface ChapterOutlineFacts {
  readonly chapterId: string;
  readonly lockedFacts: string;
}

export interface LoreConflictReport {
  readonly kind: "expiry-before-known" | "outline-fact-mismatch" | "stale-foreshadow" | "foreshadow-order-flip";
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
 * Pure continuity & worldbook conflict detector across approved settings,
 * foreshadow lifecycles, and chapter outlines.
 */
export function detectLoreConflicts(
  facts: readonly SettingFact[],
  foreshadows: readonly LoreForeshadowEntry[],
  chapterOrder: readonly string[],
  outlines: readonly ChapterOutlineFacts[],
): LoreConflictReport[] {
  const conflicts: LoreConflictReport[] = [];
  const positions = new Map<string, number>();
  chapterOrder.forEach((id, index) => {
    if (!positions.has(id)) positions.set(id, index);
  });

  // 1. Check setting effectiveTo vs character knownFrom ordering
  for (const fact of facts) {
    if (!fact.effectiveTo) continue;
    for (const [character, knownAt] of Object.entries(fact.knownFrom)) {
      if (!precedes(knownAt, fact.effectiveTo, chapterOrder)) {
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

  // 2. Check chapter outline lockedFacts referencing expired or not-yet-effective fact IDs
  const factsById = new Map<string, SettingFact[]>();
  for (const fact of facts) {
    const bucket = factsById.get(fact.id) ?? [];
    bucket.push(fact);
    factsById.set(fact.id, bucket);
  }
  for (const outline of outlines) {
    if (!outline.lockedFacts.trim()) continue;
    const at = anchor(outline.chapterId, 1);
    for (const [factId, versions] of factsById) {
      if (factId.length < 2 || !outline.lockedFacts.includes(factId)) continue;
      const anyActive = versions.some((entry) => isEffective(entry, at, chapterOrder));
      if (!anyActive) {
        conflicts.push({
          kind: "outline-fact-mismatch",
          severity: "warning",
          targetId: factId,
          chapterId: outline.chapterId,
          message: `章纲锁定事实提及「${factId}」，但该设定在当前章尚未生效或已失效`,
        });
      }
    }
  }

  // 3. Check foreshadow temporal consistency and long-unresolved tails
  for (const fs of foreshadows) {
    if (fs.status === "abandoned") continue;
    const plantedIdx = fs.plantedChapterId ? positions.get(fs.plantedChapterId) : undefined;
    const resolvedIdx = fs.resolvedChapterId ? positions.get(fs.resolvedChapterId) : undefined;
    if (plantedIdx !== undefined && resolvedIdx !== undefined && resolvedIdx < plantedIdx) {
      conflicts.push({
        kind: "foreshadow-order-flip",
        severity: "error",
        targetId: fs.id,
        chapterId: fs.resolvedChapterId ?? undefined,
        message: `伏笔「${fs.title}」的回收章位于埋设章之前`,
      });
    }
    if ((fs.status === "planted" || fs.status === "hinted") && plantedIdx !== undefined) {
      const span = chapterOrder.length - 1 - plantedIdx;
      const targetIdx = fs.targetChapterId ? positions.get(fs.targetChapterId) : undefined;
      if ((targetIdx !== undefined && chapterOrder.length - 1 > targetIdx) || span >= 25) {
        conflicts.push({
          kind: "stale-foreshadow",
          severity: "warning",
          targetId: fs.id,
          chapterId: fs.targetChapterId ?? fs.plantedChapterId ?? undefined,
          message: `伏笔「${fs.title}」已跨越 ${span} 章仍未回收`,
        });
      }
    }
  }

  return conflicts;
}
