import {
  isLockedDocumentState,
  RUN_STATE_LABELS,
  SETTING_DECISION_LABELS,
  WORKSPACE_EDITORIAL_REJECTION_LIMIT,
  WORKSPACE_QA_REFINEMENT_LIMIT,
  type BudgetPreviewResult,
  type EvidenceDetailResult,
  type NarrativeAnchorDto,
  type ReorderImpactResult,
  type RunDetailView,
  type RunHistoryItem,
  type SettingFactDto,
  type SettingProposalEntry,
} from "../../../contracts/workspace.ts";
import { confirmDialog, promptDialog } from "../dialogs.ts";
import type { PipelineTab, WorkbenchStore } from "../store.ts";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formValues(form: HTMLFormElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export interface PipelineController {
  onDirectoryChanged(chapterTitles: ReadonlyMap<string, string>): void;
  render(): void;
}

export function createPipelineView(store: WorkbenchStore): PipelineController {
  const flowEmpty = byId<HTMLElement>("flow-empty");
  const flowContent = byId<HTMLElement>("flow-content");
  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-pipeline-tab]"));
  const tabPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-pipeline-panel]"));

  const fanqieActions = byId<HTMLElement>("fanqie-actions");
  const reviewsLabel = byId<HTMLElement>("reviews");
  const reviewPassBtn = byId<HTMLButtonElement>("review-pass");
  const reviewRejectBtn = byId<HTMLButtonElement>("review-reject");
  const finalizeBtn = byId<HTMLButtonElement>("finalize");

  const toutiaoActions = byId<HTMLElement>("toutiao-actions");
  const articleReport = byId<HTMLElement>("article-report");
  const exportStatusEl = byId<HTMLElement>("export-status");
  const approvedVersionEl = byId<HTMLElement>("approved-version");
  const qaForm = byId<HTMLFormElement>("qa");
  const refineBtn = byId<HTMLButtonElement>("refine");
  const acceptBtn = byId<HTMLButtonElement>("accept");
  const rejectBtn = byId<HTMLButtonElement>("reject");
  const approveBtn = byId<HTMLButtonElement>("approve");
  const deliverBtn = byId<HTMLButtonElement>("deliver");
  const downloadLink = byId<HTMLAnchorElement>("download");

  const outlineForm = byId<HTMLFormElement>("chapter-outline");
  const articlePlanForm = byId<HTMLFormElement>("article-plan");
  const titleMatrixLabel = byId<HTMLElement>("title-matrix");

  const continuityTabBtn = document.querySelector<HTMLButtonElement>('[data-pipeline-tab="continuity"]');
  const continuityPanel = byId<HTMLElement>("continuity");
  const settingProposalForm = byId<HTMLFormElement>("setting-proposal");
  const settingToPoint = byId<HTMLElement>("setting-to-point");
  const settingPeople = byId<HTMLElement>("setting-people");
  const settingAddPersonBtn = byId<HTMLButtonElement>("setting-add-person");
  const settingPersonTemplate = byId<HTMLTemplateElement>("setting-person-template");
  const settingsReadForm = byId<HTMLFormElement>("settings-read");
  const knownSettings = byId<HTMLElement>("known-settings");
  const settingsList = byId<HTMLElement>("settings");
  const settingsMoreBtn = byId<HTMLButtonElement>("settings-more");
  const recordEvidenceForm = byId<HTMLFormElement>("record-evidence");
  const evidenceDetailBtn = byId<HTMLButtonElement>("evidence-detail");
  const evidenceResult = byId<HTMLElement>("evidence-result");
  const moveUpBtn = byId<HTMLButtonElement>("move-up");
  const moveDownBtn = byId<HTMLButtonElement>("move-down");

  const startRunForm = byId<HTMLFormElement>("start-run");
  const estimateBudgetBtn = byId<HTMLButtonElement>("estimate-budget");
  const budgetHint = byId<HTMLElement>("budget-hint");
  const runPointField = byId<HTMLElement>("run-point");
  const runContent = byId<HTMLElement>("run-content");
  const runStatus = byId<HTMLElement>("run-status");
  const runDetailBtn = byId<HTMLButtonElement>("run-detail");
  const runInputPanel = byId<HTMLElement>("run-input");
  const runHistoryBtn = byId<HTMLButtonElement>("run-history");
  const runHistoryList = byId<HTMLElement>("run-history-list");
  const reconcileForm = byId<HTMLFormElement>("reconcile");
  const generateRunForm = byId<HTMLFormElement>("generate-run");
  const automaticQaLabel = byId<HTMLElement>("automatic-qa");
  const refreshRunBtn = byId<HTMLButtonElement>("refresh-run");
  const completeRunForm = byId<HTMLFormElement>("complete-run");
  const cancelRunBtn = byId<HTMLButtonElement>("cancel");

  let chapterTitles: ReadonlyMap<string, string> = new Map();
  let deliveryUrl: string | undefined;
  let planDocument: string | undefined;
  let settingProject: string | undefined;
  let settingsKey = "";
  let toolDocument: string | undefined;

  for (const btn of tabButtons) {
    btn.onclick = () => {
      const tab = btn.dataset.pipelineTab as PipelineTab | undefined;
      if (tab) store.setActiveTab(tab);
    };
  }

  function settingPoint(anchor: NarrativeAnchorDto): string {
    return `${chapterTitles.get(anchor.chapterId) ?? anchor.chapterId}第 ${anchor.point} 段`;
  }

  function populateChapterSelect(select: HTMLSelectElement): void {
    const previous = select.value;
    select.replaceChildren(
      new Option(select.dataset.default ?? "", ""),
      ...Array.from(chapterTitles, ([id, title]) => new Option(title, id)),
    );
    if (chapterTitles.has(previous)) select.value = previous;
  }

  function syncSettingExpiry(): void {
    const toChapter = settingProposalForm.elements.namedItem("toChapter") as HTMLSelectElement;
    const toPoint = settingProposalForm.elements.namedItem("toPoint") as HTMLInputElement;
    const expires = Boolean(toChapter.value);
    settingToPoint.hidden = !expires;
    toPoint.disabled = !expires;
  }

  function appendSettingEntries(entries: readonly SettingProposalEntry[]): void {
    for (const entry of entries) {
      const row = el("article", undefined, "setting-item");
      const titleLine = el(
        "p",
        `${entry.fact.id} · ${entry.fact.note} · ${SETTING_DECISION_LABELS[entry.decision]}`,
        "setting-title",
      );
      const { source, effectiveFrom, effectiveTo, knownFrom, locked } = entry.fact;
      const meta = [
        source,
        locked ? "已锁定" : "",
        `${settingPoint(effectiveFrom)}生效`,
        effectiveTo ? `${settingPoint(effectiveTo)}起失效` : "",
        ...Object.entries(knownFrom).map(([name, at]) => `${name}在${settingPoint(at)}知情`),
      ]
        .filter(Boolean)
        .join(" · ");
      const metaLine = el("p", meta, "setting-meta");
      row.append(titleLine, metaLine);

      if (entry.decision === "pending") {
        const actions = el("div", undefined, "actions");
        for (const [label, accept] of [
          ["确认设定", true],
          ["拒绝提案", false],
        ] as const) {
          const button = el("button", label);
          button.type = "button";
          if (accept) button.className = "primary";
          button.onclick = () => {
            void store.perform(() =>
              store.change("setting.decide", {
                projectId: store.projectId,
                proposalId: entry.id,
                accept,
              }),
            );
          };
          actions.append(button);
        }
        row.append(actions);
      }
      settingsList.append(row);
    }
  }

  function showBudgetEstimate(): void {
    const active = store.snapshot.active;
    if (!active) return;
    const instruction = (startRunForm.elements.namedItem("instruction") as HTMLTextAreaElement).value;
    const serialized = JSON.stringify([active.body, active.title, store.snapshot.planning, store.snapshot.scenario, instruction]);
    const estimate = new TextEncoder().encode(serialized).length + 1024;
    const recommended = Math.max(8000, Math.ceil((estimate * 2 + 2400) / 1000) * 1000);
    const tokenLimit = startRunForm.elements.namedItem("tokenLimit") as HTMLInputElement;
    if (toolDocument !== active.id || !tokenLimit.value || tokenLimit.value === tokenLimit.dataset.suggested) {
      tokenLimit.value = String(recommended);
    }
    tokenLimit.dataset.suggested = String(recommended);
    budgetHint.textContent = `保守输入估算约 ${estimate} token · 建议总额 ${recommended}（含输出余量，多轮质检另计）`;
    const isFanqie = active.product === "fanqie";
    runPointField.hidden = !isFanqie;
    (startRunForm.elements.namedItem("point") as HTMLInputElement).disabled = !isFanqie;
  }

  function renderStructuredRunDetail(detail: RunDetailView): void {
    runInputPanel.hidden = false;
    const container = el("div", undefined, "structured-detail");

    // 1. Frozen input summary
    let parsedFrozen: {
      title?: string;
      instruction?: string;
      knownAt?: NarrativeAnchorDto;
      knownFacts?: SettingFactDto[];
    } = {};
    try {
      parsedFrozen = JSON.parse(detail.frozenInput) as typeof parsedFrozen;
    } catch {
      // Ignore malformed legacy input.
    }

    const summaryBlock = el("div", undefined, "detail-section");
    summaryBlock.append(
      el("h4", "冻结输入摘要"),
      el("p", `任务状态：${RUN_STATE_LABELS[detail.state]} · 额度 ${detail.settled} / ${detail.reserved} token`, "detail-meta"),
      el("p", `写作要求：${parsedFrozen.instruction || "—"}`),
    );
    if (parsedFrozen.knownAt) {
      const factSummary = parsedFrozen.knownFacts?.length
        ? parsedFrozen.knownFacts.map((fact) => `${fact.id}（${fact.note}）`).join("、")
        : "无知情设定";
      summaryBlock.append(
        el("p", `冻结知情时点：${settingPoint(parsedFrozen.knownAt)} · ${factSummary}`, "detail-meta"),
      );
    }
    container.append(summaryBlock);

    // 2. Generation attempts & calls table
    if (detail.attempts.length > 0 || detail.calls.length > 0) {
      const callsBlock = el("div", undefined, "detail-section");
      callsBlock.append(el("h4", "模型调用与四类令牌明细"));

      for (const attempt of detail.attempts) {
        const line = el(
          "p",
          `${attempt.provider} / ${attempt.model} · ${attempt.state}${attempt.stage ? ` (${attempt.stage})` : ""}${attempt.error ? ` · ${attempt.error}` : ""}`,
          "detail-meta",
        );
        callsBlock.append(line);
      }

      if (detail.calls.length > 0) {
        const table = document.createElement("table");
        table.className = "usage-table";
        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const label of ["阶段", "预留", "输入", "输出", "缓存读", "缓存写"]) {
          headRow.append(el("th", label));
        }
        thead.append(headRow);
        table.append(thead);

        const tbody = document.createElement("tbody");
        for (const call of detail.calls) {
          const parsedUsage = call.usage ? (JSON.parse(call.usage) as number[]) : null;
          const tr = document.createElement("tr");
          tr.append(
            el("td", call.phase),
            el("td", String(call.inputReserve), "num"),
            el("td", parsedUsage ? String(parsedUsage[0]) : "—", "num"),
            el("td", parsedUsage ? String(parsedUsage[1]) : "—", "num"),
            el("td", parsedUsage ? String(parsedUsage[2]) : "—", "num"),
            el("td", parsedUsage ? String(parsedUsage[3]) : "—", "num"),
          );
          tbody.append(tr);
        }
        table.append(tbody);
        callsBlock.append(table);
      }
      container.append(callsBlock);
    }

    if (detail.candidate?.body) {
      const candBlock = el("details", undefined, "detail-section");
      candBlock.append(el("summary", "查看该任务生成的候选正文"), el("pre", detail.candidate.body));
      container.append(candBlock);
    }

    runInputPanel.replaceChildren(container);
  }

  async function loadRunDetail(runId: string): Promise<RunDetailView> {
    const detail = await store.mutate<RunDetailView>("run.detail", store.activeInput({ runId }));
    renderStructuredRunDetail(detail);
    return detail;
  }

  // --- Wire Event Handlers ---

  reviewPassBtn.onclick = () =>
    void store.perform(() => store.change("chapter.review", { accept: true }, { savedVersion: true }));
  reviewRejectBtn.onclick = () =>
    void store.perform(() => store.change("chapter.review", { accept: false }, { savedVersion: true }));
  finalizeBtn.onclick = () =>
    void store.perform(() => store.change("draft.finalize", {}, { savedVersion: true, message: "本章已定稿" }));

  qaForm.onsubmit = (event) => {
    event.preventDefault();
    void store.perform(async () => {
      const values = formValues(qaForm);
      const passedInput = qaForm.elements.namedItem("passed") as HTMLInputElement;
      const result = await store.change<{ overall: number; hardGates: string[]; fails: string[] }>(
        "article.qa",
        {
          score: Number(values.score),
          passed: passedInput.checked,
          fails: (values.fails ?? "")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        },
        { savedVersion: true },
      );
      store.setNotice([...result.hardGates, ...result.fails].join(" · ") || `质检已记录 · ${result.overall} 分`);
    });
  };

  refineBtn.onclick = () => {
    const editor = byId<HTMLTextAreaElement>("body");
    void store.perform(() =>
      store.change("article.refine", { body: editor.value }, { clearDraft: true, message: "已保存回改稿" }),
    );
  };

  acceptBtn.onclick = () =>
    void store.perform(() => store.change("article.accept", { accept: true }, { savedVersion: true, message: "已验收" }));

  rejectBtn.onclick = () => {
    void store.perform(async () => {
      const reason = await promptDialog({
        title: "验收退回",
        message: "请记录本次退回修订的具体原因，以便回溯核对。",
        label: "退回原因（选填）",
        placeholder: "例如：核心论据缺少来源、开头切入偏慢…",
        confirmLabel: "确认退回",
      });
      if (reason === null) return;
      await store.change("article.accept", { accept: false, reason }, { savedVersion: true, message: "已退回修订" });
    });
  };

  approveBtn.onclick = () => {
    void store.perform(async () => {
      const active = store.snapshot.active;
      const revShort = active?.revisionId ? active.revisionId.slice(0, 8) : "";
      const confirmed = await confirmDialog({
        title: "批准交稿版本",
        message: `确认批准当前已验收修订（${revShort}）用于导出本地交稿单？批准后该版本将绑定至交稿记录。`,
        confirmLabel: "批准当前版本",
      });
      if (!confirmed) return;
      await store.change("approval.decide", { confirmed: true }, { message: "已批准交稿" });
    });
  };

  deliverBtn.onclick = () => {
    void store.perform(async () => {
      const active = store.snapshot.active;
      if (!active?.revisionId) return;
      const result = await store.change<{ state: string }>("article.deliver", {
        key: `delivery:${active.revisionId}`,
      });
      store.setNotice(
        result.state === "exported" ? "交稿单已生成" : "已记录交稿，文件导出失败，可从此处重试。",
        result.state !== "exported",
      );
    });
  };

  outlineForm.onsubmit = (event) => {
    event.preventDefault();
    void store.perform(async () => {
      const values = formValues(outlineForm);
      const result = await store.change<{ warnings: string[] }>("chapter.outline", {
        ...values,
        target: Number(values.target),
      });
      if (result.warnings.length) store.setNotice(result.warnings.join(" · "));
    });
  };

  articlePlanForm.onsubmit = (event) => {
    event.preventDefault();
    void store.perform(() => store.change("article.plan", formValues(articlePlanForm)));
  };

  (settingProposalForm.elements.namedItem("toChapter") as HTMLSelectElement).onchange = syncSettingExpiry;

  settingAddPersonBtn.onclick = () => {
    const fragment = settingPersonTemplate.content.firstElementChild?.cloneNode(true) as HTMLElement | null;
    if (!fragment) return;
    const select = fragment.querySelector<HTMLSelectElement>("select");
    if (select) populateChapterSelect(select);
    const removeBtn = fragment.querySelector<HTMLButtonElement>("button");
    if (removeBtn) removeBtn.onclick = () => fragment.remove();
    settingPeople.append(fragment);
    fragment.querySelector<HTMLInputElement>("[data-person]")?.focus();
  };

  settingProposalForm.onsubmit = (event) => {
    event.preventDefault();
    void store.perform(async () => {
      const values = formValues(settingProposalForm);
      const lockedBox = settingProposalForm.elements.namedItem("locked") as HTMLInputElement;
      const from = { chapterId: values.fromChapter || store.documentId, point: Number(values.point) };
      const people = Array.from(settingPeople.children, (row) => {
        const character = (row.querySelector<HTMLInputElement>("[data-person]")?.value ?? "").trim();
        const chapterId = row.querySelector<HTMLSelectElement>("[data-when]")?.value ?? "";
        const pointRaw = row.querySelector<HTMLInputElement>("[data-point]")?.value ?? "";
        return {
          character,
          at:
            chapterId || pointRaw
              ? {
                  chapterId: chapterId || from.chapterId,
                  point: Number(pointRaw || (chapterId ? 1 : from.point)),
                }
              : undefined,
        };
      });
      await store.change(
        "setting.propose",
        {
          projectId: store.projectId,
          factId: values.factId,
          note: values.note,
          source: values.source,
          from,
          people,
          to: values.toChapter ? { chapterId: values.toChapter, point: Number(values.toPoint) } : undefined,
          locked: lockedBox.checked,
        },
        { message: "设定提案已提交" },
      );
      settingProposalForm.reset();
      settingPeople.replaceChildren();
      syncSettingExpiry();
    });
  };

  settingsReadForm.onsubmit = (event) => {
    event.preventDefault();
    void store.perform(async () => {
      const values = formValues(settingsReadForm);
      const result = await store.mutate<{ entries: SettingFactDto[] }>("settings.read", {
        projectId: store.projectId,
        character: values.character,
        at: { chapterId: store.documentId, point: Number(values.point) },
      });
      if (result.entries.length === 0) {
        knownSettings.replaceChildren(el("p", "此时该人物没有已确认的知情设定。", "muted-hint"));
        return;
      }
      knownSettings.replaceChildren(
        ...result.entries.map((fact) =>
          el(
            "p",
            [
              fact.note,
              `来源 ${fact.source}`,
              fact.locked ? "已锁定" : "",
              `${settingPoint(fact.effectiveFrom)}生效`,
              fact.effectiveTo ? `${settingPoint(fact.effectiveTo)}起失效` : "",
            ]
              .filter(Boolean)
              .join(" · "),
            "known-fact-row",
          ),
        ),
      );
    });
  };

  settingsMoreBtn.onclick = () => {
    void store.perform(async () => {
      const result = await store.mutate<{ entries: SettingProposalEntry[]; cursor: number | null }>(
        "settings.history",
        { projectId: store.projectId, before: Number(settingsMoreBtn.dataset.cursor) },
      );
      appendSettingEntries(result.entries);
      settingsMoreBtn.dataset.cursor = result.cursor ? String(result.cursor) : "";
      settingsMoreBtn.hidden = !result.cursor;
    });
  };

  recordEvidenceForm.onsubmit = (event) => {
    event.preventDefault();
    void store.perform(() =>
      store.change("evidence.record", formValues(recordEvidenceForm), {
        savedVersion: true,
        message: "已记录当前修订的正文证据",
      }),
    );
  };

  evidenceDetailBtn.onclick = () => {
    void store.perform(async () => {
      const factId = (recordEvidenceForm.elements.namedItem("factId") as HTMLInputElement).value;
      const { value } = await store.mutate<EvidenceDetailResult>(
        "evidence.detail",
        store.activeInput({ factId }),
      );
      const active = store.snapshot.active;
      const isCurrent =
        value.anchor?.chapterId === store.documentId &&
        value.revisionId === active?.revisionId &&
        value.quoteRange !== undefined;
      evidenceResult.textContent = isCurrent
        ? `第 ${value.anchor!.point} 段 · ${(active?.body ?? "").slice(value.quoteRange!.start, value.quoteRange!.end)}`
        : value.revisionId
          ? `第 ${value.anchor?.point ?? "?"} 段 · 修订 ${value.revisionId.slice(0, 8)}`
          : "暂无正文证据";
    });
  };

  for (const [button, offset] of [
    [moveUpBtn, -1],
    [moveDownBtn, 1],
  ] as const) {
    button.onclick = () => {
      void store.perform(async () => {
        const chapterIds = (store.snapshot.documents ?? []).map(({ id }) => id);
        const position = chapterIds.indexOf(store.documentId);
        if (position < 0) return;
        const target = position + offset;
        if (target < 0 || target >= chapterIds.length) return;
        [chapterIds[position], chapterIds[target]] = [chapterIds[target], chapterIds[position]];
        const plan = await store.mutate<ReorderImpactResult>("reorder.impact", {
          projectId: store.projectId,
          chapterIds,
        });
        const impacts = plan.impact.flatMap(({ id, relations }) =>
          relations.map(({ label }) => `${id} · ${label}`),
        );
        const confirmed = await confirmDialog({
          title: "确认调整章序",
          message: impacts.length
            ? "以下设定时间关系将因章序调整发生翻转，请核对后再提交："
            : "本次章序调整不影响已确认设定的时间关系，是否确认调整？",
          details: impacts,
          confirmLabel: "确认调整章序",
        });
        if (!confirmed) return;
        await store.change(
          "reorder.commit",
          { projectId: store.projectId, chapterIds, asOfSeq: plan.asOfSeq, confirmed: true },
          { message: "章序已更新" },
        );
      });
    };
  }

  (startRunForm.elements.namedItem("instruction") as HTMLTextAreaElement).addEventListener("input", showBudgetEstimate);

  startRunForm.onsubmit = (event) => {
    event.preventDefault();
    void store.perform(() => {
      const values = formValues(startRunForm);
      return store.change(
        "run.start",
        { ...values, tokenLimit: Number(values.tokenLimit), point: Number(values.point || 1) },
        { savedVersion: true, message: "写作任务已创建" },
      );
    });
  };

  estimateBudgetBtn.onclick = () => {
    void store.perform(async () => {
      if (store.isEditorDirty()) {
        throw new Error("保存当前正文后即可按该修订核算预算。");
      }
      const instruction = startRunForm.elements.namedItem("instruction") as HTMLTextAreaElement;
      const point = startRunForm.elements.namedItem("point") as HTMLInputElement;
      const tokenLimit = startRunForm.elements.namedItem("tokenLimit") as HTMLInputElement;
      if (!instruction.reportValidity() || !point.reportValidity()) return;
      const { inputReserve, recommended } = await store.mutate<BudgetPreviewResult>(
        "run.preview",
        store.activeInput({
          instruction: instruction.value,
          point: point.disabled ? 1 : Number(point.value || 1),
        }),
      );
      if (!tokenLimit.value || tokenLimit.value === tokenLimit.dataset.suggested) {
        tokenLimit.value = String(recommended);
      }
      tokenLimit.dataset.suggested = String(recommended);
      const maxOutput = Math.max(0, Number(tokenLimit.value) - inputReserve);
      budgetHint.textContent = `首轮写作预留约 ${inputReserve} token，当前额度最多可输出 ${maxOutput}。质检与回改使用任务剩余额度。`;
    });
  };

  completeRunForm.onsubmit = (event) => {
    event.preventDefault();
    void store.perform(async () => {
      const running = store.currentRun();
      if (!running) return;
      const values = formValues(completeRunForm);
      await store.change(
        "run.complete",
        { ...values, tokens: Number(values.tokens), runId: running.id },
        { message: "已导入候选稿" },
      );
      completeRunForm.reset();
    });
  };

  cancelRunBtn.onclick = () => {
    void store.perform(async () => {
      const running = store.currentRun();
      if (!running) return;
      await store.change("run.cancel", { runId: running.id }, { message: "任务已取消" });
    });
  };

  generateRunForm.onsubmit = (event) => {
    event.preventDefault();
    void store.perform(async () => {
      const run = store.currentRun() ?? store.uncertainRun() ?? store.snapshot.runs?.[0];
      if (!run) return;
      const values = formValues(generateRunForm);
      const autoQaBox = generateRunForm.elements.namedItem("autoQa") as HTMLInputElement;
      await store.change(
        "run.generate",
        { ...values, autoQa: autoQaBox.checked, runId: run.id },
        { message: "DsH 正在生成候选稿" },
      );
    });
  };

  refreshRunBtn.onclick = () => {
    void store.perform(async () => {
      store.stashCurrentEditor();
      await store.load();
    });
  };

  runDetailBtn.onclick = () => {
    const runId = runDetailBtn.dataset.run;
    if (!runId) return;
    void store.perform(() => loadRunDetail(runId));
  };

  runHistoryBtn.onclick = () => {
    void store.perform(async () => {
      runHistoryList.replaceChildren();
      async function loadPage(before?: number): Promise<void> {
        const entries = await store.mutate<RunHistoryItem[]>(
          "run.history",
          store.activeInput(before !== undefined ? { before } : {}),
        );
        if (entries.length === 0 && before === undefined) {
          runHistoryList.append(el("p", "暂无历史任务。", "muted-hint"));
          return;
        }
        for (const entry of entries) {
          const itemBtn = el(
            "button",
            `${RUN_STATE_LABELS[entry.state]} · ${entry.settled} / ${entry.reserved} token`,
            "history-item",
          );
          itemBtn.type = "button";
          itemBtn.onclick = () => void store.perform(() => loadRunDetail(entry.id));
          runHistoryList.append(itemBtn);
        }
        if (entries.length === 25) {
          const more = el("button", "加载更早记录");
          more.type = "button";
          more.onclick = () =>
            void store.perform(async () => {
              await loadPage(entries.at(-1)!.cursor);
              more.remove();
            });
          runHistoryList.append(more);
        }
      }
      await loadPage();
    });
  };

  reconcileForm.onsubmit = (event) => {
    event.preventDefault();
    void store.perform(async () => {
      const runId = runDetailBtn.dataset.run;
      if (!runId) return;
      const detail = await loadRunDetail(runId);
      const uncertain = detail.attempts.find(({ state }) => state === "uncertain");
      if (!uncertain) throw new Error("未找到待核对的调用记录。");
      const values = formValues(reconcileForm);
      await store.change(
        "run.reconcile",
        { runId, attemptId: uncertain.id, tokens: Number(values.tokens) },
        { message: "已完成用量核对" },
      );
      reconcileForm.reset();
    });
  };

  function onDirectoryChanged(nextTitles: ReadonlyMap<string, string>): void {
    chapterTitles = nextTitles;
    if (settingProject !== store.projectId) {
      settingProject = store.projectId;
      settingProposalForm.reset();
      settingPeople.replaceChildren();
    }
    for (const select of settingProposalForm.querySelectorAll<HTMLSelectElement>("[data-setting-chapters]")) {
      populateChapterSelect(select);
    }
    syncSettingExpiry();
  }

  function render(): void {
    const snapshot = store.snapshot;
    const active = snapshot.active;
    const article = active?.product === "toutiao";
    const hasDraft = Boolean(active?.revisionId);
    const locked = isLockedDocumentState(active?.state);

    flowEmpty.hidden = Boolean(active);
    flowContent.hidden = !active;
    if (!active) return;

    // Hide Fanqie-only continuity tab on Toutiao documents.
    if (continuityTabBtn) continuityTabBtn.hidden = article;
    if (article && store.activeTab === "continuity") {
      store.activeTab = "flow";
    }
    for (const btn of tabButtons) {
      const isSelected = btn.dataset.pipelineTab === store.activeTab;
      btn.setAttribute("aria-selected", String(isSelected));
    }
    for (const panel of tabPanels) {
      const panelTab = panel.dataset.pipelinePanel as PipelineTab;
      panel.hidden = panelTab !== store.activeTab || (article && panelTab === "continuity");
    }

    // --- Flow Actions ---
    fanqieActions.hidden = article;
    toutiaoActions.hidden = !article;

    reviewsLabel.textContent = `审稿打回 ${active.editorialRejections} / ${WORKSPACE_EDITORIAL_REJECTION_LIMIT} 次`;
    reviewPassBtn.disabled = !hasDraft || locked || active.state === "reviewed";
    reviewRejectBtn.disabled =
      !hasDraft || locked || active.editorialRejections >= WORKSPACE_EDITORIAL_REJECTION_LIMIT;
    finalizeBtn.disabled = active.state !== "reviewed";

    const report = snapshot.report;
    articleReport.hidden = !report;
    if (report) {
      articleReport.textContent =
        report.overall !== undefined
          ? [`最近质检 ${report.overall} 分`, ...(report.hardGates ?? []), ...(report.fails ?? [])].join(" · ")
          : `验收退回 · ${report.reason || "请修订后重新质检"}`;
    }

    const exportStatus = snapshot.exportStatus;
    approvedVersionEl.hidden = !snapshot.approved;
    approvedVersionEl.textContent = snapshot.approved
      ? `获批修订 ${(exportStatus?.revisionId ?? active.revisionId ?? "").slice(0, 8)}`
      : "";
    exportStatusEl.hidden = !exportStatus;
    exportStatusEl.textContent =
      ({
        exported: "已写入交稿文件",
        pending: "已记录交稿，等待写入文件",
        failed: String(exportStatus?.error).includes("export.conflict")
          ? "存在同名的不同文件，请处理冲突后重试"
          : "已记录交稿，文件写入失败",
      } as Record<string, string>)[exportStatus?.state ?? ""] ?? "";

    const qaSubmit = qaForm.querySelector<HTMLButtonElement>("button[type=submit]");
    if (qaSubmit) qaSubmit.disabled = !hasDraft || locked;
    refineBtn.disabled =
      !hasDraft || active.state !== "初稿待改" || active.qaRounds >= WORKSPACE_QA_REFINEMENT_LIMIT;
    acceptBtn.disabled = rejectBtn.disabled = active.state !== "待验收";
    approveBtn.disabled = active.state !== "已验收" || Boolean(snapshot.approved);
    approveBtn.textContent = snapshot.approved ? "已批准交稿" : "批准交稿";
    deliverBtn.disabled = !snapshot.approved || !["已验收", "已交稿"].includes(active.state);
    deliverBtn.textContent = active.state === "已交稿" ? "重试或检查导出" : "交稿";

    if (deliveryUrl) URL.revokeObjectURL(deliveryUrl);
    deliveryUrl = snapshot.delivery
      ? URL.createObjectURL(new Blob([snapshot.delivery], { type: "text/markdown;charset=utf-8" }))
      : undefined;
    downloadLink.hidden = !deliveryUrl;
    if (deliveryUrl) downloadLink.href = deliveryUrl;

    // --- Planning Forms ---
    outlineForm.hidden = article;
    articlePlanForm.hidden = !article;
    if (planDocument !== active.id) {
      planDocument = active.id;
      outlineForm.reset();
      articlePlanForm.reset();
      const plan = snapshot.planning ?? {};
      const flatOutline: Record<string, unknown> = { ...plan, ...(plan.sections ?? {}) };
      for (const [key, value] of Object.entries(flatOutline)) {
        const field = outlineForm.elements.namedItem(key) as HTMLInputElement | HTMLTextAreaElement | null;
        if (field && (typeof value === "string" || typeof value === "number")) {
          field.value = String(value);
        }
      }
      if (snapshot.scenario) {
        for (const [name, key] of [
          ["driver", "drivers"],
          ["opening", "openings"],
          ["ending", "endings"],
        ] as const) {
          const select = articlePlanForm.elements.namedItem(name) as HTMLSelectElement;
          select.replaceChildren(...snapshot.scenario[key].map((word) => new Option(word, word)));
          const selected = plan[name];
          if (selected) select.value = selected;
        }
        titleMatrixLabel.hidden = !snapshot.scenario.hasTitle;
        const titlesField = articlePlanForm.elements.namedItem("titles") as HTMLTextAreaElement;
        titlesField.value =
          plan.titleMatrix?.valid.map(({ text, motif }) => `${text} | ${motif}`).join("\n") ?? "";
      }
    }

    // --- Continuity (Fanqie) ---
    if (!article) {
      const nextSettingsKey = JSON.stringify([store.projectId, snapshot.settings, snapshot.settingsCursor]);
      if (nextSettingsKey !== settingsKey) {
        settingsKey = nextSettingsKey;
        settingsList.replaceChildren();
        appendSettingEntries(snapshot.settings ?? []);
        settingsMoreBtn.hidden = !snapshot.settingsCursor;
        settingsMoreBtn.dataset.cursor = snapshot.settingsCursor ? String(snapshot.settingsCursor) : "";
      }
      const docs = snapshot.documents ?? [];
      const position = docs.findIndex(({ id }) => id === active.id);
      moveUpBtn.disabled = position < 1;
      moveDownBtn.disabled = position < 0 || position >= docs.length - 1;
      continuityPanel.dataset.product = "fanqie";
    }

    // --- Runs & Generation ---
    const pending = store.candidateRun();
    const run = store.currentRun() ?? store.uncertainRun() ?? snapshot.runs?.[0];
    automaticQaLabel.hidden = !article;
    runContent.hidden = !run;
    const startBtn = startRunForm.querySelector<HTMLButtonElement>("button[type=submit]");
    if (startBtn) {
      startBtn.disabled =
        !hasDraft ||
        locked ||
        Boolean(store.currentRun() || pending) ||
        run?.generationState === "uncertain";
    }
    estimateBudgetBtn.disabled = !hasDraft || locked;
    showBudgetEstimate();

    if (toolDocument !== active.id) {
      toolDocument = active.id;
      runHistoryList.replaceChildren();
      runInputPanel.hidden = true;
    }

    runStatus.textContent = run ? (RUN_STATE_LABELS[run.state] ?? run.state) : "";
    if (run?.generationError) runStatus.append(` · ${run.generationError}`);
    const uncertain = run?.generationState === "uncertain";
    reconcileForm.hidden = !uncertain;
    if (uncertain) runStatus.append(" · 请先查 DsH 提供方用量，再确认未记账部分");
    runDetailBtn.dataset.run = run?.id ?? "";
    completeRunForm.hidden = run?.state !== "running";
    generateRunForm.hidden = locked || uncertain || !run || !["running", "failed"].includes(run.state);
    cancelRunBtn.hidden = run?.state !== "running";
  }

  return { onDirectoryChanged, render };
}
