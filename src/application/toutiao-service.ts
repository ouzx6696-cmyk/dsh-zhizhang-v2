import { ContractError, type ApprovalRecord } from "../contracts/index.ts";
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
} from "../domain/toutiao/index.ts";
import { attemptExport, pendingExports } from "../storage/index.ts";
import { commitApprovedDelivery } from "../storage/delivery.ts";
import {
  count,
  invalid,
  isLockedState,
  refuse,
  requiredRow,
  text,
  type DocumentRow,
  type Input,
  type WorkspaceContext,
} from "./context.ts";

/**
 * Toutiao (article & micro-post) vertical slice.
 * Depends strictly on `domain/toutiao` — never `domain/fanqie`.
 */
export function createToutiaoService(
  ctx: WorkspaceContext,
  writeDelivery: (documentId: string, text: string) => void,
) {
  const { db } = ctx;

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

  function moveArticle(row: DocumentRow, next: ArticleStatus): void {
    if (row.product !== "toutiao") invalid("documentId", "article-required");
    if (row.state !== next) assertArticleTransition(row.state as ArticleStatus, next);
    db.prepare("UPDATE author_documents SET state = ? WHERE id = ?;").run(next, row.id);
    ctx.event(row.projectId, "chapter", "document.state", { documentId: row.id, state: next });
  }

  function onDraftSaved(row: DocumentRow): void {
    moveArticle(row, "初稿待改");
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

  function recordReport(row: DocumentRow, revisionId: string, kind: "article.qa" | "article.rejected", payload: Input): void {
    db.prepare(`
      INSERT INTO author_article_reports (project_id, document_id, revision_id, kind, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?);
    `).run(row.projectId, row.id, revisionId, kind, JSON.stringify(payload), Date.now());
  }

  function latestReport(projectId: string, revisionId: string): Input | null {
    const row = db.prepare(`
      SELECT payload FROM author_article_reports
      WHERE project_id = ? AND revision_id = ?
      ORDER BY id DESC LIMIT 1;
    `).get(projectId, revisionId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Input) : null;
  }

  function recordedApproval(row: DocumentRow, revisionId: string): ApprovalRecord | null {
    const record = db
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

  function approvedMarkdown(id: string): string {
    const revision = requiredRow<{ title: string; body: string }>(
      db.prepare(`
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

  function exportDelivery(id: string) {
    return attemptExport(db, id, (body) => writeDelivery(id, body), () => approvedMarkdown(id));
  }

  function planArticle(row: DocumentRow, input: Input) {
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

  function renameArticle(row: DocumentRow, input: Input) {
    return ctx.atomic(() => {
      const current = ctx.document(row.id);
      if (!current.mode || current.mode === "micro" || isLockedState(current.state)) {
        refuse("article.rename", "title-not-editable");
      }
      if (current.revisionId !== input.baseRevisionId) ctx.currentBody(current, input);
      const title = validateArticleTitle(current.mode, text(input, "title").trim());
      if (title === current.title) return { revisionId: current.revisionId };
      db.prepare("UPDATE author_documents SET title = ? WHERE id = ?;").run(title, current.id);
      ctx.event(row.projectId, "chapter", "document.renamed", { documentId: row.id, title });
      return current.revisionId
        ? ctx.appendDraftRevision(current, current.body ?? "", onDraftSaved)
        : { revisionId: null };
    });
  }

  function recordQa(row: DocumentRow, input: Input) {
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
      moveArticle(current, next);
      const payload = { documentId: row.id, revisionId: current.revisionId!, ...qa };
      recordReport(current, current.revisionId!, "article.qa", payload);
      ctx.event(row.projectId, "evidence", "article.qa", payload);
      return qa;
    });
  }

  function refineDraft(row: DocumentRow, input: Input) {
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
      db.prepare("UPDATE author_documents SET qa_rounds = qa_rounds + 1 WHERE id = ?;").run(row.id);
      return ctx.appendDraftRevision(current, text(input, "body"), onDraftSaved);
    });
  }

  function acceptArticle(row: DocumentRow, input: Input) {
    return ctx.dispatch("article.accept", row, input, () => {
      if (typeof input.accept !== "boolean") invalid("accept");
      const current = ctx.document(row.id);
      if (current.state !== "待验收") refuse("article.accept", "qa-pass-required");
      moveArticle(current, input.accept ? "已验收" : "验收退回");
      if (!input.accept) {
        const payload = {
          documentId: row.id,
          revisionId: current.revisionId!,
          reason: typeof input.reason === "string" ? input.reason.trim() : "",
        };
        recordReport(current, current.revisionId!, "article.rejected", payload);
        ctx.event(row.projectId, "evidence", "article.rejected", payload);
      } else {
        db.prepare("UPDATE author_documents SET final_revision_id = ? WHERE id = ?;")
          .run(current.revisionId, current.id);
      }
      return { revisionId: current.revisionId };
    });
  }

  function decideApproval(row: DocumentRow, input: Input) {
    return ctx.atomic(() => {
      const current = ctx.document(row.id);
      ctx.currentBody(current, input);
      if (current.state !== "已验收") refuse("approval.decide", "accepted-article-required");
      if (input.confirmed !== true) refuse("approval.decide", "explicit-confirmation-required");
      if (recordedApproval(current, current.revisionId!)) return { approved: true };
      const at = new Date().toISOString();
      const approvalRow = db
        .prepare("INSERT INTO author_approvals (document_id, revision_id, at) VALUES (?, ?, ?);")
        .run(row.id, current.revisionId, at);
      const version = db
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

  function deliverArticle(row: DocumentRow, input: Input) {
    const approval = recordedApproval(row, text(input, "baseRevisionId"));
    if (!approval) refuse("article.deliver", "approval-missing");
    const outcome = commitApprovedDelivery(
      db,
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
        moveArticle(current, "已交稿");
        return { id: row.id };
      },
    );
    if (!outcome.ok) throw new ContractError(outcome.code!, outcome.details);
    return exportDelivery(row.id);
  }

  function resumeExports(): void {
    for (const id of pendingExports(db)) {
      const row = ctx.document(id);
      if (row.state !== "已交稿") continue;
      exportDelivery(id);
    }
  }

  return {
    validateArticleTitle,
    resolveScenario,
    onDraftSaved,
    buildCandidateQa,
    latestReport,
    recordedApproval,
    approvedMarkdown,
    planArticle,
    renameArticle,
    recordQa,
    refineDraft,
    acceptArticle,
    decideApproval,
    deliverArticle,
    resumeExports,
  };
}

export type ToutiaoService = ReturnType<typeof createToutiaoService>;
