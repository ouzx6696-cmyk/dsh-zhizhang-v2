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
    CREATE TABLE IF NOT EXISTS author_volumes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      title TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS author_acts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      volume_id TEXT NOT NULL REFERENCES author_volumes(id),
      title TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS author_lore_current (
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      fact_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'world_rule',
      entity_name TEXT NOT NULL DEFAULT '',
      latest_setting_id TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      value TEXT NOT NULL,
      decided_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, fact_id)
    );
    CREATE TABLE IF NOT EXISTS author_foreshadows (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      fact_id TEXT,
      title TEXT NOT NULL,
      planted_chapter_id TEXT,
      planted_point INTEGER NOT NULL DEFAULT 1,
      target_chapter_id TEXT,
      resolved_chapter_id TEXT,
      status TEXT NOT NULL DEFAULT 'planted',
      note TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS library_deconstructions (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      project_id TEXT,
      override_of_id TEXT,
      title TEXT NOT NULL,
      source_book TEXT NOT NULL DEFAULT '',
      genre TEXT NOT NULL DEFAULT '',
      pacing TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      excerpt TEXT NOT NULL,
      hook_analysis TEXT NOT NULL DEFAULT '',
      conflict_beats TEXT NOT NULL DEFAULT '',
      payoff_rhythm TEXT NOT NULL DEFAULT '',
      prose_notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'approved',
      source_kind TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS library_technique_cards (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      project_id TEXT,
      override_of_id TEXT,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'narrative',
      pacing TEXT NOT NULL DEFAULT '',
      scene_tags_json TEXT NOT NULL DEFAULT '[]',
      trigger_when TEXT NOT NULL DEFAULT '',
      execution_steps TEXT NOT NULL DEFAULT '',
      constraints TEXT NOT NULL DEFAULT '',
      anti_patterns TEXT NOT NULL DEFAULT '',
      example_excerpt TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 50,
      status TEXT NOT NULL DEFAULT 'approved',
      source_kind TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS author_library_mounts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      item_kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'include',
      weight INTEGER NOT NULL DEFAULT 100,
      note TEXT NOT NULL DEFAULT '',
      UNIQUE(project_id, target_type, target_id, item_kind, item_id)
    );
    CREATE TABLE IF NOT EXISTS author_ai_proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      document_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      source_ref TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      provider TEXT,
      model TEXT,
      reserved INTEGER NOT NULL DEFAULT 0,
      settled INTEGER NOT NULL DEFAULT 0,
      usage TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  const hasEventLog = hasObject(db, "table", "event_log");
  const docCols = tableColumns(db, "author_documents");
  if (!docCols.has("volume_id")) db.exec("ALTER TABLE author_documents ADD COLUMN volume_id TEXT;");
  if (!docCols.has("act_id")) db.exec("ALTER TABLE author_documents ADD COLUMN act_id TEXT;");
  if (!docCols.has("char_count")) db.exec("ALTER TABLE author_documents ADD COLUMN char_count INTEGER NOT NULL DEFAULT 0;");
  if (!docCols.has("summary")) db.exec("ALTER TABLE author_documents ADD COLUMN summary TEXT NOT NULL DEFAULT '';");
  if (!docCols.has("updated_at")) db.exec("ALTER TABLE author_documents ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;");

  const settingCols = tableColumns(db, "author_settings");
  if (!settingCols.has("category")) db.exec("ALTER TABLE author_settings ADD COLUMN category TEXT NOT NULL DEFAULT 'world_rule';");
  if (!settingCols.has("entity_name")) db.exec("ALTER TABLE author_settings ADD COLUMN entity_name TEXT NOT NULL DEFAULT '';");

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
    CREATE INDEX IF NOT EXISTS author_documents_by_tree ON author_documents(project_id, volume_id, act_id);
    CREATE INDEX IF NOT EXISTS author_volumes_by_project ON author_volumes(project_id, sort_order);
    CREATE INDEX IF NOT EXISTS author_acts_by_volume ON author_acts(project_id, volume_id, sort_order);
    CREATE INDEX IF NOT EXISTS author_runs_by_document ON author_runs(document_id);
    CREATE INDEX IF NOT EXISTS author_settings_by_project ON author_settings(project_id);
    CREATE INDEX IF NOT EXISTS author_settings_approved_order
      ON author_settings(project_id, decided_seq) WHERE decision = 'approved';
    CREATE INDEX IF NOT EXISTS author_lore_current_by_cat ON author_lore_current(project_id, category, decided_seq);
    CREATE INDEX IF NOT EXISTS author_foreshadows_by_project ON author_foreshadows(project_id, status);
    CREATE INDEX IF NOT EXISTS library_deconstructions_scope ON library_deconstructions(scope, project_id, status);
    CREATE INDEX IF NOT EXISTS library_techniques_scope ON library_technique_cards(scope, project_id, status, priority DESC);
    CREATE INDEX IF NOT EXISTS author_library_mounts_lookup ON author_library_mounts(project_id, target_type, target_id);
    CREATE INDEX IF NOT EXISTS author_ai_proposals_status ON author_ai_proposals(project_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS author_reports_by_revision
      ON author_article_reports(project_id, revision_id, id DESC);
    CREATE INDEX IF NOT EXISTS author_evidence_by_fact
      ON author_evidence(project_id, fact_id);
  `);

  // Idempotent backfill for materialized lore current table and document char counts.
  const loreCount = db.prepare("SELECT COUNT(*) AS count FROM author_lore_current;").get() as { count?: number };
  if ((loreCount?.count ?? 0) === 0) {
    const approvedRows = db.prepare(`
      SELECT project_id, fact_id, category, entity_name, id, value, COALESCE(decided_seq, 0) AS decided_seq
      FROM author_settings
      WHERE decision = 'approved'
      ORDER BY project_id ASC, COALESCE(decided_seq, 0) DESC, sequence DESC;
    `).all() as readonly {
      project_id: string;
      fact_id: string;
      category: string;
      entity_name: string;
      id: string;
      value: string;
      decided_seq: number;
    }[];
    const seen = new Set<string>();
    const upsertLore = db.prepare(`
      INSERT OR IGNORE INTO author_lore_current
        (project_id, fact_id, category, entity_name, latest_setting_id, locked, value, decided_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const row of approvedRows) {
      const composite = `${row.project_id}\0${row.fact_id}`;
      if (seen.has(composite)) continue;
      seen.add(composite);
      let locked = 0;
      let category = row.category;
      try {
        const parsed = JSON.parse(row.value) as { locked?: boolean; kind?: string };
        locked = parsed.locked === true ? 1 : 0;
        if (parsed.kind === "agreement") category = "agreement";
      } catch {
        // Keep raw defaults on malformed legacy entries.
      }
      upsertLore.run(
        row.project_id,
        row.fact_id,
        category,
        row.entity_name,
        row.id,
        locked,
        row.value,
        row.decided_seq,
      );
    }
  }

  const uncountedDocs = db.prepare(`
    SELECT a.id, r.body, r.created_at AS createdAt
    FROM author_documents a
    JOIN documents d ON d.document_id = a.id
    JOIN revisions r ON r.revision_id = d.current_revision_id
    WHERE a.char_count = 0 AND length(r.body) > 0;
  `).all() as readonly { id: string; body: string; createdAt: number }[];
  if (uncountedDocs.length > 0) {
    const updateDoc = db.prepare(
      "UPDATE author_documents SET char_count = ?, updated_at = CASE WHEN updated_at = 0 THEN ? ELSE updated_at END WHERE id = ?;",
    );
    for (const doc of uncountedDocs) {
      const count = [...doc.body.replace(/\s/gu, "")].length;
      if (count > 0) updateDoc.run(count, doc.createdAt, doc.id);
    }
  }
}
