// The storage layer's error type.
//
// The envelope shape and the closed code set are frozen in contracts.md §2 and
// B.1 and live in `contracts/errors.ts`, because every module raises these
// codes. `StorageError` is the storage layer's name for the same thing, so a
// caller can tell a persistence refusal from a workflow or domain one without
// matching on a code string.

import { ContractError } from "../contracts/errors.ts";
import type { ErrorCode, ErrorDetails } from "../contracts/errors.ts";

export { ERROR_CODES } from "../contracts/errors.ts";
export type { ErrorCode, ErrorDetails, ErrorEnvelope } from "../contracts/errors.ts";

/** A storage refusal, in the frozen envelope shape. */
export class StorageError extends ContractError {
  constructor(code: ErrorCode, details: ErrorDetails = {}) {
    super(code, details);
    this.name = "StorageError";
  }
}

/** Narrows an unknown thrown value to a storage error carrying a given code. */
export function isStorageErrorWithCode(error: unknown, code: ErrorCode): boolean {
  return error instanceof StorageError && error.code === code;
}
