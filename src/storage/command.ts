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

import { randomUUID } from "node:crypto";
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
    result_payload TEXT NOT NULL,
    PRIMARY KEY (actor_id, command_id, document_id, request_key)
  );
`;

/** Creates the command-journal tables. Safe to run on every open. */
export function createCommandSchema(db: SqliteDatabase): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(COMMAND_SCHEMA);
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

function readCurrentRevisionId(db: SqliteDatabase, documentId: string): string | null {
  const row = db.prepare("SELECT current_revision_id FROM documents WHERE document_id = ?;").get(documentId);
  if (row === null || row === undefined) {
    throw new StorageError("input.not_found", { objectType: "document", objectId: documentId });
  }
  const value = (row as { current_revision_id?: unknown }).current_revision_id;
  return typeof value === "string" ? value : null;
}

interface JournalRow {
  readonly request_payload: string;
  readonly result_payload: string;
}

function readJournalRow(
  db: SqliteDatabase,
  request: AuthorWriteRequest,
): JournalRow | null {
  const row = db
    .prepare(
      `SELECT request_payload, result_payload FROM command_journal
       WHERE actor_id = ? AND command_id = ? AND document_id = ? AND request_key = ?;`,
    )
    .get(request.actorId, request.commandId, request.documentId, request.idempotencyKey);
  if (row === null || row === undefined) return null;
  const value = row as Partial<JournalRow>;
  if (typeof value.request_payload !== "string" || typeof value.result_payload !== "string") {
    throw new StorageError("storage.format_unsupported", { reason: "journal-row-malformed" });
  }
  return { request_payload: value.request_payload, result_payload: value.result_payload };
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
 */
export function runAuthorWrite<T>(
  db: SqliteDatabase,
  request: AuthorWriteRequest,
  apply: () => T,
  options?: { readonly baseCheck?: boolean },
): AuthorWriteOutcome<T> {
  const withBaseCheck = options?.baseCheck ?? true;
  db.exec("BEGIN IMMEDIATE");
  try {
    // 1. Idempotency first: a replay never reaches the base check.
    const prior = readJournalRow(db, request);
    if (prior) {
      if (!payloadEquals(JSON.parse(prior.request_payload) as unknown, request.payload)) {
        throw new StorageError("idempotency.mismatch", {
          command: request.commandId,
          target: request.documentId,
        });
      }
      const result = JSON.parse(prior.result_payload) as T;
      db.exec("COMMIT");
      return { replayed: true, result };
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

    // 4. Record for replay.
    db.prepare(
      `INSERT INTO command_journal
         (actor_id, command_id, document_id, request_key, request_payload, result_payload)
       VALUES (?, ?, ?, ?, ?, ?);`,
    ).run(
      request.actorId,
      request.commandId,
      request.documentId,
      request.idempotencyKey,
      canonicalJson(request.payload),
      canonicalJson(result),
    );
    db.exec("COMMIT");
    return { replayed: false, result };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed rollback is reported through the original failure: the
      // caller must not assume the store is in any particular state.
    }
    throw error;
  }
}

/** Creates a document with no revision yet. */
export function createDocument(db: SqliteDatabase, documentId: string): void {
  db.prepare("INSERT INTO documents (document_id) VALUES (?);").run(documentId);
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
  db.prepare(
    "INSERT INTO candidates (candidate_id, document_id, base_revision_id, body) VALUES (?, ?, ?, ?);",
  ).run(candidate.candidateId, candidate.documentId, candidate.baseRevisionId, candidate.body);
}

/** The revision a document currently points at, or null when it has none. */
export function currentRevision(
  db: SqliteDatabase,
  documentId: string,
): { revision_id: string; body: string } | null {
  const row = db
    .prepare(
      `SELECT revisions.revision_id AS revision_id, revisions.body AS body
       FROM documents JOIN revisions USING (document_id)
       WHERE documents.document_id = ? AND revisions.revision_id = documents.current_revision_id;`,
    )
    .get(documentId);
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
  db.prepare(
    "INSERT INTO revisions (revision_id, document_id, body, created_at) VALUES (?, ?, ?, ?);",
  ).run(revision.revisionId, revision.documentId, revision.body, revision.createdAt);
  db.prepare("UPDATE documents SET current_revision_id = ? WHERE document_id = ?;").run(
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

/** Row counts, for tests that assert nothing was half-committed. */
export function rowCount(db: SqliteDatabase, table: string): number {
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
 * A command whose entry declares no idempotency key gets a generated one, so
 * each request is its own journal row: with no key there is nothing for a
 * replay to match, and a repeated request is a second write rather than a
 * replay.
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

  const idempotencyKey =
    entry.idempotent && request.idempotencyKey !== undefined
      ? request.idempotencyKey
      : randomUUID();
  try {
    const outcome = runAuthorWrite(
      db,
      {
        actorId: request.actor,
        commandId: request.commandId,
        documentId: request.documentId,
        idempotencyKey,
        payload: request.payload,
        baseRevisionId: request.baseRevisionId,
      },
      apply,
      { baseCheck: entry.baseCheck },
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
