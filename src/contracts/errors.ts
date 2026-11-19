// The frozen error envelope.
//
// The shape and the closed code set are frozen in contracts.md §2 and B.1
// (2026-11-19, A-class): a structured error carries `code`, the
// disclosure-allowed `details`, and a `diagnosticId` that ties the failure back
// to a log entry. The code set is closed — adding a code is a contract change,
// not a local decision, so a code outside the set is refused at construction
// rather than surfacing at a caller.
//
// This lives in `contracts/` because every module raises these codes; the
// storage layer keeps its own `StorageError` subclass for domain clarity.

import { randomUUID } from "node:crypto";

/** The frozen closed code set (contracts.md B.1). */
export const ERROR_CODES = [
  "version.conflict",
  "auth.denied",
  "gate.denied",
  "budget.exhausted",
  "idempotency.mismatch",
  "stage.output_invalid",
  "usage.uncertain",
  "storage.format_unsupported",
  "input.invalid",
  "input.not_found",
  "dependency.unavailable",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Structured details attached to an error. Values must be disclosure-safe. */
export type ErrorDetails = Readonly<Record<string, unknown>>;

/** The frozen envelope returned to a caller. */
export interface ErrorEnvelope {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;
  readonly diagnosticId: string;
}

function isFrozenCode(code: string): code is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(code);
}

/** The base error every module raises, in the frozen envelope shape. */
export class ContractError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, details: ErrorDetails = {}) {
    if (!isFrozenCode(code)) {
      throw new Error(`error code outside the frozen set: ${String(code)}`);
    }
    super(code);
    this.name = "ContractError";
    this.code = code;
    this.details = details;
  }

  /** The frozen envelope. A fresh diagnostic id is minted per envelope. */
  toEnvelope(): ErrorEnvelope {
    return { code: this.code, details: this.details, diagnosticId: randomUUID() };
  }
}

/** Narrows an unknown thrown value to an error carrying a given code. */
export function isErrorWithCode(error: unknown, code: ErrorCode): boolean {
  return error instanceof ContractError && error.code === code;
}
