// The contracts module's public surface.
//
// Only the frozen contract primitives live here. The error envelope and its
// closed code set are frozen (contracts.md §2 and B.1, 2026-11-19) and every
// module raises these codes, so they belong to the shared layer rather than to
// any one module.
//
// The rest of the shared contract — the command envelope, the read-model
// schemas and the domain types — stays out until its own items are frozen.

export {
  ERROR_CODES,
  ContractError,
  isErrorWithCode,
  type ErrorCode,
  type ErrorDetails,
  type ErrorEnvelope,
} from "./errors.ts";

export {
  APPROVAL_FIELDS,
  APPROVAL_GATED_ACTIONS,
  approvalMatches,
  assertApprovalGate,
  checkApprovalGate,
  createApproval,
  isApprovalGated,
  type ApprovalGateRequest,
  type ApprovalRecord,
} from "./approval.ts";

export {
  COMMANDS,
  DEMANDED_DISTINCTIONS,
  NON_COMMAND_ACTIONS,
  READ_ACTIONS,
  commandAllows,
  commandByName,
  commandPlan,
  isCommand,
  validateCommand,
  type CheckStep,
  type CommandDescriptor,
  type CommandRefusal,
  type NonCommandAction,
  type Subject,
} from "./commands.ts";

export {
  TITLE_MAX,
  QA_PASS_SCORE,
  QA_REFINEMENT_LIMIT,
  EDITORIAL_REJECTION_LIMIT,
  DELIVERY_ENDING,
  CHAPTER_STATES,
  ARTICLE_STATES,
  type ProtectedChapterState,
  type ProtectedArticleState,
} from "./protected-rules.ts";
