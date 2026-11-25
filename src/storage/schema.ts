import { StorageError } from "./errors.ts";

export const SCHEMA_ID = "zhizhang/3.0";
export const SCHEMA_USER_VERSION = 30;

export function isSupportedSchema(schemaId: string): boolean {
  return schemaId === SCHEMA_ID;
}

export function assertSupportedSchema(schemaId: string): void {
  if (isSupportedSchema(schemaId)) return;
  throw new StorageError("storage.format_unsupported", {
    reason: "schema-unsupported",
    schemaId,
    supported: [SCHEMA_ID],
  });
}
