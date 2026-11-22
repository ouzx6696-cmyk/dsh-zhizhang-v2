import {
  articleScenario,
  assertArticleTransition,
  QA_REFINEMENT_LIMIT,
  qaPassed,
  structuralGates,
  TITLE_MAX,
  validateTitleMatrix,
  type ArticleMode,
  type ArticleQa,
  type ArticleStatus,
} from "../../../domain/toutiao/index.ts";
import { stmt, syncChapterFts } from "../../../storage/index.ts";
import {
  count,
  invalid,
  refuse,
  text,
  type DocumentRow,
  type Input,
  type WorkspaceContext,
} from "../../context.ts";

export const TOUTIAO_LOCKED_STATES: readonly ArticleStatus[] = ["已验收", "已交稿"];

export function isLockedArticleState(state: string): boolean {
  return (TOUTIAO_LOCKED_STATES as readonly string[]).includes(state);
}

export function validateArticleTitle(mode: string | null, title: string): string {
  if (mode === "micro" ? Boolean(title) : !title) {
    invalid("title", mode === "micro" ? "micro-has-no-title" : "required");
  }
  if (mode && [...title].length > TITLE_MAX) invalid("title", "title-limit");
  return title;
}

export function resolveScenario(mode: string | null, line: string | null) {
  return mode && line ? articleScenario(mode, line) : null;
}

export function moveArticle(ctx: WorkspaceContext, row: DocumentRow, next: ArticleStatus): void {
  if (row.product !== "toutiao") invalid("documentId", "article-required");
  if (row.state !== next) assertArticleTransition(row.state as ArticleStatus, next);
  stmt(ctx.db, "UPDATE author_documents SET state = ? WHERE id = ?;").run(next, row.id);
  ctx.event(row.projectId, "chapter", "document.state", { documentId: row.id, state: next });
}

export function onDraftSaved(ctx: WorkspaceContext, row: DocumentRow): void {
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

export function buildCandidateQa(mode: string, title: string, body: string, reported: Input): ArticleQa {
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
  stmt(ctx.db, `
    INSERT INTO author_article_reports (project_id, document_id, revision_id, kind, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?);
  `).run(row.projectId, row.id, revisionId, kind, JSON.stringify(payload), Date.now());
}

export function latestReport(ctx: WorkspaceContext, projectId: string, revisionId: string): Input | null {
  const row = stmt(ctx.db, `
    SELECT payload FROM author_article_reports
    WHERE project_id = ? AND revision_id = ?
    ORDER BY id DESC LIMIT 1;
  `).get(projectId, revisionId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as Input) : null;
}

export function planArticle(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
  return ctx.atomic(() => {
    const current = ctx.document(row.id);
    if (isLockedArticleState(current.state)) {
      refuse("article.plan", "revision-locked");
    }
    if (!current.mode || !current.line) invalid("documentId", "article-required");
    const scenario = articleScenario(current.mode, current.line);
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
    if (!scenario.hasTitle && typeof input.titles === "string" && input.titles.trim()) {
      refuse("article.plan", "micro-title-forbidden");
    }
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
    ctx.savePlanning(current, value);
    return value;
  });
}

export function renameArticle(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
  return ctx.atomic(() => {
    const current = ctx.document(row.id);
    if (!current.mode || current.mode === "micro" || isLockedArticleState(current.state)) {
      refuse("article.rename", "title-not-editable");
    }
    if (current.revisionId !== input.baseRevisionId) ctx.currentBody(current, input);
    const title = validateArticleTitle(current.mode, text(input, "title").trim());
    if (title === current.title) return { revisionId: current.revisionId };
    stmt(ctx.db, "UPDATE author_documents SET title = ?, updated_at = ? WHERE id = ?;")
      .run(title, Date.now(), current.id);
    ctx.event(row.projectId, "chapter", "document.renamed", { documentId: row.id, title });
    if (current.revisionId) {
      const renamedRow: DocumentRow = { ...current, title };
      return ctx.appendDraftRevision(renamedRow, current.body ?? "", (doc) => onDraftSaved(ctx, doc));
    }
    syncChapterFts(ctx.db, {
      projectId: current.projectId,
      documentId: current.id,
      title,
      summary: current.summary,
      body: "",
    });
    return { revisionId: null };
  });
}

export function recordQa(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
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

export function refineDraft(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
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
    stmt(ctx.db, "UPDATE author_documents SET qa_rounds = qa_rounds + 1 WHERE id = ?;").run(row.id);
    return ctx.appendDraftRevision(current, text(input, "body"), (doc) => onDraftSaved(ctx, doc));
  });
}

export function acceptArticle(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
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
      stmt(ctx.db, "UPDATE author_documents SET final_revision_id = ? WHERE id = ?;")
        .run(current.revisionId, current.id);
    }
    return { revisionId: current.revisionId };
  });
}
