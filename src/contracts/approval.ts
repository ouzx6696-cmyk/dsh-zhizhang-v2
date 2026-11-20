// The approval record and its gate (contracts.md B.9, frozen 2026-11-19).
//
// An approval record carries six fields — `actor`, `action`, `target`,
// `targetVersion`, `decision` and `at` — and a record missing any of them is
// refused rather than stored. The record exists to answer one question: does
// this specific author decision authorise this specific request?
//
// The gate therefore binds four things, and all four must match:
//
//   - the subject, which is the trusted actor the Host resolved — never a field
//     the caller passed in;
//   - the action the command performs;
//   - the object it operates on;
//   - the version of that object.
//
// A record for another object, another version, another action or another
// subject grants nothing: the refusal is `gate.denied`, and its details are
// limited to the two fields the disclosure table allows (`action`, `reason`).
//
// Two things are deliberately **not** decided here and stay with the author:
// whether an approval is per delivery or a session-level policy (C.1 item 10),
// and whether an Agent may cancel a run it started (C.1 item 9).
//
// C.1 numbering follows the complete table in `contracts.md`. The one-page
// signature sheet (`作者裁决单.md`) numbers the same items differently, so a
// reference by number alone is ambiguous across the two documents.

import { ContractError } from "./errors.ts";

/** One author approval, as the frozen schema records it. */
export interface ApprovalRecord {
  /** The subject who decided — the trusted actor, never a caller claim. */
  readonly actor: string;
  /** The action the approval authorises. */
  readonly action: string;
  /** The object the approval is about. */
  readonly target: string;
  /** The version of that object the approval is about. */
  readonly targetVersion: string;
  /** The decision itself. */
  readonly decision: string;
  /** When the decision was made. */
  readonly at: string;
}

/** The frozen field set, in the order the schema lists them. */
export const APPROVAL_FIELDS = [
  "actor",
  "action",
  "target",
  "targetVersion",
  "decision",
  "at",
] as const;

/**
 * The commands the authority matrix marks approval-gated.
 *
 * The set itself is the frozen proposal (`article.deliver` is the only one);
 * whether an approval is per delivery or session-level is the author's
 * decision (C.1 item 10) and is not assumed here.
 */
export const APPROVAL_GATED_ACTIONS: readonly string[] = ["article.deliver"];

/** Whether an action requires an approval record before it may run. */
export function isApprovalGated(action: string): boolean {
  return APPROVAL_GATED_ACTIONS.includes(action);
}

/** Creates a record, refusing one that is missing any of the six fields. */
export function createApproval(
  record: Readonly<Partial<ApprovalRecord>>,
): { ok: true; record: ApprovalRecord } | { ok: false; code: "input.invalid"; details: Record<string, unknown> } {
  const missing = APPROVAL_FIELDS.filter((field) => {
    const value = record[field];
    return typeof value !== "string" || value.trim().length === 0;
  });
  if (missing.length > 0) {
    return { ok: false, code: "input.invalid", details: { field: "approval", reason: "missing-fields", missing } };
  }
  return {
    ok: true,
    record: {
      actor: record.actor as string,
      action: record.action as string,
      target: record.target as string,
      targetVersion: record.targetVersion as string,
      decision: record.decision as string,
      at: record.at as string,
    },
  };
}

/** Whether a record names the action, object and version a request carries. */
export function approvalMatches(
  record: ApprovalRecord,
  action: string,
  target: string,
  targetVersion: string,
): boolean {
  return (
    record.action === action && record.target === target && record.targetVersion === targetVersion
  );
}

/** What a gate check needs: the record, and the request it must authorise. */
export interface ApprovalGateRequest {
  readonly record: ApprovalRecord | undefined | null;
  /** The trusted subject the Host resolved for this request. */
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly targetVersion: string;
}

/**
 * Checks the gate for one request.
 *
 * Returns null when the request is authorised, or the frozen refusal when it is
 * not. The subject is compared against the record's actor, so a record another
 * subject obtained grants nothing.
 */
export function checkApprovalGate(request: ApprovalGateRequest): ContractError | null {
  const { record, actor, action, target, targetVersion } = request;
  const matches =
    record !== undefined &&
    record !== null &&
    record.decision === "approved" &&
    record.actor === actor &&
    approvalMatches(record, action, target, targetVersion);
  if (!matches) {
    return new ContractError("gate.denied", { action, reason: "approval-missing" });
  }
  return null;
}

/** Throws the frozen refusal when the gate does not authorise the request. */
export function assertApprovalGate(request: ApprovalGateRequest): void {
  const refusal = checkApprovalGate(request);
  if (refusal) throw refusal;
}
