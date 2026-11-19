import type { SqliteDatabase } from "./driver.ts";

/**
 * Clean V2 author-workspace schema.
 *
 * Designed without legacy compatibility shims:
 * - `author_settings.decided_seq` records the authoritative approval sequence
 *   directly so operational queries and event-log projections always agree
 *   without brittle `json_extract` joins against `event_log`.
 * - `author_runs.late_usage_settled` replaces sentinel empty-string hacks on
 *   `candidate_id` for cancelled-run late usage accounting.
 * - `author_article_reports` and `author_evidence` index QA/rejection reports
 *   and text evidence directly by revision/fact.
 * - `author_read_checkpoints` persists per-key projection checkpoints across
 *   restarts while leveraging `ProjectionStore.restore` tail replay.
 */
export function createAuthorSchema(db: SqliteDatabase): void {
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
