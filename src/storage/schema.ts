// The schema version window (contracts.md B.10, frozen 2026-11-19).
//
// A store records one schema id in its `meta` table. Opening accepts only the
// ids inside the V2 window: the whole V2 major, `zhizhang/2.x`. Anything
// outside that major — a future 3.0, or any v1.x id — is refused with
// `storage.format_unsupported`, never migrated and never half-served. V2 only
// ever moves forward inside its own major.

import { StorageError } from "./errors.ts";

/** The schema id a newly created store records. */
export const SCHEMA_ID = "zhizhang/2.0";

/** The window: any `zhizhang/2.<minor>` id opens, and nothing else does. */
export const SCHEMA_WINDOW = /^zhizhang\/2\.\d+$/;

/** Whether an id read from a store is inside the V2 window. */
export function isSupportedSchema(schemaId: string): boolean {
  return schemaId === SCHEMA_ID || SCHEMA_WINDOW.test(schemaId);
}

/** Refuses an id outside the window, carrying the frozen details shape. */
export function assertSupportedSchema(schemaId: string): void {
  if (isSupportedSchema(schemaId)) return;
  throw new StorageError("storage.format_unsupported", {
    reason: "schema-unsupported",
    schemaId,
    supported: [SCHEMA_ID],
  });
}
