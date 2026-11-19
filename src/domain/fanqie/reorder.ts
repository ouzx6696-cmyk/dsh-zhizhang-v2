// Chapter reordering and its continuity impact (contracts.md B.8, frozen
// 2026-11-19).
//
// The frozen rule: reordering chapters must produce an impact list — the
// temporal relations whose relative order was flipped — for the author to
// review, never silently accepted. The frozen command form is a pair:
//
//   1. a read-only `reorder.impact` that returns the list;
//   2. only after the author confirms, a write command that submits the new
//      chapter order.
//
// This module owns the read half and the decision of whether the write half is
// allowed to proceed. The write itself belongs to the fanqie storage port and
// is wired when that port exists; `planReorder` returns what a caller needs to
// gate on, so no caller can submit an unreviewed reorder by accident.

import { anchor, precedes, type Anchor } from "../shared/anchors.ts";

/** One temporal relation between two anchors, named by what it asserts. */
export interface TemporalRelation {
  readonly from: Anchor;
  readonly to: Anchor;
  readonly label: string;
}

/** One continuity entry: a subject with the relations recorded about it. */
export interface ContinuityEntry {
  readonly id: string;
  readonly relations: readonly TemporalRelation[];
}

/** The relations of one entry that the reorder flipped. */
export interface ReorderImpact {
  readonly id: string;
  readonly relations: readonly TemporalRelation[];
}

/** Whether a relation's relative order changed between two chapter orders. */
export function relationFlipped(
  relation: TemporalRelation,
  before: readonly string[],
  after: readonly string[],
): boolean {
  return (
    precedes(relation.from, relation.to, before) !== precedes(relation.from, relation.to, after)
  );
}

/**
 * The continuity impact of reordering chapters.
 *
 * Entries with no flipped relation are omitted, so an empty list means the
 * reorder disturbs nothing the author recorded. The same order on both sides
 * therefore yields an empty list.
 */
export function reorderImpact(
  entries: readonly ContinuityEntry[],
  before: readonly string[],
  after: readonly string[],
): ReorderImpact[] {
  const impacts: ReorderImpact[] = [];
  for (const entry of entries) {
    const flipped = entry.relations.filter((relation) => relationFlipped(relation, before, after));
    if (flipped.length > 0) impacts.push({ id: entry.id, relations: flipped });
  }
  return impacts;
}

/** What a caller needs before it may submit a reorder. */
export interface ReorderPlan {
  /** The relations the reorder flips, per affected entry. */
  readonly impact: readonly ReorderImpact[];
  /** Whether the author must confirm before the write command may run. */
  readonly requiresAuthorConfirmation: boolean;
}

/**
 * Plans a reorder: computes its impact and states the gate.
 *
 * A reorder that flips nothing still requires no confirmation, because there is
 * nothing for the author to review.
 */
export function planReorder(
  entries: readonly ContinuityEntry[],
  before: readonly string[],
  after: readonly string[],
): ReorderPlan {
  const impact = reorderImpact(entries, before, after);
  return { impact, requiresAuthorConfirmation: impact.length > 0 };
}

/** A chapter order, as the reorder commands carry it. */
export interface ChapterOrder {
  readonly chapterIds: readonly string[];
}

/** The read-only `reorder.impact` command result. */
export interface ReorderImpactResult {
  readonly impact: readonly ReorderImpact[];
  readonly requiresAuthorConfirmation: boolean;
}

/**
 * The read-only half of the frozen command pair.
 *
 * It never writes: a caller that wants to submit the new order must take the
 * result to the author first, and the write command is a separate call.
 */
export function reorderImpactCommand(
  entries: readonly ContinuityEntry[],
  current: ChapterOrder,
  proposed: ChapterOrder,
): ReorderImpactResult {
  const plan = planReorder(entries, current.chapterIds, proposed.chapterIds);
  return { impact: plan.impact, requiresAuthorConfirmation: plan.requiresAuthorConfirmation };
}

export { anchor, precedes };
export type { Anchor };
