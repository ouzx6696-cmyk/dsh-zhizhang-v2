import type { SqliteDatabase } from "./driver.ts";

function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table});`).all() as readonly { name?: unknown }[];
  const cols = new Set<string>();
  for (const row of rows) {
    if (typeof row.name === "string") cols.add(row.name);
  }
  return cols;
}

function hasObject(db: SqliteDatabase, type: "table" | "index", name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?;").get(type, name),
  );
}

/**
 * V2 author-workspace schema with idempotent `2.0.0` -> `2.1.0` upgrade path.
 *
 * - Drops the legacy `author_article_reports` index on `event_log` (which
 *   collides with the `author_article_reports` table name in SQLite's shared
 *   namespace) and backfills historical QA/rejection reports.
 * - Adds `author_projects.created_at`, `author_runs.late_usage_settled`, and
 *   `author_settings.decided_seq` when opening pre-refactor 2.0.0 databases,
 *   backfilling `decided_seq` and `late_usage_settled` from existing rows and
 *   `event_log`.
 */
export function createAuthorSchema(db: SqliteDatabase): void {
  const droppedLegacyReportsIndex = hasObject(db, "index", "author_article_reports");
  if (droppedLegacyReportsIndex) {
    db.exec("DROP INDEX IF EXISTS author_article_reports;");
  }

  db.exec(`
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
      qa_rounds INTEGER NOT NULL DEFAULT 0
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
      late_usage_settled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS author_planning (
      document_id TEXT PRIMARY KEY REFERENCES author_documents(id),
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS author_run_refinement_claims (
      run_id TEXT PRIMARY KEY REFERENCES author_runs(id),
      rounds INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS author_candidate_qa (
      candidate_id TEXT PRIMARY KEY REFERENCES candidates(candidate_id),
      report TEXT NOT NULL,
      rounds INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS author_article_reports (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      document_id TEXT NOT NULL REFERENCES author_documents(id),
      revision_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS author_evidence (
      snapshot_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      document_id TEXT NOT NULL REFERENCES author_documents(id),
      fact_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      point INTEGER NOT NULL,
      quote_start INTEGER NOT NULL,
      quote_end INTEGER NOT NULL,
      verification_kind TEXT NOT NULL,
      verification_score INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS author_approvals (
      document_id TEXT NOT NULL REFERENCES author_documents(id),
      revision_id TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (document_id, revision_id)
    );
    CREATE TABLE IF NOT EXISTS author_chapter_order (
      project_id TEXT PRIMARY KEY REFERENCES author_projects(id),
      chapter_ids TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS author_settings (
      sequence INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      fact_id TEXT NOT NULL,
      value TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'pending',
      decided_seq INTEGER
    );
    CREATE TABLE IF NOT EXISTS author_read_checkpoints (
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      cache_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (project_id, cache_key)
    );
  `);

  const hasEventLog = hasObject(db, "table", "event_log");

  if (!tableColumns(db, "author_projects").has("created_at")) {
    db.exec("ALTER TABLE author_projects ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;");
  }

  if (!tableColumns(db, "author_runs").has("late_usage_settled")) {
    db.exec("ALTER TABLE author_runs ADD COLUMN late_usage_settled INTEGER NOT NULL DEFAULT 0;");
    db.exec("UPDATE author_runs SET late_usage_settled = 1, candidate_id = NULL WHERE state = 'cancelled' AND candidate_id = '';");
    if (hasEventLog) {
      db.exec(`
        UPDATE author_runs
        SET late_usage_settled = 1
        WHERE state = 'cancelled'
          AND id IN (SELECT json_extract(payload, '$.runId') FROM event_log WHERE kind = 'run.usage.late');
      `);
    }
  }

  if (!tableColumns(db, "author_settings").has("decided_seq")) {
    db.exec("ALTER TABLE author_settings ADD COLUMN decided_seq INTEGER;");
    if (hasEventLog) {
      db.exec(`
        UPDATE author_settings
        SET decided_seq = (
          SELECT MAX(seq) FROM event_log
          WHERE event_log.project_id = author_settings.project_id
            AND event_log.kind = 'setting.decided'
            AND json_extract(event_log.payload, '$.id') = author_settings.id
        )
        WHERE decision != 'pending' AND decided_seq IS NULL;
      `);
    }
  }

  if (droppedLegacyReportsIndex && hasEventLog) {
    const existingCount = db.prepare("SELECT COUNT(*) AS count FROM author_article_reports;").get() as { count?: number };
    if ((existingCount?.count ?? 0) === 0) {
      db.exec(`
        INSERT INTO author_article_reports (project_id, document_id, revision_id, kind, payload, created_at)
        SELECT project_id,
               COALESCE(json_extract(payload, '$.documentId'), ''),
               COALESCE(json_extract(payload, '$.revisionId'), ''),
               kind,
               payload,
               seq
        FROM event_log
        WHERE kind IN ('article.qa', 'article.rejected')
        ORDER BY seq ASC;
      `);
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS author_documents_by_project ON author_documents(project_id);
    CREATE INDEX IF NOT EXISTS author_runs_by_document ON author_runs(document_id);
    CREATE INDEX IF NOT EXISTS author_settings_by_project ON author_settings(project_id);
    CREATE INDEX IF NOT EXISTS author_settings_approved_order
      ON author_settings(project_id, decided_seq) WHERE decision = 'approved';
    CREATE INDEX IF NOT EXISTS author_reports_by_revision
      ON author_article_reports(project_id, revision_id, id DESC);
    CREATE INDEX IF NOT EXISTS author_evidence_by_fact
      ON author_evidence(project_id, fact_id);
  `);
}
