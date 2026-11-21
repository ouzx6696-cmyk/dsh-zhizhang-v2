// Structured error envelope and closed error code set.
//
// Every domain, workflow, storage, and host error carries a closed `code`,
// disclosure-safe `details`, and a `diagnosticId` that correlates the caller
// response with server-side logs. Adding or changing a code is a contract-level
// decision, so codes outside the closed set are rejected at construction time.
//
// Lives in `contracts/` because every layer raises these codes; the storage
// layer exposes a `StorageError` subclass for clarity.

import { randomUUID } from "node:crypto";

/** Closed error code set shared across all layers. */
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
  readonly diagnosticId: string;

  constructor(code: ErrorCode, details: ErrorDetails = {}) {
    if (!isFrozenCode(code)) {
      throw new Error(`error code outside the frozen set: ${String(code)}`);
    }
    super(code);
    this.name = "ContractError";
    this.code = code;
    this.details = details;
    this.diagnosticId = randomUUID();
  }

  /** The frozen envelope carrying the instance's diagnostic correlation id. */
  toEnvelope(): ErrorEnvelope {
    return { code: this.code, details: this.details, diagnosticId: this.diagnosticId };
  }
}

/** Narrows an unknown thrown value to an error carrying a given code. */
export function isErrorWithCode(error: unknown, code: ErrorCode): boolean {
  return error instanceof ContractError && error.code === code;
}
