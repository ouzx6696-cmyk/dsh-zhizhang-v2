import type {
  AutopilotAdoptionPolicy,
  AutopilotAutonomyMode,
  AutopilotBatchDto,
  AutopilotScope,
  AutopilotStepKind,
} from "../../../contracts/workspace-dto.ts";
import { el } from "../dom.ts";
import type { WorkbenchShellHost } from "../plugins/types.ts";
import { createButton, createCard, createInput } from "../ui/primitives.ts";

export interface AutopilotPanelOptions {
  readonly getProviderModel: () => { readonly provider: string; readonly model: string };
}

const STEP_ORDER: readonly { readonly id: AutopilotStepKind; readonly label: string }[] = [
  { id: "beat_plan", label: "节拍规划" },
  { id: "draft_write", label: "正文生成" },
  { id: "offline_qa", label: "双轨体检" },
  { id: "surgical_refine", label: "外科精修" },
  { id: "fact_sync", label: "记忆同步" },
];

const STATUS_LABELS: Readonly<Record<string, string>> = {
  running: "运行中",
  paused_redline: "红线触发暂停",
  paused_gate: "逐章门控等待放行",
  completed: "已完成",
  cancelled: "已终止",
  failed: "执行失败",
};

const REDLINE_LABELS: Readonly<Record<string, string>> = {
  manual_pause: "手动暂停",
  interrupted: "执行已中断",
  locked_lore_conflict: "锁定设定冲突",
  pov_leak: "视角越权疑点",
  quality_below_floor: "回改达上限仍低于质量底线",
  high_severity_review: "高危定性审稿警报",
  budget_cap: "批次 Token 预算耗尽",
  consecutive_errors: "连续异常中断",
  candidate_conflict: "章节版本冲突",
  chapter_gate_checkpoint: "逐章门控检查点",
};

const STEP_LABELS: Readonly<Record<string, string>> = {
  beat_plan: "节拍规划",
  draft_write: "正文生成",
  offline_qa: "离线体检",
  model_review: "定性审稿",
  surgical_refine: "外科精修",
  fact_sync: "记忆同步",
  arc_roll: "弧线滚动",
};

/**
 * Right-rail Tiered Autonomous Writing Console (`zhizhang/3.0`).
 * Supports single-chapter 5-step pipeline and multi-chapter serial queue
 * with red-line pause cards, override resume, and one-click non-destructive rollback.
 */
export function createAutopilotPanel(
  container: HTMLElement,
  host: WorkbenchShellHost,
  options: AutopilotPanelOptions,
) {
  let activeProjectId = "";
  let activeDocId = "";
  let scope: AutopilotScope = "single_chapter";
  let autonomyMode: AutopilotAutonomyMode = "redline_pause";
  let adoptionPolicy: AutopilotAdoptionPolicy = "working_draft_snapshot";
  let tokenBudget = 60000;
  let instruction = "";
  const selectedChapterIds = new Set<string>();
  let batches: readonly AutopilotBatchDto[] = [];
  let activeBatch: AutopilotBatchDto | null = null;
  let pollTimer: number | null = null;
  let refreshSequence = 0;
  let refreshing = false;
  let batchSignature = "";

  const root = el("section", { className: "autopilot-panel" });
  root.hidden = true;
  container.replaceChildren(root);

  function stopPolling(): void {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function ensurePolling(): void {
    if (activeBatch && activeBatch.status === "running") {
      if (pollTimer === null) {
        pollTimer = window.setInterval(() => {
          void refreshBatches(true);
        }, 2500);
      }
    } else {
      stopPolling();
    }
  }

  function getEligibleChapters(): readonly { readonly id: string; readonly title: string }[] {
    return host.getState().snapshot.documents ?? [];
  }

  async function refreshBatches(silent = false): Promise<void> {
    if (!activeProjectId || (silent && refreshing)) return;
    const sequence = ++refreshSequence;
    refreshing = true;
    try {
      const list = await host.request<readonly AutopilotBatchDto[]>("autopilot.list", {
        projectId: activeProjectId,
        limit: 6,
        includeHistoryDetails: false,
        detailBatchId: activeBatch?.id,
      });
      if (sequence !== refreshSequence) return;
      const signature = JSON.stringify(list);
      if (silent && signature === batchSignature) return;
      batchSignature = signature;
      batches = list;
      if (activeBatch) {
        const updated = list.find((b) => b.id === activeBatch!.id);
        activeBatch = updated ?? list[0] ?? null;
      } else {
        activeBatch = list[0] ?? null;
      }
      ensurePolling();
      paint();
    } catch {
      if (sequence === refreshSequence && !silent) {
        batchSignature = "";
        batches = [];
        activeBatch = null;
        ensurePolling();
        paint();
      }
    } finally {
      if (sequence === refreshSequence) refreshing = false;
    }
  }

  function stepStateFor(batch: AutopilotBatchDto, stepId: AutopilotStepKind): "done" | "active" | "paused" | "skipped" | "pending" {
    const currentDoc = batch.chapterIds[batch.currentChapterIndex] ?? batch.chapterIds[batch.chapterIds.length - 1];
    const docSteps = batch.steps.filter((s) => s.documentId === currentDoc);
    const matching = docSteps.filter((s) =>
      stepId === "offline_qa" ? s.stepKind === "offline_qa" || s.stepKind === "model_review" : s.stepKind === stepId,
    );
    if (matching.some((s) => s.status === "paused")) return "paused";
    if (batch.status === "running" && (batch.currentStep === stepId || (stepId === "offline_qa" && batch.currentStep === "model_review"))) {
      return "active";
    }
    if (matching.some((s) => s.status === "completed")) return "done";
    if (matching.some((s) => s.status === "skipped")) return "skipped";
    return "pending";
  }

  function paint(): void {
    if (!activeDocId || !activeProjectId) {
      root.hidden = true;
      root.replaceChildren();
      return;
    }
    root.hidden = false;
    root.replaceChildren();

    const header = el("div", { className: "autopilot-header" });
    header.append(
      el("h3", { className: "sub-heading", text: "分级自治全自动写作" }),
      createButton({
        label: "刷新状态",
        variant: "ghost",
        size: "sm",
        onClick: () => void refreshBatches(false),
      }),
    );
    root.append(header);

    // Config surface
    const configBody: HTMLElement[] = [];

    const scopeBar = el("div", { className: "segmented autopilot-scope" });
    for (const [id, label] of [
      ["single_chapter", "单章流水线"],
      ["multi_chapter", "多章连跑"],
    ] as const) {
      scopeBar.append(
        createButton({
          label,
          variant: "ghost",
          size: "sm",
          active: scope === id,
          pressed: scope === id,
          onClick: () => {
            scope = id;
            if (scope === "multi_chapter" && selectedChapterIds.size === 0) {
              const eligible = getEligibleChapters();
              const startIdx = Math.max(0, eligible.findIndex((c) => c.id === activeDocId));
              for (const ch of eligible.slice(startIdx, startIdx + 3)) {
                selectedChapterIds.add(ch.id);
              }
            }
            paint();
          },
        }),
      );
    }
    configBody.push(scopeBar);

    if (scope === "multi_chapter") {
      const eligible = getEligibleChapters();
      const chWrap = el("div", { className: "autopilot-chapter-picker" });
      if (eligible.length === 0) {
        chWrap.append(el("p", { className: "muted-copy", text: "当前无未定稿章节可供连跑。" }));
      } else {
        chWrap.append(el("p", { className: "setting-meta", text: `勾选待连跑章节（已选 ${selectedChapterIds.size} 章，自动跳过已定稿章）` }));
        for (const ch of eligible.slice(0, 12)) {
          const lbl = el("label", { className: "diff-check-label" });
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = selectedChapterIds.has(ch.id);
          cb.onchange = () => {
            if (cb.checked) selectedChapterIds.add(ch.id);
            else selectedChapterIds.delete(ch.id);
            paint();
          };
          lbl.append(cb, document.createTextNode(ch.title));
          chWrap.append(lbl);
        }
      }
      configBody.push(chWrap);
    }

    const modeField = createInput({
      kind: "select",
      label: "自治门控策略",
      name: "autopilotMode",
      value: autonomyMode,
      options: [
        { value: "redline_pause", label: "红线触发暂停（遇高危即停）" },
        { value: "chapter_gate", label: "逐章放行（每章完成后确认）" },
      ],
      onChange: (val) => {
        autonomyMode = val === "chapter_gate" ? "chapter_gate" : "redline_pause";
      },
    });

    const policyField = createInput({
      kind: "select",
      label: "正文落盘策略",
      name: "autopilotPolicy",
      value: adoptionPolicy,
      options: [
        { value: "working_draft_snapshot", label: "写入工作稿（留快照可回滚）" },
        { value: "candidate_only", label: "生成待审候选稿" },
      ],
      onChange: (val) => {
        adoptionPolicy = val === "candidate_only" ? "candidate_only" : "working_draft_snapshot";
      },
    });

    const budgetField = createInput({
      kind: "number",
      label: "批次 Token 预算上限",
      name: "autopilotBudget",
      value: String(tokenBudget),
      min: "8000",
      max: "500000",
      onInput: (val) => {
        const n = Number(val);
        if (Number.isFinite(n) && n >= 8000) tokenBudget = Math.floor(n);
      },
    });

    const noteField = createInput({
      kind: "text",
      label: "本批附加指令（可选）",
      name: "autopilotInstruction",
      value: instruction,
      placeholder: "例如：强化主角压迫感，尾段留出大钩子",
      onInput: (val) => {
        instruction = val;
      },
    });

    configBody.push(modeField.root, policyField.root, budgetField.root, noteField.root);

    const launchActions = el("div", { className: "actions" });
    const isRunning = activeBatch?.status === "running";
    launchActions.append(
      createButton({
        label: scope === "single_chapter" ? "启动单章五步流水线" : "启动多章分级连跑",
        variant: "primary",
        size: "sm",
        disabled: isRunning,
        onClick: () =>
          void host.perform(async () => {
            const chapterIds =
              scope === "single_chapter"
                ? [activeDocId]
                : getEligibleChapters()
                    .filter((c) => selectedChapterIds.has(c.id))
                    .map((c) => c.id);
            if (chapterIds.length === 0) {
              throw new Error("请先选择至少一个未定稿章节。");
            }
            const { provider, model } = options.getProviderModel();
            const res = await host.request<{ batch?: AutopilotBatchDto; batchId?: string }>("autopilot.start", {
              projectId: activeProjectId,
              scope,
              chapterIds,
              autonomyMode,
              adoptionPolicy,
              tokenBudget,
              provider,
              model,
              instruction: instruction.trim() || undefined,
              previousVersionId: chapterIds[0] === activeDocId
                ? document.querySelector<HTMLSelectElement>("#continuation-version")?.value || undefined
                : undefined,
            });
            if (res.batch) activeBatch = res.batch;
            host.notice("已启动分级自治写作流水线（复用 L0+L1+L2 缓存前缀）");
            await refreshBatches(false);
          }),
      }),
    );
    configBody.push(launchActions);

    root.append(
      createCard({
        tag: "div",
        variant: "subtle",
        padding: "sm",
        body: configBody,
        className: "autopilot-config-card",
      }),
    );

    // Active / latest batch monitor
    if (activeBatch) {
      const batch = activeBatch;
      const monitorBody: HTMLElement[] = [];

      const totalCh = Math.max(1, batch.chapterIds.length);
      const currentPos = Math.min(totalCh, batch.currentChapterIndex + 1);
      const statusText = STATUS_LABELS[batch.status] ?? batch.status;
      monitorBody.push(
        el("p", {
          className: "setting-title tabular",
          text: `${statusText} · 第 ${currentPos}/${totalCh} 章 · 已耗 ${batch.tokensSpent.toLocaleString("zh-Hans")} / ${batch.tokenBudget.toLocaleString("zh-Hans")} token`,
        }),
      );

      // 5-step progress track
      const track = el("ol", { className: "autopilot-steps" });
      for (const step of STEP_ORDER) {
        const st = stepStateFor(batch, step.id);
        const li = el("li", { className: `autopilot-step step-${st}` });
        const stateWord = st === "done" ? "完成" : st === "active" ? "进行中" : st === "paused" ? "暂停" : st === "skipped" ? "跳过" : "待执行";
        li.append(
          el("span", { className: "autopilot-step-name", text: step.label }),
          el("span", { className: "autopilot-step-state", text: stateWord }),
        );
        track.append(li);
      }
      monitorBody.push(track);

      const pending = batch.candidates.filter((candidate) => candidate.state === "awaiting-author");
      if (pending.length) {
        const entries = el("div", { className: "actions" });
        for (const candidate of pending) {
          const title = host.getState().snapshot.documents?.find((doc) => doc.id === candidate.documentId)?.title ?? "章节";
          entries.append(createButton({
            label: `审阅《${title}》候选稿`,
            variant: "secondary",
            size: "sm",
            onClick: () => void host.perform(async () => {
              await host.selectDocument(candidate.documentId);
              host.switchPipelineTab("workflow");
            }),
          }));
        }
        monitorBody.push(entries);
      }

      // Red-line / gate pause card
      if ((batch.status === "paused_redline" || batch.status === "paused_gate") && batch.pauseReason) {
        const pr = batch.pauseReason;
        const override = batch.status === "paused_redline" && pr.kind !== "candidate_conflict";
        const redBody: HTMLElement[] = [
          el("p", {
            className: "setting-title status-warning",
            text: `${REDLINE_LABELS[pr.kind] ?? pr.kind} · ${pr.chapterTitle}`,
          }),
          el("p", { className: "setting-meta", text: pr.message }),
        ];
        if (pr.problemParagraphs.length > 0) {
          redBody.push(
            el("p", {
              className: "setting-meta tabular",
              text: `关联段落：第 ${pr.problemParagraphs.join("、")} 段`,
            }),
          );
        }
        for (const detail of pr.details.slice(0, 4)) {
          redBody.push(el("p", { className: "setting-meta", text: detail }));
        }

        const redActions = el("div", { className: "actions" });
        redActions.append(
          createButton({
            label: "定位问题章",
            variant: "secondary",
            size: "sm",
            onClick: () => void host.selectDocument(pr.documentId),
          }),
          createButton({
            label: override ? "放行本章并继续" : "继续批次",
            variant: "primary",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                const { provider, model } = options.getProviderModel();
                await host.request("autopilot.resume", {
                  batchId: batch.id,
                  overrideRedLine: override,
                  provider,
                  model,
                });
                host.notice("已提交续跑请求");
                await refreshBatches(false);
              }),
          }),
          ...(batch.adoptionPolicy === "working_draft_snapshot" ? [createButton({
            label: "一键回滚本章",
            variant: "danger",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                const confirmed = await host.modal.confirm({
                  title: "一键回滚本章",
                  message: `确认将「${pr.chapterTitle}」恢复到本自治批次启动前的修订快照？`,
                  confirmLabel: "确认回滚",
                  destructive: true,
                });
                if (!confirmed) return;
                await host.request("autopilot.rollback_chapter", {
                  batchId: batch.id,
                  documentId: pr.documentId,
                });
                host.notice("已无损回滚至批次前快照");
                await host.load();
                await refreshBatches(false);
              }),
          })] : []),
          createButton({
            label: "终止批次",
            variant: "ghost",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                await host.request("autopilot.cancel", { batchId: batch.id });
                host.notice("已终止自治批次");
                await refreshBatches(false);
              }),
          }),
        );
        redBody.push(redActions);

        monitorBody.push(
          el("div", { className: "autopilot-redline" }),
        );
        (monitorBody[monitorBody.length - 1] as HTMLElement).append(...redBody);
      }

      // Running controls or post-batch rollback
      const batchActions = el("div", { className: "actions" });
      if (batch.status === "running") {
        batchActions.append(
          createButton({
            label: "暂停本批",
            variant: "secondary",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                await host.request("autopilot.pause", { batchId: batch.id });
                host.notice("已发送暂停指令");
                await refreshBatches(false);
              }),
          }),
          createButton({
            label: "终止本批",
            variant: "danger",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                await host.request("autopilot.cancel", { batchId: batch.id });
                host.notice("已终止自治批次");
                await refreshBatches(false);
              }),
          }),
        );
      } else if (batch.adoptionPolicy === "working_draft_snapshot" && batch.preBatchRevisions[activeDocId] !== undefined) {
        batchActions.append(
          createButton({
            label: "回滚当前章至批次前快照",
            variant: "secondary",
            size: "sm",
            onClick: () =>
              void host.perform(async () => {
                const confirmed = await host.modal.confirm({
                  title: "回滚当前章节",
                  message: "确认将当前章节恢复到该自治批次运行前的快照版本？",
                  confirmLabel: "确认回滚",
                });
                if (!confirmed) return;
                await host.request("autopilot.rollback_chapter", {
                  batchId: batch.id,
                  documentId: activeDocId,
                });
                host.notice("当前章节已恢复到批次前快照");
                await host.load();
              }),
          }),
        );
      }
      if (batchActions.childElementCount > 0) {
        monitorBody.push(batchActions);
      }

      // Recent step telemetry log
      if (batch.steps.length > 0) {
        const logList = el("ul", { className: "autopilot-step-log tabular" });
        for (const st of batch.steps.slice(-6).reverse()) {
          const scorePart =
            st.scoreBefore !== null && st.scoreAfter !== null
              ? ` · 质量分 ${st.scoreBefore}→${st.scoreAfter}`
              : st.scoreAfter !== null
                ? ` · 质量分 ${st.scoreAfter}`
                : "";
          const cachePart =
            st.cacheHitRate !== null ? ` · 缓存命中 ${Math.round(st.cacheHitRate * 100)}%` : "";
          const tokenPart = st.tokensUsed > 0 ? ` · ${st.tokensUsed} tok` : "";
          logList.append(
            el("li", {
              className: "setting-meta",
              text: `[${STEP_LABELS[st.stepKind] ?? st.stepKind}${st.round > 1 ? ` #${st.round}` : ""}] ${st.summary}${scorePart}${cachePart}${tokenPart}`,
            }),
          );
        }
        monitorBody.push(logList);
      }

      root.append(
        createCard({
          tag: "div",
          variant: "default",
          padding: "sm",
          body: monitorBody,
          className: "autopilot-monitor-card",
        }),
      );
    }

    if (batches.length > 1) {
      const histLabel = el("p", {
        className: "setting-meta tabular",
        text: `历史批次 ${batches.length} 条 · 最近批次 ${batches[0]?.id.slice(0, 8) ?? ""}`,
      });
      root.append(histLabel);
    }
  }

  async function refreshForDocument(documentId: string, projectId: string): Promise<void> {
    if (!documentId || !projectId) {
      clear();
      return;
    }
    const projectChanged = projectId !== activeProjectId;
    const documentChanged = documentId !== activeDocId;
    activeDocId = documentId;
    activeProjectId = projectId;
    if (projectChanged) {
      stopPolling();
      refreshSequence += 1;
      refreshing = false;
      batchSignature = "";
      selectedChapterIds.clear();
      activeBatch = null;
      batches = [];
    }
    if (projectChanged || documentChanged) paint();
    await refreshBatches(true);
  }

  function clear(): void {
    stopPolling();
    refreshSequence += 1;
    refreshing = false;
    batchSignature = "";
    activeProjectId = "";
    activeDocId = "";
    activeBatch = null;
    batches = [];
    selectedChapterIds.clear();
    paint();
  }

  return { refreshForDocument, clear };
}
