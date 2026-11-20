// The author-action command journal.
//
// The frozen write order (contracts.md §2 and B.2, frozen 2026-11-19) is
// **idempotency → base revision → business state**, all inside one
// transaction. This module is that order, expressed once so every author
// command inherits it:
//
//   1. a replayed request returns the recorded result without touching state;
//   2. a request whose payload differs from the recorded one for the same key
//      is refused (`idempotency.mismatch`) — a reused key is a client bug, not
//      a second write;
//   3. a stale base revision is refused (`version.conflict`) before any
//      business state changes;
//   4. only then does the command's own work run;
//   5. an injected failure anywhere rolls the whole thing back, so a partial
//      adoption can never be observed after a restart.
//
// Payload comparison is structural: two requests are the same request when
// their payloads are deeply equal, not when they serialise identically.
//
// `executeCommand` puts the frozen command table (`contracts/commands.ts`) in
// front of that order: an unknown name, a subject outside the entry's authority
// list and a missing approval record are refused before the journal is touched,
// and the entry's own flags decide whether the base check runs at all.

import { createHash, randomUUID } from "node:crypto";
import {
  ContractError,
  checkApprovalGate,
  commandAllows,
  commandByName,
  type ApprovalRecord,
  type Subject,
} from "../contracts/index.ts";
import type { ErrorCode, ErrorDetails } from "../contracts/index.ts";
import type { SqliteDatabase } from "./driver.ts";
import { StorageError } from "./errors.ts";
import { stmt } from "./stmt-pool.ts";
import { withWriteTx } from "./tx.ts";

/** A write request as the journal sees it. */
export interface AuthorWriteRequest {
  /** Who is asking. Part of the idempotency identity. */
  readonly actorId: string;
  /** The §2 command name, e.g. `draft.save`. */
  readonly commandId: string;
  /** The business object the command targets. */
  readonly documentId: string;
  /** The caller's idempotency key for this command and object. */
  readonly idempotencyKey: string;
  /** The request payload, structurally compared on replay. */
  readonly payload: unknown;
  /**
   * The revision the caller believes is current, or null when the caller
   * expects the object to have no revision yet.
   */
  readonly baseRevisionId: string | null;
}

/** What a write reports: whether it was a replay, and the recorded result. */
export interface AuthorWriteOutcome<T> {
  readonly replayed: boolean;
  readonly result: T;
}

/** The V2 command-journal schema. Created idempotently. */
const COMMAND_SCHEMA = `
  CREATE TABLE IF NOT EXISTS documents (
    document_id TEXT PRIMARY KEY,
    current_revision_id TEXT
  );
  CREATE TABLE IF NOT EXISTS revisions (
    revision_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS candidates (
    candidate_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(document_id),
    base_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
    body TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS author_decisions (
    decision_id INTEGER PRIMARY KEY,
    actor_id TEXT NOT NULL,
    document_id TEXT NOT NULL REFERENCES documents(document_id),
    candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),
    revision_id TEXT NOT NULL REFERENCES revisions(revision_id)
  );
  CREATE TABLE IF NOT EXISTS command_journal (
    actor_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    request_payload TEXT NOT NULL,
    request_hash TEXT NOT NULL DEFAULT '',
    result_payload TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (actor_id, command_id, document_id, request_key)
  );
`;

/** Creates the command-journal tables. Safe to run on every open. */
export function createCommandSchema(db: SqliteDatabase): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(COMMAND_SCHEMA);
  const cols = new Set(
    (db.prepare("PRAGMA table_info(command_journal);").all() as readonly { name?: unknown }[])
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
  if (!cols.has("request_hash")) {
    db.exec("ALTER TABLE command_journal ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';");
  }
  if (!cols.has("created_at")) {
    db.exec("ALTER TABLE command_journal ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS command_journal_created_at ON command_journal(created_at);
    CREATE INDEX IF NOT EXISTS revisions_by_document_created ON revisions(document_id, created_at);
    CREATE INDEX IF NOT EXISTS candidates_by_document ON candidates(document_id);
  `);
}

/**
 * Canonical JSON: object keys sorted at every level, so two deeply equal
 * payloads always produce the same string and a reordered one still matches.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Structural equality through canonical JSON. */
export function payloadEquals(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

const LARGE_JOURNAL_FIELDS: ReadonlySet<string> = new Set([
  "body",
  "mergedBody",
  "sourceText",
  "files",
]);

/**
 * Replaces huge text/file fields with a compact SHA-256 + length digest so
 * `command_journal` never suffers body write amplification (DB-02).
 */
function stripLargePayloadFields(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const source = payload as Record<string, unknown>;
  let stripped = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (LARGE_JOURNAL_FIELDS.has(key) && value !== null) {
      const serialized = typeof value === "string" ? value : canonicalJson(value);
      out[key] = {
        $sha256: createHash("sha256").update(serialized).digest("hex"),
        $len: serialized.length,
      };
      stripped = true;
    } else {
      out[key] = value;
    }
  }
  return stripped ? out : payload;
}

function readCurrentRevisionId(db: SqliteDatabase, documentId: string): string | null {
  const row = stmt(db, "SELECT current_revision_id FROM documents WHERE document_id = ?;").get(documentId);
  if (row === null || row === undefined) {
    throw new StorageError("input.not_found", { objectType: "document", objectId: documentId });
  }
  const value = (row as { current_revision_id?: unknown }).current_revision_id;
  return typeof value === "string" ? value : null;
}

interface JournalRow {
  readonly request_payload: string;
  readonly request_hash: string;
  readonly result_payload: string;
}

function hashCanonicalPayload(canonicalPayload: string): string {
  return createHash("sha256").update(canonicalPayload).digest("hex");
}

function readJournalRow(
  db: SqliteDatabase,
  request: AuthorWriteRequest,
): JournalRow | null {
  const row = stmt(
    db,
    `SELECT request_payload, request_hash, result_payload FROM command_journal
     WHERE actor_id = ? AND command_id = ? AND document_id = ? AND request_key = ?;`,
  ).get(request.actorId, request.commandId, request.documentId, request.idempotencyKey);
  if (row === null || row === undefined) return null;
  const value = row as Partial<JournalRow>;
  if (
    typeof value.request_payload !== "string" ||
    typeof value.result_payload !== "string" ||
    (value.request_hash !== undefined && typeof value.request_hash !== "string")
  ) {
    throw new StorageError("storage.format_unsupported", { reason: "journal-row-malformed" });
  }
  return {
    request_payload: value.request_payload,
    request_hash: value.request_hash ?? "",
    result_payload: value.result_payload,
  };
}

/**
 * Runs one author write through the frozen order inside a single
 * transaction. `apply` performs the command's own work and returns a
 * JSON-serialisable result, which the journal records for replay.
 *
 * `options.baseCheck` defaults to true, which is the order the base-checking
 * commands inherit. A command whose frozen entry declares no base check
 * (`run.start`, `setting.decide`) passes false, so a request is never refused
 * for a base revision the command does not validate.
 *
 * `options.auditOnly` (DB-02 / Res#11): for non-idempotent commands that get a
 * fresh UUID key per request and can never replay, writes only lightweight
 * audit metadata (`request_payload = ''`, `request_hash = sha256`, compact
 * result summary) to eliminate body write amplification.
 */
export function runAuthorWrite<T>(
  db: SqliteDatabase,
  request: AuthorWriteRequest,
  apply: () => T,
  options?: { readonly baseCheck?: boolean; readonly auditOnly?: boolean },
): AuthorWriteOutcome<T> {
  const withBaseCheck = options?.baseCheck ?? true;
  const auditOnly = options?.auditOnly ?? false;
  const payloadJson = canonicalJson(request.payload);
  const requestHash = hashCanonicalPayload(payloadJson);
  const leanPayload = auditOnly ? null : stripLargePayloadFields(request.payload);

  return withWriteTx(db, () => {
    // 1. Idempotency first: a replay never reaches the base check.
    if (!auditOnly) {
      const prior = readJournalRow(db, request);
      if (prior) {
        const hashMismatch = prior.request_hash.length > 0 && prior.request_hash !== requestHash;
        let payloadMismatch = false;
        if (prior.request_hash.length === 0) {
          payloadMismatch = prior.request_payload.length > 0
            ? !payloadEquals(JSON.parse(prior.request_payload) as unknown, request.payload)
            : true;
        } else if (prior.request_payload.length > 0) {
          const parsedPrior = JSON.parse(prior.request_payload) as unknown;
          payloadMismatch =
            !payloadEquals(parsedPrior, leanPayload) &&
            !payloadEquals(parsedPrior, request.payload);
        }
        if (hashMismatch || payloadMismatch) {
          throw new StorageError("idempotency.mismatch", {
            command: request.commandId,
            target: request.documentId,
          });
        }
        const result = JSON.parse(prior.result_payload) as T;
        return { replayed: true, result };
      }
    }

    // 2. Base revision, before any business state changes.
    if (withBaseCheck) {
      const current = readCurrentRevisionId(db, request.documentId);
      if (current !== request.baseRevisionId) {
        throw new StorageError("version.conflict", {
          documentId: request.documentId,
          baseRevisionId: request.baseRevisionId,
          currentRevisionId: current,
        });
      }
    }

    // 3. The command's own work.
    const result = apply();

    // 4. Record for replay (lean payload for idempotent commands; audit-only metadata for non-idempotent).
    const storedRequestPayload = auditOnly ? "" : canonicalJson(leanPayload);
    const rawResultJson = canonicalJson(result);
    const storedResultPayload =
      auditOnly && rawResultJson.length > 512
        ? canonicalJson({ $auditOnly: true, $sha256: hashCanonicalPayload(rawResultJson), $len: rawResultJson.length })
        : rawResultJson;

    stmt(
      db,
      `INSERT INTO command_journal
         (actor_id, command_id, document_id, request_key, request_payload, request_hash, result_payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    ).run(
      request.actorId,
      request.commandId,
      request.documentId,
      request.idempotencyKey,
      storedRequestPayload,
      requestHash,
      storedResultPayload,
      Date.now(),
    );
    return { replayed: false, result };
  });
}

export interface JournalPruneOptions {
  readonly nowMs?: number;
  readonly compactAfterMs?: number;
  readonly deleteAfterMs?: number;
  readonly keepRecentPerDocument?: number;
}

/**
 * Tiered pruning for `command_journal`: compacts old request payloads while
 * preserving `request_hash` for replay validation, then deletes expired
 * non-critical entries beyond the per-document retention floor.
 */
export function pruneCommandJournal(
  db: SqliteDatabase,
  options: JournalPruneOptions = {},
): { readonly compacted: number; readonly deleted: number } {
  const nowMs = options.nowMs ?? Date.now();
  const compactAfterMs = options.compactAfterMs ?? 7 * 86_400_000;
  const deleteAfterMs = options.deleteAfterMs ?? 30 * 86_400_000;
  const keepRecent = Math.max(0, Math.floor(options.keepRecentPerDocument ?? 50));

  return withWriteTx(db, () => {
    const compactCutoff = nowMs - compactAfterMs;
    const deleteCutoff = nowMs - deleteAfterMs;

    const compacted = stmt(
      db,
      `UPDATE command_journal
       SET request_payload = ''
       WHERE created_at > 0 AND created_at < ? AND request_hash != '' AND length(request_payload) > 0;`,
    ).run(compactCutoff).changes;

    const deleted = stmt(
      db,
      `DELETE FROM command_journal
       WHERE created_at > 0
         AND created_at < ?
         AND command_id NOT IN ('article.deliver', 'draft.finalize')
         AND rowid NOT IN (
           SELECT rowid FROM (
             SELECT rowid, ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY created_at DESC, rowid DESC) AS rn
             FROM command_journal
           )
           WHERE rn <= ?
         );`,
    ).run(deleteCutoff, keepRecent).changes;

    return { compacted, deleted };
  });
}

export interface RevisionCompactOptions {
  readonly nowMs?: number;
  readonly retainRawAfterMs?: number;
  readonly projectId?: string;
  readonly documentId?: string;
  readonly dryRun?: boolean;
}

export interface RevisionCompactResult {
  readonly examined: number;
  readonly deleted: number;
  readonly kept: number;
  readonly dryRun: boolean;
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?;").get(table));
}

/**
 * Compacts redundant intra-day auto-save revisions older than 7 days (DB-18 / Res#10)
 * while strictly preserving every current, finalized, adopted, approved, delivered,
 * evidenced, run-base, proposal-base, memory-synced, recent (<7d), and daily-latest revision.
 */
export function compactAutoSaveRevisions(
  db: SqliteDatabase,
  options: RevisionCompactOptions = {},
): RevisionCompactResult {
  const nowMs = options.nowMs ?? Date.now();
  const retainRawAfterMs = options.retainRawAfterMs ?? 7 * 86_400_000;
  const cutoff = nowMs - retainRawAfterMs;
  const dryRun = options.dryRun === true;

  return withWriteTx(db, () => {
    const protectedIds = new Set<string>();
    const collect = (sql: string) => {
      const rows = db.prepare(sql).all() as readonly { rev?: unknown }[];
      for (const row of rows) {
        if (typeof row.rev === "string" && row.rev.length > 0) protectedIds.add(row.rev);
      }
    };

    collect("SELECT current_revision_id AS rev FROM documents WHERE current_revision_id IS NOT NULL;");
    collect("SELECT base_revision_id AS rev FROM candidates WHERE base_revision_id IS NOT NULL;");
    collect("SELECT revision_id AS rev FROM author_decisions WHERE revision_id IS NOT NULL;");
    if (tableExists(db, "deliveries")) {
      collect("SELECT final_revision_id AS rev FROM deliveries WHERE final_revision_id IS NOT NULL;");
    }
    if (tableExists(db, "author_documents")) {
      collect("SELECT final_revision_id AS rev FROM author_documents WHERE final_revision_id IS NOT NULL;");
    }
    if (tableExists(db, "author_approvals")) {
      collect("SELECT revision_id AS rev FROM author_approvals WHERE revision_id IS NOT NULL;");
    }
    if (tableExists(db, "author_evidence")) {
      collect("SELECT revision_id AS rev FROM author_evidence WHERE revision_id IS NOT NULL;");
    }
    if (tableExists(db, "author_runs")) {
      collect("SELECT base_revision_id AS rev FROM author_runs WHERE base_revision_id IS NOT NULL;");
    }
    if (tableExists(db, "author_chapter_memory_sync")) {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(author_chapter_memory_sync);").all() as readonly { name?: unknown }[])
          .map((row) => row.name)
          .filter((name): name is string => typeof name === "string"),
      );
      if (cols.has("synced_revision_id")) {
        collect("SELECT synced_revision_id AS rev FROM author_chapter_memory_sync WHERE synced_revision_id IS NOT NULL;");
      }
    }
    if (tableExists(db, "author_ai_proposals")) {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(author_ai_proposals);").all() as readonly { name?: unknown }[])
          .map((row) => row.name)
          .filter((name): name is string => typeof name === "string"),
      );
      if (cols.has("base_revision_id")) {
        collect("SELECT base_revision_id AS rev FROM author_ai_proposals WHERE base_revision_id IS NOT NULL;");
      }
    }

    let rows: readonly { revision_id: string; document_id: string; created_at: number }[];
    if (options.documentId) {
      rows = db.prepare(`
        SELECT revision_id, document_id, created_at
        FROM revisions
        WHERE document_id = ?
        ORDER BY document_id ASC, created_at DESC, rowid DESC;
      `).all(options.documentId) as readonly { revision_id: string; document_id: string; created_at: number }[];
    } else if (options.projectId && tableExists(db, "author_documents")) {
      rows = db.prepare(`
        SELECT r.revision_id, r.document_id, r.created_at
        FROM revisions r
        JOIN author_documents a ON a.id = r.document_id
        WHERE a.project_id = ?
        ORDER BY r.document_id ASC, r.created_at DESC, r.rowid DESC;
      `).all(options.projectId) as readonly { revision_id: string; document_id: string; created_at: number }[];
    } else {
      rows = db.prepare(`
        SELECT revision_id, document_id, created_at
        FROM revisions
        ORDER BY document_id ASC, created_at DESC, rowid DESC;
      `).all() as readonly { revision_id: string; document_id: string; created_at: number }[];
    }

    const keptDailyKeys = new Set<string>();
    const toDelete: string[] = [];

    for (const row of rows) {
      if (protectedIds.has(row.revision_id) || row.created_at >= cutoff) {
        continue;
      }
      const dayBucket = Math.floor(row.created_at / 86_400_000);
      const dailyKey = `${row.document_id}\0${dayBucket}`;
      if (!keptDailyKeys.has(dailyKey)) {
        keptDailyKeys.add(dailyKey);
        continue;
      }
      toDelete.push(row.revision_id);
    }

    if (!dryRun && toDelete.length > 0) {
      const delStmt = stmt(db, "DELETE FROM revisions WHERE revision_id = ?;");
      for (const revisionId of toDelete) {
        delStmt.run(revisionId);
      }
    }

    return {
      examined: rows.length,
      deleted: toDelete.length,
      kept: rows.length - toDelete.length,
      dryRun,
    };
  });
}

/** Creates a document with no revision yet. */
export function createDocument(db: SqliteDatabase, documentId: string): void {
  stmt(db, "INSERT INTO documents (document_id) VALUES (?);").run(documentId);
}

/** Creates a candidate revision for a document, bound to its base revision. */
export function createCandidate(
  db: SqliteDatabase,
  candidate: {
    readonly candidateId: string;
    readonly documentId: string;
    readonly baseRevisionId: string;
    readonly body: string;
  },
): void {
  stmt(
    db,
    "INSERT INTO candidates (candidate_id, document_id, base_revision_id, body) VALUES (?, ?, ?, ?);",
  ).run(candidate.candidateId, candidate.documentId, candidate.baseRevisionId, candidate.body);
}

/** The revision a document currently points at, or null when it has none. */
export function currentRevision(
  db: SqliteDatabase,
  documentId: string,
): { revision_id: string; body: string } | null {
  const row = stmt(
    db,
    `SELECT revisions.revision_id AS revision_id, revisions.body AS body
     FROM documents JOIN revisions USING (document_id)
     WHERE documents.document_id = ? AND revisions.revision_id = documents.current_revision_id;`,
  ).get(documentId);
  if (row === null || row === undefined) return null;
  const value = row as { revision_id?: unknown; body?: unknown };
  if (typeof value.revision_id !== "string" || typeof value.body !== "string") return null;
  return { revision_id: value.revision_id, body: value.body };
}

/** Appends a revision and moves the document pointer, inside `apply`. */
export function appendRevision(
  db: SqliteDatabase,
  revision: {
    readonly revisionId: string;
    readonly documentId: string;
    readonly body: string;
    readonly createdAt: number;
  },
): { revisionId: string } {
  stmt(
    db,
    "INSERT INTO revisions (revision_id, document_id, body, created_at) VALUES (?, ?, ?, ?);",
  ).run(revision.revisionId, revision.documentId, revision.body, revision.createdAt);
  stmt(db, "UPDATE documents SET current_revision_id = ? WHERE document_id = ?;").run(
    revision.revisionId,
    revision.documentId,
  );
  return { revisionId: revision.revisionId };
}

/** `draft.save`: the author's own edit becomes a new revision. */
export function saveDraft(
  db: SqliteDatabase,
  request: {
    readonly actorId: string;
    readonly documentId: string;
    readonly idempotencyKey: string;
    readonly baseRevisionId: string | null;
    readonly body: string;
  },
  generated: { readonly revisionId: string; readonly createdAt: number },
): { replayed: boolean; revisionId: string } {
  const outcome = runAuthorWrite(
    db,
    {
      actorId: request.actorId,
      commandId: "draft.save",
      documentId: request.documentId,
      idempotencyKey: request.idempotencyKey,
      payload: { body: request.body },
      baseRevisionId: request.baseRevisionId,
    },
    () =>
      appendRevision(db, {
        revisionId: generated.revisionId,
        documentId: request.documentId,
        body: request.body,
        createdAt: generated.createdAt,
      }),
  );
  return { replayed: outcome.replayed, revisionId: outcome.result.revisionId };
}

/** `candidate.adopt`: a candidate's body becomes a revision, as the author. */
export function adoptCandidate(
  db: SqliteDatabase,
  request: {
    readonly actorId: string;
    readonly documentId: string;
    readonly candidateId: string;
    readonly baseRevisionId: string;
    readonly idempotencyKey: string;
  },
  generated: { readonly revisionId: string; readonly createdAt: number },
): { replayed: boolean; revisionId: string } {
  const outcome = runAuthorWrite(
    db,
    {
      actorId: request.actorId,
      commandId: "candidate.adopt",
      documentId: request.documentId,
      idempotencyKey: request.idempotencyKey,
      payload: { baseRevisionId: request.baseRevisionId, candidateId: request.candidateId },
      baseRevisionId: request.baseRevisionId,
    },
    () => {
      const candidate = db
        .prepare("SELECT body, base_revision_id FROM candidates WHERE candidate_id = ? AND document_id = ?;")
        .get(request.candidateId, request.documentId);
      if (candidate === null || candidate === undefined) {
        throw new StorageError("input.not_found", {
          objectType: "candidate",
          objectId: request.candidateId,
        });
      }
      const value = candidate as { body?: unknown; base_revision_id?: unknown };
      if (typeof value.body !== "string") {
        throw new StorageError("storage.format_unsupported", { reason: "candidate-row-malformed" });
      }
      if (value.base_revision_id !== request.baseRevisionId) {
        // The candidate was produced against a different revision than the
        // one the author is adopting from, so adopting it would silently
        // drop whatever changed in between.
        throw new StorageError("version.conflict", {
          documentId: request.documentId,
          baseRevisionId: request.baseRevisionId,
          currentRevisionId: value.base_revision_id,
        });
      }
      const appended = appendRevision(db, {
        revisionId: generated.revisionId,
        documentId: request.documentId,
        body: value.body,
        createdAt: generated.createdAt,
      });
      db.prepare(
        `INSERT INTO author_decisions (actor_id, document_id, candidate_id, revision_id)
         VALUES (?, ?, ?, ?);`,
      ).run(request.actorId, request.documentId, request.candidateId, appended.revisionId);
      return appended;
    },
  );
  return { replayed: outcome.replayed, revisionId: outcome.result.revisionId };
}

const VALID_TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Row counts, for tests that assert nothing was half-committed. */
export function rowCount(db: SqliteDatabase, table: string): number {
  if (!VALID_TABLE_NAME.test(table)) {
    throw new StorageError("input.invalid", { field: "table", reason: "invalid-table-name" });
  }
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table};`).get();
  const value = (row as { count?: unknown }).count;
  return typeof value === "number" ? value : 0;
}

/** What a command reports, in the one envelope shape §2 demands. */
export interface CommandOutcome<T> {
  readonly ok: boolean;
  /** The frozen code, or null on success. */
  readonly code: ErrorCode | null;
  /** Only the fields the disclosure table allows for this code. */
  readonly details?: ErrorDetails;
  readonly result?: T;
  /** Whether the result came from the journal rather than fresh work. */
  readonly replayed?: boolean;
}

/** One command request, as the dispatcher sees it. */
export interface CommandRequest {
  /** The §2 command name. */
  readonly commandId: string;
  /** The subject the Host resolved, never a caller claim. */
  readonly actor: Subject;
  /** Optional rich actor identifier for journal audit trail (DSH-04). */
  readonly actorId?: string;
  /** The object the command targets. */
  readonly documentId: string;
  /** The caller's idempotency key, for the commands whose entry declares one. */
  readonly idempotencyKey?: string;
  /** The request payload, structurally compared on replay. */
  readonly payload: unknown;
  /** The revision the caller believes is current. */
  readonly baseRevisionId: string | null;
  /** The approval record, for the commands whose entry declares a gate. */
  readonly approval?: ApprovalRecord | null;
  /**
   * The object version the command operates on, which an approval record must
   * name. Defaults to the base revision; a command that versions something else
   * (a delivery versions the revision it delivers, not the one it starts from)
   * passes it explicitly.
   */
  readonly targetVersion?: string;
}

/**
 * Runs one command through the frozen alignment and then the frozen write
 * order.
 *
 * The checks run in the order `commandPlan` derives from the entry's flags:
 * an unknown name, a subject outside the authority list and a missing approval
 * record are refused before the journal is touched, so a refused command leaves
 * no row behind. The entry's own `baseCheck` flag then decides whether the base
 * revision is validated at all.
 *
 * A command whose entry declares no idempotency key gets a generated one and
 * records only lightweight audit metadata (DB-02 / Res#11).
 */
export function executeCommand<T>(
  db: SqliteDatabase,
  request: CommandRequest,
  apply: () => T,
): CommandOutcome<T> {
  const entry = commandByName(request.commandId);
  if (!entry) {
    return {
      ok: false,
      code: "input.invalid",
      details: { field: "commandId", reason: "unknown-command" },
    };
  }
  if (!commandAllows(request.commandId, request.actor)) {
    return { ok: false, code: "auth.denied", details: { action: request.commandId, actor: request.actor } };
  }
  if (entry.approvalGate) {
    const refusal = checkApprovalGate({
      record: request.approval,
      actor: request.actor,
      action: request.commandId,
      target: request.documentId,
      targetVersion: request.targetVersion ?? request.baseRevisionId ?? "",
    });
    if (refusal) {
      return { ok: false, code: refusal.code, details: refusal.details };
    }
  }

  let idempotencyKey = request.idempotencyKey;
  let auditOnly = false;
  if (!entry.idempotent) {
    idempotencyKey = randomUUID();
    auditOnly = true;
  } else if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return {
      ok: false,
      code: "input.invalid",
      details: { field: "idempotencyKey", reason: "required" },
    };
  }
  try {
    const outcome = runAuthorWrite(
      db,
      {
        actorId: request.actorId ?? request.actor,
        commandId: request.commandId,
        documentId: request.documentId,
        idempotencyKey,
        payload: request.payload,
        baseRevisionId: request.baseRevisionId,
      },
      apply,
      { baseCheck: entry.baseCheck, auditOnly },
    );
    return { ok: true, code: null, result: outcome.result, replayed: outcome.replayed };
  } catch (error) {
    // Any frozen-code error the command's own work raises — a business-state
    // gate as much as a storage refusal — becomes its envelope, so a caller
    // branches on the code alone. Anything else is a bug and propagates.
    if (error instanceof ContractError) {
      return { ok: false, code: error.code, details: error.details };
    }
    throw error;
  }
}
