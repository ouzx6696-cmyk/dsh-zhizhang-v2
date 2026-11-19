import { randomUUID } from "node:crypto";
import { ContractError, type ApprovalRecord } from "../contracts/index.ts";
import { assertChapterFinalizable, EDITORIAL_REJECTION_LIMIT, planReorder, settingsAt, OUTLINE_SECTIONS, chapterLengthWarnings } from "../domain/fanqie/index.ts";
import type { ChapterState, SettingFact } from "../domain/fanqie/index.ts";
import {
  articleScenario, assertArticleTransition, formatDelivery, qaPassed, structuralGates,
  QA_REFINEMENT_LIMIT, TITLE_MAX, validateTitleMatrix, type ArticleMode, type ArticleQa, type ArticleStatus,
} from "../domain/toutiao/index.ts";
import {
  appendEvent, appendRevision, attemptExport, createCandidate, createCommandSchema, createDeliverySchema,
  createDocument, createEventLogSchema, currentSeq, executeCommand, insertDeliveryRow, pendingExports, type SqliteDatabase,
} from "../storage/index.ts";
import { createGenerationLedger } from "../storage/author-generation.ts";
import { anchor, precedes, type Anchor } from "../domain/shared/index.ts";
import { createAuthorModelReader } from "../workflow/author-reads.ts";
import { isLegalTransition, type Concern, type RunState } from "../workflow/index.ts";

type Input = Record<string, unknown>;
type Product = "fanqie" | "toutiao";
interface DocumentRow {
  id: string;
  projectId: string;
  title: string;
  product: Product;
  state: ChapterState | ArticleStatus;
  mode: ArticleMode | null;
  line: string | null;
  revisionId: string | null;
  finalRevisionId: string | null;
  body: string | null;
  editorialRejections: number;
  qaRounds: number;
}
interface RunRow {
  id: string;
  documentId: string;
  state: RunState;
  baseRevisionId: string;
  frozenInput: string;
  reserved: number;
  settled: number;
  candidateId: string | null;
}

function invalid(field: string, reason = "required"): never {
  throw new ContractError("input.invalid", { field, reason });
}

function text(input: Input, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) invalid(field);
  return value;
}

function count(input: Input, field: string): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(field, "nonnegative-integer-required");
  return value;
}

function requiredRow<T>(row: unknown, objectType: string, objectId: string): T {
  if (!row) throw new ContractError("input.not_found", { objectType, objectId });
  return row as T;
}

function titleFor(mode: string | null, title: string): string {
  if (mode === "micro" ? !!title : !title) invalid("title", mode === "micro" ? "micro-has-no-title" : "required");
  if (mode && [...title].length > TITLE_MAX) invalid("title", "title-limit");
  return title;
}

function locked(row: DocumentRow): boolean {
  return ["final", "已验收", "已交稿"].includes(row.state);
}

function refuse(action: string, reason: string): never {
  throw new ContractError("gate.denied", { action, reason });
}

export function openAuthorWorkspace(
  db: SqliteDatabase,
  writeDelivery: (documentId: string, text: string) => void,
) {
  createCommandSchema(db);
  createEventLogSchema(db);
  createDeliverySchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS author_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, product TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS author_documents (
      id TEXT PRIMARY KEY REFERENCES documents(document_id),
      project_id TEXT NOT NULL REFERENCES author_projects(id), title TEXT NOT NULL,
      state TEXT NOT NULL, mode TEXT, line TEXT, final_revision_id TEXT,
      editorial_rejections INTEGER NOT NULL DEFAULT 0, qa_rounds INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS author_runs (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES author_documents(id),
      state TEXT NOT NULL, base_revision_id TEXT NOT NULL, frozen_input TEXT NOT NULL,
      reserved INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, candidate_id TEXT
    );
    CREATE TABLE IF NOT EXISTS author_planning (
      document_id TEXT PRIMARY KEY REFERENCES author_documents(id), value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS author_run_refinement_claims (
      run_id TEXT PRIMARY KEY REFERENCES author_runs(id), rounds INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS author_candidate_qa (
      candidate_id TEXT PRIMARY KEY REFERENCES candidates(candidate_id),
      report TEXT NOT NULL, rounds INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS author_approvals (
      document_id TEXT NOT NULL REFERENCES author_documents(id), revision_id TEXT NOT NULL,
      at TEXT NOT NULL, PRIMARY KEY (document_id, revision_id)
    );
    CREATE TABLE IF NOT EXISTS author_chapter_order (
      project_id TEXT PRIMARY KEY REFERENCES author_projects(id), chapter_ids TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS author_settings (
      sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES author_projects(id), fact_id TEXT NOT NULL,
      value TEXT NOT NULL, decision TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS author_documents_by_project ON author_documents(project_id);
    CREATE INDEX IF NOT EXISTS author_runs_by_document ON author_runs(document_id);
    CREATE INDEX IF NOT EXISTS author_settings_by_project ON author_settings(project_id);
    CREATE INDEX IF NOT EXISTS author_settings_decision_events ON event_log(project_id, json_extract(payload, '$.id'))
      WHERE kind = 'setting.decided';
    CREATE INDEX IF NOT EXISTS author_article_reports ON event_log(project_id, json_extract(payload, '$.revisionId'), seq)
      WHERE kind IN ('article.qa','article.rejected');
  `);

  const generation = createGenerationLedger(db);
  const readAuthorModel = createAuthorModelReader(db);
  const documentQuery = `
    SELECT a.id, a.project_id AS projectId, a.title, p.product, a.state, a.mode, a.line,
      d.current_revision_id AS revisionId, a.final_revision_id AS finalRevisionId, r.body,
      a.editorial_rejections AS editorialRejections, a.qa_rounds AS qaRounds
    FROM author_documents a JOIN author_projects p ON p.id = a.project_id
    JOIN documents d ON d.document_id = a.id
    LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
  `;

  function document(id: string): DocumentRow {
    return requiredRow(db.prepare(documentQuery + " WHERE a.id = ?;").get(id), "document", id);
  }

  function run(id: string): RunRow {
    return requiredRow(db.prepare(`
      SELECT id, document_id AS documentId, state, base_revision_id AS baseRevisionId,
        frozen_input AS frozenInput, reserved, settled, candidate_id AS candidateId
      FROM author_runs WHERE id = ?;
    `).get(id), "run", id);
  }

  function atomic<T>(apply: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = apply();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function event(projectId: string, concern: Concern, kind: string, payload: Input): void {
    appendEvent(db, { projectId, eventId: randomUUID(), kind, payload: { ...payload, concern } });
  }

  function stage(current: RunRow, next: RunState): void {
    if (!isLegalTransition(current.state, next)) refuse("run.transition", `${current.state} → ${next}`);
    db.prepare("UPDATE author_runs SET state = ? WHERE id = ?;").run(next, current.id);
    const row = document(current.documentId);
    event(row.projectId, "run", "run.state", { runId: current.id, state: next });
    if ((next === "applied" || next === "discarded" || next === "cancelled") && current.candidateId) {
      event(row.projectId, "candidate", "candidate.closed", { documentId: row.id, candidateId: current.candidateId });
    }
  }

  function moveArticle(row: DocumentRow, next: ArticleStatus): void {
    if (row.product !== "toutiao") invalid("documentId", "article-required");
    if (row.state !== next) assertArticleTransition(row.state as ArticleStatus, next);
    db.prepare("UPDATE author_documents SET state = ? WHERE id = ?;").run(next, row.id);
    event(row.projectId, "chapter", "document.state", { documentId: row.id, state: next });
  }

  function addRevision(row: DocumentRow, body: string): { revisionId: string } {
    if (locked(row)) {
      refuse("draft.save", "revision-locked");
    }
    const revision = appendRevision(db, { revisionId: randomUUID(), documentId: row.id, body, createdAt: Date.now() });
    if (row.product === "fanqie") {
      const next = row.state === "planned" || row.state === "drafting" ? "drafting" : "drafted";
      db.prepare("UPDATE author_documents SET state = ? WHERE id = ?;").run(next, row.id);
      event(row.projectId, "chapter", "document.state", { documentId: row.id, state: next });
    } else {
      moveArticle(row, "初稿待改");
    }
    event(row.projectId, "revision", "revision.saved", { documentId: row.id, revisionId: revision.revisionId });
    return revision;
  }

  function dispatch(commandId: string, row: DocumentRow, input: Input, apply: () => unknown, approval?: ApprovalRecord) {
    const base = input.baseRevisionId;
    if (base !== null && base !== undefined && typeof base !== "string") invalid("baseRevisionId");
    const result = executeCommand(db, {
      commandId, actor: "author", documentId: row.id, payload: input,
      baseRevisionId: base ?? null,
      idempotencyKey: typeof input.key === "string" ? input.key : undefined,
      approval,
      targetVersion: approval?.targetVersion,
    }, apply);
    if (!result.ok) throw new ContractError(result.code!, result.details);
    return result.result;
  }

  function currentBody(row: DocumentRow, input: Input): void {
    if (!row.revisionId || row.revisionId !== input.baseRevisionId) {
      throw new ContractError("version.conflict", {
        documentId: row.id, baseRevisionId: input.baseRevisionId ?? null, currentRevisionId: row.revisionId,
      });
    }
  }

  function qaReport(input: Input, hardGates: readonly string[] = []): ArticleQa {
    const failures = input.fails;
    const suppliedGates = input.hardGates ?? [];
    if (!Array.isArray(failures) || failures.some((item) => typeof item !== "string")) invalid("fails");
    if (!Array.isArray(suppliedGates) || suppliedGates.some((item) => typeof item !== "string")) invalid("hardGates");
    if (typeof input.passed !== "boolean") invalid("passed");
    const overall = count(input, "score");
    if (overall > 100) invalid("score", "out-of-range");
    return { overall, passed: input.passed, fails: failures, hardGates: [...new Set([...suppliedGates, ...hardGates])] };
  }

  function recordedApproval(row: DocumentRow, revisionId: string): ApprovalRecord | null {
    const record = db.prepare("SELECT at FROM author_approvals WHERE document_id = ? AND revision_id = ?;")
      .get(row.id, revisionId) as { at: string } | undefined;
    return record ? { actor: "author", action: "article.deliver", target: row.id, targetVersion: revisionId, decision: "approved", at: record.at } : null;
  }

  function chapterOrder(projectId: string, chapters?: readonly { id: string }[]): string[] {
    const known = chapters ?? db.prepare("SELECT id FROM author_documents WHERE project_id = ? ORDER BY rowid;")
      .all(projectId) as readonly { id: string }[];
    const saved = db.prepare("SELECT chapter_ids FROM author_chapter_order WHERE project_id = ?;")
      .get(projectId) as { chapter_ids: string } | undefined;
    const ids: string[] = saved ? JSON.parse(saved.chapter_ids) : [];
    const ordered = new Set(ids);
    return [...ids, ...known.map(({ id }) => id).filter((id) => !ordered.has(id))];
  }

  function facts(projectId: string): SettingFact[] {
    const rows = db.prepare(`
      SELECT s.value FROM author_settings s JOIN event_log e
        ON e.project_id = s.project_id AND e.kind = 'setting.decided'
        AND json_extract(e.payload, '$.id') = s.id
      WHERE s.project_id = ? AND s.decision = 'approved' ORDER BY e.seq;
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

  function proposedOrder(input: Input, before: readonly string[]): string[] {
    const next = input.chapterIds;
    const known = new Set(before);
    if (!Array.isArray(next) || next.length !== before.length || new Set(next).size !== before.length ||
      next.some((id) => typeof id !== "string" || !known.has(id))) invalid("chapterIds", "order-must-contain-every-chapter-once");
    return next as string[];
  }

  function reorder(projectId: string, input: Input) {
    const before = chapterOrder(projectId);
    const after = proposedOrder(input, before);
    const relations = facts(projectId).map((fact) => ({
      id: fact.id,
      relations: [
        ...(fact.effectiveTo ? [{ from: fact.effectiveFrom, to: fact.effectiveTo, label: "设定有效期" }] : []),
        ...Object.entries(fact.knownFrom).map(([character, at]) => ({
          from: fact.effectiveFrom, to: at, label: `${character}知晓`,
        })),
      ],
    }));
    return { ...planReorder(relations, before, after), chapterIds: after, asOfSeq: currentSeq(db, projectId) };
  }

  function settingsPage(projectId: string, before = Number.MAX_SAFE_INTEGER) {
    const rows = db.prepare(`
      SELECT sequence, id, decision, value FROM author_settings
      WHERE project_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 51;
    `).all(projectId, before) as readonly { sequence: number; id: string; decision: string; value: string }[];
    return {
      entries: rows.slice(0, 50).map(({ id, decision, value }) => ({ id, decision, fact: JSON.parse(value) as SettingFact })),
      cursor: rows.length > 50 ? rows[49].sequence : null,
    };
  }

  function continuity(action: string, input: Input) {
    const projectId = text(input, "projectId");
    const project = requiredRow<{ product: Product }>(
      db.prepare("SELECT product FROM author_projects WHERE id = ?;").get(projectId), "project", projectId,
    );
    if (project.product !== "fanqie") invalid("projectId", "novel-required");
    if (action === "settings.history") return settingsPage(projectId, count(input, "before"));
    const order = chapterOrder(projectId);
    if (action === "reorder.impact") return reorder(projectId, input);
    if (action === "settings.read") {
      const at = settingAnchor(input, "at", order);
      const characterId = text(input, "character");
      return { entries: settingsAt(facts(projectId), order, at, characterId), asOfSeq: currentSeq(db, projectId) };
    }
    if (action === "reorder.commit") {
      return atomic(() => {
        const plan = reorder(projectId, input);
        if (input.asOfSeq !== plan.asOfSeq) throw new ContractError("version.conflict", {
          documentId: projectId, baseRevisionId: String(input.asOfSeq), currentRevisionId: String(plan.asOfSeq),
        });
        if (input.confirmed !== true) refuse(action, "author-confirmation-required");
        db.prepare(`
          INSERT INTO author_chapter_order (project_id, chapter_ids) VALUES (?, ?)
          ON CONFLICT (project_id) DO UPDATE SET chapter_ids = excluded.chapter_ids;
        `).run(projectId, JSON.stringify(plan.chapterIds));
        event(projectId, "chapter", "chapter.reordered", { chapterIds: plan.chapterIds });
        return { chapterIds: plan.chapterIds };
      });
    }

    const row = document(text(input, "documentId"));
    if (row.projectId !== projectId) invalid("documentId", "project-mismatch");
    if (action === "setting.propose") {
      const id = randomUUID();
      const factId = text(input, "factId").trim();
      const effectiveFrom = settingAnchor(input, "from", order);
      const effectiveTo = input.to ? settingAnchor(input, "to", order) : undefined;
      if (effectiveTo && !precedes(effectiveFrom, effectiveTo, order)) invalid("to", "empty-validity-interval");
      const character = typeof input.character === "string" ? input.character.trim() : "";
      const value: SettingFact = {
        id: factId, note: text(input, "note"), source: text(input, "source"),
        kind: input.kind === "agreement" ? "agreement" : "fact", locked: input.locked === true,
        effectiveFrom, effectiveTo,
        knownFrom: character ? { [character]: input.knownAt ? settingAnchor(input, "knownAt", order) : effectiveFrom } : {},
      };
      return atomic(() => {
        db.prepare("INSERT INTO author_settings (id, project_id, fact_id, value) VALUES (?, ?, ?, ?);")
          .run(id, projectId, factId, JSON.stringify(value));
        event(projectId, "setting", "setting.proposed", { id, factId });
        return { id };
      });
    }
    return dispatch(action, row, input, () => {
      const id = text(input, "proposalId");
      const proposal = requiredRow<{ fact_id: string; decision: string; value: string }>(
        db.prepare("SELECT fact_id, decision, value FROM author_settings WHERE id = ? AND project_id = ?;").get(id, projectId),
        "setting-proposal", id,
      );
      if (proposal.decision !== "pending") refuse(action, "decision-already-recorded");
      if (typeof input.accept !== "boolean") invalid("accept");
      if (input.accept && facts(projectId).some((fact) => fact.id === proposal.fact_id && fact.locked)) {
        refuse(action, "setting-is-locked");
      }
      const decision = input.accept ? "approved" : "rejected";
      db.prepare("UPDATE author_settings SET decision = ? WHERE id = ?;").run(decision, id);
      event(projectId, "setting", "setting.decided", { id, factId: proposal.fact_id, decision, fact: JSON.parse(proposal.value) });
      return { id, decision };
    });
  }

  function planning(documentId: string): Input | null {
    const row = db.prepare("SELECT value FROM author_planning WHERE document_id = ?;").get(documentId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Input : null;
  }

  function savePlanning(row: DocumentRow, value: Input): void {
    db.prepare(`
      INSERT INTO author_planning (document_id, value) VALUES (?, ?)
      ON CONFLICT (document_id) DO UPDATE SET value = excluded.value;
    `).run(row.id, JSON.stringify(value));
    event(row.projectId, "chapter", "document.planning", { documentId: row.id });
  }

  function completeRun(current: RunRow, row: DocumentRow, input: Input) {
    const usage = count(input, "tokens");
    if (!Number.isSafeInteger(current.settled + usage)) invalid("tokens", "usage-overflow");
    if (current.state !== "running") refuse("run.complete", "run-no-longer-running");
    db.prepare("UPDATE author_runs SET settled = settled + ? WHERE id = ?;").run(usage, current.id);
    if (usage + current.settled > current.reserved) {
      event(row.projectId, "run", "run.attempt", { runId: current.id, usage, outcome: "budget.exhausted" });
      stage(current, "failed");
      return { id: current.id, state: "failed" };
    }
    const body = text(input, "body");
    const id = randomUUID();
    createCandidate(db, { candidateId: id, documentId: row.id, baseRevisionId: current.baseRevisionId, body });
    if (input.qa && typeof input.qa === "object" && row.mode) {
      const reported = input.qa as Input;
      const qa = qaReport({ ...reported, score: reported.overall }, structuralGates(row.mode, row.title, body));
      const rounds = count(input, "rounds");
      if (rounds > QA_REFINEMENT_LIMIT) invalid("rounds", "qa-refinement-limit");
      db.prepare("INSERT INTO author_candidate_qa (candidate_id, report, rounds) VALUES (?, ?, ?);")
        .run(id, JSON.stringify(qa), rounds);
    }
    db.prepare("UPDATE author_runs SET candidate_id = ? WHERE id = ?;").run(id, current.id);
    event(row.projectId, "run", "run.attempt", { runId: current.id, usage, outputRef: id, outcome: "completed" });
    stage(current, "awaiting-author");
    event(row.projectId, "candidate", "candidate.produced", { documentId: row.id, candidateId: id, runId: current.id });
    return { id: current.id, candidateId: id };
  }

  function mutation(action: string, input: Input) {
    switch (action) {
      case "read.model": {
        const projectId = text(input, "projectId");
        requiredRow(db.prepare("SELECT id FROM author_projects WHERE id = ?;").get(projectId), "project", projectId);
        return readAuthorModel(projectId, input);
      }
      case "setting.propose":
      case "setting.decide":
      case "settings.history":
      case "settings.read":
      case "reorder.impact":
      case "reorder.commit":
        return continuity(action, input);
      case "project.create": {
        const name = text(input, "name").trim();
        const product = input.product;
        if (product !== "fanqie" && product !== "toutiao") invalid("product", "unknown-product");
        const id = randomUUID();
        return atomic(() => {
          db.prepare("INSERT INTO author_projects (id, name, product) VALUES (?, ?, ?);").run(id, name, product);
          event(id, "chapter", "project.created", { name, product });
          return { id };
        });
      }
      case "document.create": {
        const projectId = text(input, "projectId");
        const title = typeof input.title === "string" ? input.title.trim() : "";
        const project = requiredRow<{ product: Product }>(
          db.prepare("SELECT product FROM author_projects WHERE id = ?;").get(projectId), "project", projectId,
        );
        const article = project.product === "toutiao";
        const mode = article ? text(input, "mode") : null;
        const line = article ? text(input, "line") : null;
        if (mode && line) articleScenario(mode, line);
        titleFor(mode, title);
        const id = randomUUID();
        return atomic(() => {
          createDocument(db, id);
          db.prepare(`
            INSERT INTO author_documents (id, project_id, title, state, mode, line) VALUES (?, ?, ?, ?, ?, ?);
          `).run(id, projectId, title, article ? "初稿待改" : "planned", mode, line);
          event(projectId, "chapter", "document.created", { documentId: id, title, mode, line, state: article ? "初稿待改" : "planned" });
          return { id };
        });
      }
      case "run.complete":
      case "run.cancel":
      case "run.discard": {
        return atomic(() => {
          const current = run(text(input, "runId"));
          const row = document(current.documentId);
          if (action !== "run.complete") {
            stage(current, action === "run.cancel" ? "cancelled" : "discarded");
            return { id: current.id };
          }
          if (generation.pending(current.id)) {
            refuse(action, "generation-needs-reconciliation");
          }
          const usage = count(input, "tokens");
          if (current.state === "cancelled") {
            if (current.candidateId === null && generation.history(current.id).length === 0) {
              db.prepare("UPDATE author_runs SET settled = settled + ?, candidate_id = '' WHERE id = ? AND candidate_id IS NULL;")
                .run(usage, current.id);
              event(row.projectId, "run", "run.usage.late", { runId: current.id, usage });
            }
            return { id: current.id };
          }
          return completeRun(current, row, input);
        });
      }
    }
    const row = document(text(input, "documentId"));
    switch (action) {
      case "run.history":
        return db.prepare(`
          SELECT rowid AS cursor, id, state, reserved, settled FROM author_runs
          WHERE document_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 25;
        `).all(row.id, input.before === undefined ? Number.MAX_SAFE_INTEGER : count(input, "before"));
      case "run.reconcile": {
        return atomic(() => {
          const id = text(input, "attemptId");
          const detail = run(text(input, "runId"));
          if (detail.documentId !== row.id) invalid("runId", "document-mismatch");
          const tokens = count(input, "tokens");
          if (!Number.isSafeInteger(detail.settled + tokens)) invalid("tokens", "usage-overflow");
          if (!generation.reconcile(id, detail.id)) {
            refuse(action, "no-uncertain-attempt");
          }
          db.prepare("UPDATE author_runs SET settled = settled + ? WHERE id = ?;").run(tokens, detail.id);
          event(row.projectId, "run", "run.attempt", { runId: detail.id, attemptId: id, usage: tokens, outcome: "reconciled" });
          return { id };
        });
      }
      case "run.detail": {
        const detail = run(text(input, "runId"));
        if (detail.documentId !== row.id) invalid("runId", "document-mismatch");
        const candidate = detail.candidateId ? db.prepare("SELECT body FROM candidates WHERE candidate_id = ?;").get(detail.candidateId) : null;
        return { ...detail, candidate, attempts: generation.history(detail.id) };
      }
      case "evidence.detail": {
        if (row.product !== "fanqie") invalid("documentId", "chapter-required");
        return readAuthorModel(row.projectId, { model: "evidence", factId: text(input, "factId") });
      }
      case "evidence.record":
        return atomic(() => {
          const current = document(row.id);
          currentBody(current, input);
          const quote = text(input, "quote");
          const body = current.body ?? "";
          const start = body.indexOf(quote);
          if (start < 0 || body.indexOf(quote, start + 1) >= 0) invalid("quote", "quote-must-match-exactly-once");
          const point = body.slice(0, start).split(/\r?\n/).length;
          const record = {
            snapshotId: randomUUID(), revisionId: current.revisionId,
            anchor: { chapterId: row.id, point: String(point) },
            quoteRange: { start, end: start + quote.length }, verification: { kind: "exact", score: 100 },
          };
          event(row.projectId, "evidence", "evidence.recorded", { factId: text(input, "factId"), record });
          return record;
        });
      case "chapter.outline":
        return atomic(() => {
          if (row.product !== "fanqie") invalid("documentId", "chapter-required");
          const viewpoint = text(input, "viewpoint");
          const target = count(input, "target");
          if (!target) invalid("target", "positive-length-required");
          const sections = Object.fromEntries(OUTLINE_SECTIONS.map((name) => [name, text(input, name)]));
          const value = {
            viewpoint, target, sections, lockedFacts: text(input, "lockedFacts"), knowledge: text(input, "knowledge"),
          };
          savePlanning(row, value);
          return { ...value, warnings: chapterLengthWarnings(target) };
        });
      case "article.plan":
        return atomic(() => {
          if (!row.mode || !row.line) invalid("documentId", "article-required");
          const scenario = articleScenario(row.mode, row.line);
          const driver = text(input, "driver");
          const opening = text(input, "opening");
          const ending = text(input, "ending");
          if (!(scenario.drivers as readonly string[]).includes(driver)) invalid("driver", "driver-unavailable-in-line");
          if (!(scenario.openings as readonly string[]).includes(opening)) invalid("opening", "opening-unavailable-in-line");
          if (!(scenario.endings as readonly string[]).includes(ending)) invalid("ending", "ending-unavailable-in-line");
          let titleMatrix;
          if (scenario.hasTitle && input.titles) {
            const candidates = text(input, "titles").split(/\r?\n/).filter((line) => line.trim()).map((line) => {
              const separator = line.indexOf("|");
              if (separator < 1) invalid("titles", "expected-title-pipe-motif");
              return { text: line.slice(0, separator).trim(), motif: line.slice(separator + 1).trim() };
            });
            titleMatrix = validateTitleMatrix(candidates);
            if (!titleMatrix.passed) invalid("titles", "five-titles-three-motifs-required");
          }
          const value = { driver, opening, ending, titleMatrix };
          savePlanning(row, value);
          return value;
        });
      case "article.rename":
        return atomic(() => {
          const current = document(row.id);
          if (!current.mode || current.mode === "micro" || locked(current)) refuse(action, "title-not-editable");
          if (current.revisionId !== input.baseRevisionId) currentBody(current, input);
          const title = titleFor(current.mode, text(input, "title").trim());
          if (title === current.title) return { revisionId: current.revisionId };
          db.prepare("UPDATE author_documents SET title = ? WHERE id = ?;").run(title, current.id);
          event(row.projectId, "chapter", "document.renamed", { documentId: row.id, title });
          return current.revisionId ? addRevision(current, current.body ?? "") : { revisionId: null };
        });
      case "draft.save":
        return dispatch(action, row, input, () => addRevision(document(row.id), text(input, "body")));
      case "run.start":
        return dispatch(action, row, input, () => {
          const current = document(row.id);
          currentBody(current, input);
          if (locked(current)) refuse(action, "revision-locked");
          const existing = db.prepare(`
            SELECT id FROM author_runs WHERE document_id = ? AND state IN ('running','paused','awaiting-author') LIMIT 1;
          `).get(current.id) as { id: string } | undefined;
          if (existing) refuse(action, "generation-in-progress");
          if (generation.uncertainForDocument(current.id)) {
            refuse(action, "generation-needs-reconciliation");
          }
          const reserved = count(input, "tokenLimit");
          if (reserved === 0) invalid("tokenLimit", "positive-budget-required");
          const id = randomUUID();
          const plan = planning(row.id);
          const point = input.point === undefined ? 1 : count(input, "point");
          if (point === 0) invalid("point", "positive-integer-required");
          const know = plan && typeof plan.viewpoint === "string"
            ? settingsAt(facts(row.projectId), chapterOrder(row.projectId), anchor(row.id, point), plan.viewpoint)
            : [];
          const frozenInput = JSON.stringify({
            title: current.title, revisionId: current.revisionId, text: current.body, instruction: text(input, "instruction"),
            mode: current.mode, planning: plan, knownAt: { chapterId: row.id, point }, knownFacts: know,
            scenario: current.mode && current.line ? articleScenario(current.mode, current.line) : null,
          });
          db.prepare(`
            INSERT INTO author_runs (id, document_id, state, base_revision_id, frozen_input, reserved)
            VALUES (?, ?, 'running', ?, ?, ?);
          `).run(id, row.id, current.revisionId, frozenInput, reserved);
          event(row.projectId, "run", "run.started", { documentId: row.id, runId: id, reserved });
          return { id };
        });
      case "candidate.adopt":
        return dispatch(action, row, input, () => {
          const current = run(text(input, "runId"));
          if (current.documentId !== row.id || current.baseRevisionId !== input.baseRevisionId || !current.candidateId) {
            refuse(action, "candidate-base-mismatch");
          }
          const candidate = requiredRow<{ body: string }>(db.prepare("SELECT body FROM candidates WHERE candidate_id = ?;")
            .get(current.candidateId), "candidate", current.candidateId);
          const revision = addRevision(document(row.id), candidate.body);
          stage(current, "applied");
          return revision;
        });
      case "chapter.review":
        return atomic(() => {
          const current = document(row.id);
          currentBody(current, input);
          if (current.product !== "fanqie" || current.state === "final") refuse(action, "chapter-not-reviewable");
          if (typeof input.accept !== "boolean") invalid("accept");
          if (!input.accept && current.editorialRejections >= EDITORIAL_REJECTION_LIMIT) refuse(action, "editorial-rejection-limit");
          const state = input.accept ? "reviewed" : "drafted";
          db.prepare("UPDATE author_documents SET state = ?, editorial_rejections = editorial_rejections + ? WHERE id = ?;")
            .run(state, input.accept ? 0 : 1, row.id);
          event(row.projectId, "chapter", "chapter.reviewed", { documentId: row.id, state });
          return { state };
        });
      case "draft.finalize":
        return dispatch(action, row, input, () => {
          const current = document(row.id);
          if (current.product !== "fanqie" || !current.revisionId) refuse(action, "chapter-required");
          assertChapterFinalizable(current.state as ChapterState, current.editorialRejections);
          db.prepare("UPDATE author_documents SET state = 'final', final_revision_id = ? WHERE id = ?;").run(current.revisionId, row.id);
          event(row.projectId, "chapter", "document.state", { documentId: row.id, state: "final" });
          event(row.projectId, "revision", "revision.finalized", { documentId: row.id, revisionId: current.revisionId });
          return { revisionId: current.revisionId };
        });
      case "article.qa":
        return atomic(() => {
          const current = document(row.id);
          currentBody(current, input);
          if (current.product !== "toutiao" || !current.mode || !current.body ||
              !["初稿待改", "验收退回", "待验收"].includes(current.state)) refuse(action, "article-not-reviewable");
          const qa = qaReport(input, structuralGates(current.mode, current.title, current.body));
          const next = qaPassed(qa) ? "待验收" : "初稿待改";
          moveArticle(current, next);
          event(row.projectId, "evidence", "article.qa", { documentId: row.id, revisionId: current.revisionId, ...qa });
          return qa;
        });
      case "article.refine":
        return atomic(() => {
          const current = document(row.id);
          currentBody(current, input);
          if (current.product !== "toutiao" || current.state !== "初稿待改" || current.qaRounds >= QA_REFINEMENT_LIMIT) {
            refuse(action, "qa-refinement-unavailable");
          }
          db.prepare("UPDATE author_documents SET qa_rounds = qa_rounds + 1 WHERE id = ?;").run(row.id);
          return addRevision(current, text(input, "body"));
        });
      case "article.accept":
        return dispatch(action, row, input, () => {
          if (typeof input.accept !== "boolean") invalid("accept");
          const current = document(row.id);
          if (current.state !== "待验收") refuse(action, "qa-pass-required");
          moveArticle(current, input.accept ? "已验收" : "验收退回");
          if (!input.accept) event(row.projectId, "evidence", "article.rejected", {
            documentId: row.id, revisionId: current.revisionId,
            reason: typeof input.reason === "string" ? input.reason.trim() : "",
          });
          if (input.accept) db.prepare("UPDATE author_documents SET final_revision_id = ? WHERE id = ?;")
            .run(current.revisionId, current.id);
          return { revisionId: current.revisionId };
        });
      case "approval.decide":
        return atomic(() => {
          const current = document(row.id);
          currentBody(current, input);
          if (current.state !== "已验收") refuse(action, "accepted-article-required");
          if (input.confirmed !== true) refuse(action, "explicit-confirmation-required");
          if (recordedApproval(current, current.revisionId!)) return { approved: true };
          const at = new Date().toISOString();
          const approvalRow = db.prepare("INSERT INTO author_approvals (document_id, revision_id, at) VALUES (?, ?, ?);")
            .run(row.id, current.revisionId, at);
          const version = db.prepare("SELECT rowid AS number FROM revisions WHERE revision_id = ?;")
            .get(current.revisionId) as { number: number };
          event(row.projectId, "approval", "delivery.approved", {
            documentId: row.id, revisionId: current.revisionId, approvalId: String(approvalRow.lastInsertRowid),
            versionNumber: version.number, at,
          });
          return { approved: true };
        });
      case "article.deliver": {
        const approval = recordedApproval(row, text(input, "baseRevisionId"));
        if (!approval) refuse(action, "approval-missing");
        dispatch(action, row, input, () => {
          const current = document(row.id);
          if (current.state !== "已验收" || current.finalRevisionId !== approval.targetVersion) refuse(action, "accepted-article-required");
          moveArticle(current, "已交稿");
          insertDeliveryRow(db, { articleId: row.id, finalRevisionId: approval.targetVersion, approvalId: approval.at });
          return { id: row.id };
        }, approval);
        return attemptExport(db, row.id, (body) => writeDelivery(row.id, body), () => formatDelivery(row.title, row.body ?? ""));
      }
      default:
        return invalid("action", "unknown-action");
    }
  }

  function snapshot(projectId?: string, documentId?: string) {
    const projects = db.prepare("SELECT id, name, product FROM author_projects ORDER BY rowid;").all();
    if (!projectId) return { projects };
    const documents = db.prepare(`
      SELECT id, title FROM author_documents WHERE project_id = ? ORDER BY rowid;
    `).all(projectId) as readonly { id: string; title: string }[];
    const order = chapterOrder(projectId, documents);
    const byId = new Map(documents.map((entry) => [entry.id, entry]));
    const sorted = order.map((id) => byId.get(id)).filter((entry) => entry !== undefined);
    const active = documentId && byId.has(documentId) ? document(documentId) : undefined;
    const runs = active ? db.prepare(`
      SELECT r.id, r.state, r.base_revision_id AS baseRevisionId,
        r.reserved, r.settled, r.candidate_id AS candidateId,
        CASE WHEN r.state = 'awaiting-author' THEN c.body END AS candidateBody,
        q.report AS candidateQa, q.rounds AS refinementRounds,
        g.state AS generationState, g.error AS generationError
      FROM author_runs r
      LEFT JOIN candidates c ON c.candidate_id = r.candidate_id AND r.state = 'awaiting-author'
      LEFT JOIN author_candidate_qa q ON q.candidate_id = c.candidate_id
      LEFT JOIN author_generation_attempts g ON g.rowid = (
        SELECT MAX(a.rowid) FROM author_generation_attempts a WHERE a.run_id = r.id
      )
      WHERE r.document_id = ? AND (
        r.rowid IN (SELECT rowid FROM author_runs WHERE document_id = ? ORDER BY rowid DESC LIMIT 2)
        OR r.rowid IN (
          SELECT MAX(rowid) FROM author_runs WHERE document_id = ?
          AND state IN ('running', 'awaiting-author') GROUP BY state
        )
        OR g.state = 'uncertain'
      )
      ORDER BY r.rowid DESC;
    `).all(active.id, active.id, active.id) : [];
    const approved = !!(active?.revisionId && recordedApproval(active, active.revisionId));
    const delivery = active?.state === "已交稿" ? formatDelivery(active.title, active.body ?? "") : null;
    const exportStatus = delivery ? db.prepare(`
      SELECT export_state AS state, export_error AS error FROM deliveries WHERE article_id = ?;
    `).get(active!.id) : null;
    const latestReport = active?.revisionId ? db.prepare(`
      SELECT payload FROM event_log WHERE project_id = ? AND kind IN ('article.qa','article.rejected')
        AND json_extract(payload, '$.revisionId') = ? ORDER BY seq DESC LIMIT 1;
    `).get(projectId, active.revisionId) as { payload: string } | undefined : undefined;
    const settings = active?.product === "fanqie" ? settingsPage(projectId) : null;
    return {
      projects, documents: sorted, active, runs, approved, delivery, exportStatus, settings: settings?.entries ?? [], settingsCursor: settings?.cursor, report: latestReport ? JSON.parse(latestReport.payload) : null,
      planning: active ? planning(active.id) : null,
      scenario: active?.mode && active.line ? articleScenario(active.mode, active.line) : null,
      asOfSeq: currentSeq(db, projectId),
    };
  }

  function generationInput(input: Input, claim = false) {
    const provider = text(input, "provider");
    const model = text(input, "model");
    return atomic(() => {
      const current = run(text(input, "runId"));
      const row = document(current.documentId);
      if (locked(row) || current.baseRevisionId !== row.revisionId) refuse("run.generate", "revision-changed");
      if (generation.pending(current.id)) refuse("run.generate", "generation-needs-reconciliation");
      if (current.state === "failed") stage(current, "running");
      else if (current.state !== "running") refuse("run.generate", "run-no-longer-running");
      const attemptId = claim ? randomUUID() : null;
      if (attemptId) {
        generation.create(attemptId, current.id, provider, model);
        event(row.projectId, "run", "generation.started", { runId: current.id, attemptId });
      }
      return {
        id: current.id, attemptId,
        autoQa: input.autoQa === true && row.product === "toutiao",
        frozenInput: current.frozenInput,
        reserved: Math.max(0, current.reserved - current.settled),
        provider, model,
      };
    });
  }

  function finishGeneration(id: string, result: Input | null, failure: string | null) {
    return atomic(() => {
      const attempt = generation.openAttempt(id);
      if (!attempt) return;
      const current = run(attempt.runId);
      const row = document(current.documentId);
      const receipts = JSON.parse(attempt.usage) as { usage: number[] }[];
      const tokens = receipts.reduce((sum, entry) => entry.usage.reduce((total, value) => total + value, sum), 0);
      const uncertain = attempt.state === "inflight";
      generation.close(id, uncertain ? "uncertain" : result ? "completed" : "failed", failure);
      if (current.state === "running" && result && !uncertain) {
        return completeRun(current, row, { ...result, tokens });
      }
      db.prepare("UPDATE author_runs SET settled = settled + ? WHERE id = ?;").run(tokens, current.id);
      event(row.projectId, "run", "run.attempt", { runId: current.id, attemptId: id, usage: tokens, outcome: uncertain ? "usage.uncertain" : failure ?? "cancelled" });
      if (current.state === "running") stage(current, "failed");
    });
  }

  function recoverGenerations() {
    for (const { id } of generation.unfinished()) finishGeneration(id, null, "interrupted");
  }
  function reserveRefinement(id: string): void {
    atomic(() => {
      const current = run(id);
      if (current.state !== "running") refuse("run.generate", "run-no-longer-running");
      const reserved = db.prepare(`
        INSERT INTO author_run_refinement_claims (run_id, rounds) VALUES (?, 1)
        ON CONFLICT (run_id) DO UPDATE SET rounds = rounds + 1 WHERE rounds < ?;
      `).run(id, QA_REFINEMENT_LIMIT);
      if (!reserved.changes) refuse("run.generate", "qa-refinement-limit");
    });
  }

  function failGeneration(id: string, tokens: number): void {
    atomic(() => {
      const current = run(id);
      if (current.state === "running") {
        db.prepare("UPDATE author_runs SET settled = settled + ? WHERE id = ?;").run(tokens, id);
        const row = document(current.documentId);
        event(row.projectId, "run", "run.attempt", { runId: id, usage: tokens, outcome: "failed" });
        stage(current, "failed");
      }
    });
  }

  function resumeExports(): void {
    for (const id of pendingExports(db)) {
      const row = document(id);
      if (row.state !== "已交稿") continue;
      attemptExport(db, id, (body) => writeDelivery(id, body), () => formatDelivery(row.title, row.body ?? ""));
    }
  }

  return { snapshot, projectSeq: (id: string) => currentSeq(db, id), mutation, generationInput, generationProgress: generation.progress, finishGeneration, recoverGenerations, reserveRefinement, failGeneration, resumeExports };
}
