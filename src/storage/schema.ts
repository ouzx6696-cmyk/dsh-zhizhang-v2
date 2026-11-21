// Schema version window for Next-Gen Zhizhang 3.x.
//
// A store records its schema id in `meta`. Opening accepts only ids within the
// 3.x major window (`zhizhang/3.<minor>`). Anything outside that window is
// refused with `storage.format_unsupported` rather than silently migrated.

import { StorageError } from "./errors.ts";

/** Schema identifier written to newly created stores. */
export const SCHEMA_ID = "zhizhang/3.0";

/** SQLite `PRAGMA user_version` corresponding to `SCHEMA_ID`. */
export const SCHEMA_USER_VERSION = 30;

/** Accepted schema window for this major release. */
export const SCHEMA_WINDOW = /^zhizhang\/3\.\d+$/;

/** Returns true when `schemaId` falls inside the supported 3.x window. */
export function isSupportedSchema(schemaId: string): boolean {
  return schemaId === SCHEMA_ID || SCHEMA_WINDOW.test(schemaId);
}

/** Refuses any schema id outside the supported window. */
export function assertSupportedSchema(schemaId: string): void {
  if (isSupportedSchema(schemaId)) return;
  throw new StorageError("storage.format_unsupported", {
    reason: "schema-unsupported",
    schemaId,
    supported: [SCHEMA_ID],
  });
}
