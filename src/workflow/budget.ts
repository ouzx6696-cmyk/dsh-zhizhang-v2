// Budget and usage bookkeeping (contracts.md B.4, frozen 2026-11-19).
//
// The frozen part is the token vocabulary: a usage record carries exactly four
// categories — `input`, `output`, `cache_read` and `cache_write` — and a
// settled total sums all four, so an estimate and an actual are counted in the
// same categories. Everything else here is the v1.x guard's mechanics, replayed
// against the frozen error vocabulary.
//
// Two things are deliberately **not frozen** and are configurable rather than
// assumed: the money cap (whether it is a stop gate is C.1 item 11) and the
// money unit itself (Q-06, which C.1 item 11 gates on written authorisation).
// Both are marked where they are declared.
//
// C.1 numbering follows the complete table in `contracts.md`; the one-page
// signature sheet numbers the same items differently.
//
// The refusal rules, in order:
//
//   1. an estimate above the single-stage input budget refuses before anything
//      is reserved — a stage cannot start with a request the model will reject;
//   2. used plus inflight plus the estimate above the run budget refuses;
//   3. with a money cap configured, an unknown total price refuses as
//      `usage.uncertain` rather than guessing a remaining amount;
//   4. with a money cap configured, a total at or above the cap refuses.
//
// A refusal never leaves a reservation behind, and a settled reservation is
// settled once: a retried settle must not double-count usage.

import { ContractError } from "../contracts/errors.ts";

/** The frozen token categories (B.4). */
export const TOKEN_CATEGORIES = ["input", "output", "cache_read", "cache_write"] as const;

export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

/** A usage record in the frozen categories. */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
}

/** A settle's actual usage, with the price the model charged for it. */
export interface ActualUsage extends TokenUsage {
  /** `null` means the price is unknown; the money total then stays unknown. */
  readonly cost: number | null;
}

/**
 * The money cap. **Not frozen**: whether a money cap is a stop gate is C.1 item
 * 11, and the unit itself is Q-06. Both are carried here so a caller configures
 * them instead of inheriting a guess; the default behaviour mirrors the v1.x
 * guard, which refused.
 */
export interface MoneyCap {
  readonly limit: number;
  readonly onReached: "refuse";
  readonly unit: string;
}

/** One guard's configuration. */
export interface BudgetConfig {
  readonly inputBudget: number;
  readonly runBudget: number;
  readonly moneyCap?: MoneyCap | null;
}

/** A consistent view of the guard's totals. */
export interface BudgetSnapshot {
  readonly usedTokens: number;
  readonly inflightTokens: number;
  /** `null` whenever any settled cost was unknown — never a guess. */
  readonly usedMoney: number | null;
}

/** One in-flight estimate. */
export interface Reservation {
  /** Returns the reservation without counting usage. Idempotent. */
  release(): void;
  /** Releases the reservation and counts the actual usage. Idempotent. */
  settle(actual: ActualUsage): void;
}

/** One run's budget guard. */
export interface BudgetGuard {
  reserve(estimatedTokens: number, attemptId?: string): Reservation;
  snapshot(): BudgetSnapshot;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Sums the four frozen categories. An absent category counts as zero. */
export function totalTokens(usage: Partial<TokenUsage>): number {
  return TOKEN_CATEGORIES.reduce((sum, category) => sum + (usage[category] ?? 0), 0);
}

/**
 * Maps the recorded v1.x usage spelling (`cachedInput`, `cacheWrite`) onto the
 * frozen categories. The v1.x names are forensic evidence, not the V2 names;
 * this helper exists so evidence recorded in the old shape can be replayed
 * against the frozen vocabulary.
 */
export function fromRecordedUsage(usage: {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
  cost: number | null;
}): ActualUsage {
  return {
    input: usage.input,
    output: usage.output,
    cache_read: usage.cachedInput ?? 0,
    cache_write: usage.cacheWrite ?? 0,
    cost: usage.cost,
  };
}

/** Creates a guard, optionally seeded with usage already counted for the run. */
export function createBudgetGuard(config: BudgetConfig, initial?: ActualUsage): BudgetGuard {
  if (!isCount(config.inputBudget) || !isCount(config.runBudget)) {
    throw new ContractError("input.invalid", { field: "budget-config", reason: "budget-not-a-count" });
  }
  let usedTokens = initial ? totalTokens(initial) : 0;
  let usedMoney: number | null = initial ? initial.cost : 0;
  let inflightTokens = 0;

  return {
    reserve(estimatedTokens, attemptId) {
      if (!isCount(estimatedTokens)) {
        throw new ContractError("input.invalid", { field: "estimatedTokens", reason: "not-a-count" });
      }
      if (estimatedTokens > config.inputBudget) {
        throw new ContractError("budget.exhausted", {
          scope: "stage-input",
          reason: "estimate-exceeds-input-budget",
        });
      }
      if (usedTokens + inflightTokens + estimatedTokens > config.runBudget) {
        throw new ContractError("budget.exhausted", {
          scope: "run",
          reason: "tokens-exhausted",
        });
      }
      if (config.moneyCap) {
        if (usedMoney === null) {
          // The guard refuses rather than guessing a remaining amount: the run
          // cannot proceed, but the reason is uncertainty, not exhaustion.
          throw new ContractError("usage.uncertain", {
            ...(attemptId === undefined ? {} : { attemptId }),
            reason: "price-unknown",
          });
        }
        if (usedMoney >= config.moneyCap.limit) {
          throw new ContractError("budget.exhausted", {
            scope: "run",
            reason: "money-cap-reached",
          });
        }
      }
      inflightTokens += estimatedTokens;
      let outstanding = estimatedTokens;
      let settled = false;
      const release = () => {
        if (outstanding === 0) return;
        inflightTokens -= outstanding;
        outstanding = 0;
      };
      return {
        release,
        settle(actual) {
          if (settled) return;
          settled = true;
          release();
          usedTokens += totalTokens(actual);
          // An unknown price on either side leaves the total unknown; the
          // guard never guesses a remaining amount, and a later known price
          // does not backfill an earlier unknown one.
          usedMoney = usedMoney === null || actual.cost === null ? null : usedMoney + actual.cost;
        },
      };
    },

    snapshot() {
      return { usedTokens, inflightTokens, usedMoney };
    },
  };
}
