// The storage module's public surface.
//
// Only the contracts frozen in the v2.0 plan (contracts.md B.1, B.10) and
// V2.3 storage primitives are exported here. Callers open connections through
// `openDatabase` and never name a concrete driver directly.

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
  SCHEMA_USER_VERSION,
  SCHEMA_WINDOW,
  isSupportedSchema,
  assertSupportedSchema,
} from "./schema.ts";

export {
  openDatabase,
  runOnlineBackup,
  type OpenDatabaseOptions,
  type SqliteDatabase,
  type SqliteParameter,
  type SqliteStatement,
} from "./driver.ts";

export {
  createStore,
  createStoreIn,
  openStore,
  readSchemaId,
  readDatabaseUuid,
} from "./store.ts";

export {
  createCommandSchema,
  runAuthorWrite,
  pruneCommandJournal,
  compactAutoSaveRevisions,
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
  type JournalPruneOptions,
  type RevisionCompactOptions,
  type RevisionCompactResult,
} from "./command.ts";

export {
  createEventLogSchema,
  currentSeq,
  globalEventSeq,
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
  createHotBackup,
  verifyBackup,
  isBackupValid,
  restoreBackup,
  backupWorkspace,
  restoreWorkspace,
  planRetention,
  listBackups,
  listBackupDetails,
  clearBackupVerificationCache,
  pruneBackups,
  PROPOSED_BACKUP_RETENTION,
  type BackupDescriptor,
  type BackupDetailDescriptor,
  type BackupEntry,
  type BackupManifest,
  type BackupOptions,
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

export {
  MAX_STMT_CACHE_SIZE,
  stmt,
  statementCacheSize,
  clearStatementCache,
  configureStorePragmas,
  optimizeDatabase,
  checkpointDatabase,
  readStorePragmas,
  type StorePragmaSnapshot,
} from "./stmt-pool.ts";

export { withReadTx, withWriteTx, inTransaction } from "./tx.ts";

export {
  runMigrations,
  appliedMigrations,
  type SchemaMigration,
} from "./migrations.ts";

export {
  createCoreSchema,
  SORT_KEY_STEP,
  computeSortKeyBetween,
  inferEventConcern,
  auditEventLogConcerns,
  type EventLogConcernAudit,
} from "./core-schema.ts";

export {
  createJobLedger,
  type CallCacheMeta,
  type CreateJobInput,
  type JobCallRecord,
  type JobLedger,
  type JobRecord,
  type LedgerJobKind,
  type MicroUsageAggregate,
  type OpenJobRecord,
  type UsageConsistencyIssue,
} from "./job-ledger.ts";

export {
  createFtsSchema,
  deleteLibraryFts,
  optimizeFts,
  rebuildAllFts,
  rebuildProjectFts,
  searchRelatedChaptersByFts,
  searchWorkspaceFts,
  syncChapterFts,
  syncLibraryFts,
  syncLoreFts,
  verifyFtsIntegrity,
  type FtsSearchHit,
  type FtsSearchScope,
} from "./fts.ts";

export {
  assertSafeRelativePath,
  parseChapterMarkdown,
  renameWithRetry,
  sanitizePathSegment,
  serializeChapterMarkdown,
  writeLocalBundleToDir,
  type BundleFileInput,
  type ChapterMarkdownFrontmatter,
} from "./local-io.ts";
