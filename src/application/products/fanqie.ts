import { randomUUID } from "node:crypto";
import { ContractError } from "../../contracts/errors.ts";
import { sha256Text } from "../digest.ts";
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
import { getProjectCollaboration } from "../collaboration.ts";
import type { ActionDefinition, ProductLineModule } from "../product-line.ts";
import {
  buildFanqieFrozenContext,
  buildFanqieLayeredPayload,
  buildFanqieSharedLayeredPrefix,
  createFanqieGenerationRunner,
  formatTechniquesBlock,
  previewContext,
} from "./fanqie/context.ts";
import { chapterVersionOptions } from "../continuation.ts";
import {
  getBookCacheSnapshotAction,
  rebuildBookCacheSnapshotAction,
  touchBookCacheHit,
} from "./fanqie/cache-snapshot.ts";
import {
  getProjectControls,
  loadProjectControls,
  resetProjectContextTuning,
  saveProjectControls,
} from "./fanqie/controls.ts";
import {
  createObservation,
  diagnoseChapter,
  getSlopConfig,
  listObservations,
  loadSlopConfig,
  saveSlopConfig,
  updateObservation,
} from "./fanqie/diagnostics.ts";
import { exportProjectBundle, submitProjectImport, type ProjectBundleDiskWriter } from "./fanqie/io.ts";
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
  getDeconstructionById,
  getTechniqueById,
  listDeconstructions,
  listLibraryMounts,
  listProposals,
  listTechniques,
  mountLibraryItem,
  queryTechniqueRecommendations,
  queryTechniques,
  recommendTechniquesForChapter,
  recordTechniqueOutcome,
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
import {
  cancelAutopilotBatch,
  createAutopilotBatch,
  getAutopilotBatch,
  listAutopilotBatches,
  pauseAutopilotBatch,
  rollbackAutopilotChapter,
  recoverAutopilotBatches,
  runAutopilotBatch,
} from "./fanqie/autopilot.ts";
import {
  commitMaterialIngest,
  discardMaterialIngest,
  getMaterialIngest,
  listMaterialIngests,
  preprocessMaterialIngest,
  proposeMaterialBundle,
  runMaterialExtraction,
  updateMaterialChunks,
} from "./fanqie/material-ingest.ts";
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

  function proposeOrSaveOutline(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    if (row.product !== "fanqie") invalid("documentId", "chapter-required");
    if (ctx.isLockedDocument(row)) refuse("chapter.outline.propose", "revision-locked");
    const previous = ctx.planning(row.id);
    const currentHash = sha256Text(JSON.stringify(previous));
    if (input.basePlanningId !== undefined && input.basePlanningId !== currentHash) {
      throw new ContractError("version.conflict", { documentId: row.id, field: "planning" });
    }
    const existingPlan = previous ?? {};
    const existingSections =
      existingPlan.sections && typeof existingPlan.sections === "object" && !Array.isArray(existingPlan.sections)
        ? (existingPlan.sections as Record<string, string>)
        : {};
    const incomingSectionsRaw =
      input.sections && typeof input.sections === "object" && !Array.isArray(input.sections)
        ? (input.sections as Record<string, unknown>)
        : {};
    const mergedSections: Record<string, string> = { ...existingSections };
    for (const secName of OUTLINE_SECTIONS) {
      const val = incomingSectionsRaw[secName] ?? input[secName];
      if (typeof val === "string" && val.trim()) mergedSections[secName] = val.trim();
    }
    const viewpoint = optionalText(input, "viewpoint") ?? (typeof existingPlan.viewpoint === "string" ? existingPlan.viewpoint : "");
    const targetRaw = typeof input.target === "number" && Number.isFinite(input.target) && input.target > 0
      ? Math.round(input.target)
      : (typeof existingPlan.target === "number" ? existingPlan.target : 3000);
    const lockedFacts = typeof input.lockedFacts === "string"
      ? input.lockedFacts.trim()
      : (typeof existingPlan.lockedFacts === "string" ? existingPlan.lockedFacts : "");
    const knowledge = typeof input.knowledge === "string"
      ? input.knowledge.trim()
      : (typeof existingPlan.knowledge === "string" ? existingPlan.knowledge : "");
    const payload: Record<string, unknown> = {
      viewpoint,
      target: targetRaw,
      sections: mergedSections,
      lockedFacts,
      knowledge,
    };

    const collab = getProjectCollaboration(ctx, row.projectId);
    const forceProposal = input.forceProposal === true;
    if (collab.collaborationMode === "co_create" && !forceProposal) {
      return ctx.atomic(() => {
        ctx.savePlanning(row, payload);
        const writeId = randomUUID();
        stmt(ctx.db, `
          INSERT INTO author_outline_writes (id, document_id, previous_plan, new_plan_hash, created_at)
          VALUES (?, ?, ?, ?, ?);
        `).run(writeId, row.id, previous === null ? null : JSON.stringify(previous), sha256Text(JSON.stringify(payload)), Date.now());
        return {
          writeId,
          mode: "direct_write" as const,
          documentId: row.id,
          planning: payload,
          warnings: chapterLengthWarnings(targetRaw),
        };
      });
    }
    const proposal = createManualProposal(ctx, {
      kind: "outline",
      origin: "agent-tool",
      projectId: row.projectId,
      documentId: row.id,
      sourceRef: `章纲提案《${row.title}》`,
      payload: { ...payload, basePlanningId: currentHash },
    });
    return {
      mode: "proposal" as const,
      proposalId: proposal.id,
      documentId: row.id,
      status: proposal.status,
      planning: payload,
      warnings: chapterLengthWarnings(targetRaw),
    };
  }

  function rollbackOutline(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    return ctx.atomic(() => {
      if (ctx.isLockedDocument(row)) refuse("chapter.outline.rollback", "revision-locked");
      const writeId = text(input, "writeId");
      const write = stmt(ctx.db, `
        SELECT previous_plan AS previousPlan, new_plan_hash AS newPlanHash
        FROM author_outline_writes WHERE id = ? AND document_id = ?;
      `).get(writeId, row.id) as { previousPlan: string | null; newPlanHash: string } | undefined;
      if (!write || write.newPlanHash !== sha256Text(JSON.stringify(ctx.planning(row.id)))) {
        throw new ContractError("version.conflict", { documentId: row.id, field: "planning" });
      }
      if (write.previousPlan === null) {
        stmt(ctx.db, "DELETE FROM author_planning WHERE document_id = ?;").run(row.id);
        ctx.event(row.projectId, "chapter", "document.planning", { documentId: row.id });
      } else {
        ctx.savePlanning(row, JSON.parse(write.previousPlan) as Input);
      }
      stmt(ctx.db, "DELETE FROM author_outline_writes WHERE id = ?;").run(writeId);
      return { documentId: row.id, writeId };
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
    "chapter.outline.rollback": { scope: "document", handler: (ctx, input, row) => rollbackOutline(ctx, row!, input) },
    "chapter.outline.propose": { scope: "document", handler: (ctx, input, row) => proposeOrSaveOutline(ctx, row!, input) },
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
    "deconstruct.get": { scope: "global", handler: (ctx, input) => getDeconstructionById(ctx, input) },
    "deconstruct.delete": { scope: "global", handler: (ctx, input) => deleteDeconstruction(ctx, input) },
    "technique.save": { scope: "global", handler: (ctx, input) => saveTechnique(ctx, input) },
    "technique.list": { scope: "global", handler: (ctx, input) => listTechniques(ctx, input) },
    "technique.get": { scope: "global", handler: (ctx, input) => getTechniqueById(ctx, input) },
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
    "project.import_bundle": { scope: "global", handler: (ctx, input) => submitProjectImport(ctx, input) },
    "skill.import": { scope: "global", handler: (ctx, input) => importSkillDocument(ctx, input) },
    "chapter.diagnose": { scope: "document", handler: (ctx, _input, row) => diagnoseChapter(ctx, row!) },
    "slop.config.get": { scope: "project", handler: (ctx, input) => getSlopConfig(ctx, input) },
    "slop.config.save": { scope: "project", handler: (ctx, input) => saveSlopConfig(ctx, input) },
    "observation.list": { scope: "document", handler: (ctx, input, row) => listObservations(ctx, row!, input) },
    "observation.create": { scope: "document", handler: (ctx, input, row) => createObservation(ctx, row!, input) },
    "observation.update": { scope: "project", handler: (ctx, input) => updateObservation(ctx, input) },
    "controls.get": { scope: "project", handler: (ctx, input) => getProjectControls(ctx, input) },
    "controls.save": { scope: "project", handler: (ctx, input) => saveProjectControls(ctx, input) },
    "controls.reset_context": { scope: "project", handler: (ctx, input) => resetProjectContextTuning(ctx, input) },
    "cache.snapshot": { scope: "project", handler: (ctx, input) => getBookCacheSnapshotAction(ctx, input) },
    "cache.rebuild": { scope: "project", handler: (ctx, input) => rebuildBookCacheSnapshotAction(ctx, input) },
    "material.preprocess": { scope: "project", handler: (ctx, input) => preprocessMaterialIngest(ctx, input) },
    "material.list": { scope: "project", handler: (ctx, input) => listMaterialIngests(ctx, input) },
    "material.get": { scope: "global", handler: (ctx, input) => getMaterialIngest(ctx, input) },
    "material.update_chunks": { scope: "global", handler: (ctx, input) => updateMaterialChunks(ctx, input) },
    "material.propose_bundle": { scope: "project", handler: (ctx, input) => proposeMaterialBundle(ctx, input) },
    "material.commit": { scope: "global", handler: (ctx, input) => commitMaterialIngest(ctx, input) },
    "material.discard": { scope: "global", handler: (ctx, input) => discardMaterialIngest(ctx, input) },
    "autopilot.start": { scope: "project", handler: (ctx, input) => createAutopilotBatch(ctx, input) },
    "autopilot.list": { scope: "project", handler: (ctx, input) => listAutopilotBatches(ctx, input) },
    "autopilot.get": { scope: "global", handler: (ctx, input) => getAutopilotBatch(ctx, input) },
    "autopilot.pause": { scope: "global", handler: (ctx, input) => pauseAutopilotBatch(ctx, input) },
    "autopilot.cancel": { scope: "global", handler: (ctx, input) => cancelAutopilotBatch(ctx, input) },
    "autopilot.rollback_chapter": {
      scope: "global",
      handler: (ctx, input) =>
        rollbackAutopilotChapter(ctx, input, (row, body) =>
          ctx.appendDraftRevision(row, body, (saved) => {
            const next: ChapterState = saved.state === "planned" || saved.state === "drafting" ? "drafting" : "drafted";
            stmt(ctx.db, "UPDATE author_documents SET state = ? WHERE id = ?;").run(next, saved.id);
            syncChapterMemoryAndEntities(ctx, saved.projectId, saved.id, saved.body ?? "");
            ctx.event(saved.projectId, "chapter", "document.state", { documentId: saved.id, state: next });
          }),
        ),
    },
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
    onStartupRecover: recoverAutopilotBatches,
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
    buildProposalContext(ctx, { kind, phase, projectId, documentId, sourceText: initialSourceText, sourceRef: initialSourceRef, instruction, input }) {
      if (!projectId) return {};
      const doc = documentId ? ctx.document(documentId) : undefined;
      const shared = buildFanqieSharedLayeredPrefix(ctx, projectId, doc, { readOnly: false });

      const existingLoreHints = stmt(ctx.db, `
        SELECT fact_id AS factId, category, entity_name AS entityName
        FROM author_lore_current
        WHERE project_id = ?
        ORDER BY fact_id ASC LIMIT 60;
      `).all(projectId) as readonly { factId: string; category: string; entityName: string }[];
      const loreHintLines = existingLoreHints.length > 0
        ? existingLoreHints.map((h) => `- [${h.factId}] (${h.category}) ${h.entityName || "未命名"}`).join("\n")
        : "（暂无）";

      if (kind === "setting") {
        const finalSource = initialSourceText;
        const sections = [
          `### 提案类型：设定与伏笔提炼（${initialSourceRef || "设定原文"}）`,
          instruction ? `### 补充要求\n${instruction}` : "",
          `### 既有设定编号参考\n${loreHintLines}`,
          `### 待提炼正文\n${finalSource}`,
        ];
        return {
          extra: { existingLoreHints },
          layered: buildFanqieLayeredPayload(shared, phase, sections),
        };
      }
      if (kind === "fact_sync" && doc) {
        const body = doc.body ?? "";
        const syncRecord = getChapterMemorySyncRecord(ctx, doc.id);
        const delta = computeParagraphDelta(syncRecord?.syncedBody ?? "", body);
        const existingForeshadows = stmt(ctx.db, `
          SELECT id, title, fact_id AS factId, status, note
          FROM author_foreshadows
          WHERE project_id = ? AND status IN ('planted', 'hinted')
          ORDER BY id ASC LIMIT 30;
        `).all(projectId) as readonly { id: string; title: string; factId: string | null; status: string; note: string }[];
        const manualSource = optionalText(input, "sourceText");
        const finalSource = manualSource ?? (body.trim() ? delta.deltaText : "");
        const sections = [
          `### 提案类型：章节记忆与事实增量同步《${doc.title}》`,
          `同步基线：${delta.hasBaseline ? `存在基线（变更段落 ${delta.changedParagraphCount} 段）` : "首次全章同步"}`,
          instruction ? `### 补充要求\n${instruction}` : "",
          `### 既有设定编号参考\n${loreHintLines}`,
          `### 本章变更文本\n${finalSource}`,
        ];
        return {
          sourceText: finalSource,
          sourceRef: doc.title,
          extra: {
            hasBaseline: delta.hasBaseline,
            changedParagraphCount: delta.changedParagraphCount,
            existingLoreHints,
            existingForeshadows,
          },
          layered: buildFanqieLayeredPayload(shared, phase, sections),
        };
      }
      if (kind === "chapter_review" && doc) {
        const order = ctx.chapterOrder(projectId);
        const plan = ctx.planning(doc.id);
        const viewpoint = typeof plan?.viewpoint === "string" ? plan.viewpoint : undefined;
        const knownFacts = viewpoint ? settingsAt(approvedFacts(ctx, projectId), order, anchor(doc.id, 1), viewpoint) : [];
        const diagnostics = diagnoseChapter(ctx, doc);
        const mountedReview = resolveMountedLibraryForChapter(ctx, doc, "", "", "review");
        const reviewMethodology = formatTechniquesBlock(mountedReview.techniques, "review");
        const existingForeshadows = stmt(ctx.db, `
          SELECT id, title, fact_id AS factId, status, note
          FROM author_foreshadows
          WHERE project_id = ? AND status IN ('planted', 'hinted')
          ORDER BY id ASC LIMIT 30;
        `).all(projectId);
        const finalSource = optionalText(input, "sourceText") ?? (doc.body ?? "");
        const sections = [
          `### 提案类型：章节定性审稿《${doc.title}》`,
          viewpoint ? `当前视角人物：${viewpoint}` : "",
          typeof plan?.lockedFacts === "string" && plan.lockedFacts.trim() ? `本章锁定事实：${plan.lockedFacts.trim()}` : "",
          knownFacts.length > 0
            ? `### 视角知情设定\n${knownFacts.map((f) => `- [${f.id}] ${f.note}`).join("\n")}`
            : "",
          reviewMethodology ? `### 审稿方法论\n${reviewMethodology}` : "",
          `### 本地预诊断信号\n字数 ${doc.charCount} · AI套话命中 ${diagnostics.aiSlop.totalHits} · 黄金三章提醒 ${diagnostics.goldenThree.warnings.length}`,
          instruction ? `### 补充审稿重点\n${instruction}` : "",
          `### 待审章节正文\n${finalSource}`,
        ];
        return {
          sourceText: finalSource,
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
          layered: buildFanqieLayeredPayload(shared, phase, sections),
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
        const finalSource = optionalText(input, "sourceText") ?? fallbackSummaryText;
        const finalRef = targetAct?.title ?? volumes[0]?.title ?? "全书卷幕规划";
        const sections = [
          `### 提案类型：卷幕滚动规划（${finalRef}）`,
          controls.currentFocus ? `当前焦点：${controls.currentFocus}` : "",
          instruction ? `### 补充规划指令\n${instruction}` : "",
          `### 近期卷幕与章节进展\n${finalSource}`,
        ];
        return {
          sourceText: finalSource,
          sourceRef: finalRef,
          extra: {
            authorIntent: controls.authorIntent,
            currentFocus: controls.currentFocus,
            targetAct: targetAct ?? null,
            volumes,
            acts,
            recentChapters: [...chapters].reverse(),
          },
          layered: buildFanqieLayeredPayload(shared, phase, sections),
        };
      }
      if (kind === "summary" && doc) {
        const finalSource = initialSourceText || (doc.body ?? "");
        const sections = [
          `### 提案类型：章节摘要提炼《${doc.title}》`,
          instruction ? `### 补充要求\n${instruction}` : "",
          `### 章节正文\n${finalSource}`,
        ];
        return {
          sourceText: finalSource,
          sourceRef: doc.title,
          layered: buildFanqieLayeredPayload(shared, phase, sections),
        };
      }
      // Project-bound deconstruct / technique still reuses the book's L0+L1+L2 prefix.
      const fallbackSections = [
        `### 提案类型：${kind}（${initialSourceRef || "项目素材"}）`,
        instruction ? `### 补充要求\n${instruction}` : "",
        `### 输入文本\n${initialSourceText}`,
      ];
      return {
        layered: buildFanqieLayeredPayload(shared, phase, fallbackSections),
      };
    },
    buildSelectionContext(ctx, row, { mode, instruction, beforeContext, selectedText, afterContext }) {
      const shared = buildFanqieSharedLayeredPrefix(ctx, row.projectId, row, { readOnly: true });
      const stage = mode === "polish" ? "deslop" : "refine";
      const mounted = resolveMountedLibraryForChapter(ctx, row, instruction, "", stage);
      const sortedSkills = [...mounted.techniques].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const skillText = formatTechniquesBlock(sortedSkills, stage);

      const plan = ctx.planning(row.id);
      const viewpoint = typeof plan?.viewpoint === "string" ? plan.viewpoint : undefined;
      const order = ctx.chapterOrder(row.projectId);
      const knownFacts = viewpoint ? settingsAt(approvedFacts(ctx, row.projectId), order, anchor(row.id, 1), viewpoint) : [];
      const slopHints = mode === "polish"
        ? scanAiSlop(row.body ?? "", loadSlopConfig(ctx, row.projectId)).topPhrases
        : [];

      const sections = [
        `### 局部选区改写目标\n章节：《${row.title}》 · 模式：${mode}${viewpoint ? ` · 视角人物：${viewpoint}` : ""}`,
        typeof plan?.lockedFacts === "string" && plan.lockedFacts.trim() ? `本章锁定事实：${plan.lockedFacts.trim()}` : "",
        knownFacts.length > 0
          ? `### 视角人物「${viewpoint}」知情设定\n${knownFacts.map((f) => `- [${f.id}] ${f.note}`).join("\n")}`
          : "",
        skillText ? `### 本次微改写技法（${stage}）\n${skillText}` : "",
        slopHints.length > 0
          ? `### 建议规避的 AI 高频套话\n${slopHints.map((h) => `- 「${h.phrase}」（已出现 ${h.count} 次）`).join("\n")}`
          : "",
        instruction ? `### 改写指令\n${instruction}` : "",
        beforeContext ? `### 选区前文衔接\n${beforeContext}` : "",
        `### 待改写选区原文\n${selectedText}`,
        afterContext ? `### 选区后文衔接\n${afterContext}` : "",
      ];

      return {
        extra: {
          viewpoint: viewpoint ?? "",
          lockedFacts: typeof plan?.lockedFacts === "string" ? plan.lockedFacts : "",
          knownFacts,
          aiSlopHints: slopHints,
        },
        layered: buildFanqieLayeredPayload(shared, "selectionRewrite", sections),
      };
    },
    onJobCacheHit(ctx, projectId) {
      touchBookCacheHit(ctx, projectId);
    },
    runMaterialNormalize(ctx, params) {
      return runMaterialExtraction(ctx, params);
    },
    runAutopilotPipeline(ctx, params) {
      return runAutopilotBatch(ctx, params);
    },
    buildFrozenContext(ctx, row, input) {
      return buildFanqieFrozenContext(ctx, row, input, { readOnly: false });
    },
    runGeneration,
    actions,
    contributeSnapshot(ctx, projectId, active, chapterOrder) {
      const pendingAiRow = stmt(
        ctx.db,
        "SELECT COUNT(*) AS count FROM author_ai_proposals WHERE (project_id = ? OR project_id IS NULL) AND status = 'pending';",
      ).get(projectId) as { count?: number } | undefined;
      const pendingSettingRow = stmt(
        ctx.db,
        "SELECT COUNT(*) AS count FROM author_settings WHERE project_id = ? AND decision = 'pending';",
      ).get(projectId) as { count?: number } | undefined;
      const pendingProposalCount = (pendingAiRow?.count ?? 0) + (pendingSettingRow?.count ?? 0);
      if (!active) return { pendingProposalCount };
      const page = settingsPage(ctx, projectId);
      const planningId = sha256Text(JSON.stringify(ctx.planning(active.id)));
      const outline = stmt(ctx.db, `
        SELECT id, new_plan_hash AS hash FROM author_outline_writes
        WHERE document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1;
      `).get(active.id) as { id: string; hash: string } | undefined;
      return {
        settings: page.entries, settingsCursor: page.cursor, pendingProposalCount, planningId,
        previousChapterVersions: chapterVersionOptions(ctx, active, chapterOrder),
        outlineWriteId: outline?.hash === planningId ? outline.id : null,
      };
    },
    contributeSystemPrompt(ctx, projectId, active) {
      const controls = loadProjectControls(ctx, projectId);
      const lines: string[] = [];
      if (controls.pacingTier) lines.push(`- 节奏档位：${controls.pacingTier}`);
      if (controls.currentFocus) lines.push(`- 近期焦点：${controls.currentFocus.slice(0, 120)}`);
      if (controls.authorIntent) lines.push(`- 创作指南针：${controls.authorIntent.slice(0, 120)}`);

      if (active) {
        const plan = ctx.planning(active.id);
        if (typeof plan?.viewpoint === "string" && plan.viewpoint.trim()) {
          lines.push(`- 本章视角：${plan.viewpoint.trim()}${typeof plan.target === "number" ? ` · 目标 ${plan.target} 字` : ""}`);
        }
      }

      const mountedSkills = active
        ? queryTechniqueRecommendations(ctx, active).slice(0, 8).map((rec) => ({
            id: rec.card.id,
            title: rec.card.title,
            category: rec.card.category,
            triggerWhen: rec.card.triggerWhen,
            conflictGroup: rec.card.conflictGroup,
            mountedMode: rec.mountedMode,
          }))
        : queryTechniques(ctx, { projectId }).slice(0, 8).map((card) => ({
            id: card.id,
            title: card.title,
            category: card.category,
            triggerWhen: card.triggerWhen,
            conflictGroup: card.conflictGroup,
            mountedMode: null,
          }));

      const pendingAiRow = stmt(
        ctx.db,
        "SELECT COUNT(*) AS count FROM author_ai_proposals WHERE (project_id = ? OR project_id IS NULL) AND status = 'pending';",
      ).get(projectId) as { count?: number } | undefined;
      const pendingSettingRow = stmt(
        ctx.db,
        "SELECT COUNT(*) AS count FROM author_settings WHERE project_id = ? AND decision = 'pending';",
      ).get(projectId) as { count?: number } | undefined;

      return {
        lines,
        mountedSkills,
        pendingProposalCount: (pendingAiRow?.count ?? 0) + (pendingSettingRow?.count ?? 0),
      };
    },
    diagnoseForAgent(ctx, row, body) {
      const diag = diagnoseChapter(ctx, { ...row, body });
      return {
        charCount: diag.aiSlop.charCount,
        compositeScore: diag.qualityV2?.compositeScore ?? null,
        aiSlopHits: diag.aiSlop.totalHits,
        aiSlopSeverity: diag.aiSlop.severity,
        endingHookScore: diag.qualityV2?.endingHookScore ?? null,
        povLeakCount: diag.qualityV2?.povLeakWarnings.length ?? 0,
        goldenThreeWarnings: diag.goldenThree.warnings,
      };
    },
    onAgentDraftRecorded(ctx, _row, techniqueIds, diagnosticsSummary) {
      if (techniqueIds.length === 0) return;
      const score = typeof diagnosticsSummary?.compositeScore === "number" ? diagnosticsSummary.compositeScore : 75;
      recordTechniqueOutcome(ctx, techniqueIds, score - 75);
    },
    readModels,
    agentTools: createFanqieAgentTools,
  };
}
