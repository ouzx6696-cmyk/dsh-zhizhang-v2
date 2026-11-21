import type { RecoveryHintDto, RunSummary, UnifiedJobSummaryDto } from "../../../contracts/workspace-dto.ts";
import { el } from "../dom.ts";
import { createButton, createCard } from "../ui/primitives.ts";

const JOB_KIND_LABELS: Readonly<Record<string, string>> = {
  draft_generation: "候选生成",
  proposal_extraction: "提案抽取",
  selection_rewrite: "选段改写",
};

const JOB_STATE_LABELS: Readonly<Record<string, string>> = {
  prepared: "准备中",
  inflight: "调用中",
  received: "已收回执",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  uncertain: "待核对",
  reconciled: "已对账",
};

const OPEN_JOB_STATES = new Set(["prepared", "inflight", "received"]);

export interface JobCenterCallbacks {
  readonly onCancelJob: (job: UnifiedJobSummaryDto) => void;
  readonly onInspectRun: (runId: string) => void;
  readonly onApplyRecoveryHint: (hint: RecoveryHintDto) => void;
}

/**
 * Unified Job Center (`zhizhang/3.0`).
 *
 * Renders all three LLM workflows (`draft_generation`, `proposal_extraction`,
 * `selection_rewrite`) using unified Card & Button primitives.
 */
const RUN_TO_JOB_STATE: Readonly<Record<string, UnifiedJobSummaryDto["state"]>> = {
  running: "inflight",
  "awaiting-author": "completed",
  applied: "completed",
  discarded: "cancelled",
  failed: "failed",
  cancelled: "cancelled",
};

export function createJobCenter(container: HTMLElement, callbacks: JobCenterCallbacks) {
  let lastSig = "";

  function render(
    jobs: readonly UnifiedJobSummaryDto[],
    latestRun?: RunSummary,
    runs: readonly RunSummary[] = [],
  ): void {
    const coveredRunIds = new Set(jobs.map((j) => j.runId).filter((id): id is string => typeof id === "string"));
    const mergedJobs: UnifiedJobSummaryDto[] = [...jobs];
    for (const run of runs) {
      if (coveredRunIds.has(run.id)) continue;
      mergedJobs.push({
        id: `run:${run.id}`,
        kind: "draft_generation",
        subtype: run.state === "awaiting-author" ? "待作者采纳" : run.state === "applied" ? "已采纳" : "",
        projectId: null,
        documentId: null,
        runId: run.id,
        proposalId: null,
        provider: "",
        model: "",
        state: RUN_TO_JOB_STATE[run.state] ?? "completed",
        stage: run.state,
        reserved: run.reserved,
        settled: run.settled,
        error: null,
        createdAt: 0,
        updatedAt: 0,
      });
    }

    const hints = latestRun?.recoveryHints ?? [];
    const sig = JSON.stringify([
      mergedJobs.map((j) => [j.id, j.state, j.subtype, j.settled, j.reserved, j.error]),
      hints.map((h) => h.action),
    ]);
    if (sig === lastSig) return;
    lastSig = sig;

    container.replaceChildren();

    if (hints.length > 0) {
      const hintBar = el("div", { className: "recovery-hint-bar" });
      for (const hint of hints) {
        const row = el("div", { className: "recovery-hint-row" });
        row.append(el("span", { className: "muted-copy", text: hint.message }));
        const actionLabel = hint.action === "increase_budget"
          ? "追加预算"
          : hint.action === "increase_output_limit"
            ? "提高输出额度"
            : "关闭深度思考重试";
        const btn = createButton({
          label: actionLabel,
          variant: "secondary",
          size: "sm",
          className: "notice-dismiss",
          onClick: () => callbacks.onApplyRecoveryHint(hint),
        });
        row.append(btn);
        hintBar.append(row);
      }
      container.append(hintBar);
    }

    const heading = el("h3", { className: "sub-heading", text: "统一作业中心" });
    container.append(heading);

    if (mergedJobs.length === 0) {
      container.append(el("p", { className: "muted-copy", text: "暂无生成、提案或选段改写作业记录。" }));
      return;
    }

    const list = el("div", { className: "job-feed" });
    for (const job of mergedJobs.slice(0, 12)) {
      const kindLabel = JOB_KIND_LABELS[job.kind] ?? job.kind;
      const stateLabel = JOB_STATE_LABELS[job.state] ?? job.state;
      const subtypeSuffix = job.subtype ? ` · ${job.subtype}` : "";

      const head = el("div", { className: "job-row-head" });
      head.append(
        el("span", { className: "job-row-title", text: `${kindLabel}${subtypeSuffix}` }),
        el("span", {
          className: `job-row-state ${job.state === "uncertain" || job.state === "failed" ? "status-warning" : "muted-copy"}`,
          text: stateLabel,
        }),
      );

      const metaParts = [
        job.model || job.provider,
        `${job.settled.toLocaleString("zh-Hans")} / ${job.reserved.toLocaleString("zh-Hans")} tok`,
        job.error ? `原因 ${job.error}` : "",
      ].filter(Boolean);
      const meta = el("p", { className: "job-row-meta tabular", text: metaParts.join(" · ") });

      const actions = el("div", { className: "job-row-actions" });
      if (OPEN_JOB_STATES.has(job.state) && job.kind !== "selection_rewrite") {
        actions.append(
          createButton({
            label: "取消作业",
            variant: "danger",
            size: "sm",
            className: "notice-dismiss",
            onClick: () => callbacks.onCancelJob(job),
          }),
        );
      }
      if (job.runId) {
        actions.append(
          createButton({
            label: "明细",
            variant: "secondary",
            size: "sm",
            className: "notice-dismiss",
            onClick: () => callbacks.onInspectRun(job.runId!),
          }),
        );
      }

      const row = createCard({
        variant: "subtle",
        padding: "sm",
        className: "job-row",
        body: actions.childElementCount > 0 ? [head, meta, actions] : [head, meta],
      });
      list.append(row);
    }
    container.append(list);
  }

  return { render };
}
