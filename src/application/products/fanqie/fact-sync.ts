import { randomUUID } from "node:crypto";
import { ContractError } from "../../../contracts/index.ts";
import {
  assertForeshadowStatus,
  assertForeshadowTransition,
  mergeFactVersion,
  normalizeLoreCategory,
  type SettingFact,
} from "../../../domain/fanqie/index.ts";
import { anchor, pointAtOffset, precedes } from "../../../domain/shared/index.ts";
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
  const point = pointAtOffset(body, start);
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
    readonly factIdPolicy?: "require" | "generate";
    readonly requireExistingFactIds?: boolean;
  },
) {
  const approvedSettings: string[] = [];
  const evidenceIds: string[] = [];
  const order = ctx.chapterOrder(params.projectId);
  for (const item of params.items) {
    const rawId = optionalText(item, "factId");
    if (!rawId && params.factIdPolicy !== "generate") invalid("factId");
    // A model-supplied id is kept only when it is unique; a collision with an
    // existing fact is exactly the silent merge this path prevents. Legacy pending
    // proposals keep their original ids so they still decide correctly.
    const factId = rawId
      ? params.factIdPolicy === "generate" && params.factById.has(rawId)
        ? `fq-${randomUUID()}`
        : rawId
      : `fq-${randomUUID()}`;
    if (params.requireExistingFactIds && !params.factById.has(factId)) {
      throw new ContractError("gate.denied", {
        action: "proposal.decide",
        reason: "unknown-fact-id",
        factId,
      });
    }
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
    // a later sync must never postpone an earlier "already knew it" point,
    // and it inherits the original effectiveFrom instead of moving the fact.
    const merged = mergeFactVersion(params.factById.get(factId), fact, order);
    approvedSettings.push(commitApprovedFact(ctx, params.projectId, factId, category, entityName, merged));
    params.factById.set(factId, merged);
    if (merged.locked) params.lockedSet.add(factId);
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
    const requested = fs.status === undefined || fs.status === null ? null : assertForeshadowStatus(fs.status);
    const explicitId = upsertExisting ? optionalText(fs, "id") : undefined;
    const title = upsertExisting ? (optionalText(fs, "title") ?? "") : text(fs, "title").trim();
    const factId = optionalText(fs, "factId") ?? null;
    const note = typeof fs.note === "string" ? fs.note.trim() : "";
    const existing = upsertExisting
      ? explicitId
        ? (stmt(ctx.db, "SELECT id, status FROM author_foreshadows WHERE id = ? AND project_id = ?;")
            .get(explicitId, projectId) as { id: string; status: string } | undefined)
        : title
          ? (stmt(ctx.db, `
              SELECT id, status FROM author_foreshadows
              WHERE project_id = ? AND title = ? AND COALESCE(fact_id, '') = COALESCE(?, '');
            `).get(projectId, title, factId) as { id: string; status: string } | undefined)
          : undefined
      : undefined;
    const fsId = existing?.id ?? explicitId ?? randomUUID();
    if (existing) {
      const previous = assertForeshadowStatus(existing.status);
      const status = requested ?? previous;
      if (status !== previous) {
        assertForeshadowTransition(previous, status, { reopen: fs.reopen === true });
      }
      stmt(ctx.db, `
        UPDATE author_foreshadows
        SET status = ?,
            note = CASE WHEN ? != '' THEN ? ELSE note END,
            resolved_chapter_id = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_chapter_id END,
            updated_at = ?
        WHERE id = ? AND project_id = ?;
      `).run(status, note, note, status, chapterId, now, fsId, projectId);
      ctx.event(projectId, "setting", "foreshadow.updated", { id: fsId, status, from: previous });
    } else if (title) {
      const status = requested ?? "planted";
      stmt(ctx.db, `
        INSERT INTO author_foreshadows (
          id, project_id, fact_id, title, planted_chapter_id, planted_point,
          resolved_chapter_id, status, note, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?);
      `).run(fsId, projectId, factId, title, chapterId, status === "resolved" ? chapterId : null, status, note, now);
      ctx.event(projectId, "setting", "foreshadow.updated", { id: fsId, status, from: null });
    } else {
      return;
    }
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
  markMemoryClean = true,
) {
  if (!projectId) invalid("projectId", "project-required");
  assertFanqieProject(ctx, projectId);
  // the stored proposal row pins the chapter. Accepting a
  // caller-supplied documentId would redirect lore, evidence, foreshadows and
  // the memory-sync flag to another chapter while the revision check still
  // checks the original one.
  if (!proposalDocId) invalid("documentId", "chapter-required");
  const doc = ctx.document(proposalDocId);
  if (doc.projectId !== projectId) invalid("documentId", "project-mismatch");

  const currentApproved = approvedFacts(ctx, projectId);
  const lockedSet = new Set(currentApproved.filter((f) => f.locked).map((f) => f.id));
  const factById = new Map(currentApproved.map((f) => [f.id, f]));
  const selectedFactIds = Array.isArray(input.selectedFactIds) ? new Set(input.selectedFactIds.map(String)) : null;
  const selectedNewFacts = Array.isArray(input.selectedNewFactIndices)
    ? new Set(input.selectedNewFactIndices.map(Number))
    : null;
  const selectedKnown = Array.isArray(input.selectedKnownFromIndices)
    ? new Set(input.selectedKnownFromIndices.map(Number))
    : null;
  const selectedFs = Array.isArray(input.selectedForeshadowIndices)
    ? new Set(input.selectedForeshadowIndices.map(Number))
    : null;

  const newFacts = (Array.isArray(edited.newFacts) ? (edited.newFacts as Input[]) : [])
    .filter((_, index) => !selectedNewFacts || selectedNewFacts.has(index));

  const { approvedSettings, evidenceIds } = commitFactBatch(ctx, {
    projectId,
    chapterId: doc.id,
    defaultSource: "AI章节记忆同步（作者确认）",
    items: newFacts,
    lockedSet,
    factById,
    selectedFactIds,
    factIdPolicy: "generate",
    evidenceDoc: { revisionId: doc.revisionId, body: doc.body ?? "" },
  });

  const updates = (Array.isArray(edited.updates) ? (edited.updates as Input[]) : []).map((item) => {
    const factId = optionalText(item, "factId");
    const existing = factId ? factById.get(factId) : undefined;
    const meta = factId
      ? (stmt(ctx.db, `
          SELECT category, entity_name AS entityName FROM author_lore_current WHERE project_id = ? AND fact_id = ?;
        `).get(projectId, factId) as { category?: string; entityName?: string } | undefined)
      : undefined;
    return {
      ...item,
      ...(item.category === undefined && meta?.category ? { category: meta.category } : {}),
      ...(item.entityName === undefined && meta?.entityName ? { entityName: meta.entityName } : {}),
      ...(item.source === undefined && existing?.source ? { source: existing.source } : {}),
    } as Input;
  });
  if (updates.length > 0) {
    const updated = commitFactBatch(ctx, {
      projectId,
      chapterId: doc.id,
      defaultSource: "AI章节记忆更新（作者确认）",
      items: updates,
      lockedSet,
      factById,
      factIdPolicy: "require",
      requireExistingFactIds: true,
      evidenceDoc: { revisionId: doc.revisionId, body: doc.body ?? "" },
    });
    approvedSettings.push(...updated.approvedSettings);
    evidenceIds.push(...updated.evidenceIds);
  }

  const knownUpdates = Array.isArray(edited.knownFromUpdates) ? (edited.knownFromUpdates as Input[]) : [];
  const knownOrder = ctx.chapterOrder(projectId);
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
    // keep the earlier per-character anchor when a later chapter mentions it again.
    const merged = mergeFactVersion(
      existing,
      { ...existing, knownFrom: { [character]: anchor(doc.id, point) } },
      knownOrder,
    );
    approvedSettings.push(
      commitApprovedFact(ctx, projectId, factId, meta?.category ?? "world_rule", meta?.entityName ?? "", merged),
    );
    factById.set(factId, merged);
  });

  const retiredFacts = Array.isArray(edited.retiredFacts) ? (edited.retiredFacts as Input[]) : [];
  const selectedRetirements = Array.isArray(input.selectedRetiredFactIndices)
    ? new Set(input.selectedRetiredFactIndices.map(Number))
    : null;
  retiredFacts.forEach((item, index) => {
    if (selectedRetirements && !selectedRetirements.has(index)) return;
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("retiredFacts", "object-required");
    const factId = text(item, "factId").trim();
    const existing = factById.get(factId);
    if (!existing) invalid("retiredFacts", "unknown-fact");
    if (existing.locked) refuse("proposal.decide", "setting-is-locked");
    const point = item.point === undefined ? 1 : item.point;
    if (typeof point !== "number" || !Number.isSafeInteger(point) || point < 1) invalid("retiredFacts", "invalid-expiry-point");
    const end = anchor(doc.id, point);
    if (!precedes(existing.effectiveFrom, end, knownOrder)) invalid("retiredFacts", "invalid-expiry-point");
    if (existing.effectiveTo && !precedes(end, existing.effectiveTo, knownOrder)) return;
    const meta = stmt(ctx.db, `
      SELECT category, entity_name AS entityName FROM author_lore_current WHERE project_id = ? AND fact_id = ?;
    `).get(projectId, factId) as { category: string; entityName: string };
    const next = { ...existing, effectiveTo: end };
    approvedSettings.push(commitApprovedFact(ctx, projectId, factId, meta.category, meta.entityName, next));
    factById.set(factId, next);
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

  // Only a decision whose chapter was proven unchanged may mark memory clean.
  // An unpinned/hand-written proposal approved after an edit must leave the
  // chapter dirty so the next incremental sync still sees the new text.
  if (markMemoryClean) {
    markChapterMemoryClean(ctx, projectId, doc.id, doc.body ?? "");
  }
  const syncStatus = syncChapterMemoryAndEntities(ctx, projectId, doc.id, doc.body ?? "");
  ctx.event(projectId, "setting", "chapter.memory.synced", { documentId: doc.id, syncStatus });

  return { approvedSettings, foreshadows, evidenceIds, summaryUpdated, unapplied: [], syncStatus };
}
