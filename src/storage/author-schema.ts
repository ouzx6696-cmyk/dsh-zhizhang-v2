import type { SqliteDatabase } from "./driver.ts";

export function createAuthorSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS author_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, product TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS author_documents (
      id TEXT PRIMARY KEY REFERENCES documents(document_id),
      project_id TEXT NOT NULL REFERENCES author_projects(id), title TEXT NOT NULL,
      state TEXT NOT NULL, mode TEXT, line TEXT, final_revision_id TEXT,
      editorial_rejections INTEGER NOT NULL DEFAULT 0, qa_rounds INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS author_runs (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES author_documents(id),
      state TEXT NOT NULL, base_revision_id TEXT NOT NULL, frozen_input TEXT NOT NULL,
      reserved INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, candidate_id TEXT
    );
    CREATE TABLE IF NOT EXISTS author_planning (
      document_id TEXT PRIMARY KEY REFERENCES author_documents(id), value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS author_run_refinement_claims (
      run_id TEXT PRIMARY KEY REFERENCES author_runs(id), rounds INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS author_candidate_qa (
      candidate_id TEXT PRIMARY KEY REFERENCES candidates(candidate_id),
      report TEXT NOT NULL, rounds INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS author_approvals (
      document_id TEXT NOT NULL REFERENCES author_documents(id), revision_id TEXT NOT NULL,
      at TEXT NOT NULL, PRIMARY KEY (document_id, revision_id)
    );
    CREATE TABLE IF NOT EXISTS author_chapter_order (
      project_id TEXT PRIMARY KEY REFERENCES author_projects(id), chapter_ids TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS author_settings (
      sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES author_projects(id), fact_id TEXT NOT NULL,
      value TEXT NOT NULL, decision TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS author_documents_by_project ON author_documents(project_id);
    CREATE INDEX IF NOT EXISTS author_runs_by_document ON author_runs(document_id);
    CREATE INDEX IF NOT EXISTS author_settings_by_project ON author_settings(project_id);
    CREATE INDEX IF NOT EXISTS author_settings_decision_events ON event_log(project_id, json_extract(payload, '$.id'))
      WHERE kind = 'setting.decided';
    CREATE INDEX IF NOT EXISTS author_article_reports ON event_log(project_id, json_extract(payload, '$.revisionId'), seq)
      WHERE kind IN ('article.qa','article.rejected');
  `);
}
