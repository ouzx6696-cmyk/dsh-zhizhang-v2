import { ContractError, type ApprovalRecord } from "../../contracts/index.ts";
import {
  articleScenario,
  assertArticleTransition,
  formatDelivery,
  QA_REFINEMENT_LIMIT,
  qaPassed,
  structuralGates,
  TITLE_MAX,
  validateTitleMatrix,
  type ArticleMode,
  type ArticleQa,
  type ArticleStatus,
} from "../../domain/toutiao/index.ts";
import { refineArticle } from "../../domain/toutiao/refinement.ts";
import { attemptExport, createDeliverySchema, pendingExports, type SqliteDatabase } from "../../storage/index.ts";
import { commitApprovedDelivery } from "../../storage/delivery.ts";
import { projectReadUnit, type AuthorReadUnitFactory } from "../../workflow/author-reads.ts";
import { QA_SYSTEM, WRITER_SYSTEM } from "../../workflow/writing-budget.ts";
import { assertStageOutput, WRITING_STAGE_IDS } from "../../workflow/writing-stages.ts";
import {
  count,
  invalid,
  refuse,
  requiredRow,
  text,
  type DocumentRow,
  type Input,
  type WorkspaceContext,
} from "../context.ts";
import type { ActionDefinition, ProductGenerationRunner, ProductLineModule } from "../product-line.ts";

const TOUTIAO_LOCKED_STATES: readonly ArticleStatus[] = ["已验收", "已交稿"];

function isLockedArticleState(state: string): boolean {
  return (TOUTIAO_LOCKED_STATES as readonly string[]).includes(state);
}

function parseQa(source: string): ArticleQa {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.trim().replace(/^```(?:json)?\s*|\s*```$/giu, ""));
  } catch {
    throw new ContractError("stage.output_invalid", { stage: WRITING_STAGE_IDS.qa, missing: "json" });
  }
  assertStageOutput(WRITING_STAGE_IDS.qa, parsed, "qa-result");
  const result = parsed as ArticleQa;
  return {
    overall: result.overall,
    passed: result.passed,
    fails: result.fails,
    hardGates: result.hardGates,
  };
}

/**
 * Toutiao-specific generation pipeline: single-shot write, optionally followed
 * by QA assessment and up to `QA_REFINEMENT_LIMIT` (2) targeted refinement rounds.
 */
export function createToutiaoGenerationRunner(): ProductGenerationRunner {
  return async ({ caller, run, signal, reserveRefinement }) => {
    const body = await caller.complete({ phase: "write", system: WRITER_SYSTEM, prompt: run.frozenInput });
    if (!run.autoQa || signal.aborted) {
      return { body, tokens: caller.usedTokens() };
    }
    const { title, mode, scenario } = JSON.parse(run.frozenInput) as {
      title: string;
      mode: ArticleMode;
      scenario: unknown;
    };
    const result = await refineArticle(
      body,
      async (draft) => {
        signal.throwIfAborted();
        const output = await caller.complete({
          phase: "qa",
          system: QA_SYSTEM,
          prompt: JSON.stringify({ title, mode, scenario, text: draft }),
          maxOutputTokens: 1200,
        });
        const qa = parseQa(output);
        return { ...qa, hardGates: [...qa.hardGates, ...structuralGates(mode, title, draft)] };
      },
      (draft, qa) => {
        signal.throwIfAborted();
        reserveRefinement();
        return caller.complete({
          phase: "refine",
          system: WRITER_SYSTEM,
          prompt: JSON.stringify({
            title,
            scenario,
            text: draft,
            instruction: "只处理未通过项与硬门，再给出完整正文。",
            fails: qa.fails,
            hardGates: qa.hardGates,
          }),
        });
      },
    );
    return { ...result, tokens: caller.usedTokens() };
  };
}

/**
 * Toutiao (article & micro-post) product-line module.
 * Depends strictly on `domain/toutiao` — never `domain/fanqie`.
 */
export function createToutiaoModule(
  writeDelivery: (documentId: string, text: string) => void = () => {},
): ProductLineModule {
  const runGeneration = createToutiaoGenerationRunner();

  function initSchema(db: SqliteDatabase): void {
    createDeliverySchema(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS author_run_refinement_claims (
        run_id TEXT PRIMARY KEY REFERENCES author_runs(id),
        rounds INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS author_candidate_qa (
        candidate_id TEXT PRIMARY KEY REFERENCES candidates(candidate_id),
        report TEXT NOT NULL,
        rounds INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS author_article_reports (
        id INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES author_projects(id),
        document_id TEXT NOT NULL REFERENCES author_documents(id),
        revision_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS author_approvals (
        document_id TEXT NOT NULL REFERENCES author_documents(id),
        revision_id TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (document_id, revision_id)
      );
      CREATE INDEX IF NOT EXISTS author_reports_by_revision
        ON author_article_reports(project_id, revision_id, id DESC);
    `);
  }

  function validateArticleTitle(mode: string | null, title: string): string {
    if (mode === "micro" ? Boolean(title) : !title) {
      invalid("title", mode === "micro" ? "micro-has-no-title" : "required");
    }
    if (mode && [...title].length > TITLE_MAX) invalid("title", "title-limit");
    return title;
  }

  function resolveScenario(mode: string | null, line: string | null) {
    return mode && line ? articleScenario(mode, line) : null;
  }

  function moveArticle(ctx: WorkspaceContext, row: DocumentRow, next: ArticleStatus): void {
    if (row.product !== "toutiao") invalid("documentId", "article-required");
    if (row.state !== next) assertArticleTransition(row.state as ArticleStatus, next);
    ctx.db.prepare("UPDATE author_documents SET state = ? WHERE id = ?;").run(next, row.id);
    ctx.event(row.projectId, "chapter", "document.state", { documentId: row.id, state: next });
  }

  function onDraftSaved(ctx: WorkspaceContext, row: DocumentRow): void {
    moveArticle(ctx, row, "初稿待改");
  }

  function buildQaReport(input: Input, hardGates: readonly string[] = []): ArticleQa {
    const failures = input.fails;
    const suppliedGates = input.hardGates ?? [];
    if (!Array.isArray(failures) || failures.some((item) => typeof item !== "string")) invalid("fails");
    if (!Array.isArray(suppliedGates) || suppliedGates.some((item) => typeof item !== "string")) {
      invalid("hardGates");
    }
    if (typeof input.passed !== "boolean") invalid("passed");
    const overall = count(input, "score");
    if (overall > 100) invalid("score", "out-of-range");
    return {
      overall,
      passed: input.passed,
      fails: failures as string[],
      hardGates: [...new Set([...(suppliedGates as string[]), ...hardGates])],
    };
  }

  function buildCandidateQa(mode: string, title: string, body: string, reported: Input): ArticleQa {
    return buildQaReport(
      { ...reported, score: reported.overall },
      structuralGates(mode as ArticleMode, title, body),
    );
  }

  function recordReport(
    ctx: WorkspaceContext,
    row: DocumentRow,
    revisionId: string,
    kind: "article.qa" | "article.rejected",
    payload: Input,
  ): void {
    ctx.db.prepare(`
      INSERT INTO author_article_reports (project_id, document_id, revision_id, kind, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?);
    `).run(row.projectId, row.id, revisionId, kind, JSON.stringify(payload), Date.now());
  }

  function latestReport(ctx: WorkspaceContext, projectId: string, revisionId: string): Input | null {
    const row = ctx.db.prepare(`
      SELECT payload FROM author_article_reports
      WHERE project_id = ? AND revision_id = ?
      ORDER BY id DESC LIMIT 1;
    `).get(projectId, revisionId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Input) : null;
  }

  function recordedApproval(ctx: WorkspaceContext, row: DocumentRow, revisionId: string): ApprovalRecord | null {
    const record = ctx.db
      .prepare("SELECT at FROM author_approvals WHERE document_id = ? AND revision_id = ?;")
      .get(row.id, revisionId) as { at: string } | undefined;
    return record
      ? {
        actor: "author",
        action: "article.deliver",
        target: row.id,
        targetVersion: revisionId,
        decision: "approved",
        at: record.at,
      }
      : null;
  }

  function approvedMarkdown(ctx: WorkspaceContext, id: string): string {
    const revision = requiredRow<{ title: string; body: string }>(
      ctx.db.prepare(`
        SELECT a.title, r.body FROM deliveries d
        JOIN revisions r ON r.revision_id = d.final_revision_id AND r.document_id = d.article_id
        JOIN author_documents a ON a.id = d.article_id
        WHERE d.article_id = ?;
      `).get(id),
      "delivery",
      id,
    );
    return formatDelivery(revision.title, revision.body);
  }

  function exportDelivery(ctx: WorkspaceContext, id: string) {
    return attemptExport(ctx.db, id, (body) => writeDelivery(id, body), () => approvedMarkdown(ctx, id));
  }

  function planArticle(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    return ctx.atomic(() => {
      if (!row.mode || !row.line) invalid("documentId", "article-required");
      const scenario = articleScenario(row.mode, row.line);
      const driver = text(input, "driver");
      const opening = text(input, "opening");
      const ending = text(input, "ending");
      if (!(scenario.drivers as readonly string[]).includes(driver)) {
        invalid("driver", "driver-unavailable-in-line");
      }
      if (!(scenario.openings as readonly string[]).includes(opening)) {
        invalid("opening", "opening-unavailable-in-line");
      }
      if (!(scenario.endings as readonly string[]).includes(ending)) {
        invalid("ending", "ending-unavailable-in-line");
      }
      let titleMatrix;
      if (scenario.hasTitle && input.titles) {
        const candidates = text(input, "titles")
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => {
            const separator = line.indexOf("|");
            if (separator < 1) invalid("titles", "expected-title-pipe-motif");
            return { text: line.slice(0, separator).trim(), motif: line.slice(separator + 1).trim() };
          });
        titleMatrix = validateTitleMatrix(candidates);
        if (!titleMatrix.passed) invalid("titles", "five-titles-three-motifs-required");
      }
      const value = { driver, opening, ending, titleMatrix };
      ctx.savePlanning(row, value);
      return value;
    });
  }

  function renameArticle(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    return ctx.atomic(() => {
      const current = ctx.document(row.id);
      if (!current.mode || current.mode === "micro" || isLockedArticleState(current.state)) {
        refuse("article.rename", "title-not-editable");
      }
      if (current.revisionId !== input.baseRevisionId) ctx.currentBody(current, input);
      const title = validateArticleTitle(current.mode, text(input, "title").trim());
      if (title === current.title) return { revisionId: current.revisionId };
      ctx.db.prepare("UPDATE author_documents SET title = ? WHERE id = ?;").run(title, current.id);
      ctx.event(row.projectId, "chapter", "document.renamed", { documentId: row.id, title });
      return current.revisionId
        ? ctx.appendDraftRevision(current, current.body ?? "", (doc) => onDraftSaved(ctx, doc))
        : { revisionId: null };
    });
  }

  function recordQa(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    return ctx.atomic(() => {
      const current = ctx.document(row.id);
      ctx.currentBody(current, input);
      if (
        current.product !== "toutiao" ||
        !current.mode ||
        !current.body ||
        !["初稿待改", "验收退回", "待验收"].includes(current.state)
      ) {
        refuse("article.qa", "article-not-reviewable");
      }
      const qa = buildQaReport(input, structuralGates(current.mode as ArticleMode, current.title, current.body));
      const next: ArticleStatus = qaPassed(qa) ? "待验收" : "初稿待改";
      moveArticle(ctx, current, next);
      const payload = { documentId: row.id, revisionId: current.revisionId!, ...qa };
      recordReport(ctx, current, current.revisionId!, "article.qa", payload);
      ctx.event(row.projectId, "evidence", "article.qa", payload);
      return qa;
    });
  }

  function refineDraft(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    return ctx.atomic(() => {
      const current = ctx.document(row.id);
      ctx.currentBody(current, input);
      if (
        current.product !== "toutiao" ||
        current.state !== "初稿待改" ||
        current.qaRounds >= QA_REFINEMENT_LIMIT
      ) {
        refuse("article.refine", "qa-refinement-unavailable");
      }
      ctx.db.prepare("UPDATE author_documents SET qa_rounds = qa_rounds + 1 WHERE id = ?;").run(row.id);
      return ctx.appendDraftRevision(current, text(input, "body"), (doc) => onDraftSaved(ctx, doc));
    });
  }

  function acceptArticle(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    return ctx.dispatch("article.accept", row, input, () => {
      if (typeof input.accept !== "boolean") invalid("accept");
      const current = ctx.document(row.id);
      if (current.state !== "待验收") refuse("article.accept", "qa-pass-required");
      moveArticle(ctx, current, input.accept ? "已验收" : "验收退回");
      if (!input.accept) {
        const payload = {
          documentId: row.id,
          revisionId: current.revisionId!,
          reason: typeof input.reason === "string" ? input.reason.trim() : "",
        };
        recordReport(ctx, current, current.revisionId!, "article.rejected", payload);
        ctx.event(row.projectId, "evidence", "article.rejected", payload);
      } else {
        ctx.db.prepare("UPDATE author_documents SET final_revision_id = ? WHERE id = ?;")
          .run(current.revisionId, current.id);
      }
      return { revisionId: current.revisionId };
    });
  }

  function decideApproval(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    return ctx.atomic(() => {
      const current = ctx.document(row.id);
      ctx.currentBody(current, input);
      if (current.state !== "已验收") refuse("approval.decide", "accepted-article-required");
      if (input.confirmed !== true) refuse("approval.decide", "explicit-confirmation-required");
      if (recordedApproval(ctx, current, current.revisionId!)) return { approved: true };
      const at = new Date().toISOString();
      const approvalRow = ctx.db
        .prepare("INSERT INTO author_approvals (document_id, revision_id, at) VALUES (?, ?, ?);")
        .run(row.id, current.revisionId, at);
      const version = ctx.db
        .prepare("SELECT rowid AS number FROM revisions WHERE revision_id = ?;")
        .get(current.revisionId) as { number: number };
      ctx.event(row.projectId, "approval", "delivery.approved", {
        documentId: row.id,
        revisionId: current.revisionId,
        approvalId: String(approvalRow.lastInsertRowid),
        versionNumber: version.number,
        at,
      });
      return { approved: true };
    });
  }

  function deliverArticle(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
    const approval = recordedApproval(ctx, row, text(input, "baseRevisionId"));
    if (!approval) refuse("article.deliver", "approval-missing");
    const outcome = commitApprovedDelivery(
      ctx.db,
      {
        ...ctx.commandInput(row, input),
        finalRevisionId: approval.targetVersion,
        approval,
      },
      () => {
        const current = ctx.document(row.id);
        if (current.state !== "已验收" || current.finalRevisionId !== approval.targetVersion) {
          refuse("article.deliver", "accepted-article-required");
        }
        moveArticle(ctx, current, "已交稿");
        return { id: row.id };
      },
    );
    if (!outcome.ok) throw new ContractError(outcome.code!, outcome.details);
    return exportDelivery(ctx, row.id);
  }

  function resumeExports(ctx: WorkspaceContext): void {
    for (const id of pendingExports(ctx.db)) {
      const row = ctx.document(id);
      if (row.state !== "已交稿") continue;
      exportDelivery(ctx, id);
    }
  }

  const readModels: Readonly<Record<string, AuthorReadUnitFactory>> = {
    "approval-history": (definition) =>
      projectReadUnit(
        definition,
        () => ({ entries: [] as Record<string, unknown>[] }),
        (state, event) => {
          if (event.kind !== "delivery.approved" || typeof event.approvalId !== "string") return state;
          return {
            entries: [
              ...state.entries,
              {
                approvalId: event.approvalId,
                actor: "author",
                action: "article.deliver",
                target: event.documentId,
                targetVersion: event.versionNumber,
                decision: "approved",
                at: event.at,
              },
            ],
          };
        },
        (state) => state,
      ),
  };

  const actions: Readonly<Record<string, ActionDefinition>> = {
    "article.plan": { scope: "document", handler: (ctx, input, row) => planArticle(ctx, row!, input) },
    "article.rename": { scope: "document", handler: (ctx, input, row) => renameArticle(ctx, row!, input) },
    "article.qa": { scope: "document", handler: (ctx, input, row) => recordQa(ctx, row!, input) },
    "article.refine": { scope: "document", handler: (ctx, input, row) => refineDraft(ctx, row!, input) },
    "article.accept": { scope: "document", handler: (ctx, input, row) => acceptArticle(ctx, row!, input) },
    "approval.decide": { scope: "document", handler: (ctx, input, row) => decideApproval(ctx, row!, input) },
    "article.deliver": { scope: "document", handler: (ctx, input, row) => deliverArticle(ctx, row!, input) },
  };

  return {
    id: "toutiao",
    initialState: "初稿待改",
    lockedStates: TOUTIAO_LOCKED_STATES,
    supportsAutoQa: true,
    initSchema,
    validateCreate(input, title) {
      const mode = text(input, "mode");
      const line = text(input, "line");
      resolveScenario(mode, line);
      validateArticleTitle(mode, title);
      return { title, mode, line };
    },
    onDraftSaved,
    buildFrozenContext(_ctx, row, _input) {
      return { knownFacts: [], scenario: resolveScenario(row.mode, row.line) };
    },
    onCandidateCreated(ctx, row, candidateId, body, frozenInput, input) {
      if (input.qa && typeof input.qa === "object" && row.mode) {
        const { title } = JSON.parse(frozenInput) as { title: string };
        const qa = buildCandidateQa(row.mode, title, body, input.qa as Input);
        const rounds = count(input, "rounds");
        if (rounds > QA_REFINEMENT_LIMIT) invalid("rounds", "qa-refinement-limit");
        ctx.db.prepare("INSERT INTO author_candidate_qa (candidate_id, report, rounds) VALUES (?, ?, ?);")
          .run(candidateId, JSON.stringify(qa), rounds);
      }
    },
    runGeneration,
    reserveRefinement(ctx, runId) {
      const reserved = ctx.db.prepare(`
        INSERT INTO author_run_refinement_claims (run_id, rounds) VALUES (?, 1)
        ON CONFLICT (run_id) DO UPDATE SET rounds = rounds + 1 WHERE rounds < ?;
      `).run(runId, QA_REFINEMENT_LIMIT);
      if (!reserved.changes) refuse("run.generate", "qa-refinement-limit");
    },
    actions,
    contributeSnapshot(ctx, projectId, active) {
      if (!active) return {};
      const approved = Boolean(active.revisionId && recordedApproval(ctx, active, active.revisionId));
      const delivery = active.state === "已交稿" ? approvedMarkdown(ctx, active.id) : null;
      const exportStatus = delivery
        ? ctx.db.prepare(`
            SELECT export_state AS state, export_error AS error,
              export_hash AS hash, final_revision_id AS revisionId
            FROM deliveries WHERE article_id = ?;
          `).get(active.id)
        : null;
      const report = active.revisionId ? latestReport(ctx, projectId, active.revisionId) : null;
      return {
        approved,
        delivery,
        exportStatus,
        report,
        scenario: resolveScenario(active.mode, active.line),
      };
    },
    readModels,
    onStartupRecover: resumeExports,
  };
}
