import type { SqliteDatabase } from "./driver.ts";
import { stmt } from "./stmt-pool.ts";

export type FtsSearchScope = "chapter" | "lore" | "deconstruction" | "technique";

export interface FtsSearchHit {
  readonly scope: FtsSearchScope;
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly snippet: string;
}

const FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_chapters USING fts5(
    project_id UNINDEXED,
    document_id UNINDEXED,
    title,
    summary,
    body,
    tokenize='trigram'
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_lore USING fts5(
    project_id UNINDEXED,
    fact_id UNINDEXED,
    entity_name,
    note,
    source,
    tokenize='trigram'
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_library USING fts5(
    item_id UNINDEXED,
    item_kind UNINDEXED,
    scope UNINDEXED,
    project_id UNINDEXED,
    title,
    body,
    tokenize='trigram'
  );
`;

/** Creates FTS5 trigram virtual tables idempotently. */
export function createFtsSchema(db: SqliteDatabase): void {
  db.exec(FTS_SCHEMA);
}

/** Upserts a chapter's searchable title, summary, and current draft body into `fts_chapters`. */
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
  stmt(db, "DELETE FROM fts_chapters WHERE project_id = ? AND document_id = ?;")
    .run(entry.projectId, entry.documentId);
  stmt(db, `
    INSERT INTO fts_chapters (project_id, document_id, title, summary, body)
    VALUES (?, ?, ?, ?, ?);
  `).run(entry.projectId, entry.documentId, entry.title, entry.summary, entry.body);
}

/** Upserts an approved lore entry into `fts_lore`. */
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
  stmt(db, "DELETE FROM fts_lore WHERE project_id = ? AND fact_id = ?;")
    .run(entry.projectId, entry.factId);
  stmt(db, `
    INSERT INTO fts_lore (project_id, fact_id, entity_name, note, source)
    VALUES (?, ?, ?, ?, ?);
  `).run(entry.projectId, entry.factId, entry.entityName, entry.note, entry.source);
}

/** Upserts a deconstruction sample or technique card into `fts_library`. */
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
  stmt(db, "DELETE FROM fts_library WHERE item_id = ? AND item_kind = ?;")
    .run(entry.itemId, entry.itemKind);
  stmt(db, `
    INSERT INTO fts_library (item_id, item_kind, scope, project_id, title, body)
    VALUES (?, ?, ?, ?, ?, ?);
  `).run(entry.itemId, entry.itemKind, entry.scope, entry.projectId ?? "", entry.title, entry.body);
}

/** Removes a library entry from `fts_library`. */
export function deleteLibraryFts(
  db: SqliteDatabase,
  itemId: string,
  itemKind: "deconstruction" | "technique",
): void {
  stmt(db, "DELETE FROM fts_library WHERE item_id = ? AND item_kind = ?;").run(itemId, itemKind);
}

/** Rebuilds FTS indexes for one project from authoritative base tables. */
export function rebuildProjectFts(db: SqliteDatabase, projectId: string): void {
  stmt(db, "DELETE FROM fts_chapters WHERE project_id = ?;").run(projectId);
  const chapters = stmt(db, `
    SELECT a.id AS documentId, a.title, a.summary, COALESCE(r.body, '') AS body
    FROM author_documents a
    JOIN documents d ON d.document_id = a.id
    LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
    WHERE a.project_id = ?;
  `).all(projectId) as readonly { documentId: string; title: string; summary: string; body: string }[];
  for (const ch of chapters) {
    syncChapterFts(db, { projectId, ...ch });
  }

  stmt(db, "DELETE FROM fts_lore WHERE project_id = ?;").run(projectId);
  const loreRows = stmt(db, `
    SELECT fact_id AS factId, entity_name AS entityName, value
    FROM author_lore_current
    WHERE project_id = ?;
  `).all(projectId) as readonly { factId: string; entityName: string; value: string }[];
  for (const row of loreRows) {
    const parsed = JSON.parse(row.value) as { note?: string; source?: string };
    syncLoreFts(db, {
      projectId,
      factId: row.factId,
      entityName: row.entityName,
      note: parsed.note ?? "",
      source: parsed.source ?? "",
    });
  }
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

/**
 * Searches chapters, lore, deconstructions, and technique cards.
 * Uses SQLite FTS5 `trigram` when the query has >= 3 code points, and
 * falls back to escaped `LIKE` matching for 1–2 character Chinese queries.
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
  const scopes = new Set<FtsSearchScope>(
    options.scopes && options.scopes.length > 0
      ? options.scopes
      : ["chapter", "lore", "deconstruction", "technique"],
  );
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  const useFts = [...needle].length >= 3;
  const ftsQuery = escapeFtsPhrase(needle);
  const likeQuery = escapeLike(needle);
  const hits: FtsSearchHit[] = [];

  if (scopes.has("chapter")) {
    const rows = useFts
      ? (stmt(db, `
          SELECT document_id AS id, title,
            snippet(fts_chapters, 4, '[', ']', '…', 14) AS bodySnip,
            snippet(fts_chapters, 3, '[', ']', '…', 14) AS sumSnip
          FROM fts_chapters
          WHERE project_id = ? AND fts_chapters MATCH ?
          LIMIT ?;
        `).all(options.projectId, ftsQuery, limit) as readonly {
          id: string; title: string; bodySnip: string; sumSnip: string;
        }[])
      : (stmt(db, `
          SELECT a.id, a.title, a.summary AS sumSnip, COALESCE(r.body, '') AS rawBody
          FROM author_documents a
          JOIN documents d ON d.document_id = a.id
          LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
          WHERE a.project_id = ?
            AND (a.title LIKE ? ESCAPE '\\' OR a.summary LIKE ? ESCAPE '\\' OR COALESCE(r.body, '') LIKE ? ESCAPE '\\')
          LIMIT ?;
        `).all(options.projectId, likeQuery, likeQuery, likeQuery, limit) as readonly {
          id: string; title: string; sumSnip: string; rawBody: string;
        }[]).map((row) => ({
          id: row.id,
          title: row.title,
          sumSnip: row.sumSnip,
          bodySnip: makePreviewSnippet(row.rawBody || row.sumSnip || row.title, needle),
        }));
    for (const row of rows) {
      hits.push({
        scope: "chapter",
        id: row.id,
        title: row.title || "未命名章节",
        subtitle: "章节正文 / 摘要",
        snippet: row.bodySnip || row.sumSnip || row.title,
      });
    }
  }

  if (scopes.has("lore")) {
    const rows = useFts
      ? (stmt(db, `
          SELECT fact_id AS id, entity_name AS entityName,
            snippet(fts_lore, 3, '[', ']', '…', 14) AS snip
          FROM fts_lore
          WHERE project_id = ? AND fts_lore MATCH ?
          LIMIT ?;
        `).all(options.projectId, ftsQuery, limit) as readonly { id: string; entityName: string; snip: string }[])
      : (stmt(db, `
          SELECT fact_id AS id, entity_name AS entityName, value
          FROM author_lore_current
          WHERE project_id = ? AND (fact_id LIKE ? ESCAPE '\\' OR entity_name LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')
          LIMIT ?;
        `).all(options.projectId, likeQuery, likeQuery, likeQuery, limit) as readonly {
          id: string; entityName: string; value: string;
        }[]).map((row) => {
          const parsed = JSON.parse(row.value) as { note?: string };
          return {
            id: row.id,
            entityName: row.entityName,
            snip: makePreviewSnippet(parsed.note ?? row.id, needle),
          };
        });
    for (const row of rows) {
      hits.push({
        scope: "lore",
        id: row.id,
        title: row.entityName ? `${row.entityName} (${row.id})` : row.id,
        subtitle: "动态设定库",
        snippet: row.snip,
      });
    }
  }

  const wantedLibKinds: Array<"deconstruction" | "technique"> = [];
  if (scopes.has("deconstruction")) wantedLibKinds.push("deconstruction");
  if (scopes.has("technique")) wantedLibKinds.push("technique");

  if (wantedLibKinds.length > 0) {
    const rows = useFts
      ? (stmt(db, `
          SELECT item_id AS id, item_kind AS itemKind, scope, title,
            snippet(fts_library, 5, '[', ']', '…', 14) AS snip
          FROM fts_library
          WHERE (scope = 'global' OR project_id = ?) AND fts_library MATCH ?
          LIMIT ?;
        `).all(options.projectId, ftsQuery, limit) as readonly {
          id: string; itemKind: "deconstruction" | "technique"; scope: string; title: string; snip: string;
        }[])
      : [
          ...(scopes.has("deconstruction")
            ? (stmt(db, `
                SELECT id, 'deconstruction' AS itemKind, scope, title,
                  excerpt || ' ' || hook_analysis || ' ' || prose_notes AS body
                FROM library_deconstructions
                WHERE status = 'approved' AND (scope = 'global' OR project_id = ?)
                  AND (title LIKE ? ESCAPE '\\' OR source_book LIKE ? ESCAPE '\\'
                       OR excerpt LIKE ? ESCAPE '\\' OR hook_analysis LIKE ? ESCAPE '\\')
                LIMIT ?;
              `).all(options.projectId, likeQuery, likeQuery, likeQuery, likeQuery, limit) as readonly {
                id: string; itemKind: "deconstruction"; scope: string; title: string; body: string;
              }[])
            : []),
          ...(scopes.has("technique")
            ? (stmt(db, `
                SELECT id, 'technique' AS itemKind, scope, title,
                  trigger_when || ' ' || execution_steps || ' ' || constraints AS body
                FROM library_technique_cards
                WHERE status = 'approved' AND (scope = 'global' OR project_id = ?)
                  AND (title LIKE ? ESCAPE '\\' OR trigger_when LIKE ? ESCAPE '\\'
                       OR execution_steps LIKE ? ESCAPE '\\' OR scene_tags_json LIKE ? ESCAPE '\\')
                LIMIT ?;
              `).all(options.projectId, likeQuery, likeQuery, likeQuery, likeQuery, limit) as readonly {
                id: string; itemKind: "technique"; scope: string; title: string; body: string;
              }[])
            : []),
        ].map((row) => ({ ...row, snip: makePreviewSnippet(row.body || row.title, needle) }));

    for (const row of rows) {
      if (!wantedLibKinds.includes(row.itemKind)) continue;
      hits.push({
        scope: row.itemKind,
        id: row.id,
        title: row.title,
        subtitle: `${row.itemKind === "deconstruction" ? "拆书库" : "技法卡"} · ${row.scope === "global" ? "全局" : "本书"}`,
        snippet: row.snip || row.title,
      });
    }
  }

  return hits.slice(0, limit);
}
