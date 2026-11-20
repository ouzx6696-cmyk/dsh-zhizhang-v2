import { randomUUID } from "node:crypto";
import {
  assertChapterFinalizable,
  chapterLengthWarnings,
  EDITORIAL_REJECTION_LIMIT,
  OUTLINE_SECTIONS,
  type ChapterState,
} from "../../domain/fanqie/index.ts";
import { stmt, type SqliteDatabase } from "../../storage/index.ts";
import { createAuthorSchema } from "../../storage/author-schema.ts";
import { projectReadUnit, type AuthorReadUnitFactory } from "../../workflow/author-reads.ts";
import {
  count,
  invalid,
  refuse,
  text,
  type DocumentRow,
  type Input,
  type WorkspaceContext,
} from "../context.ts";
import type { ActionDefinition, ProductLineModule } from "../product-line.ts";
import { buildFanqieFrozenContext, createFanqieGenerationRunner, previewContext } from "./fanqie/context.ts";
import { exportProjectBundle, importProjectBundle, type ProjectBundleDiskWriter } from "./fanqie/io.ts";
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
  saveDeconstruction,
  saveTechnique,
  unmountLibraryItem,
} from "./fanqie/library.ts";
import {
  handleContinuity,
  listForeshadows,
  listLore,
  scanLoreConflicts,
  settingsPage,
  upsertForeshadow,
} from "./fanqie/lore.ts";
import { searchFanqieWorkspace } from "./fanqie/search.ts";
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
import { settingsAt, type SettingFact } from "../../domain/fanqie/index.ts";

/**
 * Fanqie (serialized novel) product-line module.
 * Depends strictly on `domain/fanqie` and `domain/shared` — never `domain/toutiao`.
 */
export function createFanqieModule(writeProjectExport?: ProjectBundleDiskWriter): ProductLineModule {
  const runGeneration = createFanqieGenerationRunner();

  function initSchema(db: SqliteDatabase): void {
    createAuthorSchema(db);
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
      const point = body.slice(0, start).split(/\r?\n/).length;
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
      ctx.event(row.projectId, "chapter", "document.state", { documentId: row.id, state: next });
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
  };
}
