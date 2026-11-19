import assert from "node:assert/strict";
import test from "node:test";
import {
  TOKEN_CATEGORIES,
  createBudgetGuard,
  fromRecordedUsage,
  totalTokens,
} from "../src/workflow/index.ts";
import { ContractError } from "../src/contracts/index.ts";

// W-02 conformance for the budget guard, against the mechanics `budget-a01`
// records and the frozen token vocabulary of B.4.
//
// Two deliberate refinements over the v1.x guard, both forced by the frozen
// error vocabulary rather than chosen freely:
//
//   - the local `budget.money` code was raised for two different situations;
//     the frozen set distinguishes them, so an unknown price becomes
//     `usage.uncertain` (await reconciliation) while a reached cap stays
//     `budget.exhausted` (stop the run). W-02's plan says as much: "计费不确定
//     进入待核对".
//   - `budget.exhausted` may disclose only `scope` and `reason` (errors-a01's
//     disclosure table), so the v1.x details — usedTokens, runBudget,
//     estimatedTokens, moneyCap — stay host side and are reachable only through
//     the diagnostic id. The snapshot remains the caller's own view.

const CONFIG = { inputBudget: 1000, runBudget: 2000, moneyCap: null };

function envelope(error) {
  return error.toEnvelope();
}

test("W-02 the frozen token categories are four, and a settle sums all of them", () => {
  assert.deepEqual([...TOKEN_CATEGORIES], ["input", "output", "cache_read", "cache_write"]);
  const guard = createBudgetGuard(CONFIG);
  guard
    .reserve(600)
    .settle(fromRecordedUsage({ input: 120, output: 60, cachedInput: 30, cacheWrite: 15, cost: null }));
  assert.deepEqual(guard.snapshot(), { usedTokens: 225, inflightTokens: 0, usedMoney: null });
  // The estimate and the actual usage are counted in the same categories.
  assert.equal(totalTokens({ input: 10, output: 5, cache_read: 2, cache_write: 1 }), 18);
  // The recorded v1.x spelling maps onto the frozen categories.
  assert.deepEqual(fromRecordedUsage({ input: 1, output: 2, cachedInput: 3, cacheWrite: 4, cost: null }), {
    input: 1,
    output: 2,
    cache_read: 3,
    cache_write: 4,
    cost: null,
  });
});

test("W-02 a stage reserves its estimate, then settles actual usage and releases the reservation", () => {
  const guard = createBudgetGuard(CONFIG);

  const reservation = guard.reserve(400);
  assert.deepEqual(guard.snapshot(), { usedTokens: 0, inflightTokens: 400, usedMoney: 0 });

  reservation.settle(fromRecordedUsage({ input: 120, cachedInput: 30, output: 60, cost: null }));
  assert.deepEqual(guard.snapshot(), { usedTokens: 210, inflightTokens: 0, usedMoney: null });

  guard.reserve(100).settle(fromRecordedUsage({ input: 50, cachedInput: 0, output: 50, cost: null }));
  assert.deepEqual(guard.snapshot(), { usedTokens: 310, inflightTokens: 0, usedMoney: null });
});

test("W-02 an estimate that would exceed the run budget refuses and leaves nothing reserved", () => {
  const guard = createBudgetGuard(
    { inputBudget: 2000, runBudget: 2000, moneyCap: null },
    fromRecordedUsage({ input: 100, cachedInput: 0, output: 50, cost: null }),
  );

  assert.throws(
    () => guard.reserve(1900),
    (error) =>
      error instanceof ContractError &&
      error.code === "budget.exhausted" &&
      error.details.scope === "run" &&
      error.details.reason === "tokens-exhausted",
  );
  assert.deepEqual(guard.snapshot(), { usedTokens: 150, inflightTokens: 0, usedMoney: null });
});

test("W-02 a single-stage estimate above the input budget refuses with the frozen envelope", () => {
  const guard = createBudgetGuard(CONFIG);

  assert.throws(
    () => guard.reserve(1200),
    (error) =>
      error instanceof ContractError &&
      error.code === "budget.exhausted" &&
      error.details.scope === "stage-input" &&
      error.details.reason === "estimate-exceeds-input-budget",
  );
  assert.equal(guard.snapshot().inflightTokens, 0);

  // The v1.x details used to be disclosed here; the frozen set allows only
  // scope and reason, so inputBudget stays host side.
  const guard2 = createBudgetGuard(CONFIG);
  try {
    guard2.reserve(1200);
    assert.fail("expected a refusal");
  } catch (error) {
    const { code, details } = envelope(error);
    assert.equal(code, "budget.exhausted");
    assert.deepEqual(Object.keys(details).sort(), ["reason", "scope"]);
    assert.equal(details.inputBudget, undefined);
  }
});

test("W-02 a configured money cap with an unknown price refuses as usage.uncertain instead of guessing", () => {
  const guard = createBudgetGuard(
    { ...CONFIG, moneyCap: { limit: 5, onReached: "refuse", unit: "CNY" } },
    fromRecordedUsage({ input: 10, cachedInput: 0, output: 5, cost: null }),
  );

  assert.throws(
    () => guard.reserve(100, "attempt-7"),
    (error) =>
      error instanceof ContractError &&
      error.code === "usage.uncertain" &&
      error.details.attemptId === "attempt-7" &&
      error.details.reason === "price-unknown",
  );
  assert.equal(guard.snapshot().inflightTokens, 0);
});

test("W-02 a configured money cap stops the stage once the cap is reached", () => {
  const guard = createBudgetGuard(
    { ...CONFIG, moneyCap: { limit: 5, onReached: "refuse", unit: "CNY" } },
    fromRecordedUsage({ input: 10, cachedInput: 0, output: 5, cost: 5 }),
  );

  assert.throws(
    () => guard.reserve(100),
    (error) =>
      error instanceof ContractError &&
      error.code === "budget.exhausted" &&
      error.details.scope === "run" &&
      error.details.reason === "money-cap-reached",
  );
  assert.equal(guard.snapshot().usedMoney, 5);
});

test("W-02 without a money cap the money total stays unknown rather than being reported as spare", () => {
  const guard = createBudgetGuard(CONFIG);

  guard.reserve(200).settle(fromRecordedUsage({ input: 80, cachedInput: 0, output: 40, cost: null }));
  assert.equal(guard.snapshot().usedMoney, null);
  assert.equal(guard.snapshot().usedTokens, 120);

  // A later known price does not backfill the earlier unknown one.
  guard.reserve(100).settle(fromRecordedUsage({ input: 40, cachedInput: 0, output: 20, cost: 2 }));
  assert.equal(guard.snapshot().usedMoney, null);
});

test("W-02 releasing a reservation returns the inflight tokens without counting usage", () => {
  const guard = createBudgetGuard(CONFIG);

  const reservation = guard.reserve(300);
  reservation.release();
  assert.deepEqual(guard.snapshot(), { usedTokens: 0, inflightTokens: 0, usedMoney: 0 });

  // Releasing twice must not credit the run budget.
  reservation.release();
  assert.equal(guard.snapshot().inflightTokens, 0);

  guard.reserve(300).settle(fromRecordedUsage({ input: 100, cachedInput: 0, output: 50, cost: null }));
  assert.deepEqual(guard.snapshot(), { usedTokens: 150, inflightTokens: 0, usedMoney: null });
});

test("W-02 a retried settle counts usage once, so a crash retry cannot double-charge", () => {
  const guard = createBudgetGuard(CONFIG);
  const reservation = guard.reserve(300);
  const actual = fromRecordedUsage({ input: 100, cachedInput: 0, output: 50, cost: null });
  reservation.settle(actual);
  // A retry of the same settle is a no-op: the reservation is already closed.
  reservation.settle(actual);
  assert.deepEqual(guard.snapshot(), { usedTokens: 150, inflightTokens: 0, usedMoney: null });
});

test("W-02 a non-count estimate or budget config is refused as input.invalid", () => {
  const guard = createBudgetGuard(CONFIG);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "100", null]) {
    assert.throws(
      () => guard.reserve(bad),
      (error) =>
        error instanceof ContractError &&
        error.code === "input.invalid" &&
        error.details.field === "estimatedTokens",
    );
  }
  assert.equal(guard.snapshot().inflightTokens, 0);

  for (const bad of [{ inputBudget: -1, runBudget: 10 }, { inputBudget: 10, runBudget: Number.NaN }]) {
    assert.throws(
      () => createBudgetGuard(bad),
      (error) =>
        error instanceof ContractError &&
        error.code === "input.invalid" &&
        error.details.field === "budget-config",
    );
  }
});
