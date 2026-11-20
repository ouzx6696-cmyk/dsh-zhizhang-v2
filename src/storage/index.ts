// The storage module's public surface.
//
// Only the contracts frozen in the v2.0 plan (contracts.md B.1, B.10) are
// exported here. The driver itself is deliberately not part of this surface:
// Q-05 (which SQLite driver the shipped Bundle uses) is still an open author
// decision, so callers go through `openDatabase` and never name a driver.

export {
  ERROR_CODES,
  StorageError,
  isStorageErrorWithCode,
  type ErrorCode,
  type ErrorDetails,
  type ErrorEnvelope,
} from "./errors.ts";

export {
  SCHEMA_ID,
  SCHEMA_WINDOW,
  isSupportedSchema,
  assertSupportedSchema,
} from "./schema.ts";

export { openDatabase, type SqliteDatabase, type SqliteParameter, type SqliteStatement } from "./driver.ts";

export { createStore, createStoreIn, openStore, readSchemaId } from "./store.ts";

export {
  createCommandSchema,
  runAuthorWrite,
  canonicalJson,
  payloadEquals,
  createDocument,
  createCandidate,
  currentRevision,
  appendRevision,
  saveDraft,
  adoptCandidate,
  rowCount,
  executeCommand,
  type AuthorWriteOutcome,
  type AuthorWriteRequest,
  type CommandOutcome,
  type CommandRequest,
} from "./command.ts";

export {
  createEventLogSchema,
  currentSeq,
  appendEvent,
  readEvents,
  createCursor,
  type BackfillEvent,
  type BackfillResult,
  type Cursor,
  type LoggedEvent,
  type SnapshotCut,
} from "./eventlog.ts";

export {
  createProjectionSchema,
  createProjectionStore,
  readTail,
  projectWatermark,
  type CheckpointRow,
  type ProjectionChange,
  type ProjectionCut,
  type ProjectionStore,
  type ProjectionUnit,
} from "./projection.ts";

export {
  createBackup,
  verifyBackup,
  isBackupValid,
  restoreBackup,
  planRetention,
  listBackups,
  pruneBackups,
  PROPOSED_BACKUP_RETENTION,
  type BackupDescriptor,
  type BackupEntry,
  type BackupManifest,
  type RetentionPlan,
} from "./backup.ts";

export {
  EXPORT_STATES,
  createDeliverySchema,
  commitDelivery,
  insertDeliveryRow,
  exportPayload,
  attemptExport,
  pendingExports,
  reconcileExports,
  type Delivery,
  type ExportAttempt,
  type ExportReconciliation,
  type ExportState,
} from "./export.ts";

export {
  deliverArticle,
  type DeliverArticleOutcome,
  type DeliverArticleRequest,
  type ExportWriter,
} from "./delivery.ts";

export { stmt, configureStorePragmas } from "./stmt-pool.ts";

export {
  createFtsSchema,
  deleteLibraryFts,
  rebuildProjectFts,
  searchWorkspaceFts,
  syncChapterFts,
  syncLibraryFts,
  syncLoreFts,
  type FtsSearchHit,
  type FtsSearchScope,
} from "./fts.ts";

export {
  assertSafeRelativePath,
  parseChapterMarkdown,
  sanitizePathSegment,
  serializeChapterMarkdown,
  writeLocalBundleToDir,
  type BundleFileInput,
  type ChapterMarkdownFrontmatter,
} from "./local-io.ts";
