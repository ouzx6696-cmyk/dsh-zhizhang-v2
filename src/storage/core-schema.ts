import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./driver.ts";
import { SCHEMA_ID, SCHEMA_USER_VERSION } from "./schema.ts";

/** Default fractional-index gap between adjacent chapters (`author_documents.sort_key`). */
export const SORT_KEY_STEP = 1024;

/**
 * Computes a fractional `sort_key` strictly between `before` and `after` so
 * moving a chapter updates only a single row in `author_documents`.
 */
export function computeSortKeyBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return SORT_KEY_STEP;
  if (before === null) return (after as number) - SORT_KEY_STEP;
  if (after === null) return before + SORT_KEY_STEP;
  return (before + after) / 2;
}

const VALID_CONCERNS = new Set([
  "chapter",
  "revision",
  "candidate",
  "setting",
  "evidence",
  "run",
  "approval",
]);

/** Infers the read-model concern from a committed event's `kind`. */
export function inferEventConcern(kind: string): string | null {
  if (
    kind.startsWith("project.") ||
    kind.startsWith("document.") ||
    kind.startsWith("chapter.") ||
    kind.startsWith("volume.") ||
    kind.startsWith("act.") ||
    kind.startsWith("library.") ||
    kind.startsWith("foreshadow.") ||
    kind.startsWith("controls.")
  ) {
    return "chapter";
  }
  if (kind.startsWith("revision.")) return "revision";
  if (kind.startsWith("candidate.")) return "candidate";
  if (kind.startsWith("setting.") || kind.startsWith("proposal.") || kind.startsWith("lore.")) {
    return "setting";
  }
  if (kind.startsWith("evidence.") || kind.startsWith("article.") || kind.startsWith("observation.")) {
    return "evidence";
  }
  if (kind.startsWith("run.") || kind.startsWith("generation.") || kind.startsWith("job.") || kind.startsWith("selection.")) {
    return "run";
  }
  if (kind.startsWith("approval.") || kind.startsWith("delivery.")) return "approval";
  return null;
}

export interface EventLogConcernAudit {
  readonly total: number;
  readonly valid: number;
  readonly missingConcern: number;
  readonly invalidConcern: number;
  readonly quarantined: number;
}

function hasTable(db: SqliteDatabase, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?;").get(name));
}

/** Read-only startup/diagnostics audit of `event_log` concern integrity. */
export function auditEventLogConcerns(db: SqliteDatabase): EventLogConcernAudit {
  if (!hasTable(db, "event_log")) {
    return { total: 0, valid: 0, missingConcern: 0, invalidConcern: 0, quarantined: 0 };
  }
  const rows = db.prepare("SELECT payload FROM event_log;").all() as readonly { payload?: unknown }[];
  let valid = 0;
  let missingConcern = 0;
  let invalidConcern = 0;
  for (const row of rows) {
    if (typeof row.payload !== "string") {
      invalidConcern += 1;
      continue;
    }
    try {
      const parsed = JSON.parse(row.payload) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        invalidConcern += 1;
        continue;
      }
      const concern = parsed.concern;
      if (concern === undefined || concern === null || concern === "") {
        missingConcern += 1;
      } else if (typeof concern === "string" && VALID_CONCERNS.has(concern)) {
        valid += 1;
      } else {
        invalidConcern += 1;
      }
    } catch {
      invalidConcern += 1;
    }
  }
  let quarantined = 0;
  if (hasTable(db, "event_log_quarantine")) {
    const q = db.prepare("SELECT COUNT(*) AS count FROM event_log_quarantine;").get() as { count?: number } | undefined;
    quarantined = q?.count ?? 0;
  }
  return { total: rows.length, valid, missingConcern, invalidConcern, quarantined };
}

/**
 * Clean Next-Gen (`zhizhang/3.0`) Core Platform DDL.
 *
 * Owns only product-neutral tables: metadata, projects, documents, planning,
 * runs, the unified async job ledger (`author_jobs` + `author_job_calls`),
 * read-model checkpoints, and event quarantine. Product-line tables live in
 * their own isolated modules (`products/fanqie/schema.ts`, `products/toutiao/`).
 */
export function createCoreSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS author_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      product TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS author_documents (
      id TEXT PRIMARY KEY REFERENCES documents(document_id),
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      mode TEXT,
      line TEXT,
      final_revision_id TEXT,
      editorial_rejections INTEGER NOT NULL DEFAULT 0,
      qa_rounds INTEGER NOT NULL DEFAULT 0,
      volume_id TEXT,
      act_id TEXT,
      char_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      sort_key REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS author_planning (
      document_id TEXT PRIMARY KEY REFERENCES author_documents(id),
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS author_chapter_order (
      project_id TEXT PRIMARY KEY REFERENCES author_projects(id),
      chapter_ids TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS author_runs (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES author_documents(id),
      state TEXT NOT NULL,
      base_revision_id TEXT NOT NULL,
      frozen_input TEXT NOT NULL,
      reserved INTEGER NOT NULL,
      settled INTEGER NOT NULL DEFAULT 0,
      candidate_id TEXT,
      late_usage_settled INTEGER NOT NULL DEFAULT 0,
      context_trace TEXT,
      recovery_hints TEXT
    );

    CREATE TABLE IF NOT EXISTS author_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('draft_generation', 'proposal_extraction', 'selection_rewrite')),
      subtype TEXT NOT NULL DEFAULT '',
      scope_key TEXT NOT NULL DEFAULT '',
      project_id TEXT,
      document_id TEXT,
      run_id TEXT REFERENCES author_runs(id),
      proposal_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'inflight', 'received', 'completed', 'failed', 'cancelled', 'uncertain', 'reconciled')),
      stage TEXT,
      reserved INTEGER NOT NULL DEFAULT 0,
      settled INTEGER NOT NULL DEFAULT 0,
      usage TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(usage)),
      late_usage TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(late_usage)),
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE IF NOT EXISTS author_job_calls (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES author_jobs(id),
      phase TEXT NOT NULL,
      input_reserve INTEGER NOT NULL,
      max_output INTEGER NOT NULL,
      usage TEXT,
      prefix_sha256 TEXT,
      l1_version INTEGER,
      cache_strategy TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE IF NOT EXISTS author_read_checkpoints (
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      cache_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      state TEXT NOT NULL,
      last_used_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, cache_key)
    );

    CREATE TABLE IF NOT EXISTS event_log_quarantine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      reason TEXT NOT NULL,
      quarantined_at INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE IF NOT EXISTS author_workspace_focus (
      id TEXT PRIMARY KEY CHECK (id = 'default'),
      project_id TEXT,
      document_id TEXT,
      view_mode TEXT NOT NULL DEFAULT 'main',
      updated_at INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE IF NOT EXISTS author_session_focus (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES author_projects(id) ON DELETE CASCADE,
      document_id TEXT REFERENCES author_documents(id) ON DELETE SET NULL,
      view_mode TEXT NOT NULL DEFAULT 'conversation',
      updated_at INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE IF NOT EXISTS author_project_collaboration (
      project_id TEXT PRIMARY KEY REFERENCES author_projects(id),
      collaboration_mode TEXT NOT NULL DEFAULT 'cautious' CHECK (collaboration_mode IN ('cautious', 'co_create')),
      agent_prompt_injection INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE IF NOT EXISTS author_agent_writes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      document_id TEXT NOT NULL REFERENCES author_documents(id),
      mode TEXT NOT NULL CHECK (mode IN ('candidate', 'direct_write')),
      run_id TEXT,
      candidate_id TEXT,
      previous_revision_id TEXT,
      new_revision_id TEXT,
      summary TEXT NOT NULL DEFAULT '',
      technique_ids_json TEXT NOT NULL DEFAULT '[]',
      rolled_back INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE INDEX IF NOT EXISTS author_documents_by_project ON author_documents(project_id);
    CREATE INDEX IF NOT EXISTS author_documents_by_tree_sort ON author_documents(project_id, volume_id, act_id, sort_key);
    CREATE INDEX IF NOT EXISTS author_runs_by_document ON author_runs(document_id);
    CREATE INDEX IF NOT EXISTS author_runs_by_doc_state ON author_runs(document_id, state);
    CREATE INDEX IF NOT EXISTS author_jobs_by_run ON author_jobs(run_id);
    CREATE INDEX IF NOT EXISTS author_jobs_uncertain_draft ON author_jobs(run_id)
      WHERE kind = 'draft_generation' AND state = 'uncertain';
    CREATE INDEX IF NOT EXISTS author_jobs_by_doc ON author_jobs(document_id, kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS author_jobs_by_project ON author_jobs(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS author_jobs_open ON author_jobs(state)
      WHERE state IN ('prepared', 'inflight', 'received');
    CREATE UNIQUE INDEX IF NOT EXISTS ux_author_jobs_active_scope ON author_jobs(kind, scope_key)
      WHERE scope_key != '' AND state IN ('prepared', 'inflight', 'received');
    CREATE INDEX IF NOT EXISTS author_job_calls_by_job ON author_job_calls(job_id);
    CREATE INDEX IF NOT EXISTS author_read_checkpoints_lru ON author_read_checkpoints(last_used_at ASC);
    CREATE INDEX IF NOT EXISTS event_log_quarantine_by_project ON event_log_quarantine(project_id, seq);
    CREATE INDEX IF NOT EXISTS author_agent_writes_by_doc ON author_agent_writes(document_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS author_agent_writes_by_project ON author_agent_writes(project_id, created_at DESC);
  `);

  if (hasTable(db, "revisions")) {
    db.exec("CREATE INDEX IF NOT EXISTS revisions_by_document_created ON revisions(document_id, created_at);");
  }
  if (hasTable(db, "candidates")) {
    db.exec("CREATE INDEX IF NOT EXISTS candidates_by_document ON candidates(document_id);");
  }

  db.prepare(`
    INSERT INTO meta (key, value) VALUES ('schema', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `).run(SCHEMA_ID);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('db_uuid', ?);").run(randomUUID());
  db.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION};`);
}
