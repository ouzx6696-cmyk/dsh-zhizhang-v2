// The run state machine (contracts.md B.3, frozen 2026-11-19).
//
// Seven states, fourteen legal transitions, one initial state and three
// terminal ones. The vocabulary is deliberately disjoint from both product
// lines' business state words: a run's state says where the orchestration is,
// never where a chapter or an article is.
//
// The two invariants that matter operationally:
//
//   - a terminal state has no outgoing transition, so a cancellation cannot be
//     undone by a late response;
//   - a late model response after cancellation only adds usage — it never
//     writes a checkpoint, never changes the state and never delivers a
//     candidate (W-01 invariant 3).

import { ContractError } from "../contracts/errors.ts";

/** The closed run-state vocabulary. */
export const RUN_STATES = [
  "running",
  "paused",
  "awaiting-author",
  "failed",
  "cancelled",
  "applied",
  "discarded",
] as const;

export type RunState = (typeof RUN_STATES)[number];

/** The only initial state. */
export const INITIAL_STATE: RunState = "running";

/** States with no outgoing transition. */
export const TERMINAL_STATES: readonly RunState[] = ["cancelled", "applied", "discarded"];

/** The legal transitions, as [from, to] pairs. */
export const TRANSITIONS: readonly (readonly [RunState, RunState])[] = [
  ["running", "paused"],
  ["paused", "running"],
  ["running", "awaiting-author"],
  ["paused", "awaiting-author"],
  ["awaiting-author", "running"],
  ["awaiting-author", "applied"],
  ["awaiting-author", "discarded"],
  ["running", "failed"],
  ["paused", "failed"],
  ["failed", "running"],
  ["running", "cancelled"],
  ["paused", "cancelled"],
  ["failed", "cancelled"],
  ["awaiting-author", "cancelled"],
];

const STATE_SET: ReadonlySet<string> = new Set(RUN_STATES);
const TRANSITION_SET: ReadonlySet<string> = new Set(
  TRANSITIONS.map(([from, to]) => `${from}->${to}`),
);

/** Whether a word belongs to the run-state vocabulary. */
export function isRunState(value: unknown): value is RunState {
  return typeof value === "string" && STATE_SET.has(value);
}

/** Whether a transition is legal. Unknown words are never legal. */
export function isLegalTransition(from: RunState, to: RunState): boolean {
  return STATE_SET.has(from) && STATE_SET.has(to) && TRANSITION_SET.has(`${from}->${to}`);
}

/** Whether a state is terminal. */
export function isTerminal(state: RunState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** Usage as the run accounts for it. */
export interface RunUsage {
  /** Usage from responses the run still acts on. */
  settled: number;
  /** Usage from responses that arrived after cancellation. */
  pendingLate: number;
}

/** What a late response reports. */
export interface LateUsageResult {
  readonly state: RunState;
  /** Whether the response was still actionable. */
  readonly applied: boolean;
}

/** One run's state machine and usage bookkeeping. */
export interface Run {
  readonly state: RunState;
  readonly usage: RunUsage;
  transition(to: RunState): RunState;
  recordLateUsage(tokens: number): LateUsageResult;
}

/** Creates a run in the single initial state. */
export function createRun(): Run {
  let state: RunState = INITIAL_STATE;
  const usage: RunUsage = { settled: 0, pendingLate: 0 };

  return {
    get state() {
      return state;
    },
    get usage() {
      return usage;
    },
    transition(to) {
      if (!isRunState(to) || !isLegalTransition(state, to)) {
        throw new ContractError("gate.denied", { from: state, to });
      }
      state = to;
      return state;
    },
    recordLateUsage(tokens) {
      if (isTerminal(state)) {
        usage.pendingLate += tokens;
        return { state, applied: false };
      }
      usage.settled += tokens;
      return { state, applied: true };
    },
  };
}
