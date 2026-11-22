import { QA_PASS_SCORE, QA_REFINEMENT_LIMIT, TITLE_MAX } from "../../../domain/toutiao/index.ts";
import { createDeliverySchema, stmt, type SqliteDatabase } from "../../../storage/index.ts";
import { projectReadUnit, type AuthorReadUnitFactory } from "../../../workflow/author-reads.ts";
import { count, invalid, refuse, text } from "../../context.ts";
import type { ActionDefinition, ProductLineModule } from "../../product-line.ts";
import {
  approvedMarkdown,
  decideApproval,
  deliverArticle,
  recordedApproval,
  resumeExports,
} from "./delivery.ts";
import { buildToutiaoFrozenContext, createToutiaoGenerationRunner } from "./generation.ts";
import { createToutiaoAgentTools } from "./tools.ts";
import {
  acceptArticle,
  buildCandidateQa,
  latestReport,
  onDraftSaved,
  planArticle,
  recordQa,
  refineDraft,
  renameArticle,
  resolveScenario,
  TOUTIAO_LOCKED_STATES,
  validateArticleTitle,
} from "./workflow.ts";

export { createToutiaoGenerationRunner } from "./generation.ts";

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
    "article.deliver": {
      scope: "document",
      handler: (ctx, input, row) => deliverArticle(ctx, row!, input, writeDelivery),
    },
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
    buildFrozenContext: buildToutiaoFrozenContext,
    onCandidateCreated(ctx, row, candidateId, body, frozenInput, input) {
      if (input.qa && typeof input.qa === "object" && row.mode) {
        const { title } = JSON.parse(frozenInput) as { title: string };
        const qa = buildCandidateQa(row.mode, title, body, input.qa as Record<string, unknown>);
        const rounds = count(input, "rounds");
        if (rounds > QA_REFINEMENT_LIMIT) invalid("rounds", "qa-refinement-limit");
        stmt(ctx.db, "INSERT INTO author_candidate_qa (candidate_id, report, rounds) VALUES (?, ?, ?);")
          .run(candidateId, JSON.stringify(qa), rounds);
      }
    },
    runGeneration,
    reserveRefinement(ctx, runId) {
      const reserved = stmt(ctx.db, `
        INSERT INTO author_run_refinement_claims (run_id, rounds) VALUES (?, 1)
        ON CONFLICT (run_id) DO UPDATE SET rounds = rounds + 1 WHERE rounds < ?;
      `).run(runId, QA_REFINEMENT_LIMIT);
      if (!reserved.changes) refuse("run.generate", "qa-refinement-limit");
    },
    actions,
    enrichRunSummaries(ctx, _active, runs) {
      const qaStmt = stmt(
        ctx.db,
        "SELECT report AS candidateQa, rounds AS refinementRounds FROM author_candidate_qa WHERE candidate_id = ?;",
      );
      return runs.map((run) => {
        if (run.state !== "awaiting-author" || typeof run.candidateId !== "string") return run;
        const qa = qaStmt.get(run.candidateId) as { candidateQa: string; refinementRounds: number } | undefined;
        return qa ? { ...run, candidateQa: qa.candidateQa, refinementRounds: qa.refinementRounds } : run;
      });
    },
    contributeSnapshot(ctx, projectId, active) {
      if (!active) return {};
      const approved = Boolean(active.revisionId && recordedApproval(ctx, active, active.revisionId));
      const delivery = active.state === "已交稿" ? approvedMarkdown(ctx, active.id) : null;
      const exportStatus = delivery
        ? stmt(ctx.db, `
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
    contributeSystemPrompt(_ctx, _projectId, active) {
      const lines: string[] = [
        `- 头条受保护硬规则：标题上限 ${TITLE_MAX} 字（微头条无标题），质检及格线 ${QA_PASS_SCORE} 分，自动打磨最多 ${QA_REFINEMENT_LIMIT} 轮，已验收/已交稿严禁改写。`,
      ];
      if (active) {
        const scenario = resolveScenario(active.mode, active.line);
        lines.push(`- 当前体裁/条线：${active.mode ?? "未设"} / ${active.line ?? "未设"} · 已打磨 ${active.qaRounds}/${QA_REFINEMENT_LIMIT} 轮`);
        if (scenario) {
          lines.push(`- 推荐驱动/开篇/收束：驱动=${scenario.drivers.join("、")} | 开篇=${scenario.openings.join("、")} | 收束=${scenario.endings.join("、")}`);
        }
        if (active.mode !== "micro") {
          lines.push("- 标题矩阵方法论：通过 `zhizhang_plan_toutiao_article` 提交 5 组「标题|母题」候选，至少覆盖 3 个不同母题且每条 ≤ 34 字。");
        }
      }
      return { lines };
    },
    diagnoseForAgent(_ctx, row, body) {
      const charCount = [...body.replace(/\s/gu, "")].length;
      return {
        charCount,
        mode: row.mode,
        line: row.line,
        state: row.state,
        titleLength: [...row.title].length,
        titleMax: TITLE_MAX,
        qaPassScore: QA_PASS_SCORE,
      };
    },
    readModels,
    agentTools: createToutiaoAgentTools,
    onStartupRecover: (ctx) => resumeExports(ctx, writeDelivery),
  };
}
