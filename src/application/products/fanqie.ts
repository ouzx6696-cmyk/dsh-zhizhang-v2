import { randomUUID } from "node:crypto";
import {
  assertChapterFinalizable,
  assertChapterTransition,
  chapterLengthWarnings,
  EDITORIAL_REJECTION_LIMIT,
  OUTLINE_SECTIONS,
  scanAiSlop,
  settingsAt,
  type ChapterState,
  type SettingFact,
} from "../../domain/fanqie/index.ts";
import { pointAtOffset } from "../../domain/shared/index.ts";
import { stmt, type SqliteDatabase } from "../../storage/index.ts";
import { projectReadUnit, type AuthorReadUnitFactory } from "../../workflow/author-reads.ts";
import {
  count,
  invalid,
  optionalText,
  refuse,
  text,
  type DocumentRow,
  type Input,
  type WorkspaceContext,
} from "../context.ts";
import type { ActionDefinition, ProductLineModule } from "../product-line.ts";
import {
  buildFanqieFrozenContext,
  createFanqieGenerationRunner,
  formatTechniquesBlock,
  previewContext,
} from "./fanqie/context.ts";
import { getProjectControls, loadProjectControls, saveProjectControls } from "./fanqie/controls.ts";
import {
  createObservation,
  diagnoseChapter,
  getSlopConfig,
  listObservations,
  loadSlopConfig,
  saveSlopConfig,
  updateObservation,
} from "./fanqie/diagnostics.ts";
import { exportProjectBundle, importProjectBundle, type ProjectBundleDiskWriter } from "./fanqie/io.ts";
import {
  computeParagraphDelta,
  getChapterMemorySyncRecord,
  getChapterSyncStatus,
  syncChapterMemoryAndEntities,
} from "./fanqie/memory-sync.ts";
import { importSkillDocument } from "./fanqie/skill-importer.ts";
import { approvedFacts } from "./fanqie/shared.ts";
import {
  createManualProposal,
  decideProposal,
  deleteDeconstruction,
  deleteTechnique,
  listDeconstructions,
  listLibraryMounts,
  listProposals,
  listTechniques,
  mountLibraryItem,
  recommendTechniquesForChapter,
  resolveMountedLibraryForChapter,
  saveDeconstruction,
  saveTechnique,
  unmountLibraryItem,
} from "./fanqie/library.ts";
import {
  createForeshadow,
  handleContinuity,
  listForeshadows,
  listLore,
  patchForeshadow,
  scanLoreConflicts,
  settingsPage,
  upsertForeshadow,
} from "./fanqie/lore.ts";
import { searchFanqieWorkspace } from "./fanqie/search.ts";
import { initFanqieSchema } from "./fanqie/schema.ts";
import { createFanqieAgentTools } from "./fanqie/tools.ts";
import {
  attachChapterToTree,
  createAct,
  createVolume,
  deleteAct,
  deleteVolume,
  getTree,
  moveChapter,
  saveChapterSummary,
  updateAct,
  updateVolume,
} from "./fanqie/tree.ts";
import { anchor } from "../../domain/shared/index.ts";

/**
 * Fanqie (serialized novel) product-line module.
 * Depends strictly on `domain/fanqie` and `domain/shared` — never `domain/toutiao`.
 */
export function createFanqieModule(writeProjectExport?: ProjectBundleDiskWriter): ProductLineModule {
  const runGeneration = createFanqieGenerationRunner();

  function initSchema(db: SqliteDatabase): void {
    initFanqieSchema(db);
  }

  function recordEvidence(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    if (row.product !== "fanqie") invalid("documentId", "chapter-required");
    return ctx.atomic(() => {
      const current = ctx.document(row.id);
      ctx.currentBody(current, input);
      const quote = text(input, "quote");
      const factId = text(input, "factId");
      const body = current.body ?? "";
      const start = body.indexOf(quote);
      if (start < 0 || body.indexOf(quote, start + 1) >= 0) {
        invalid("quote", "quote-must-match-exactly-once");
      }
      const point = pointAtOffset(body, start);
      const snapshotId = randomUUID();
      const end = start + quote.length;
      const record = {
        snapshotId,
        revisionId: current.revisionId,
        anchor: { chapterId: row.id, point: String(point) },
        quoteRange: { start, end },
        verification: { kind: "exact", score: 100 },
      };
      stmt(ctx.db, `
        INSERT INTO author_evidence (
          snapshot_id, project_id, document_id, fact_id, revision_id,
          point, quote_start, quote_end, verification_kind, verification_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'exact', 100);
      `).run(snapshotId, row.projectId, row.id, factId, current.revisionId!, point, start, end);
      ctx.event(row.projectId, "evidence", "evidence.recorded", { factId, record });
      return record;
    });
  }

  function evidenceDetail(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    if (row.product !== "fanqie") invalid("documentId", "chapter-required");
    return ctx.readAuthorModel(row.projectId, { model: "evidence", factId: text(input, "factId") });
  }

  function saveOutline(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    return ctx.atomic(() => {
      if (row.product !== "fanqie") invalid("documentId", "chapter-required");
      const viewpoint = text(input, "viewpoint");
      const target = count(input, "target");
      if (!target) invalid("target", "positive-length-required");
      const sections = Object.fromEntries(OUTLINE_SECTIONS.map((name) => [name, text(input, name)]));
      const value = {
        viewpoint,
        target,
        sections,
        lockedFacts: text(input, "lockedFacts"),
        knowledge: text(input, "knowledge"),
      };
      ctx.savePlanning(row, value);
      return { ...value, warnings: chapterLengthWarnings(target) };
    });
  }

  function reviewChapter(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    return ctx.atomic(() => {
      const current = ctx.document(row.id);
      ctx.currentBody(current, input);
      if (current.product !== "fanqie" || current.state === "final") {
        refuse("chapter.review", "chapter-not-reviewable");
      }
      if (typeof input.accept !== "boolean") invalid("accept");
      if (!input.accept && current.editorialRejections >= EDITORIAL_REJECTION_LIMIT) {
        refuse("chapter.review", "editorial-rejection-limit");
      }
      const state: ChapterState = input.accept ? "reviewed" : "drafted";
      assertChapterTransition(current.state as ChapterState, state);
      stmt(ctx.db, `
        UPDATE author_documents
        SET state = ?, editorial_rejections = editorial_rejections + ?, updated_at = ?
        WHERE id = ?;
      `).run(state, input.accept ? 0 : 1, Date.now(), row.id);
      ctx.event(row.projectId, "chapter", "chapter.reviewed", { documentId: row.id, state });
      return { state };
    });
  }

  function finalizeChapter(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    return ctx.dispatch("draft.finalize", row, input, () => {
      const current = ctx.document(row.id);
      if (current.product !== "fanqie" || !current.revisionId) {
        refuse("draft.finalize", "chapter-required");
      }
      assertChapterFinalizable(current.state as ChapterState, current.editorialRejections);
      stmt(ctx.db, "UPDATE author_documents SET state = 'final', final_revision_id = ?, updated_at = ? WHERE id = ?;")
        .run(current.revisionId, Date.now(), row.id);
      ctx.event(row.projectId, "chapter", "document.state", { documentId: row.id, state: "final" });
      ctx.event(row.projectId, "revision", "revision.finalized", {
        documentId: row.id,
        revisionId: current.revisionId,
      });
      return { revisionId: current.revisionId };
    });
  }

  const readModels: Readonly<Record<string, AuthorReadUnitFactory>> = {
    "settings-view": (definition, _projectId, identity, point) => {
      const [chapterId, characterId] = identity;
      return projectReadUnit(
        definition,
        () => ({ order: [] as string[], facts: [] as SettingFact[] }),
        (state, event) => {
          if (event.kind === "document.created") {
            return { ...state, order: [...state.order, event.documentId as string] };
          }
          if (event.kind === "chapter.reordered") {
            return { ...state, order: event.chapterIds as string[] };
          }
          if (event.kind === "setting.decided" && event.decision === "approved" && event.fact) {
            return { ...state, facts: [...state.facts, event.fact as SettingFact] };
          }
          return state;
        },
        ({ order, facts }) => ({
          query: { asOfChapter: chapterId, characterId },
          entries: settingsAt(facts, order, anchor(chapterId, point), characterId).map((fact) => ({
            factId: fact.id,
            note: fact.note,
            effectiveFrom: fact.effectiveFrom.chapterId,
          })),
        }),
      );
    },
    evidence: (definition, _projectId, identity) => {
      const [factId] = identity;
      return projectReadUnit(
        definition,
        () => ({ record: null as Record<string, unknown> | null }),
        (state, event) => {
          if (event.kind !== "evidence.recorded" || event.factId !== factId) return state;
          return { record: event.record as Record<string, unknown> };
        },
        ({ record }) => record ?? {},
      );
    },
  };

  const actions: Readonly<Record<string, ActionDefinition>> = {
    "setting.propose": { scope: "project", handler: (ctx, input) => handleContinuity("setting.propose", ctx, input) },
    "setting.decide": { scope: "project", handler: (ctx, input) => handleContinuity("setting.decide", ctx, input) },
    "settings.history": { scope: "project", handler: (ctx, input) => handleContinuity("settings.history", ctx, input) },
    "settings.read": { scope: "project", handler: (ctx, input) => handleContinuity("settings.read", ctx, input) },
    "reorder.impact": { scope: "project", handler: (ctx, input) => handleContinuity("reorder.impact", ctx, input) },
    "reorder.commit": { scope: "project", handler: (ctx, input) => handleContinuity("reorder.commit", ctx, input) },
    "chapter.outline": { scope: "document", handler: (ctx, input, row) => saveOutline(ctx, row!, input) },
    "chapter.review": { scope: "document", handler: (ctx, input, row) => reviewChapter(ctx, row!, input) },
    "draft.finalize": { scope: "document", handler: (ctx, input, row) => finalizeChapter(ctx, row!, input) },
    "evidence.record": { scope: "document", handler: (ctx, input, row) => recordEvidence(ctx, row!, input) },
    "evidence.detail": { scope: "document", handler: (ctx, input, row) => evidenceDetail(ctx, row!, input) },
    "tree.get": { scope: "project", handler: (ctx, input) => getTree(ctx, input) },
    "volume.create": { scope: "project", handler: (ctx, input) => createVolume(ctx, input) },
    "volume.update": { scope: "project", handler: (ctx, input) => updateVolume(ctx, input) },
    "volume.delete": { scope: "project", handler: (ctx, input) => deleteVolume(ctx, input) },
    "act.create": { scope: "project", handler: (ctx, input) => createAct(ctx, input) },
    "act.update": { scope: "project", handler: (ctx, input) => updateAct(ctx, input) },
    "act.delete": { scope: "project", handler: (ctx, input) => deleteAct(ctx, input) },
    "chapter.move": { scope: "document", handler: (ctx, input, row) => moveChapter(ctx, row!, input) },
    "chapter.summary.save": { scope: "document", handler: (ctx, input, row) => saveChapterSummary(ctx, row!, input) },
    "lore.list": { scope: "project", handler: (ctx, input) => listLore(ctx, input) },
    "lore.conflicts": { scope: "project", handler: (ctx, input) => scanLoreConflicts(ctx, input) },
    "foreshadow.upsert": { scope: "project", handler: (ctx, input) => upsertForeshadow(ctx, input) },
    "foreshadow.create": { scope: "project", handler: (ctx, input) => createForeshadow(ctx, input) },
    "foreshadow.patch": { scope: "project", handler: (ctx, input) => patchForeshadow(ctx, input) },
    "foreshadow.list": { scope: "project", handler: (ctx, input) => listForeshadows(ctx, input) },
    "deconstruct.save": { scope: "global", handler: (ctx, input) => saveDeconstruction(ctx, input) },
    "deconstruct.list": { scope: "global", handler: (ctx, input) => listDeconstructions(ctx, input) },
    "deconstruct.delete": { scope: "global", handler: (ctx, input) => deleteDeconstruction(ctx, input) },
    "technique.save": { scope: "global", handler: (ctx, input) => saveTechnique(ctx, input) },
    "technique.list": { scope: "global", handler: (ctx, input) => listTechniques(ctx, input) },
    "technique.delete": { scope: "global", handler: (ctx, input) => deleteTechnique(ctx, input) },
    "library.mount": { scope: "project", handler: (ctx, input) => mountLibraryItem(ctx, input) },
    "library.unmount": { scope: "project", handler: (ctx, input) => unmountLibraryItem(ctx, input) },
    "library.mounts": { scope: "project", handler: (ctx, input) => listLibraryMounts(ctx, input) },
    "technique.recommend": { scope: "document", handler: (ctx, input, row) => recommendTechniquesForChapter(ctx, row!, input) },
    "context.preview": { scope: "document", handler: (ctx, input, row) => previewContext(ctx, row!, input) },
    "proposal.create": { scope: "global", handler: (ctx, input) => createManualProposal(ctx, input) },
    "proposal.list": { scope: "global", handler: (ctx, input) => listProposals(ctx, input) },
    "proposal.decide": { scope: "global", handler: (ctx, input) => decideProposal(ctx, input) },
    "workspace.search": { scope: "project", handler: (ctx, input) => searchFanqieWorkspace(ctx, input) },
    "project.export_bundle": { scope: "project", handler: (ctx, input) => exportProjectBundle(ctx, input, writeProjectExport) },
    "project.import_bundle": { scope: "global", handler: (ctx, input) => importProjectBundle(ctx, input) },
    "skill.import": { scope: "global", handler: (ctx, input) => importSkillDocument(ctx, input) },
    "chapter.diagnose": { scope: "document", handler: (ctx, _input, row) => diagnoseChapter(ctx, row!) },
    "slop.config.get": { scope: "project", handler: (ctx, input) => getSlopConfig(ctx, input) },
    "slop.config.save": { scope: "project", handler: (ctx, input) => saveSlopConfig(ctx, input) },
    "observation.list": { scope: "document", handler: (ctx, input, row) => listObservations(ctx, row!, input) },
    "observation.create": { scope: "document", handler: (ctx, input, row) => createObservation(ctx, row!, input) },
    "observation.update": { scope: "project", handler: (ctx, input) => updateObservation(ctx, input) },
    "controls.get": { scope: "project", handler: (ctx, input) => getProjectControls(ctx, input) },
    "controls.save": { scope: "project", handler: (ctx, input) => saveProjectControls(ctx, input) },
  };

  return {
    id: "fanqie",
    initialState: "planned",
    lockedStates: ["final"],
    supportsAutoQa: false,
    initSchema,
    validateCreate(_input, title) {
      if (!title) invalid("title", "required");
      return { title, mode: null, line: null };
    },
    onDocumentCreated(ctx, projectId, documentId, input) {
      attachChapterToTree(ctx, projectId, documentId, input);
    },
    onDraftSaved(ctx, row) {
      const next: ChapterState = row.state === "planned" || row.state === "drafting" ? "drafting" : "drafted";
      stmt(ctx.db, "UPDATE author_documents SET state = ? WHERE id = ?;").run(next, row.id);
      syncChapterMemoryAndEntities(ctx, row.projectId, row.id, row.body ?? "");
      ctx.event(row.projectId, "chapter", "document.state", { documentId: row.id, state: next });
    },
    buildActiveContext(ctx, active) {
      return {
        volumeId: active.volumeId,
        volumeTitle: active.volumeId
          ? ((stmt(ctx.db, "SELECT title FROM author_volumes WHERE id = ?;").get(active.volumeId) as { title?: string } | undefined)?.title ?? null)
          : null,
        actId: active.actId,
        actTitle: active.actId
          ? ((stmt(ctx.db, "SELECT title FROM author_acts WHERE id = ?;").get(active.actId) as { title?: string } | undefined)?.title ?? null)
          : null,
        charCount: active.charCount,
        summary: active.summary,
        syncStatus: getChapterSyncStatus(ctx, active.id),
      };
    },
    buildProposalContext(ctx, { kind, projectId, documentId, input }) {
      if (!projectId) return {};
      const existingLoreHints = stmt(ctx.db, `
        SELECT fact_id AS factId, category, entity_name AS entityName
        FROM author_lore_current
        WHERE project_id = ?
        ORDER BY decided_seq DESC LIMIT 40;
      `).all(projectId) as readonly { factId: string; category: string; entityName: string }[];

      if (kind === "setting") {
        return { extra: { existingLoreHints } };
      }
      if (kind === "fact_sync" && documentId) {
        const doc = ctx.document(documentId);
        const body = doc.body ?? "";
        const syncRecord = getChapterMemorySyncRecord(ctx, documentId);
        const delta = computeParagraphDelta(syncRecord?.syncedBody ?? "", body);
        const existingForeshadows = stmt(ctx.db, `
          SELECT id, title, fact_id AS factId, status, note
          FROM author_foreshadows
          WHERE project_id = ? AND status IN ('planted', 'hinted')
          ORDER BY updated_at DESC LIMIT 30;
        `).all(projectId);
        const manualSource = optionalText(input, "sourceText");
        return {
          sourceText: manualSource ?? (body.trim() ? delta.deltaText : ""),
          sourceRef: doc.title,
          extra: {
            hasBaseline: delta.hasBaseline,
            changedParagraphCount: delta.changedParagraphCount,
            existingLoreHints,
            existingForeshadows,
          },
        };
      }
      if (kind === "chapter_review" && documentId) {
        const doc = ctx.document(documentId);
        const order = ctx.chapterOrder(projectId);
        const plan = ctx.planning(doc.id);
        const viewpoint = typeof plan?.viewpoint === "string" ? plan.viewpoint : undefined;
        const knownFacts = viewpoint ? settingsAt(approvedFacts(ctx, projectId), order, anchor(doc.id, 1), viewpoint) : [];
        const diagnostics = diagnoseChapter(ctx, doc);
        const mountedReview = resolveMountedLibraryForChapter(ctx, doc, "", "", "review");
        const reviewMethodology = formatTechniquesBlock(mountedReview.techniques);
        const existingForeshadows = stmt(ctx.db, `
          SELECT id, title, fact_id AS factId, status, note
          FROM author_foreshadows
          WHERE project_id = ? AND status IN ('planted', 'hinted')
          ORDER BY updated_at DESC LIMIT 30;
        `).all(projectId);
        return {
          sourceText: optionalText(input, "sourceText") ?? (doc.body ?? ""),
          sourceRef: doc.title,
          extra: {
            viewpoint: viewpoint ?? "",
            lockedFacts: typeof plan?.lockedFacts === "string" ? plan.lockedFacts : "",
            knownFacts,
            existingLoreHints,
            existingForeshadows,
            diagnostics,
            reviewMethodology,
          },
        };
      }
      if (kind === "arc_plan") {
        const controls = loadProjectControls(ctx, projectId);
        const volumes = stmt(ctx.db, `
          SELECT id, title, goal, summary FROM author_volumes
          WHERE project_id = ? ORDER BY sort_order ASC, rowid ASC;
        `).all(projectId) as readonly { id: string; title: string; goal: string; summary: string }[];
        const acts = stmt(ctx.db, `
          SELECT id, volume_id AS volumeId, title, goal, summary, arc_goal AS arcGoal, arc_summary AS arcSummary
          FROM author_acts WHERE project_id = ? ORDER BY sort_order ASC, rowid ASC;
        `).all(projectId) as readonly {
          id: string;
          volumeId: string;
          title: string;
          goal: string;
          summary: string;
          arcGoal: string;
          arcSummary: string;
        }[];
        const chapters = stmt(ctx.db, `
          SELECT id, title, summary, act_id AS actId FROM author_documents
          WHERE project_id = ? ORDER BY rowid DESC LIMIT 12;
        `).all(projectId) as readonly { id: string; title: string; summary: string; actId: string | null }[];
        const actId = optionalText(input, "actId") ?? null;
        const targetAct = actId ? acts.find((a) => a.id === actId) : acts[acts.length - 1];
        const fallbackSummaryText = [
          ...chapters.map((ch) => `《${ch.title}》：${ch.summary || "（暂无摘要）"}`),
          ...acts.map((a) => `[幕] ${a.title}：${a.arcSummary || a.summary || a.arcGoal || a.goal || ""}`),
          controls.currentFocus ? `[焦点] ${controls.currentFocus}` : "",
          controls.authorIntent ? `[指南针] ${controls.authorIntent}` : "",
        ].filter(Boolean).join("\n") || "（新书初期，暂无卷幕历史，请规划第一幕）";
        return {
          sourceText: optionalText(input, "sourceText") ?? fallbackSummaryText,
          sourceRef: targetAct?.title ?? volumes[0]?.title ?? "全书卷幕规划",
          extra: {
            authorIntent: controls.authorIntent,
            currentFocus: controls.currentFocus,
            targetAct: targetAct ?? null,
            volumes,
            acts,
            recentChapters: [...chapters].reverse(),
          },
        };
      }
      return {};
    },
    buildSelectionContext(ctx, row, mode) {
      const agreements = stmt(ctx.db, `
        SELECT fact_id AS factId, value FROM author_lore_current
        WHERE project_id = ? AND category = 'agreement'
        ORDER BY fact_id ASC;
      `).all(row.projectId) as readonly { factId: string; value: string }[];
      const agreementText = agreements
        .map((entry) => {
          try {
            const parsed = JSON.parse(entry.value) as { note?: string };
            return `- [${entry.factId}] ${parsed.note ?? ""}`;
          } catch {
            return "";
          }
        })
        .filter(Boolean)
        .join("\n");
      const stage = mode === "polish" ? "deslop" : "refine";
      const mounted = resolveMountedLibraryForChapter(ctx, row, "", "", stage);
      const sortedSkills = [...mounted.techniques].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const skillText = formatTechniquesBlock(sortedSkills);
      const cachePrefix = [agreementText, skillText].filter(Boolean).join("\n\n---\n\n") || undefined;

      const plan = ctx.planning(row.id);
      const viewpoint = typeof plan?.viewpoint === "string" ? plan.viewpoint : undefined;
      const order = ctx.chapterOrder(row.projectId);
      const knownFacts = viewpoint ? settingsAt(approvedFacts(ctx, row.projectId), order, anchor(row.id, 1), viewpoint) : [];
      const slopHints = mode === "polish"
        ? scanAiSlop(row.body ?? "", loadSlopConfig(ctx, row.projectId)).topPhrases
        : [];
      return {
        cachePrefix,
        extra: {
          viewpoint: viewpoint ?? "",
          lockedFacts: typeof plan?.lockedFacts === "string" ? plan.lockedFacts : "",
          knownFacts,
          aiSlopHints: slopHints,
        },
      };
    },
    buildFrozenContext(ctx, row, input) {
      return buildFanqieFrozenContext(ctx, row, input);
    },
    runGeneration,
    actions,
    contributeSnapshot(ctx, projectId, active) {
      if (!active) return {};
      const page = settingsPage(ctx, projectId);
      return { settings: page.entries, settingsCursor: page.cursor };
    },
    readModels,
    agentTools: createFanqieAgentTools,
  };
}
