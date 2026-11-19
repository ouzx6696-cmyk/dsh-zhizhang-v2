// The workflow module's public surface.
//
// Frozen contracts only: the run state machine (B.3), the stage registry
// (B.5), the read-model surface (B.7.3) and the serve that joins a read to the
// log (B.7). The runner that executes stages against the Host is not here yet —
// it needs the isolated-profile experiments (P0-02) — and the money unit the
// budget guard carries is the author's decision (C.1 item 11).

export {
  RUN_STATES,
  INITIAL_STATE,
  TERMINAL_STATES,
  TRANSITIONS,
  createRun,
  isRunState,
  isLegalTransition,
  isTerminal,
  type LateUsageResult,
  type Run,
  type RunState,
  type RunUsage,
} from "./runstate.ts";

export {
  STAGE_ID,
  AUTHOR_ACTION_WORDS,
  createStageRegistry,
  registerStage,
  parseStageId,
  stageKey,
  type StageDefinition,
  type StageExecution,
  type StageIdParts,
  type StageRegistry,
} from "./stages.ts";

export {
  TOKEN_CATEGORIES,
  createBudgetGuard,
  fromRecordedUsage,
  totalTokens,
  type ActualUsage,
  type BudgetConfig,
  type BudgetGuard,
  type BudgetSnapshot,
  type MoneyCap,
  type Reservation,
  type TokenCategory,
  type TokenUsage,
} from "./budget.ts";

export {
  CONCERNS,
  READ_MODELS,
  concernEvents,
  createReadRegistry,
  isConcern,
  readKey,
  serveRead,
  validateReadModel,
  validateReadValue,
  validateValue,
  type Concern,
  type ReadDefinition,
  type ReadRefusal,
  type ReadRegistry,
  type ValueSchema,
} from "./readmodels.ts";

export {
  serveReadFromLog,
  type ReadServeEntry,
  type ServeReadOptions,
  type ServedRead,
} from "./readserve.ts";
