import { randomUUID } from "node:crypto";
import { ContractError } from "../../contracts/index.ts";
import {
  assertChapterFinalizable,
  chapterLengthWarnings,
  EDITORIAL_REJECTION_LIMIT,
  OUTLINE_SECTIONS,
  planReorder,
  settingsAt,
  type ChapterState,
  type SettingFact,
} from "../../domain/fanqie/index.ts";
import { anchor, precedes, type Anchor } from "../../domain/shared/index.ts";
import { currentSeq, type SqliteDatabase } from "../../storage/index.ts";
import { projectReadUnit, type AuthorReadUnitFactory } from "../../workflow/author-reads.ts";
import {
  count,
  invalid,
  refuse,
  requiredRow,
  text,
  type DocumentRow,
  type Input,
  type Product,
  type WorkspaceContext,
} from "../context.ts";
import type { ActionDefinition, ProductLineModule } from "../product-line.ts";

/**
 * Fanqie (serialized novel) product-line module.
 * Depends strictly on `domain/fanqie` and `domain/shared` — never `domain/toutiao`.
 */
export function createFanqieModule(): ProductLineModule {
  function initSchema(db: SqliteDatabase): void {
    db.exec(`
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
      CREATE INDEX IF NOT EXISTS author_settings_by_project ON author_settings(project_id);
      CREATE INDEX IF NOT EXISTS author_settings_approved_order
        ON author_settings(project_id, decided_seq) WHERE decision = 'approved';
      CREATE INDEX IF NOT EXISTS author_evidence_by_fact
        ON author_evidence(project_id, fact_id);
    `);
  }

  function approvedFacts(ctx: WorkspaceContext, projectId: string): SettingFact[] {
    const rows = ctx.db.prepare(`
      SELECT value FROM author_settings
      WHERE project_id = ? AND decision = 'approved'
      ORDER BY decided_seq ASC, sequence ASC;
    `).all(projectId) as readonly { value: string }[];
    return rows.map(({ value }) => JSON.parse(value) as SettingFact);
  }

  function settingAnchor(input: Input, field: string, order: readonly string[]): Anchor {
    const value = input[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
    const fields = value as Input;
    const id = text(fields, "chapterId");
    const point = count(fields, "point");
    if (!order.includes(id) || point === 0) invalid(field, "unknown-chapter-or-point");
    return anchor(id, point);
  }

  function knownFrom(input: Input, from: Anchor, order: readonly string[]): SettingFact["knownFrom"] {
    if (input.people === undefined) {
      const character = typeof input.character === "string" ? input.character.trim() : "";
      return character ? { [character]: input.knownAt ? settingAnchor(input, "knownAt", order) : from } : {};
    }
    if (!Array.isArray(input.people)) invalid("people", "expected-character-list");
    const characters = new Map<string, Anchor>();
    for (const person of input.people) {
      if (!person || typeof person !== "object" || Array.isArray(person)) {
        invalid("people", "invalid-character");
      }
      const record = person as Input;
      const character = text(record, "character").trim();
      if (characters.has(character)) invalid("people", "duplicate-character");
      characters.set(character, record.at === undefined ? from : settingAnchor(record, "at", order));
    }
    return Object.fromEntries(characters);
  }

  function proposedOrder(input: Input, before: readonly string[]): string[] {
    const next = input.chapterIds;
    const known = new Set(before);
    if (
      !Array.isArray(next) ||
      next.length !== before.length ||
      new Set(next).size !== before.length ||
      next.some((id) => typeof id !== "string" || !known.has(id))
    ) {
      invalid("chapterIds", "order-must-contain-every-chapter-once");
    }
    return next as string[];
  }

  function computeReorder(ctx: WorkspaceContext, projectId: string, input: Input) {
    const before = ctx.chapterOrder(projectId);
    const after = proposedOrder(input, before);
    const relations = approvedFacts(ctx, projectId).map((fact) => ({
      id: fact.id,
      relations: [
        ...(fact.effectiveTo ? [{ from: fact.effectiveFrom, to: fact.effectiveTo, label: "设定有效期" }] : []),
        ...Object.entries(fact.knownFrom).map(([character, at]) => ({
          from: fact.effectiveFrom,
          to: at,
          label: `${character}知晓`,
        })),
      ],
    }));
    return { ...planReorder(relations, before, after), chapterIds: after, asOfSeq: currentSeq(ctx.db, projectId) };
  }

  function settingsPage(ctx: WorkspaceContext, projectId: string, before = Number.MAX_SAFE_INTEGER) {
    const rows = ctx.db.prepare(`
      SELECT sequence, id, decision, value FROM author_settings
      WHERE project_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 51;
    `).all(projectId, before) as readonly { sequence: number; id: string; decision: string; value: string }[];
    return {
      entries: rows.slice(0, 50).map(({ id, decision, value }) => ({
        id,
        decision,
        fact: JSON.parse(value) as SettingFact,
      })),
      cursor: rows.length > 50 ? rows[49].sequence : null,
    };
  }

  function handleContinuity(action: string, ctx: WorkspaceContext, input: Input) {
    const { db } = ctx;
    const projectId = text(input, "projectId");
    const project = requiredRow<{ product: Product }>(
      db.prepare("SELECT product FROM author_projects WHERE id = ?;").get(projectId),
      "project",
      projectId,
    );
    if (project.product !== "fanqie") invalid("projectId", "novel-required");

    if (action === "settings.history") return settingsPage(ctx, projectId, count(input, "before"));
    if (action === "reorder.impact") return ctx.read(() => computeReorder(ctx, projectId, input));
    if (action === "settings.read") {
      return ctx.read(() => {
        const order = ctx.chapterOrder(projectId);
        const at = settingAnchor(input, "at", order);
        const characterId = text(input, "character");
        return {
          entries: settingsAt(approvedFacts(ctx, projectId), order, at, characterId),
          asOfSeq: currentSeq(db, projectId),
        };
      });
    }
    if (action === "reorder.commit") {
      return ctx.atomic(() => {
        const plan = computeReorder(ctx, projectId, input);
        if (input.asOfSeq !== plan.asOfSeq) {
          throw new ContractError("version.conflict", {
            documentId: projectId,
            baseRevisionId: String(input.asOfSeq),
            currentRevisionId: String(plan.asOfSeq),
          });
        }
        if (input.confirmed !== true) refuse(action, "author-confirmation-required");
        db.prepare(`
          INSERT INTO author_chapter_order (project_id, chapter_ids) VALUES (?, ?)
          ON CONFLICT (project_id) DO UPDATE SET chapter_ids = excluded.chapter_ids;
        `).run(projectId, JSON.stringify(plan.chapterIds));
        ctx.event(projectId, "chapter", "chapter.reordered", { chapterIds: plan.chapterIds });
        return { chapterIds: plan.chapterIds };
      });
    }

    const row = ctx.document(text(input, "documentId"));
    if (row.projectId !== projectId) invalid("documentId", "project-mismatch");

    if (action === "setting.propose") {
      return ctx.atomic(() => {
        const id = randomUUID();
        const factId = text(input, "factId").trim();
        const order = ctx.chapterOrder(projectId);
        const effectiveFrom = settingAnchor(input, "from", order);
        const effectiveTo = input.to ? settingAnchor(input, "to", order) : undefined;
        if (effectiveTo && !precedes(effectiveFrom, effectiveTo, order)) {
          invalid("to", "empty-validity-interval");
        }
        const value: SettingFact = {
          id: factId,
          note: text(input, "note"),
          source: text(input, "source"),
          kind: input.kind === "agreement" ? "agreement" : "fact",
          locked: input.locked === true,
          effectiveFrom,
          effectiveTo,
          knownFrom: knownFrom(input, effectiveFrom, order),
        };
        db.prepare("INSERT INTO author_settings (id, project_id, fact_id, value) VALUES (?, ?, ?, ?);")
          .run(id, projectId, factId, JSON.stringify(value));
        ctx.event(projectId, "setting", "setting.proposed", { id, factId });
        return { id };
      });
    }

    return ctx.dispatch(action, row, input, () => {
      const id = text(input, "proposalId");
      const proposal = requiredRow<{ fact_id: string; decision: string; value: string }>(
        db.prepare("SELECT fact_id, decision, value FROM author_settings WHERE id = ? AND project_id = ?;")
          .get(id, projectId),
        "setting-proposal",
        id,
      );
      if (proposal.decision !== "pending") refuse(action, "decision-already-recorded");
      if (typeof input.accept !== "boolean") invalid("accept");
      if (input.accept && approvedFacts(ctx, projectId).some((fact) => fact.id === proposal.fact_id && fact.locked)) {
        refuse(action, "setting-is-locked");
      }
      const decision = input.accept ? "approved" : "rejected";
      const decidedSeq = ctx.event(projectId, "setting", "setting.decided", {
        id,
        factId: proposal.fact_id,
        decision,
        fact: JSON.parse(proposal.value),
      });
      db.prepare("UPDATE author_settings SET decision = ?, decided_seq = ? WHERE id = ?;")
        .run(decision, decidedSeq, id);
      return { id, decision };
    });
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
      ctx.db.prepare(`
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
      ctx.db.prepare(`
        UPDATE author_documents
        SET state = ?, editorial_rejections = editorial_rejections + ?
        WHERE id = ?;
      `).run(state, input.accept ? 0 : 1, row.id);
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
      ctx.db.prepare("UPDATE author_documents SET state = 'final', final_revision_id = ? WHERE id = ?;")
        .run(current.revisionId, row.id);
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
    onDraftSaved(ctx, row) {
      const next: ChapterState = row.state === "planned" || row.state === "drafting" ? "drafting" : "drafted";
      ctx.db.prepare("UPDATE author_documents SET state = ? WHERE id = ?;").run(next, row.id);
      ctx.event(row.projectId, "chapter", "document.state", { documentId: row.id, state: next });
    },
    buildFrozenContext(ctx, row, input) {
      const plan = ctx.planning(row.id);
      const point = input.point === undefined ? 1 : count(input, "point");
      if (point === 0) invalid("point", "positive-integer-required");
      const at = anchor(row.id, point);
      const viewpoint = typeof plan?.viewpoint === "string" ? plan.viewpoint : undefined;
      const knownFacts = viewpoint
        ? settingsAt(approvedFacts(ctx, row.projectId), ctx.chapterOrder(row.projectId), at, viewpoint)
        : [];
      return { knownAt: at, knownFacts, scenario: null };
    },
    actions,
    contributeSnapshot(ctx, projectId, active) {
      if (!active) return {};
      const page = settingsPage(ctx, projectId);
      return { settings: page.entries, settingsCursor: page.cursor };
    },
    readModels,
  };
}
