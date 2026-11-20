import type { SqliteDatabase } from "./driver.ts";
import { stmt } from "./stmt-pool.ts";
import { withWriteTx } from "./tx.ts";

export type FtsSearchScope = "chapter" | "lore" | "deconstruction" | "technique";

export interface FtsSearchHit {
  readonly scope: FtsSearchScope;
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly snippet: string;
}

const FTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS fts_rowid_map (
    fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    project_id TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    item_scope TEXT NOT NULL DEFAULT 'project',
    indexed INTEGER NOT NULL DEFAULT 1,
    UNIQUE(scope, project_id, entity_key)
  );
  CREATE INDEX IF NOT EXISTS fts_rowid_map_lookup ON fts_rowid_map(scope, entity_key);
  CREATE INDEX IF NOT EXISTS fts_rowid_map_project ON fts_rowid_map(scope, project_id);

  CREATE VIEW IF NOT EXISTS v_fts_chapters AS
    SELECT m.fts_rowid AS fts_rowid, a.title, a.summary, COALESCE(r.body, '') AS body
    FROM fts_rowid_map m
    JOIN author_documents a ON m.scope = 'chapter' AND m.project_id = a.project_id AND m.entity_key = a.id
    JOIN documents d ON d.document_id = a.id
    LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
    WHERE m.indexed = 1;

  CREATE VIEW IF NOT EXISTS v_fts_lore AS
    SELECT m.fts_rowid AS fts_rowid, l.entity_name,
      COALESCE(json_extract(l.value, '$.note'), '') AS note,
      COALESCE(json_extract(l.value, '$.source'), '') AS source
    FROM fts_rowid_map m
    JOIN author_lore_current l ON m.scope = 'lore' AND m.project_id = l.project_id AND m.entity_key = l.fact_id
    WHERE m.indexed = 1;

  CREATE VIEW IF NOT EXISTS v_fts_library AS
    SELECT m.fts_rowid AS fts_rowid, d.title,
      COALESCE(d.source_book, '') || char(10) || COALESCE(d.genre, '') || char(10) || COALESCE(d.tags_json, '[]') || char(10) ||
      COALESCE(d.hook_analysis, '') || char(10) || COALESCE(d.conflict_beats, '') || char(10) ||
      COALESCE(d.payoff_rhythm, '') || char(10) || COALESCE(d.prose_notes, '') || char(10) || COALESCE(d.excerpt, '') AS body
    FROM fts_rowid_map m
    JOIN library_deconstructions d ON m.scope = 'deconstruction' AND m.entity_key = d.id AND d.status = 'approved'
    WHERE m.indexed = 1
    UNION ALL
    SELECT m.fts_rowid AS fts_rowid, t.title,
      COALESCE(t.category, '') || char(10) || COALESCE(t.scene_tags_json, '[]') || char(10) || COALESCE(t.trigger_when, '') || char(10) ||
      COALESCE(t.execution_steps, '') || char(10) || COALESCE(t.constraints, '') || char(10) ||
      COALESCE(t.anti_patterns, '') || char(10) || COALESCE(t.example_excerpt, '') AS body
    FROM fts_rowid_map m
    JOIN library_technique_cards t ON m.scope = 'technique' AND m.entity_key = t.id AND t.status = 'approved'
    WHERE m.indexed = 1;

  CREATE VIRTUAL TABLE IF NOT EXISTS fts_chapters USING fts5(
    title,
    summary,
    body,
    content='v_fts_chapters',
    content_rowid='fts_rowid',
    tokenize='trigram'
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_lore USING fts5(
    entity_name,
    note,
    source,
    content='v_fts_lore',
    content_rowid='fts_rowid',
    tokenize='trigram'
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_library USING fts5(
    title,
    body,
    content='v_fts_library',
    content_rowid='fts_rowid',
    tokenize='trigram'
  );

  CREATE TRIGGER IF NOT EXISTS tr_fts_doc_rev_bu BEFORE UPDATE OF current_revision_id ON documents
  WHEN OLD.current_revision_id IS NOT NEW.current_revision_id
  BEGIN
    INSERT INTO fts_chapters(fts_chapters, rowid, title, summary, body)
    SELECT 'delete', m.fts_rowid, a.title, a.summary, COALESCE(r.body, '')
    FROM fts_rowid_map m
    JOIN author_documents a ON a.id = OLD.document_id AND m.project_id = a.project_id
    LEFT JOIN revisions r ON r.revision_id = OLD.current_revision_id
    WHERE m.scope = 'chapter' AND m.entity_key = OLD.document_id AND m.indexed = 1;
    UPDATE fts_rowid_map SET indexed = 0 WHERE scope = 'chapter' AND entity_key = OLD.document_id AND indexed = 1;
  END;

  CREATE TRIGGER IF NOT EXISTS tr_fts_doc_rev_au AFTER UPDATE OF current_revision_id ON documents
  WHEN OLD.current_revision_id IS NOT NEW.current_revision_id
  BEGIN
    UPDATE fts_rowid_map SET indexed = 1 WHERE scope = 'chapter' AND entity_key = NEW.document_id AND indexed = 0;
    INSERT INTO fts_chapters(rowid, title, summary, body)
    SELECT fts_rowid, title, summary, body FROM v_fts_chapters
    WHERE fts_rowid IN (SELECT fts_rowid FROM fts_rowid_map WHERE scope = 'chapter' AND entity_key = NEW.document_id AND indexed = 1);
  END;

  CREATE TRIGGER IF NOT EXISTS tr_fts_adoc_bu BEFORE UPDATE OF title, summary ON author_documents
  WHEN OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary
  BEGIN
    INSERT INTO fts_chapters(fts_chapters, rowid, title, summary, body)
    SELECT 'delete', m.fts_rowid, OLD.title, OLD.summary, COALESCE(r.body, '')
    FROM fts_rowid_map m
    JOIN documents d ON d.document_id = OLD.id
    LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
    WHERE m.scope = 'chapter' AND m.project_id = OLD.project_id AND m.entity_key = OLD.id AND m.indexed = 1;
    UPDATE fts_rowid_map SET indexed = 0 WHERE scope = 'chapter' AND project_id = OLD.project_id AND entity_key = OLD.id AND indexed = 1;
  END;

  CREATE TRIGGER IF NOT EXISTS tr_fts_adoc_au AFTER UPDATE OF title, summary ON author_documents
  WHEN OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary
  BEGIN
    UPDATE fts_rowid_map SET indexed = 1 WHERE scope = 'chapter' AND project_id = NEW.project_id AND entity_key = NEW.id AND indexed = 0;
    INSERT INTO fts_chapters(rowid, title, summary, body)
    SELECT fts_rowid, title, summary, body FROM v_fts_chapters
    WHERE fts_rowid IN (SELECT fts_rowid FROM fts_rowid_map WHERE scope = 'chapter' AND project_id = NEW.project_id AND entity_key = NEW.id AND indexed = 1);
  END;

  CREATE TRIGGER IF NOT EXISTS tr_fts_adoc_bd BEFORE DELETE ON author_documents
  BEGIN
    INSERT INTO fts_chapters(fts_chapters, rowid, title, summary, body)
    SELECT 'delete', m.fts_rowid, OLD.title, OLD.summary, COALESCE(r.body, '')
    FROM fts_rowid_map m
    JOIN documents d ON d.document_id = OLD.id
    LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
    WHERE m.scope = 'chapter' AND m.project_id = OLD.project_id AND m.entity_key = OLD.id AND m.indexed = 1;
    DELETE FROM fts_rowid_map WHERE scope = 'chapter' AND project_id = OLD.project_id AND entity_key = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS tr_fts_lore_bu BEFORE UPDATE OF entity_name, value ON author_lore_current
  BEGIN
    INSERT INTO fts_lore(fts_lore, rowid, entity_name, note, source)
    SELECT 'delete', m.fts_rowid, OLD.entity_name,
      COALESCE(json_extract(OLD.value, '$.note'), ''),
      COALESCE(json_extract(OLD.value, '$.source'), '')
    FROM fts_rowid_map m
    WHERE m.scope = 'lore' AND m.project_id = OLD.project_id AND m.entity_key = OLD.fact_id AND m.indexed = 1;
    UPDATE fts_rowid_map SET indexed = 0 WHERE scope = 'lore' AND project_id = OLD.project_id AND entity_key = OLD.fact_id AND indexed = 1;
  END;

  CREATE TRIGGER IF NOT EXISTS tr_fts_lore_au AFTER UPDATE OF entity_name, value ON author_lore_current
  BEGIN
    UPDATE fts_rowid_map SET indexed = 1 WHERE scope = 'lore' AND project_id = NEW.project_id AND entity_key = NEW.fact_id AND indexed = 0;
    INSERT INTO fts_lore(rowid, entity_name, note, source)
    SELECT fts_rowid, entity_name, note, source FROM v_fts_lore
    WHERE fts_rowid IN (SELECT fts_rowid FROM fts_rowid_map WHERE scope = 'lore' AND project_id = NEW.project_id AND entity_key = NEW.fact_id AND indexed = 1);
  END;

  CREATE TRIGGER IF NOT EXISTS tr_fts_lore_bd BEFORE DELETE ON author_lore_current
  BEGIN
    INSERT INTO fts_lore(fts_lore, rowid, entity_name, note, source)
    SELECT 'delete', m.fts_rowid, OLD.entity_name,
      COALESCE(json_extract(OLD.value, '$.note'), ''),
      COALESCE(json_extract(OLD.value, '$.source'), '')
    FROM fts_rowid_map m
    WHERE m.scope = 'lore' AND m.project_id = OLD.project_id AND m.entity_key = OLD.fact_id AND m.indexed = 1;
    DELETE FROM fts_rowid_map WHERE scope = 'lore' AND project_id = OLD.project_id AND entity_key = OLD.fact_id;
  END;

  CREATE TRIGGER IF NOT EXISTS tr_fts_dec_bd BEFORE DELETE ON library_deconstructions
  BEGIN
    INSERT INTO fts_library(fts_library, rowid, title, body)
    SELECT 'delete', m.fts_rowid, OLD.title,
      COALESCE(OLD.source_book, '') || char(10) || COALESCE(OLD.genre, '') || char(10) || COALESCE(OLD.tags_json, '[]') || char(10) ||
      COALESCE(OLD.hook_analysis, '') || char(10) || COALESCE(OLD.conflict_beats, '') || char(10) ||
      COALESCE(OLD.payoff_rhythm, '') || char(10) || COALESCE(OLD.prose_notes, '') || char(10) || COALESCE(OLD.excerpt, '')
    FROM fts_rowid_map m
    WHERE m.scope = 'deconstruction' AND m.entity_key = OLD.id AND m.indexed = 1;
    DELETE FROM fts_rowid_map WHERE scope = 'deconstruction' AND entity_key = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS tr_fts_dec_bu
  BEFORE UPDATE OF title, source_book, genre, tags_json, hook_analysis, conflict_beats, payoff_rhythm, prose_notes, excerpt, status
  ON library_deconstructions
  BEGIN
    INSERT INTO fts_library(fts_library, rowid, title, body)
    SELECT 'delete', m.fts_rowid, OLD.title,
      COALESCE(OLD.source_book, '') || char(10) || COALESCE(OLD.genre, '') || char(10) || COALESCE(OLD.tags_json, '[]') || char(10) ||
      COALESCE(OLD.hook_analysis, '') || char(10) || COALESCE(OLD.conflict_beats, '') || char(10) ||
      COALESCE(OLD.payoff_rhythm, '') || char(10) || COALESCE(OLD.prose_notes, '') || char(10) || COALESCE(OLD.excerpt, '')
    FROM fts_rowid_map m
    WHERE m.scope = 'deconstruction' AND m.entity_key = OLD.id AND m.indexed = 1;
    UPDATE fts_rowid_map SET indexed = 0 WHERE scope = 'deconstruction' AND entity_key = OLD.id AND indexed = 1;
  END;

  CREATE TRIGGER IF NOT EXISTS tr_fts_dec_au
  AFTER UPDATE OF title, source_book, genre, tags_json, hook_analysis, conflict_beats, payoff_rhythm, prose_notes, excerpt, status
  ON library_deconstructions
  BEGIN
    UPDATE fts_rowid_map SET indexed = CASE WHEN NEW.status = 'approved' THEN 1 ELSE 0 END
    WHERE scope = 'deconstruction' AND entity_key = NEW.id AND indexed = 0;
    INSERT INTO fts_library(rowid, title, body)
    SELECT fts_rowid, title, body FROM v_fts_library
    WHERE fts_rowid IN (SELECT fts_rowid FROM fts_rowid_map WHERE scope = 'deconstruction' AND entity_key = NEW.id AND indexed = 1);
  END;

  CREATE TRIGGER IF NOT EXISTS tr_fts_tech_bd BEFORE DELETE ON library_technique_cards
  BEGIN
    INSERT INTO fts_library(fts_library, rowid, title, body)
    SELECT 'delete', m.fts_rowid, OLD.title,
      COALESCE(OLD.category, '') || char(10) || COALESCE(OLD.scene_tags_json, '[]') || char(10) || COALESCE(OLD.trigger_when, '') || char(10) ||
      COALESCE(OLD.execution_steps, '') || char(10) || COALESCE(OLD.constraints, '') || char(10) ||
      COALESCE(OLD.anti_patterns, '') || char(10) || COALESCE(OLD.example_excerpt, '')
    FROM fts_rowid_map m
    WHERE m.scope = 'technique' AND m.entity_key = OLD.id AND m.indexed = 1;
    DELETE FROM fts_rowid_map WHERE scope = 'technique' AND entity_key = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS tr_fts_tech_bu
  BEFORE UPDATE OF title, category, scene_tags_json, trigger_when, execution_steps, constraints, anti_patterns, example_excerpt, status
  ON library_technique_cards
  BEGIN
    INSERT INTO fts_library(fts_library, rowid, title, body)
    SELECT 'delete', m.fts_rowid, OLD.title,
      COALESCE(OLD.category, '') || char(10) || COALESCE(OLD.scene_tags_json, '[]') || char(10) || COALESCE(OLD.trigger_when, '') || char(10) ||
      COALESCE(OLD.execution_steps, '') || char(10) || COALESCE(OLD.constraints, '') || char(10) ||
      COALESCE(OLD.anti_patterns, '') || char(10) || COALESCE(OLD.example_excerpt, '')
    FROM fts_rowid_map m
    WHERE m.scope = 'technique' AND m.entity_key = OLD.id AND m.indexed = 1;
    UPDATE fts_rowid_map SET indexed = 0 WHERE scope = 'technique' AND entity_key = OLD.id AND indexed = 1;
  END;

  CREATE TRIGGER IF NOT EXISTS tr_fts_tech_au
  AFTER UPDATE OF title, category, scene_tags_json, trigger_when, execution_steps, constraints, anti_patterns, example_excerpt, status
  ON library_technique_cards
  BEGIN
    UPDATE fts_rowid_map SET indexed = CASE WHEN NEW.status = 'approved' THEN 1 ELSE 0 END
    WHERE scope = 'technique' AND entity_key = NEW.id AND indexed = 0;
    INSERT INTO fts_library(rowid, title, body)
    SELECT fts_rowid, title, body FROM v_fts_library
    WHERE fts_rowid IN (SELECT fts_rowid FROM fts_rowid_map WHERE scope = 'technique' AND entity_key = NEW.id AND indexed = 1);
  END;
`;

function masterObjectSql(db: SqliteDatabase, type: "table" | "view" | "trigger", name: string): string | null {
  const row = stmt(db, "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?;").get(type, name) as
    | { sql?: string | null }
    | undefined;
  return typeof row?.sql === "string" ? row.sql : null;
}

function configureFtsRankWeights(db: SqliteDatabase): void {
  db.exec(`
    INSERT INTO fts_chapters(fts_chapters, rank) VALUES('rank', 'bm25(6.0, 3.0, 1.0)');
    INSERT INTO fts_lore(fts_lore, rank) VALUES('rank', 'bm25(5.0, 2.0, 1.0)');
    INSERT INTO fts_library(fts_library, rank) VALUES('rank', 'bm25(4.0, 1.0)');
  `);
}

function backfillAllFtsMapsAndRebuild(db: SqliteDatabase): void {
  db.exec(`
    INSERT OR IGNORE INTO fts_rowid_map (scope, project_id, entity_key, item_scope, indexed)
    SELECT 'chapter', project_id, id, 'project', 1 FROM author_documents;

    INSERT OR IGNORE INTO fts_rowid_map (scope, project_id, entity_key, item_scope, indexed)
    SELECT 'lore', project_id, fact_id, 'project', 1 FROM author_lore_current;

    INSERT OR IGNORE INTO fts_rowid_map (scope, project_id, entity_key, item_scope, indexed)
    SELECT 'deconstruction', COALESCE(project_id, ''), id, scope, 1
    FROM library_deconstructions WHERE status = 'approved';

    INSERT OR IGNORE INTO fts_rowid_map (scope, project_id, entity_key, item_scope, indexed)
    SELECT 'technique', COALESCE(project_id, ''), id, scope, 1
    FROM library_technique_cards WHERE status = 'approved';

    UPDATE fts_rowid_map SET indexed = 1 WHERE indexed = 0;

    INSERT INTO fts_chapters(fts_chapters) VALUES('rebuild');
    INSERT INTO fts_lore(fts_lore) VALUES('rebuild');
    INSERT INTO fts_library(fts_library) VALUES('rebuild');
  `);
}

/**
 * Creates External Content FTS5 trigram virtual tables, `fts_rowid_map`, read-only
 * views, ranked BM25 configuration (DB-05), and column-scoped incremental triggers
 * (DB-17) idempotently, migrating legacy v2.1.0/v2.2.0 structures automatically.
 */
export function createFtsSchema(db: SqliteDatabase): void {
  const chaptersSql = masterObjectSql(db, "table", "fts_chapters");
  const loreSql = masterObjectSql(db, "table", "fts_lore");
  const librarySql = masterObjectSql(db, "table", "fts_library");
  const viewsMissing =
    !masterObjectSql(db, "view", "v_fts_chapters") ||
    !masterObjectSql(db, "view", "v_fts_lore") ||
    !masterObjectSql(db, "view", "v_fts_library");
  const legacyDetected =
    (chaptersSql !== null && !chaptersSql.includes("v_fts_chapters")) ||
    (loreSql !== null && !loreSql.includes("v_fts_lore")) ||
    (librarySql !== null && !librarySql.includes("v_fts_library")) ||
    (chaptersSql !== null && viewsMissing);

  const decBuSql = masterObjectSql(db, "trigger", "tr_fts_dec_bu");
  const techBuSql = masterObjectSql(db, "trigger", "tr_fts_tech_bu");
  const needsColumnScopedTriggers =
    (decBuSql !== null && !/UPDATE\s+OF/i.test(decBuSql)) ||
    (techBuSql !== null && !/UPDATE\s+OF/i.test(techBuSql));

  withWriteTx(db, () => {
    if (legacyDetected) {
      db.exec(`
        DROP TABLE IF EXISTS fts_chapters;
        DROP TABLE IF EXISTS fts_lore;
        DROP TABLE IF EXISTS fts_library;
        DROP VIEW IF EXISTS v_fts_chapters;
        DROP VIEW IF EXISTS v_fts_lore;
        DROP VIEW IF EXISTS v_fts_library;
      `);
    }
    if (needsColumnScopedTriggers) {
      db.exec(`
        DROP TRIGGER IF EXISTS tr_fts_dec_bu;
        DROP TRIGGER IF EXISTS tr_fts_dec_au;
        DROP TRIGGER IF EXISTS tr_fts_tech_bu;
        DROP TRIGGER IF EXISTS tr_fts_tech_au;
      `);
    }
    db.exec(FTS_SCHEMA);
    configureFtsRankWeights(db);
    if (legacyDetected) {
      backfillAllFtsMapsAndRebuild(db);
    }
  });
}

function ensureMappingRow(
  db: SqliteDatabase,
  scope: FtsSearchScope,
  projectId: string,
  entityKey: string,
  itemScope: string,
): { readonly ftsRowid: number; readonly action: "insert" | "noop" } {
  const existing = stmt(db, `
    SELECT fts_rowid AS ftsRowid, indexed
    FROM fts_rowid_map
    WHERE scope = ? AND project_id = ? AND entity_key = ?;
  `).get(scope, projectId, entityKey) as { ftsRowid: number; indexed: number } | undefined;

  if (!existing) {
    const res = stmt(db, `
      INSERT INTO fts_rowid_map (scope, project_id, entity_key, item_scope, indexed)
      VALUES (?, ?, ?, ?, 1);
    `).run(scope, projectId, entityKey, itemScope);
    return { ftsRowid: Number(res.lastInsertRowid), action: "insert" };
  }
  if (existing.indexed === 0) {
    stmt(db, "UPDATE fts_rowid_map SET indexed = 1, item_scope = ? WHERE fts_rowid = ?;")
      .run(itemScope, existing.ftsRowid);
    return { ftsRowid: existing.ftsRowid, action: "insert" };
  }
  return { ftsRowid: existing.ftsRowid, action: "noop" };
}

/** Ensures a chapter row is registered and indexed in `fts_chapters`. */
export function syncChapterFts(
  db: SqliteDatabase,
  entry: {
    readonly projectId: string;
    readonly documentId: string;
    readonly title: string;
    readonly summary: string;
    readonly body: string;
  },
): void {
  const mapped = ensureMappingRow(db, "chapter", entry.projectId, entry.documentId, "project");
  if (mapped.action === "noop") return;
  stmt(db, `
    INSERT INTO fts_chapters(rowid, title, summary, body)
    SELECT fts_rowid, title, summary, body FROM v_fts_chapters WHERE fts_rowid = ?;
  `).run(mapped.ftsRowid);
}

/** Ensures an approved lore entry is registered and indexed in `fts_lore`. */
export function syncLoreFts(
  db: SqliteDatabase,
  entry: {
    readonly projectId: string;
    readonly factId: string;
    readonly entityName: string;
    readonly note: string;
    readonly source: string;
  },
): void {
  const mapped = ensureMappingRow(db, "lore", entry.projectId, entry.factId, "project");
  if (mapped.action === "noop") return;
  stmt(db, `
    INSERT INTO fts_lore(rowid, entity_name, note, source)
    SELECT fts_rowid, entity_name, note, source FROM v_fts_lore WHERE fts_rowid = ?;
  `).run(mapped.ftsRowid);
}

/** Ensures an approved deconstruction sample or technique card is registered and indexed in `fts_library`. */
export function syncLibraryFts(
  db: SqliteDatabase,
  entry: {
    readonly itemId: string;
    readonly itemKind: "deconstruction" | "technique";
    readonly scope: "global" | "project";
    readonly projectId: string | null;
    readonly title: string;
    readonly body: string;
  },
): void {
  const mapped = ensureMappingRow(db, entry.itemKind, entry.projectId ?? "", entry.itemId, entry.scope);
  if (mapped.action === "noop") return;
  stmt(db, `
    INSERT INTO fts_library(rowid, title, body)
    SELECT fts_rowid, title, body FROM v_fts_library WHERE fts_rowid = ?;
  `).run(mapped.ftsRowid);
}

/** Removes a library entry from `fts_library` and `fts_rowid_map` if triggers have not already deleted it. */
export function deleteLibraryFts(
  db: SqliteDatabase,
  itemId: string,
  itemKind: "deconstruction" | "technique",
): void {
  const rows = stmt(db, `
    SELECT fts_rowid AS ftsRowid, indexed
    FROM fts_rowid_map
    WHERE scope = ? AND entity_key = ?;
  `).all(itemKind, itemId) as readonly { ftsRowid: number; indexed: number }[];
  for (const row of rows) {
    if (row.indexed === 1) {
      stmt(db, `
        INSERT INTO fts_library(fts_library, rowid, title, body)
        SELECT 'delete', fts_rowid, title, body FROM v_fts_library WHERE fts_rowid = ?;
      `).run(row.ftsRowid);
    }
    stmt(db, "DELETE FROM fts_rowid_map WHERE fts_rowid = ?;").run(row.ftsRowid);
  }
}

function ftsDocCount(db: SqliteDatabase, ftsTable: "fts_chapters" | "fts_lore" | "fts_library"): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${ftsTable}_docsize;`).get() as { count?: number } | undefined;
  return row?.count ?? 0;
}

/** Runs FTS5 `'optimize'` to merge b-tree segments after bulk ingestion (DB-16). */
export function optimizeFts(db: SqliteDatabase): void {
  db.exec(`
    INSERT INTO fts_chapters(fts_chapters) VALUES('optimize');
    INSERT INTO fts_lore(fts_lore) VALUES('optimize');
    INSERT INTO fts_library(fts_library) VALUES('optimize');
  `);
}

/** Full-database maintenance FTS5 rebuild across all projects (DB-16). */
export function rebuildAllFts(db: SqliteDatabase): void {
  withWriteTx(db, () => {
    db.exec(`
      DELETE FROM fts_rowid_map
      WHERE scope = 'chapter' AND entity_key NOT IN (SELECT id FROM author_documents);
      DELETE FROM fts_rowid_map
      WHERE scope = 'lore' AND (project_id || char(0) || entity_key) NOT IN (SELECT project_id || char(0) || fact_id FROM author_lore_current);
      DELETE FROM fts_rowid_map
      WHERE scope = 'deconstruction' AND entity_key NOT IN (SELECT id FROM library_deconstructions WHERE status = 'approved');
      DELETE FROM fts_rowid_map
      WHERE scope = 'technique' AND entity_key NOT IN (SELECT id FROM library_technique_cards WHERE status = 'approved');
    `);
    backfillAllFtsMapsAndRebuild(db);
    optimizeFts(db);
  });
}

/**
 * Reconciles `fts_rowid_map` and updates FTS5 indexes strictly for `projectId`
 * (without rebuilding unrelated projects' FTS entries), falling back to a
 * table-level rebuild only if out-of-band map/index desynchronization is
 * detected, followed by `'optimize'` (DB-16).
 */
export function rebuildProjectFts(db: SqliteDatabase, projectId: string): void {
  withWriteTx(db, () => {
    // 1. Project-scoped chapters reconciliation
    const chMapBefore = (
      stmt(db, "SELECT COUNT(*) AS count FROM fts_rowid_map WHERE scope = 'chapter' AND indexed = 1;").get() as {
        count?: number;
      }
    )?.count ?? 0;
    const chDesynced = ftsDocCount(db, "fts_chapters") !== chMapBefore;

    if (!chDesynced) {
      stmt(db, `
        INSERT INTO fts_chapters(fts_chapters, rowid, title, summary, body)
        SELECT 'delete', v.fts_rowid, v.title, v.summary, v.body
        FROM v_fts_chapters v
        JOIN fts_rowid_map m ON m.fts_rowid = v.fts_rowid
        WHERE m.scope = 'chapter' AND m.project_id = ? AND m.indexed = 1;
      `).run(projectId);
    }
    stmt(db, `
      DELETE FROM fts_rowid_map
      WHERE scope = 'chapter' AND project_id = ?
        AND entity_key NOT IN (SELECT id FROM author_documents WHERE project_id = ?);
    `).run(projectId, projectId);
    stmt(db, `
      INSERT OR IGNORE INTO fts_rowid_map (scope, project_id, entity_key, item_scope, indexed)
      SELECT 'chapter', project_id, id, 'project', 1 FROM author_documents WHERE project_id = ?;
    `).run(projectId);
    stmt(db, "UPDATE fts_rowid_map SET indexed = 1 WHERE scope = 'chapter' AND project_id = ?;").run(projectId);
    if (chDesynced) {
      db.exec("INSERT INTO fts_chapters(fts_chapters) VALUES('rebuild');");
    } else {
      stmt(db, `
        INSERT INTO fts_chapters(rowid, title, summary, body)
        SELECT v.fts_rowid, v.title, v.summary, v.body
        FROM v_fts_chapters v
        JOIN fts_rowid_map m ON m.fts_rowid = v.fts_rowid
        WHERE m.scope = 'chapter' AND m.project_id = ? AND m.indexed = 1;
      `).run(projectId);
    }

    // 2. Project-scoped lore reconciliation
    const loreMapBefore = (
      stmt(db, "SELECT COUNT(*) AS count FROM fts_rowid_map WHERE scope = 'lore' AND indexed = 1;").get() as {
        count?: number;
      }
    )?.count ?? 0;
    const loreDesynced = ftsDocCount(db, "fts_lore") !== loreMapBefore;

    if (!loreDesynced) {
      stmt(db, `
        INSERT INTO fts_lore(fts_lore, rowid, entity_name, note, source)
        SELECT 'delete', v.fts_rowid, v.entity_name, v.note, v.source
        FROM v_fts_lore v
        JOIN fts_rowid_map m ON m.fts_rowid = v.fts_rowid
        WHERE m.scope = 'lore' AND m.project_id = ? AND m.indexed = 1;
      `).run(projectId);
    }
    stmt(db, `
      DELETE FROM fts_rowid_map
      WHERE scope = 'lore' AND project_id = ?
        AND entity_key NOT IN (SELECT fact_id FROM author_lore_current WHERE project_id = ?);
    `).run(projectId, projectId);
    stmt(db, `
      INSERT OR IGNORE INTO fts_rowid_map (scope, project_id, entity_key, item_scope, indexed)
      SELECT 'lore', project_id, fact_id, 'project', 1 FROM author_lore_current WHERE project_id = ?;
    `).run(projectId);
    stmt(db, "UPDATE fts_rowid_map SET indexed = 1 WHERE scope = 'lore' AND project_id = ?;").run(projectId);
    if (loreDesynced) {
      db.exec("INSERT INTO fts_lore(fts_lore) VALUES('rebuild');");
    } else {
      stmt(db, `
        INSERT INTO fts_lore(rowid, entity_name, note, source)
        SELECT v.fts_rowid, v.entity_name, v.note, v.source
        FROM v_fts_lore v
        JOIN fts_rowid_map m ON m.fts_rowid = v.fts_rowid
        WHERE m.scope = 'lore' AND m.project_id = ? AND m.indexed = 1;
      `).run(projectId);
    }

    // 3. Project + global library reconciliation
    const libMapBefore = (
      stmt(
        db,
        "SELECT COUNT(*) AS count FROM fts_rowid_map WHERE scope IN ('deconstruction', 'technique') AND indexed = 1;",
      ).get() as { count?: number }
    )?.count ?? 0;
    const libDesynced = ftsDocCount(db, "fts_library") !== libMapBefore;

    if (!libDesynced) {
      stmt(db, `
        INSERT INTO fts_library(fts_library, rowid, title, body)
        SELECT 'delete', v.fts_rowid, v.title, v.body
        FROM v_fts_library v
        JOIN fts_rowid_map m ON m.fts_rowid = v.fts_rowid
        WHERE m.scope IN ('deconstruction', 'technique')
          AND (m.item_scope = 'global' OR m.project_id = ?)
          AND m.indexed = 1;
      `).run(projectId);
    }
    stmt(db, `
      DELETE FROM fts_rowid_map
      WHERE scope = 'deconstruction'
        AND (item_scope = 'global' OR project_id = ?)
        AND entity_key NOT IN (SELECT id FROM library_deconstructions WHERE status = 'approved');
    `).run(projectId);
    stmt(db, `
      INSERT OR IGNORE INTO fts_rowid_map (scope, project_id, entity_key, item_scope, indexed)
      SELECT 'deconstruction', COALESCE(project_id, ''), id, scope, 1
      FROM library_deconstructions
      WHERE status = 'approved' AND (scope = 'global' OR project_id = ?);
    `).run(projectId);
    stmt(db, `
      DELETE FROM fts_rowid_map
      WHERE scope = 'technique'
        AND (item_scope = 'global' OR project_id = ?)
        AND entity_key NOT IN (SELECT id FROM library_technique_cards WHERE status = 'approved');
    `).run(projectId);
    stmt(db, `
      INSERT OR IGNORE INTO fts_rowid_map (scope, project_id, entity_key, item_scope, indexed)
      SELECT 'technique', COALESCE(project_id, ''), id, scope, 1
      FROM library_technique_cards
      WHERE status = 'approved' AND (scope = 'global' OR project_id = ?);
    `).run(projectId);
    stmt(db, `
      UPDATE fts_rowid_map SET indexed = 1
      WHERE scope IN ('deconstruction', 'technique') AND (item_scope = 'global' OR project_id = ?);
    `).run(projectId);
    if (libDesynced) {
      db.exec("INSERT INTO fts_library(fts_library) VALUES('rebuild');");
    } else {
      stmt(db, `
        INSERT INTO fts_library(rowid, title, body)
        SELECT v.fts_rowid, v.title, v.body
        FROM v_fts_library v
        JOIN fts_rowid_map m ON m.fts_rowid = v.fts_rowid
        WHERE m.scope IN ('deconstruction', 'technique')
          AND (m.item_scope = 'global' OR m.project_id = ?)
          AND m.indexed = 1;
      `).run(projectId);
    }

    optimizeFts(db);
  });
}

/** Verifies structural integrity of all three External Content FTS5 tables against their views. */
export function verifyFtsIntegrity(db: SqliteDatabase): void {
  db.exec(`
    INSERT INTO fts_chapters(fts_chapters) VALUES('integrity-check');
    INSERT INTO fts_lore(fts_lore) VALUES('integrity-check');
    INSERT INTO fts_library(fts_library) VALUES('integrity-check');
  `);
}

function escapeFtsPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

function escapeLike(query: string): string {
  return `%${query.replace(/[\\%_]/g, "\\$&")}%`;
}

function makePreviewSnippet(text: string, needle: string): string {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return text.slice(0, 80);
  const start = Math.max(0, idx - 24);
  const end = Math.min(text.length, idx + needle.length + 48);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function hasChapterEntitiesTable(db: SqliteDatabase): boolean {
  return Boolean(
    stmt(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'author_chapter_entities';").get(),
  );
}

/**
 * Two-phase FTS5 chapter search (DB-05) + 1–2 char CJK entity/title fast path (DB-06):
 * - For >=3 chars: Phase 1 selects ONLY `(rowid, entity_key)` ranked by FTS5 `rank`
 *   with `LIMIT ?` (zero `revisions` join, zero `snippet()` overhead for non-winners);
 *   Phase 2 materializes title + snippet ONLY for the top K rows.
 * - For 1–2 chars: queries indexed `author_chapter_entities` first, then `title`/`summary`,
 *   falling back to bounded body `LIKE` only for remaining slots.
 */
function queryChapterScopeHits(
  db: SqliteDatabase,
  projectId: string,
  needle: string,
  useFts: boolean,
  ftsQuery: string,
  likeQuery: string,
  limit: number,
): FtsSearchHit[] {
  if (useFts) {
    // Phase 1: lightweight ranked rowid fetch without joining revisions/body or calling snippet().
    const topRows = stmt(db, `
      SELECT fts_chapters.rowid AS rid, m.entity_key AS id
      FROM fts_chapters
      JOIN fts_rowid_map m ON m.fts_rowid = fts_chapters.rowid
      WHERE m.scope = 'chapter' AND m.project_id = ? AND fts_chapters MATCH ?
      ORDER BY rank
      LIMIT ?;
    `).all(projectId, ftsQuery, limit) as readonly { rid: number; id: string }[];

    if (topRows.length === 0) return [];

    // Phase 2: materialize title & FTS5 snippet ONLY for the top K winners.
    const detailStmt = stmt(db, `
      SELECT v.title,
        snippet(fts_chapters, 2, '[', ']', '…', 14) AS bodySnip,
        snippet(fts_chapters, 1, '[', ']', '…', 14) AS sumSnip
      FROM fts_chapters
      JOIN v_fts_chapters v ON v.fts_rowid = fts_chapters.rowid
      WHERE fts_chapters.rowid = ? AND fts_chapters MATCH ?;
    `);
    const hits: FtsSearchHit[] = [];
    for (const row of topRows) {
      const detail = detailStmt.get(row.rid, ftsQuery) as
        | { title: string; bodySnip: string; sumSnip: string }
        | undefined;
      if (!detail) continue;
      hits.push({
        scope: "chapter",
        id: row.id,
        title: detail.title || "未命名章节",
        subtitle: "章节正文 / 摘要",
        snippet: detail.bodySnip || detail.sumSnip || detail.title,
      });
    }
    return hits;
  }

  // DB-06: 1–2 char CJK fast path: entity inverted index -> title/summary -> bounded body LIKE fallback.
  const seen = new Set<string>();
  const hits: FtsSearchHit[] = [];

  if (hasChapterEntitiesTable(db)) {
    const entityRows = stmt(db, `
      SELECT e.document_id AS id, a.title, a.summary, COALESCE(r.body, '') AS rawBody
      FROM author_chapter_entities e
      JOIN author_documents a ON a.id = e.document_id
      JOIN documents d ON d.document_id = a.id
      LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
      WHERE e.project_id = ? AND e.entity_name LIKE ? ESCAPE '\\'
      ORDER BY e.mention_count DESC, a.rowid ASC
      LIMIT ?;
    `).all(projectId, likeQuery, limit) as readonly {
      id: string;
      title: string;
      summary: string;
      rawBody: string;
    }[];
    for (const row of entityRows) {
      if (seen.has(row.id) || hits.length >= limit) continue;
      seen.add(row.id);
      hits.push({
        scope: "chapter",
        id: row.id,
        title: row.title || "未命名章节",
        subtitle: "章节正文 / 摘要",
        snippet: makePreviewSnippet(row.rawBody || row.summary || row.title, needle),
      });
    }
  }

  if (hits.length < limit) {
    const metaRows = stmt(db, `
      SELECT a.id, a.title, a.summary
      FROM author_documents a
      WHERE a.project_id = ?
        AND (a.title LIKE ? ESCAPE '\\' OR a.summary LIKE ? ESCAPE '\\')
      ORDER BY CASE WHEN a.title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END ASC, a.rowid ASC
      LIMIT ?;
    `).all(projectId, likeQuery, likeQuery, likeQuery, limit) as readonly {
      id: string;
      title: string;
      summary: string;
    }[];
    for (const row of metaRows) {
      if (seen.has(row.id) || hits.length >= limit) continue;
      seen.add(row.id);
      hits.push({
        scope: "chapter",
        id: row.id,
        title: row.title || "未命名章节",
        subtitle: "章节正文 / 摘要",
        snippet: makePreviewSnippet(row.summary || row.title, needle),
      });
    }
  }

  if (hits.length < limit) {
    const remaining = limit - hits.length;
    const bodyRows = stmt(db, `
      SELECT a.id, a.title, a.summary, COALESCE(r.body, '') AS rawBody
      FROM author_documents a
      JOIN documents d ON d.document_id = a.id
      LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
      WHERE a.project_id = ?
        AND COALESCE(r.body, '') LIKE ? ESCAPE '\\'
      ORDER BY a.rowid ASC
      LIMIT ?;
    `).all(projectId, likeQuery, remaining + seen.size) as readonly {
      id: string;
      title: string;
      summary: string;
      rawBody: string;
    }[];
    for (const row of bodyRows) {
      if (seen.has(row.id) || hits.length >= limit) continue;
      seen.add(row.id);
      hits.push({
        scope: "chapter",
        id: row.id,
        title: row.title || "未命名章节",
        subtitle: "章节正文 / 摘要",
        snippet: makePreviewSnippet(row.rawBody || row.summary || row.title, needle),
      });
    }
  }

  return hits;
}

function queryLoreScopeHits(
  db: SqliteDatabase,
  projectId: string,
  needle: string,
  useFts: boolean,
  ftsQuery: string,
  likeQuery: string,
  limit: number,
): FtsSearchHit[] {
  if (useFts) {
    const topRows = stmt(db, `
      SELECT fts_lore.rowid AS rid, m.entity_key AS id
      FROM fts_lore
      JOIN fts_rowid_map m ON m.fts_rowid = fts_lore.rowid
      WHERE m.scope = 'lore' AND m.project_id = ? AND fts_lore MATCH ?
      ORDER BY rank
      LIMIT ?;
    `).all(projectId, ftsQuery, limit) as readonly { rid: number; id: string }[];
    if (topRows.length === 0) return [];

    const detailStmt = stmt(db, `
      SELECT v.entity_name AS entityName,
        snippet(fts_lore, 1, '[', ']', '…', 14) AS snip
      FROM fts_lore
      JOIN v_fts_lore v ON v.fts_rowid = fts_lore.rowid
      WHERE fts_lore.rowid = ? AND fts_lore MATCH ?;
    `);
    const hits: FtsSearchHit[] = [];
    for (const row of topRows) {
      const detail = detailStmt.get(row.rid, ftsQuery) as { entityName: string; snip: string } | undefined;
      if (!detail) continue;
      hits.push({
        scope: "lore",
        id: row.id,
        title: detail.entityName ? `${detail.entityName} (${row.id})` : row.id,
        subtitle: "动态设定库",
        snippet: detail.snip,
      });
    }
    return hits;
  }

  const rows = (stmt(db, `
    SELECT fact_id AS id, entity_name AS entityName, value
    FROM author_lore_current
    WHERE project_id = ? AND (fact_id LIKE ? ESCAPE '\\' OR entity_name LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')
    ORDER BY CASE WHEN entity_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END ASC, decided_seq DESC
    LIMIT ?;
  `).all(projectId, likeQuery, likeQuery, likeQuery, likeQuery, limit) as readonly {
    id: string;
    entityName: string;
    value: string;
  }[]).map((row) => {
    const parsed = JSON.parse(row.value) as { note?: string };
    return {
      id: row.id,
      entityName: row.entityName,
      snip: makePreviewSnippet(parsed.note ?? row.id, needle),
    };
  });
  return rows.map((row) => ({
    scope: "lore",
    id: row.id,
    title: row.entityName ? `${row.entityName} (${row.id})` : row.id,
    subtitle: "动态设定库",
    snippet: row.snip,
  }));
}

function queryLibraryScopeHits(
  db: SqliteDatabase,
  itemKind: "deconstruction" | "technique",
  projectId: string,
  needle: string,
  useFts: boolean,
  ftsQuery: string,
  likeQuery: string,
  limit: number,
): FtsSearchHit[] {
  if (useFts) {
    const topRows = stmt(db, `
      SELECT fts_library.rowid AS rid, m.entity_key AS id, m.item_scope AS scope
      FROM fts_library
      JOIN fts_rowid_map m ON m.fts_rowid = fts_library.rowid
      WHERE m.scope = ? AND (m.item_scope = 'global' OR m.project_id = ?) AND fts_library MATCH ?
      ORDER BY rank
      LIMIT ?;
    `).all(itemKind, projectId, ftsQuery, limit) as readonly { rid: number; id: string; scope: string }[];
    if (topRows.length === 0) return [];

    const detailStmt = stmt(db, `
      SELECT v.title,
        snippet(fts_library, 1, '[', ']', '…', 14) AS snip
      FROM fts_library
      JOIN v_fts_library v ON v.fts_rowid = fts_library.rowid
      WHERE fts_library.rowid = ? AND fts_library MATCH ?;
    `);
    const hits: FtsSearchHit[] = [];
    for (const row of topRows) {
      const detail = detailStmt.get(row.rid, ftsQuery) as { title: string; snip: string } | undefined;
      if (!detail) continue;
      hits.push({
        scope: itemKind,
        id: row.id,
        title: detail.title,
        subtitle: `${itemKind === "deconstruction" ? "拆书库" : "技法卡"} · ${row.scope === "global" ? "全局" : "本书"}`,
        snippet: detail.snip || detail.title,
      });
    }
    return hits;
  }

  const rows = (itemKind === "deconstruction"
    ? (stmt(db, `
        SELECT id, scope, title,
          excerpt || ' ' || hook_analysis || ' ' || prose_notes AS body
        FROM library_deconstructions
        WHERE status = 'approved' AND (scope = 'global' OR project_id = ?)
          AND (title LIKE ? ESCAPE '\\' OR source_book LIKE ? ESCAPE '\\'
               OR excerpt LIKE ? ESCAPE '\\' OR hook_analysis LIKE ? ESCAPE '\\')
        ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END ASC, updated_at DESC
        LIMIT ?;
      `).all(projectId, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, limit) as readonly {
        id: string;
        scope: string;
        title: string;
        body: string;
      }[])
    : (stmt(db, `
        SELECT id, scope, title,
          trigger_when || ' ' || execution_steps || ' ' || constraints AS body
        FROM library_technique_cards
        WHERE status = 'approved' AND (scope = 'global' OR project_id = ?)
          AND (title LIKE ? ESCAPE '\\' OR trigger_when LIKE ? ESCAPE '\\'
               OR execution_steps LIKE ? ESCAPE '\\' OR scene_tags_json LIKE ? ESCAPE '\\')
        ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END ASC, priority DESC
        LIMIT ?;
      `).all(projectId, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, limit) as readonly {
        id: string;
        scope: string;
        title: string;
        body: string;
      }[])
  ).map((row) => ({ ...row, snip: makePreviewSnippet(row.body || row.title, needle) }));

  return rows.map((row) => ({
    scope: itemKind,
    id: row.id,
    title: row.title,
    subtitle: `${itemKind === "deconstruction" ? "拆书库" : "技法卡"} · ${row.scope === "global" ? "全局" : "本书"}`,
    snippet: row.snip || row.title,
  }));
}

/**
 * Searches chapters, lore, deconstructions, and technique cards with two-phase
 * BM25 ranking, 2-char CJK entity acceleration, Reciprocal Rank Fusion (RRF),
 * and anti-starvation Top-2 quota per non-empty scope.
 */
export function searchWorkspaceFts(
  db: SqliteDatabase,
  options: {
    readonly projectId: string;
    readonly query: string;
    readonly scopes?: readonly FtsSearchScope[];
    readonly limit?: number;
  },
): FtsSearchHit[] {
  const needle = options.query.trim();
  if (!needle) return [];
  const requestedOrder: FtsSearchScope[] =
    options.scopes && options.scopes.length > 0
      ? [...new Set(options.scopes)]
      : ["chapter", "lore", "deconstruction", "technique"];
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  const useFts = [...needle].length >= 3;
  const ftsQuery = escapeFtsPhrase(needle);
  const likeQuery = escapeLike(needle);

  const scopeLists = requestedOrder
    .map((scope) => {
      if (scope === "chapter") {
        return queryChapterScopeHits(db, options.projectId, needle, useFts, ftsQuery, likeQuery, limit);
      }
      if (scope === "lore") {
        return queryLoreScopeHits(db, options.projectId, needle, useFts, ftsQuery, likeQuery, limit);
      }
      return queryLibraryScopeHits(db, scope, options.projectId, needle, useFts, ftsQuery, likeQuery, limit);
    })
    .filter((list) => list.length > 0);

  if (scopeLists.length === 0) return [];
  if (scopeLists.length === 1) return scopeLists[0].slice(0, limit);

  const pickedKeys = new Set<string>();
  const result: FtsSearchHit[] = [];
  const guaranteed = Math.min(2, Math.max(1, Math.floor(limit / scopeLists.length)));

  for (const list of scopeLists) {
    for (let i = 0; i < Math.min(guaranteed, list.length) && result.length < limit; i++) {
      const hit = list[i];
      const key = `${hit.scope}\0${hit.id}`;
      if (!pickedKeys.has(key)) {
        pickedKeys.add(key);
        result.push(hit);
      }
    }
  }

  if (result.length < limit) {
    const remaining: Array<{ readonly hit: FtsSearchHit; readonly rrf: number; readonly order: number }> = [];
    let seq = 0;
    for (const list of scopeLists) {
      for (let rank = 0; rank < list.length; rank++) {
        const hit = list[rank];
        const key = `${hit.scope}\0${hit.id}`;
        if (!pickedKeys.has(key)) {
          remaining.push({ hit, rrf: 1 / (60 + rank + 1), order: seq++ });
        }
      }
    }
    remaining.sort((a, b) => (b.rrf !== a.rrf ? b.rrf - a.rrf : a.order - b.order));
    for (const entry of remaining) {
      if (result.length >= limit) break;
      result.push(entry.hit);
    }
  }

  return result;
}

/**
 * Computes normalized semantic similarity scores across historical chapters
 * for multiple query phrases using Reciprocal Rank Fusion:
 * - >= 3-char terms use FTS5 trigram `ORDER BY rank`;
 * - 1–2 char CJK terms (e.g. character names) use `author_chapter_entities` (DB-06).
 */
export function searchRelatedChaptersByFts(
  db: SqliteDatabase,
  options: {
    readonly projectId: string;
    readonly queryTerms: readonly string[];
    readonly excludeIds?: readonly string[];
    readonly limit?: number;
  },
): Array<{ readonly documentId: string; readonly score: number }> {
  const excluded = new Set(options.excludeIds ?? []);
  const ftsTerms: string[] = [];
  const shortTerms: string[] = [];
  const seenTerms = new Set<string>();
  for (const raw of options.queryTerms) {
    const term = raw.trim();
    const len = [...term].length;
    if (len < 1 || seenTerms.has(term)) continue;
    seenTerms.add(term);
    if (len >= 3) {
      if (ftsTerms.length < 8) ftsTerms.push(term);
    } else if (len >= 2) {
      if (shortTerms.length < 8) shortTerms.push(term);
    }
  }
  if (ftsTerms.length === 0 && shortTerms.length === 0) return [];

  const rrfScores = new Map<string, number>();

  if (ftsTerms.length > 0) {
    const queryStmt = stmt(db, `
      SELECT m.entity_key AS id
      FROM fts_chapters
      JOIN fts_rowid_map m ON m.fts_rowid = fts_chapters.rowid AND m.scope = 'chapter'
      WHERE m.project_id = ? AND fts_chapters MATCH ?
      ORDER BY rank
      LIMIT 24;
    `);
    for (const term of ftsTerms) {
      const rows = queryStmt.all(options.projectId, escapeFtsPhrase(term)) as readonly { id: string }[];
      let rankIdx = 0;
      for (const row of rows) {
        if (excluded.has(row.id)) continue;
        rrfScores.set(row.id, (rrfScores.get(row.id) ?? 0) + 1 / (10 + rankIdx));
        rankIdx += 1;
      }
    }
  }

  if (shortTerms.length > 0 && hasChapterEntitiesTable(db)) {
    const entityStmt = stmt(db, `
      SELECT document_id AS id
      FROM author_chapter_entities
      WHERE project_id = ? AND entity_name LIKE ? ESCAPE '\\'
      ORDER BY mention_count DESC
      LIMIT 24;
    `);
    for (const term of shortTerms) {
      const rows = entityStmt.all(options.projectId, escapeLike(term)) as readonly { id: string }[];
      let rankIdx = 0;
      for (const row of rows) {
        if (excluded.has(row.id)) continue;
        rrfScores.set(row.id, (rrfScores.get(row.id) ?? 0) + 1 / (10 + rankIdx));
        rankIdx += 1;
      }
    }
  }

  let maxScore = 0;
  for (const val of rrfScores.values()) {
    if (val > maxScore) maxScore = val;
  }
  if (maxScore <= 0) return [];

  const limit = Math.max(1, options.limit ?? 12);
  return [...rrfScores.entries()]
    .map(([documentId, score]) => ({
      documentId,
      score: Math.round((score / maxScore) * 10000) / 10000,
    }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.documentId < b.documentId ? -1 : 1))
    .slice(0, limit);
}
