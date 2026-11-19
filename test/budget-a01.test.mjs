import assert from "node:assert/strict";
import test from "node:test";
import { RecordedError } from "../support/a01.mjs";

// A-01 supporting fixture for budget and usage bookkeeping. Mechanics are
// recorded from the v1.x core pipeline budget guard as forensic evidence for
// appendix B.4 of contracts.md. **Frozen on 2026-11-19 as an A-class item**:
// the four token categories (input/output/cache_read/cache_write) and their
// summation. Still open: the money units (Q-06, author) and whether a money
// cap is a stop gate (C.1 item 11). v1.x used the codes model.context_overflow,
// budget.tokens and budget.money; they are recorded here under those names and
// are not the V2 names.

// v1.x createBudgetGuard: reserve checks the single-stage estimate against the
// input budget, used plus inflight plus the estimate against the run budget,
// and the money cap when one is configured. settle releases the reservation
// and adds actual usage; release only returns the reservation.
function createBudgetGuard(config, initial) {
  let usedTokens = initial ? initial.input + initial.cachedInput + initial.output : 0;
  let usedMoney = initial ? initial.cost : 0;
  let inflightTokens = 0;

  return {
    reserve(estimatedTokens) {
      if (estimatedTokens > config.inputBudget) {
        throw new RecordedError("model.context_overflow", {
          estimatedTokens,
          inputBudget: config.inputBudget,
        });
      }
      if (usedTokens + inflightTokens + estimatedTokens > config.runBudget) {
        throw new RecordedError("budget.tokens", {
          usedTokens,
          inflightTokens,
          estimatedTokens,
          runBudget: config.runBudget,
        });
      }
      if (config.moneyCap !== null) {
        if (usedMoney === null) {
          throw new RecordedError("budget.money", { reason: "price-unknown" });
        }
        if (usedMoney >= config.moneyCap) {
          throw new RecordedError("budget.money", {
            usedMoney,
            moneyCap: config.moneyCap,
          });
        }
      }
      inflightTokens += estimatedTokens;
      let outstanding = estimatedTokens;
      const release = () => {
        inflightTokens -= outstanding;
        outstanding = 0;
      };
      return {
        release,
        settle(actual) {
          release();
          usedTokens += totalTokens(actual);
          // An unknown price on either side leaves the total unknown; the
          // guard never guesses a remaining amount.
          usedMoney =
            usedMoney === null || actual.cost === null ? null : usedMoney + actual.cost;
        },
      };
    },

    snapshot() {
      return { usedTokens, inflightTokens, usedMoney };
    },
  };
}

// The frozen token categories proposed in B.4: input, output, cache_read and
// cache_write. The recorded usage shape spells them input, output, cachedInput
// and cacheWrite; the mapping to the frozen names is part of the proposal.
const TOKEN_CATEGORIES = {
  input: "input",
  output: "output",
  cachedInput: "cache_read",
  cacheWrite: "cache_write",
};

function totalTokens(usage) {
  return Object.keys(TOKEN_CATEGORIES).reduce(
    (sum, key) => sum + (usage[key] ?? 0),
    0,
  );
}

const config = { inputBudget: 1000, runBudget: 2000, moneyCap: null };

test("A-01 the frozen token categories are input, output, cache_read and cache_write, and a settle sums all four", () => {
  assert.deepEqual(Object.values(TOKEN_CATEGORIES), [
    "input",
    "output",
    "cache_read",
    "cache_write",
  ]);
  const guard = createBudgetGuard(config);
  guard.reserve(600).settle({
    input: 120,
    output: 60,
    cachedInput: 30,
    cacheWrite: 15,
    cost: null,
  });
  assert.deepEqual(guard.snapshot(), {
    usedTokens: 225,
    inflightTokens: 0,
    usedMoney: null,
  });
  // The estimate and the actual usage are counted in the same categories.
  assert.equal(totalTokens({ input: 10, output: 5, cachedInput: 2, cacheWrite: 1 }), 18);
});

test("A-01 a stage reserves its estimate, then settles actual usage and releases the reservation", () => {
  const guard = createBudgetGuard(config);

  const reservation = guard.reserve(400);
  assert.deepEqual(guard.snapshot(), { usedTokens: 0, inflightTokens: 400, usedMoney: 0 });

  reservation.settle({ input: 120, cachedInput: 30, output: 60, cost: null });
  assert.deepEqual(guard.snapshot(), { usedTokens: 210, inflightTokens: 0, usedMoney: null });

  guard.reserve(100).settle({ input: 50, cachedInput: 0, output: 50, cost: null });
  assert.deepEqual(guard.snapshot(), { usedTokens: 310, inflightTokens: 0, usedMoney: null });
});

test("A-01 an estimate that would exceed the run budget fails the stage and leaves nothing reserved", () => {
  // A dedicated config keeps the single-stage check out of the way so the run
  // budget check is what fires.
  const guard = createBudgetGuard(
    { inputBudget: 2000, runBudget: 2000, moneyCap: null },
    { input: 100, cachedInput: 0, output: 50, cost: null },
  );

  assert.throws(
    () => guard.reserve(1900),
    (error) =>
      error instanceof RecordedError &&
      error.code === "budget.tokens" &&
      error.details.runBudget === 2000 &&
      error.details.usedTokens === 150
  );
  assert.deepEqual(guard.snapshot(), { usedTokens: 150, inflightTokens: 0, usedMoney: null });
});

test("A-01 a single-stage estimate above the input budget fails with the context overflow error", () => {
  const guard = createBudgetGuard(config);

  assert.throws(
    () => guard.reserve(1200),
    (error) => error.code === "model.context_overflow" && error.details.inputBudget === 1000,
  );
  assert.equal(guard.snapshot().inflightTokens, 0);
});

test("A-01 a configured money cap with an unknown price refuses instead of guessing", () => {
  const guard = createBudgetGuard({ ...config, moneyCap: 5 }, {
    input: 10,
    cachedInput: 0,
    output: 5,
    cost: null,
  });

  assert.throws(
    () => guard.reserve(100),
    (error) => error.code === "budget.money" && error.details.reason === "price-unknown",
  );
  assert.equal(guard.snapshot().inflightTokens, 0);
});

test("A-01 a configured money cap stops the stage once the cap is reached", () => {
  const guard = createBudgetGuard({ ...config, moneyCap: 5 }, {
    input: 10,
    cachedInput: 0,
    output: 5,
    cost: 5,
  });

  assert.throws(
    () => guard.reserve(100),
    (error) => error.code === "budget.money" && error.details.moneyCap === 5,
  );
  assert.equal(guard.snapshot().usedMoney, 5);
});

test("A-01 without a money cap the money total stays unknown rather than being reported as spare", () => {
  const guard = createBudgetGuard(config);

  guard.reserve(200).settle({ input: 80, cachedInput: 0, output: 40, cost: null });
  const snapshot = guard.snapshot();

  assert.equal(snapshot.usedMoney, null);
  assert.equal(snapshot.usedTokens, 120);
  // A later known price does not backfill the earlier unknown one.
  guard.reserve(100).settle({ input: 40, cachedInput: 0, output: 20, cost: 2 });
  assert.equal(guard.snapshot().usedMoney, null);
});

test("A-01 releasing a reservation returns the inflight tokens without counting usage", () => {
  const guard = createBudgetGuard(config);

  const reservation = guard.reserve(300);
  reservation.release();
  assert.deepEqual(guard.snapshot(), { usedTokens: 0, inflightTokens: 0, usedMoney: 0 });

  // Releasing twice must not credit the run budget.
  reservation.release();
  assert.equal(guard.snapshot().inflightTokens, 0);

  guard.reserve(300).settle({ input: 100, cachedInput: 0, output: 50, cost: null });
  assert.deepEqual(guard.snapshot(), { usedTokens: 150, inflightTokens: 0, usedMoney: null });
});
