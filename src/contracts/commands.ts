// The section 2 command table, executable (contracts.md §2 and B.2, frozen
// 2026-11-19).
//
// Every command in the section 2 table carries exactly one authority entry, one
// approval-gate flag, one idempotency requirement, one base-check requirement
// and one envelope shape. This module encodes that table so the alignment is
// checkable rather than merely documented, and derives from it the *order* the
// checks must run in.
//
// The frozen write order (contracts.md §2):
//
//   1. authority — a subject outside the entry's list is `auth.denied`;
//   2. approval gate, for the commands that carry one — a missing or mismatched
//      record is `gate.denied` (see `approval.ts`);
//   3. idempotency, for the commands whose request carries a key — a replay with
//      the same payload returns the original result, a replay with a different
//      payload is `idempotency.mismatch`;
//   4. base check, for the commands that validate one — a stale base is
//      `version.conflict`;
//   5. business state gate — `gate.denied`;
//   6. commit.
//
// The mechanics of steps 3 to 6 live in `storage/command.ts`, which writes the
// order "幂等 → 基准 → 业务状态" as one transaction. This module owns the table
// and the order, not the transaction.

import { ERROR_CODES, type ErrorCode } from "./errors.ts";

/** A subject a command may name in its authority list. */
export type Subject = "author" | "agent";

/** One frozen command entry. */
export interface CommandDescriptor {
  readonly name: string;
  readonly authority: readonly Subject[];
  readonly approvalGate: boolean;
  /** Whether the request carries an idempotency key. */
  readonly idempotent: boolean;
  /** Whether the base revision must be validated before the write. */
  readonly baseCheck: boolean;
  readonly envelope: {
    /** The kind of value a success returns. */
    readonly success: string;
    readonly errors: readonly ErrorCode[];
  };
}

/** An action that has an envelope and an authority entry but is not a command. */
export interface NonCommandAction {
  readonly name: string;
  readonly authority: readonly Subject[];
  readonly approvalGate: boolean;
  /** Whether the author has yet to decide this action's rule. */
  readonly pendingAuthorDecision?: boolean;
}

/** The seven section 2 commands, as frozen. */
export const COMMANDS: readonly CommandDescriptor[] = [
  {
    name: "draft.save",
    authority: ["author"],
    approvalGate: false,
    idempotent: false,
    baseCheck: true,
    envelope: {
      success: "revision",
      errors: ["version.conflict", "input.invalid", "input.not_found"],
    },
  },
  {
    name: "run.start",
    authority: ["author"],
    approvalGate: false,
    idempotent: false,
    baseCheck: false,
    envelope: {
      success: "run",
      errors: ["budget.exhausted", "input.invalid", "input.not_found", "dependency.unavailable"],
    },
  },
  {
    name: "candidate.adopt",
    authority: ["author"],
    approvalGate: false,
    idempotent: true,
    baseCheck: true,
    envelope: {
      success: "revision",
      errors: ["version.conflict", "idempotency.mismatch", "input.invalid"],
    },
  },
  {
    name: "draft.finalize",
    authority: ["author"],
    approvalGate: false,
    idempotent: false,
    baseCheck: true,
    envelope: {
      success: "revision",
      errors: ["version.conflict", "gate.denied", "input.invalid"],
    },
  },
  {
    name: "setting.decide",
    authority: ["author"],
    approvalGate: false,
    idempotent: false,
    baseCheck: false,
    envelope: {
      success: "setting-version",
      errors: ["gate.denied", "input.invalid", "input.not_found"],
    },
  },
  {
    name: "article.accept",
    authority: ["author"],
    approvalGate: false,
    idempotent: false,
    baseCheck: true,
    envelope: {
      success: "acceptance",
      errors: ["version.conflict", "gate.denied", "input.invalid"],
    },
  },
  {
    name: "article.deliver",
    authority: ["author"],
    approvalGate: true,
    idempotent: true,
    baseCheck: true,
    envelope: {
      success: "delivery",
      errors: ["gate.denied", "idempotency.mismatch", "version.conflict", "input.invalid"],
    },
  },
];

/**
 * Actions that are not section 2 commands: the Agent's run artifact and the
 * host approval seam. They have envelopes and authority entries but no place in
 * the command table.
 */
export const NON_COMMAND_ACTIONS: readonly NonCommandAction[] = [
  { name: "candidate.produce", authority: ["agent"], approvalGate: false },
  { name: "approval.decide", authority: ["author"], approvalGate: true },
  { name: "run.cancel", authority: ["author"], approvalGate: false, pendingAuthorDecision: true },
];

/** Reads are a separate namespace: they never carry a write envelope. */
export const READ_ACTIONS: readonly string[] = ["workspace.read", "run.read"];

/** The six distinctions section 2 demands, each mapping to one frozen code. */
export const DEMANDED_DISTINCTIONS: Readonly<Record<string, ErrorCode>> = {
  "version conflict": "version.conflict",
  "identity or permission refusal": "auth.denied",
  "state or business gate refusal": "gate.denied",
  "budget exhaustion": "budget.exhausted",
  "idempotency key with a different payload": "idempotency.mismatch",
  "unknown storage format": "storage.format_unsupported",
};

/** Why a command entry is not a valid alignment. */
export type CommandRefusal =
  | "malformed-name"
  | "missing-authority"
  | "undeclared-approval-gate"
  | "undeclared-idempotency"
  | "undeclared-base-check"
  | "unfrozen-error-code"
  | "unknown-command";

/**
 * Validates one entry against the alignment rules: a dotted name, a non-empty
 * authority list, all three flags declared, and every envelope code inside the
 * frozen set.
 */
export function validateCommand(entry: CommandDescriptor): CommandRefusal | null {
  if (typeof entry.name !== "string" || !entry.name.includes(".")) return "malformed-name";
  if (!Array.isArray(entry.authority) || entry.authority.length === 0) return "missing-authority";
  if (typeof entry.approvalGate !== "boolean") return "undeclared-approval-gate";
  if (typeof entry.idempotent !== "boolean") return "undeclared-idempotency";
  if (typeof entry.baseCheck !== "boolean") return "undeclared-base-check";
  for (const code of entry.envelope.errors) {
    if (!(ERROR_CODES as readonly string[]).includes(code)) return "unfrozen-error-code";
  }
  return null;
}

/** Looks a command up by name. */
export function commandByName(name: string): CommandDescriptor | undefined {
  return COMMANDS.find((command) => command.name === name);
}

/** Whether a name belongs to the command table. */
export function isCommand(name: string): boolean {
  return commandByName(name) !== undefined;
}

/** One step of the frozen check order. */
export type CheckStep = "authority" | "approval-gate" | "idempotency" | "base-check" | "business-state";

/**
 * The checks a command runs, in the frozen order.
 *
 * Derived from the descriptor's flags rather than written out per command, so a
 * flag change cannot leave the order behind.
 */
export function commandPlan(name: string): readonly CheckStep[] | null {
  const command = commandByName(name);
  if (!command) return null;
  const plan: CheckStep[] = ["authority"];
  if (command.approvalGate) plan.push("approval-gate");
  if (command.idempotent) plan.push("idempotency");
  if (command.baseCheck) plan.push("base-check");
  plan.push("business-state");
  return plan;
}

/** Whether a subject may run a command at all, before any other check. */
export function commandAllows(name: string, actor: Subject): boolean {
  const command = commandByName(name);
  return command !== undefined && command.authority.includes(actor);
}
