import type { MemorySyncStatus } from "../../../contracts/workspace-dto.ts";
import { splitChapterParagraphs } from "../../../domain/shared/index.ts";
import { stmt } from "../../../storage/index.ts";
import { sha256Text } from "../../digest.ts";
import type { WorkspaceContext } from "../../context.ts";

export interface ParagraphDeltaResult {
  readonly hasBaseline: boolean;
  readonly deltaText: string;
  readonly changedParagraphCount: number;
}

export { sha256Text } from "../../digest.ts";

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  let count = 0;
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

/**
 * Paragraph boundaries come from the shared splitter so the delta markers use
 * the same "one non-empty line is one paragraph" rule as evidence anchors and
 * diagnostics (FQ-02). Trailing/leading spaces stay out of the comparison text.
 */
function splitParagraphs(text: string): string[] {
  return splitChapterParagraphs(text).map((span) => span.text.trim());
}

/**
 * Computes incremental paragraph-level diff between the last memory-synced
 * chapter snapshot and the current draft body so `fact_sync` transmits only
 * changed/added paragraphs instead of resending unchanged prose.
 */
export function computeParagraphDelta(previousBody: string, currentBody: string): ParagraphDeltaResult {
  const curParas = splitParagraphs(currentBody);
  if (!previousBody.trim()) {
    return {
      hasBaseline: false,
      deltaText: currentBody,
      changedParagraphCount: curParas.length,
    };
  }
  const prevParas = splitParagraphs(previousBody);
  const m = prevParas.length;
  const n = curParas.length;

  const matchedPrev = new Uint8Array(m);
  const matchedCur = new Uint8Array(n);

  if (m * n <= 250_000) {
    const width = n + 1;
    const dp = new Int32Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (prevParas[i] === curParas[j]) {
          dp[i * width + j] = dp[(i + 1) * width + (j + 1)] + 1;
        } else {
          const down = dp[(i + 1) * width + j];
          const right = dp[i * width + (j + 1)];
          dp[i * width + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (prevParas[i] === curParas[j]) {
        matchedPrev[i] = 1;
        matchedCur[j] = 1;
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        i += 1;
      } else {
        j += 1;
      }
    }
  } else {
    const prevSet = new Set(prevParas);
    const curSet = new Set(curParas);
    for (let i = 0; i < m; i++) {
      if (curSet.has(prevParas[i])) matchedPrev[i] = 1;
    }
    for (let j = 0; j < n; j++) {
      if (prevSet.has(curParas[j])) matchedCur[j] = 1;
    }
  }

  const changedLines: string[] = [];
  for (let j = 0; j < n; j++) {
    if (!matchedCur[j]) {
      changedLines.push(`[P${j + 1}] ${curParas[j]}`);
    }
  }
  const removedLines: string[] = [];
  for (let i = 0; i < m; i++) {
    if (!matchedPrev[i]) {
      removedLines.push(`- [删减原P${i + 1}] ${prevParas[i].slice(0, 120)}`);
    }
  }

  if (changedLines.length > 0) {
    return {
      hasBaseline: true,
      deltaText: changedLines.join("\n\n"),
      changedParagraphCount: changedLines.length,
    };
  }
  if (removedLines.length > 0) {
    return {
      hasBaseline: true,
      deltaText: `[段落删减]\n${removedLines.join("\n")}`,
      changedParagraphCount: removedLines.length,
    };
  }
  return {
    hasBaseline: true,
    deltaText: "[仅空白或格式微调]",
    changedParagraphCount: 0,
  };
}

/**
 * Updates SHA-256 memory drift status (`clean` | `dirty`) and refreshes
 * zero-token entity occurrences in `author_chapter_entities` on draft save.
 */
export function syncChapterMemoryAndEntities(
  ctx: WorkspaceContext,
  projectId: string,
  documentId: string,
  body: string,
): MemorySyncStatus {
  const bodyHash = body.length > 0 ? sha256Text(body) : "";
  const existing = stmt(ctx.db, `
    SELECT synced_body_sha256 AS syncedHash, synced_body AS syncedBody
    FROM author_chapter_memory_sync
    WHERE document_id = ?;
  `).get(documentId) as { syncedHash?: string; syncedBody?: string } | undefined;

  const syncedHash = existing?.syncedHash ?? "";
  const syncedBody = existing?.syncedBody ?? "";
  const syncStatus: MemorySyncStatus = bodyHash !== syncedHash ? "dirty" : "clean";
  const now = Date.now();

  stmt(ctx.db, `
    INSERT INTO author_chapter_memory_sync (
      document_id, project_id, current_body_sha256, synced_body_sha256,
      synced_body, sync_status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (document_id) DO UPDATE SET
      current_body_sha256 = excluded.current_body_sha256,
      sync_status = CASE
        WHEN excluded.current_body_sha256 != author_chapter_memory_sync.synced_body_sha256 THEN 'dirty'
        ELSE 'clean'
      END,
      updated_at = excluded.updated_at;
  `).run(documentId, projectId, bodyHash, syncedHash, syncedBody, syncStatus, now);

  const loreEntities = stmt(ctx.db, `
    SELECT fact_id AS factId, entity_name AS entityName, category
    FROM author_lore_current
    WHERE project_id = ? AND entity_name != '';
  `).all(projectId) as readonly { factId: string; entityName: string; category: string }[];

  stmt(ctx.db, "DELETE FROM author_chapter_entities WHERE document_id = ?;").run(documentId);
  if (body.length > 0 && loreEntities.length > 0) {
    const insertEntity = stmt(ctx.db, `
      INSERT INTO author_chapter_entities (
        document_id, project_id, fact_id, entity_name, category, mention_count
      ) VALUES (?, ?, ?, ?, ?, ?);
    `);
    for (const entity of loreEntities) {
      const name = entity.entityName.trim();
      if (name.length < 2) continue;
      const mentions = countOccurrences(body, name);
      if (mentions > 0) {
        insertEntity.run(documentId, projectId, entity.factId, name, entity.category, mentions);
      }
    }
  }
  return syncStatus;
}

/**
 * Zero-token backfill across all chapters in a project whenever an approved
 * lore entry introduces or renames an entity name.
 */
export function refreshEntityMentionsForFact(
  ctx: WorkspaceContext,
  projectId: string,
  factId: string,
  entityName: string,
  category: string,
): void {
  const name = entityName.trim();
  stmt(ctx.db, "DELETE FROM author_chapter_entities WHERE project_id = ? AND fact_id = ?;")
    .run(projectId, factId);
  if (name.length < 2) return;

  const chapters = stmt(ctx.db, `
    SELECT a.id AS documentId, COALESCE(r.body, '') AS body
    FROM author_documents a
    JOIN documents d ON d.document_id = a.id
    LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
    WHERE a.project_id = ?;
  `).all(projectId) as readonly { documentId: string; body: string }[];

  const insertEntity = stmt(ctx.db, `
    INSERT INTO author_chapter_entities (
      document_id, project_id, fact_id, entity_name, category, mention_count
    ) VALUES (?, ?, ?, ?, ?, ?);
  `);
  for (const ch of chapters) {
    const mentions = countOccurrences(ch.body, name);
    if (mentions > 0) {
      insertEntity.run(ch.documentId, projectId, factId, name, category, mentions);
    }
  }
}

export function markChapterMemoryClean(
  ctx: WorkspaceContext,
  projectId: string,
  documentId: string,
  body: string,
): void {
  const hash = body.length > 0 ? sha256Text(body) : "";
  stmt(ctx.db, `
    INSERT INTO author_chapter_memory_sync (
      document_id, project_id, current_body_sha256, synced_body_sha256,
      synced_body, sync_status, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'clean', ?)
    ON CONFLICT (document_id) DO UPDATE SET
      current_body_sha256 = excluded.current_body_sha256,
      synced_body_sha256 = excluded.synced_body_sha256,
      synced_body = excluded.synced_body,
      sync_status = 'clean',
      updated_at = excluded.updated_at;
  `).run(documentId, projectId, hash, hash, body, Date.now());
}

export function getChapterSyncStatus(ctx: WorkspaceContext, documentId: string): MemorySyncStatus {
  const row = stmt(ctx.db, "SELECT sync_status AS syncStatus FROM author_chapter_memory_sync WHERE document_id = ?;")
    .get(documentId) as { syncStatus?: string } | undefined;
  return row?.syncStatus === "dirty" ? "dirty" : "clean";
}

export function getChapterMemorySyncRecord(
  ctx: WorkspaceContext,
  documentId: string,
): {
  readonly syncedBody: string;
  readonly syncedHash: string;
  readonly currentHash: string;
  readonly syncStatus: MemorySyncStatus;
} | null {
  const row = stmt(ctx.db, `
    SELECT synced_body AS syncedBody, synced_body_sha256 AS syncedHash,
      current_body_sha256 AS currentHash, sync_status AS syncStatus
    FROM author_chapter_memory_sync
    WHERE document_id = ?;
  `).get(documentId) as
    | { syncedBody: string; syncedHash: string; currentHash: string; syncStatus: string }
    | undefined;
  if (!row) return null;
  return {
    syncedBody: row.syncedBody,
    syncedHash: row.syncedHash,
    currentHash: row.currentHash,
    syncStatus: row.syncStatus === "dirty" ? "dirty" : "clean",
  };
}
