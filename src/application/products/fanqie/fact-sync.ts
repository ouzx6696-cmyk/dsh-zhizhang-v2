import { randomUUID } from "node:crypto";
import { normalizeLoreCategory, type SettingFact } from "../../../domain/fanqie/index.ts";
import { anchor } from "../../../domain/shared/index.ts";
import { stmt, syncChapterFts } from "../../../storage/index.ts";
import {
  invalid,
  optionalText,
  refuse,
  text,
  type Input,
  type WorkspaceContext,
} from "../../context.ts";
import { materializeApprovedLore } from "./lore.ts";
import { markChapterMemoryClean, syncChapterMemoryAndEntities } from "./memory-sync.ts";
import { approvedFacts, assertFanqieProject } from "./shared.ts";

const FORESHADOW_STATUSES = new Set(["proposed", "planted", "hinted", "resolved", "abandoned"]);

function buildKnownFromMap(
  item: Input,
  chapterId: string,
  point: number,
  category: string,
  entityName: string,
): SettingFact["knownFrom"] {
  const from = anchor(chapterId, point);
  const result: Record<string, { chapterId: string; point: number }> = {};
  if (Array.isArray(item.people)) {
    for (const p of item.people) {
      const ch = typeof p === "string"
        ? p.trim()
        : p && typeof p === "object" && typeof (p as Input).character === "string"
          ? ((p as Input).character as string).trim()
          : "";
      if (ch) result[ch] = from;
    }
  } else if (entityName && category === "character") {
    result[entityName] = from;
  }
  return result;
}

function commitApprovedFact(
  ctx: WorkspaceContext,
  projectId: string,
  factId: string,
  category: string,
  entityName: string,
  fact: SettingFact,
): string {
  const settingId = randomUUID();
  stmt(ctx.db, `
    INSERT INTO author_settings (id, project_id, fact_id, category, entity_name, value, decision)
    VALUES (?, ?, ?, ?, ?, ?, 'approved');
  `).run(settingId, projectId, factId, category, entityName, JSON.stringify(fact));
  const decidedSeq = ctx.event(projectId, "setting", "setting.decided", {
    id: settingId,
    factId,
    decision: "approved",
    fact,
  });
  stmt(ctx.db, "UPDATE author_settings SET decided_seq = ? WHERE id = ?;").run(decidedSeq, settingId);
  materializeApprovedLore(ctx, { projectId, settingId, factId, category, entityName, fact, decidedSeq });
  return settingId;
}

function bindExactEvidence(
  ctx: WorkspaceContext,
  projectId: string,
  docId: string,
  revisionId: string | null,
  body: string,
  factId: string,
  quoteRaw: unknown,
): string | null {
  if (!revisionId || typeof quoteRaw !== "string") return null;
  const quote = quoteRaw.trim();
  if (!quote) return null;
  const start = body.indexOf(quote);
  if (start < 0 || body.indexOf(quote, start + 1) >= 0) return null;
  const point = body.slice(0, start).split(/\r?\n/).length;
  const snapshotId = randomUUID();
  const end = start + quote.length;
  const record = {
    snapshotId,
    revisionId,
    anchor: { chapterId: docId, point: String(point) },
    quoteRange: { start, end },
    verification: { kind: "exact", score: 100 },
  };
  stmt(ctx.db, `
    INSERT INTO author_evidence (
      snapshot_id, project_id, document_id, fact_id, revision_id,
      point, quote_start, quote_end, verification_kind, verification_score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'exact', 100);
  `).run(snapshotId, projectId, docId, factId, revisionId, point, start, end);
  ctx.event(projectId, "evidence", "evidence.recorded", { factId, record });
  return snapshotId;
}

export function commitFactBatch(
  ctx: WorkspaceContext,
  params: {
    readonly projectId: string;
    readonly chapterId: string;
    readonly defaultSource: string;
    readonly items: readonly Input[];
    readonly lockedSet: Set<string>;
    readonly factById: Map<string, SettingFact>;
    readonly selectedFactIds?: Set<string> | null;
    readonly evidenceDoc?: { readonly revisionId: string | null; readonly body: string } | null;
  },
) {
  const approvedSettings: string[] = [];
  const evidenceIds: string[] = [];
  for (const item of params.items) {
    const factId = text(item, "factId").trim();
    if (params.selectedFactIds && !params.selectedFactIds.has(factId)) continue;
    if (params.lockedSet.has(factId)) refuse("proposal.decide", "setting-is-locked");
    const point = typeof item.point === "number" && Number.isSafeInteger(item.point) && item.point >= 1
      ? item.point
      : 1;
    const category = normalizeLoreCategory(item.category, "fact");
    const entityName = typeof item.entityName === "string" ? item.entityName.trim() : "";
    const fact: SettingFact = {
      id: factId,
      note: text(item, "note"),
      source: typeof item.source === "string" && item.source.trim() ? item.source.trim() : params.defaultSource,
      kind: category === "agreement" ? "agreement" : "fact",
      locked: item.locked === true,
      effectiveFrom: anchor(params.chapterId, point),
      knownFrom: buildKnownFromMap(item, params.chapterId, point, category, entityName),
    };
    approvedSettings.push(commitApprovedFact(ctx, params.projectId, factId, category, entityName, fact));
    params.factById.set(factId, fact);
    if (fact.locked) params.lockedSet.add(factId);
    if (params.evidenceDoc) {
      const snapId = bindExactEvidence(
        ctx,
        params.projectId,
        params.chapterId,
        params.evidenceDoc.revisionId,
        params.evidenceDoc.body,
        factId,
        item.quote,
      );
      if (snapId) evidenceIds.push(snapId);
    }
  }
  return { approvedSettings, evidenceIds };
}

export function commitForeshadowBatch(
  ctx: WorkspaceContext,
  projectId: string,
  chapterId: string,
  items: readonly Input[],
  upsertExisting: boolean,
  selectedIndices?: Set<number> | null,
): string[] {
  const ids: string[] = [];
  const now = Date.now();
  items.forEach((fs, idx) => {
    if (selectedIndices && !selectedIndices.has(idx)) return;
    const status = typeof fs.status === "string" && FORESHADOW_STATUSES.has(fs.status) ? fs.status : "planted";
    const explicitId = upsertExisting ? optionalText(fs, "id") : undefined;
    const title = upsertExisting ? (optionalText(fs, "title") ?? "") : text(fs, "title").trim();
    const factId = optionalText(fs, "factId") ?? null;
    const note = typeof fs.note === "string" ? fs.note.trim() : "";
    const existing = upsertExisting
      ? explicitId
        ? (stmt(ctx.db, "SELECT id FROM author_foreshadows WHERE id = ? AND project_id = ?;")
            .get(explicitId, projectId) as { id: string } | undefined)
        : title
          ? (stmt(ctx.db, `
              SELECT id FROM author_foreshadows
              WHERE project_id = ? AND title = ? AND COALESCE(fact_id, '') = COALESCE(?, '');
            `).get(projectId, title, factId) as { id: string } | undefined)
          : undefined
      : undefined;
    const fsId = existing?.id ?? explicitId ?? randomUUID();
    if (existing) {
      stmt(ctx.db, `
        UPDATE author_foreshadows
        SET status = ?,
            note = CASE WHEN ? != '' THEN ? ELSE note END,
            resolved_chapter_id = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_chapter_id END,
            updated_at = ?
        WHERE id = ?;
      `).run(status, note, note, status, chapterId, now, fsId);
    } else if (title) {
      stmt(ctx.db, `
        INSERT INTO author_foreshadows (
          id, project_id, fact_id, title, planted_chapter_id, planted_point,
          resolved_chapter_id, status, note, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?);
      `).run(fsId, projectId, factId, title, chapterId, status === "resolved" ? chapterId : null, status, note, now);
    } else {
      return;
    }
    ctx.event(projectId, "setting", "foreshadow.updated", { id: fsId, status });
    ids.push(fsId);
  });
  return ids;
}

/**
 * Atomic `CHAPTER_COMMIT` multi-table projection for confirmed `fact_sync` proposals:
 * commits approved lore & `knownFrom` updates, binds exact-quote evidence, upserts
 * foreshadows, saves optional chapter summary, and marks memory `clean`.
 */
export function commitFactSyncProposal(
  ctx: WorkspaceContext,
  proposalDocId: string | null,
  projectId: string | null,
  edited: Record<string, unknown>,
  input: Input,
) {
  if (!projectId) invalid("projectId", "project-required");
  assertFanqieProject(ctx, projectId);
  const targetDocId = optionalText(input, "documentId") ?? proposalDocId;
  if (!targetDocId) invalid("documentId", "document-required");
  const doc = ctx.document(targetDocId);
  if (doc.projectId !== projectId) invalid("documentId", "project-mismatch");

  const currentApproved = approvedFacts(ctx, projectId);
  const lockedSet = new Set(currentApproved.filter((f) => f.locked).map((f) => f.id));
  const factById = new Map(currentApproved.map((f) => [f.id, f]));
  const selectedFactIds = Array.isArray(input.selectedFactIds) ? new Set(input.selectedFactIds.map(String)) : null;
  const selectedKnown = Array.isArray(input.selectedKnownFromIndices)
    ? new Set(input.selectedKnownFromIndices.map(Number))
    : null;
  const selectedFs = Array.isArray(input.selectedForeshadowIndices)
    ? new Set(input.selectedForeshadowIndices.map(Number))
    : null;

  const { approvedSettings, evidenceIds } = commitFactBatch(ctx, {
    projectId,
    chapterId: doc.id,
    defaultSource: "AI章节记忆同步（作者确认）",
    items: Array.isArray(edited.newFacts) ? (edited.newFacts as Input[]) : [],
    lockedSet,
    factById,
    selectedFactIds,
    evidenceDoc: { revisionId: doc.revisionId, body: doc.body ?? "" },
  });

  const knownUpdates = Array.isArray(edited.knownFromUpdates) ? (edited.knownFromUpdates as Input[]) : [];
  knownUpdates.forEach((upd, idx) => {
    if (selectedKnown && !selectedKnown.has(idx)) return;
    const factId = text(upd, "factId").trim();
    const character = text(upd, "character").trim();
    if (lockedSet.has(factId)) refuse("proposal.decide", "setting-is-locked");
    const existing = factById.get(factId);
    if (!existing) return;
    const meta = stmt(ctx.db, `
      SELECT category, entity_name AS entityName FROM author_lore_current WHERE project_id = ? AND fact_id = ?;
    `).get(projectId, factId) as { category?: string; entityName?: string } | undefined;
    const point = typeof upd.point === "number" && Number.isSafeInteger(upd.point) && upd.point >= 1
      ? upd.point
      : 1;
    const merged: SettingFact = {
      ...existing,
      knownFrom: { ...existing.knownFrom, [character]: anchor(doc.id, point) },
    };
    approvedSettings.push(
      commitApprovedFact(ctx, projectId, factId, meta?.category ?? "world_rule", meta?.entityName ?? "", merged),
    );
    factById.set(factId, merged);
  });

  const foreshadows = commitForeshadowBatch(
    ctx,
    projectId,
    doc.id,
    Array.isArray(edited.foreshadowUpdates) ? (edited.foreshadowUpdates as Input[]) : [],
    true,
    selectedFs,
  );

  let summaryUpdated = false;
  if (input.applySummary !== false && typeof edited.summaryDraft === "string" && edited.summaryDraft.trim()) {
    const summary = edited.summaryDraft.trim();
    stmt(ctx.db, "UPDATE author_documents SET summary = ?, updated_at = ? WHERE id = ?;").run(summary, Date.now(), doc.id);
    syncChapterFts(ctx.db, { projectId, documentId: doc.id, title: doc.title, summary, body: doc.body ?? "" });
    ctx.event(projectId, "chapter", "chapter.summary", { documentId: doc.id });
    summaryUpdated = true;
  }

  markChapterMemoryClean(ctx, projectId, doc.id, doc.body ?? "");
  syncChapterMemoryAndEntities(ctx, projectId, doc.id, doc.body ?? "");
  ctx.event(projectId, "setting", "chapter.memory.synced", { documentId: doc.id, syncStatus: "clean" });

  return { approvedSettings, foreshadows, evidenceIds, summaryUpdated, syncStatus: "clean" as const };
}
