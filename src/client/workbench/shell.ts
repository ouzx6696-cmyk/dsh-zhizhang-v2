import type {
  CandidateQaReport,
  RunDetailDto,
  RunHistoryItem,
  RunSummary,
  WorkspaceSnapshot,
} from "../../contracts/workspace-dto.ts";
import { apiRequest, fetchWorkspaceState } from "./api.ts";
import { countNonWhitespaceChars } from "./diff.ts";
import { createDraftVault, type EditorBase } from "./draft-vault.ts";
import { createModalController } from "./modal.ts";
import type {
  PipelineTabId,
  ProductLineUiModule,
  ProductLineUiSession,
  WorkbenchShellHost,
} from "./plugins/types.ts";
import { createDiffView } from "./views/diff-view.ts";
import { renderRunInspector } from "./views/run-inspector.ts";

const RUN_STATE_LABELS: Readonly<Record<string, string>> = {
  running: "等待候选稿",
  "awaiting-author": "等待作者决定",
  applied: "已采纳",
  discarded: "已舍弃",
  failed: "任务失败",
  cancelled: "已取消",
};

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing workbench element #${id}`);
  return node as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  label = "",
  className?: string,
): HTMLElementTagNameMap[K] {
  const entry = document.createElement(tag);
  if (label) entry.textContent = label;
  if (className) entry.className = className;
  return entry;
}

function formFields(form: HTMLFormElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function initTheme(): void {
  const root = document.documentElement;
  const button = byId<HTMLButtonElement>("theme-toggle");
  const stored = (() => {
    try {
      return localStorage.getItem("zhizhang:theme");
    } catch {
      return null;
    }
  })();

  const applyTheme = (mode: "light" | "dark") => {
    root.dataset.theme = mode;
    button.textContent = mode === "dark" ? "浅色" : "深色";
    button.setAttribute("aria-label", mode === "dark" ? "切换浅色纸面主题" : "切换深色墨石主题");
    try {
      localStorage.setItem("zhizhang:theme", mode);
    } catch {
      // Ignore storage errors.
    }
  };

  if (stored === "light" || stored === "dark") {
    applyTheme(stored);
  } else {
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    button.textContent = prefersDark ? "浅色" : "深色";
  }

  button.onclick = () => {
    const current = root.dataset.theme
      ?? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    applyTheme(current === "dark" ? "light" : "dark");
  };
}

export function bootWorkbench(modules: readonly ProductLineUiModule[]): void {
  initTheme();

  const editor = byId<HTMLTextAreaElement>("body");
  const modal = createModalController(byId<HTMLDialogElement>("workbench-dialog"));
  const diffView = createDiffView(byId("comparison"));
  const modulesById = new Map(modules.map((mod) => [mod.id, mod]));

  let snapshot: WorkspaceSnapshot = {};
  let projectId = "";
  let documentId = "";
  let loading = false;
  let pollTimer: number | undefined;
  let loadSequence = 0;
  let editSequence = 0;
  let editorBase: EditorBase | undefined;
  let stashTimer: number | undefined;
  let composing = false;
  let directoryKey = "";
  let selectedDirectoryButton: HTMLButtonElement | undefined;
  let directoryButtons = new Map<string, HTMLButtonElement>();
  let toolDocument: string | undefined;
  let activePipelineTab: PipelineTabId = "workflow";

  function notice(message: string, isError = false): void {
    const container = byId("notice");
    const textNode = byId("notice-text");
    textNode.textContent = message;
    container.hidden = !message;
    container.classList.toggle("notice-error", isError);
    container.setAttribute("role", isError ? "alert" : "status");
  }

  byId("notice-close").onclick = () => notice("");

  const vault = createDraftVault((warning) => notice(warning, true));

  const request = <T>(action?: string, input?: Record<string, unknown>, ifSequence?: number) =>
    apiRequest<T>({ projectId, documentId }, action, input, ifSequence);

  function stash(): void {
    window.clearTimeout(stashTimer);
    vault.capture(editorBase, editor.value);
  }

  function dirty(): boolean {
    return vault.isDirty(editorBase, editor.value);
  }

  function pendingCandidate(): RunSummary | undefined {
    return snapshot.runs?.find((run) => run.state === "awaiting-author");
  }

  function uncertainRun(): RunSummary | undefined {
    return snapshot.runs?.find((run) => run.generationState === "uncertain");
  }

  function runningRun(): RunSummary | undefined {
    return snapshot.runs?.find((run) => run.state === "running");
  }

  function activeModule(): ProductLineUiModule | undefined {
    return snapshot.active ? modulesById.get(snapshot.active.product) : undefined;
  }

  function switchPipelineTab(tabId: PipelineTabId): void {
    activePipelineTab = tabId;
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-pipeline-tab]")) {
      const selected = button.dataset.pipelineTab === tabId;
      button.setAttribute("aria-selected", String(selected));
      button.classList.toggle("active", selected);
    }
    for (const panel of document.querySelectorAll<HTMLElement>("[data-pipeline-panel]")) {
      panel.hidden = panel.dataset.pipelinePanel !== tabId;
    }
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-pipeline-tab]")) {
    button.onclick = () => {
      const tabId = button.dataset.pipelineTab as PipelineTabId | undefined;
      if (tabId) switchPipelineTab(tabId);
    };
  }

  function updateEditorMetrics(): void {
    const chars = countNonWhitespaceChars(editor.value);
    const rangeHint = activeModule()?.wordCountHint(snapshot) ?? "";
    byId("word-count").textContent = rangeHint
      ? `${chars.toLocaleString("zh-Hans")} 字 · ${rangeHint}`
      : `${chars.toLocaleString("zh-Hans")} 字`;
  }

  function updateBudgetHint(): void {
    const form = byId<HTMLFormElement>("start-run");
    const active = snapshot.active;
    if (!active) return;
    const instruction = form.elements.namedItem("instruction") as HTMLTextAreaElement;
    const tokenLimit = form.elements.namedItem("tokenLimit") as HTMLInputElement;
    const serialized = JSON.stringify([active.body, active.title, snapshot.planning, snapshot.scenario, instruction.value]);
    const estimate = new TextEncoder().encode(serialized).length + 1024;
    const recommended = Math.max(8000, Math.ceil((estimate * 2 + 2400) / 1000) * 1000);
    if (toolDocument !== active.id || !tokenLimit.value || tokenLimit.value === tokenLimit.dataset.suggested) {
      tokenLimit.value = String(recommended);
    }
    tokenLimit.dataset.suggested = String(recommended);
    byId("budget-hint").textContent =
      `保守输入估算约 ${estimate.toLocaleString("zh-Hans")} token · 建议总额 ${recommended.toLocaleString("zh-Hans")}（含输出余量）`;
  }

  async function load(ifSequence?: number): Promise<void> {
    const sequence = ++loadSequence;
    const selection = [projectId, documentId];
    const next = await fetchWorkspaceState({ projectId, documentId }, ifSequence);
    if (sequence !== loadSequence || selection[0] !== projectId || selection[1] !== documentId) return;
    if (!next || (!Array.isArray(next.projects) && next.unchanged !== true)) {
      throw new Error("工作台响应格式有误，请刷新后重试。");
    }
    if (next.unchanged) return;
    stash();
    if (pollTimer && next.active?.id !== snapshot.active?.id) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
    snapshot = next;
    render();
  }

  async function perform(work: () => Promise<unknown> | void): Promise<void> {
    if (loading) return;
    loading = true;
    notice("");
    try {
      await work();
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error), true);
    } finally {
      loading = false;
    }
  }

  function activeInput(extra?: Record<string, unknown>): Record<string, unknown> {
    return { documentId, baseRevisionId: editorBase?.revisionId ?? null, ...extra };
  }

  async function change<T = Record<string, unknown>>(
    action: string,
    extra: Record<string, unknown> = {},
    options: { clearDraft?: boolean; savedVersion?: boolean; message?: string } = {},
  ): Promise<T> {
    if (options.savedVersion && dirty()) {
      throw new Error("请先保存正文，或复制本地稿后切回已保存版本。");
    }
    const submittedSequence = editSequence;
    const committedBody = action === "candidate.adopt"
      ? (pendingCandidate()?.candidateBody ?? "")
      : (typeof extra.body === "string" ? extra.body : editor.value);
    stash();
    const result = await request<T>(action, activeInput(extra));
    if (options.clearDraft && editorBase) {
      const id = editorBase.id;
      const newRevisionId = (result as { revisionId?: string | null }).revisionId ?? null;
      editorBase = { id, revisionId: newRevisionId, body: committedBody };
      if (editSequence === submittedSequence && !composing && editor.value !== committedBody) {
        editor.value = committedBody;
      }
      const remaining = editor.value === committedBody ? null : { body: editor.value, revisionId: newRevisionId };
      vault.write(id, remaining);
    }
    await load();
    if (!vault.isUnavailable()) notice(options.message ?? "已保存");
    return result;
  }

  function bindForm(
    id: string,
    submit: (values: Record<string, string>, form: HTMLFormElement) => Promise<unknown> | void,
  ): void {
    byId<HTMLFormElement>(id).onsubmit = (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      void perform(() => submit(formFields(form), form));
    };
  }

  function bindClick(id: string, handler: () => Promise<unknown> | void): void {
    byId(id).onclick = () => void perform(handler);
  }

  const host: WorkbenchShellHost = {
    getState: () => ({ projectId, documentId, snapshot, composing }),
    readEditorValue: () => editor.value,
    isDirty: dirty,
    stashEditor: stash,
    perform,
    load,
    change,
    request,
    notice,
    bindForm,
    bindClick,
    modal,
  };

  const sessions = new Map<string, ProductLineUiSession>(
    modules.map((mod) => [mod.id, mod.mount(host)]),
  );

  function render(): void {
    const projectsSelect = byId<HTMLSelectElement>("projects");
    const navigation = byId("documents");
    const project = snapshot.projects?.find((item) => item.id === projectId);
    const active = snapshot.active;
    const mod = activeModule();
    const hasDraft = Boolean(active?.revisionId);
    const locked = Boolean(active && mod?.lockedStates.includes(active.state));

    const nextDirectoryKey = JSON.stringify([projectId, snapshot.projects, snapshot.documents]);
    if (nextDirectoryKey !== directoryKey) {
      directoryKey = nextDirectoryKey;
      projectsSelect.replaceChildren(new Option("选择项目", ""));
      for (const item of snapshot.projects ?? []) {
        const displayName = modulesById.get(item.product)?.displayName ?? item.product;
        projectsSelect.append(new Option(`${item.name} · ${displayName}`, item.id));
      }
      directoryButtons = new Map();
      for (const item of snapshot.documents ?? []) {
        const title = item.title || "微头条";
        const button = el("button", title);
        button.type = "button";
        directoryButtons.set(item.id, button);
        button.setAttribute("aria-current", "false");
        button.onclick = () =>
          void perform(async () => {
            stash();
            for (const session of sessions.values()) session.onDocumentSelected?.();
            documentId = item.id;
            await load();
          });
      }
      if (directoryButtons.size === 0 && project) {
        navigation.replaceChildren(el("p", "暂无稿件，请先新建。", "muted-copy"));
      } else {
        navigation.replaceChildren(...directoryButtons.values());
      }
      for (const [id, session] of sessions) {
        session.onDirectoryUpdated?.(project?.product === id, projectId, snapshot);
      }
    }

    projectsSelect.value = projectId;
    const selectedButton = directoryButtons.get(documentId);
    if (selectedButton !== selectedDirectoryButton) {
      selectedDirectoryButton?.setAttribute("aria-current", "false");
      selectedButton?.setAttribute("aria-current", "true");
      selectedDirectoryButton = selectedButton;
    }

    byId("document-tools").hidden = !project;
    for (const [id, session] of sessions) {
      session.onCreateDocumentFormChanged?.(project?.product === id);
    }

    byId("breadcrumb").textContent = project
      ? active
        ? `${project.name} / ${active.title || "微头条"}`
        : project.name
      : "未选择项目";

    byId("empty").hidden = Boolean(active);
    byId("manuscript").hidden = !active;
    byId("flow-empty").hidden = Boolean(active);
    byId("flow-content").hidden = !active;
    byId<HTMLButtonElement>("save").hidden = !active;

    editorBase = active ? { id: active.id, revisionId: active.revisionId, body: active.body ?? "" } : undefined;
    if (!active) {
      for (const session of sessions.values()) session.renderDocumentSlots(false, snapshot);
      return;
    }

    byId("document-label").textContent = mod?.documentTypeLabel(snapshot) ?? active.product;
    byId("heading").textContent = active.title || "微头条";
    byId("state").textContent = mod?.stateLabels[active.state] ?? active.state;

    const saved = vault.read(active.id);
    const stale = Boolean(saved && saved.revisionId !== active.revisionId);
    const visibleBody = saved?.body ?? active.body ?? "";
    if (editor.value !== visibleBody && !composing) editor.value = visibleBody;
    editor.readOnly = locked || stale;
    byId<HTMLButtonElement>("save").disabled = locked || stale;
    updateEditorMetrics();

    const draftStatus = byId("draft-status");
    draftStatus.textContent = stale
      ? "本地编辑基于旧版本，需核对"
      : saved
        ? "已恢复本地编辑"
        : hasDraft
          ? "已保存"
          : "尚未保存";
    draftStatus.className = stale ? "status-warning" : saved ? "status-warning" : "status-muted";

    const conflictBanner = byId("conflict-banner");
    conflictBanner.hidden = !stale;
    if (stale) {
      byId("conflict-server-body").textContent = active.body ?? "";
    }

    for (const [id, session] of sessions) {
      session.renderDocumentSlots(active.product === id, snapshot);
    }
    if (mod && !mod.visibleTabs.includes(activePipelineTab)) {
      switchPipelineTab("workflow");
    }

    const pending = pendingCandidate();
    const run = runningRun() ?? uncertainRun() ?? snapshot.runs?.[0];
    if (pending && !locked) {
      const candidateQa = pending.candidateQa ? (JSON.parse(pending.candidateQa) as CandidateQaReport) : undefined;
      diffView.update({
        originalBody: active.body ?? "",
        candidateBody: pending.candidateBody ?? "",
        candidateQa,
        refinementRounds: pending.refinementRounds ?? 0,
        canAdopt: pending.baseRevisionId === active.revisionId,
      });
    } else {
      diffView.update(null);
    }

    byId("run-content").hidden = !run;
    byId<HTMLButtonElement>("start-run-submit").disabled =
      !hasDraft || locked || Boolean(runningRun() || pending) || run?.generationState === "uncertain";
    byId<HTMLButtonElement>("estimate-budget").disabled = !hasDraft || locked;
    updateBudgetHint();

    if (toolDocument !== active.id) {
      toolDocument = active.id;
      byId("run-history-list").replaceChildren();
      byId("run-input").hidden = true;
    }

    const runStatusEl = byId("run-status");
    const statusLabel = run ? RUN_STATE_LABELS[run.state] ?? run.state : "";
    const statusParts = [
      statusLabel,
      run ? `用量 ${run.settled} / ${run.reserved}` : "",
      run?.generationError ? `原因 ${run.generationError}` : "",
      run?.generationState === "uncertain" ? "请先查 DsH 提供方用量再核对" : "",
    ].filter(Boolean);
    runStatusEl.textContent = statusParts.join(" · ");

    const isUncertain = run?.generationState === "uncertain";
    byId("reconcile").hidden = !isUncertain;
    byId("run-detail").dataset.run = run?.id ?? "";
    byId("complete-run").hidden = run?.state !== "running";
    byId("generate-run").hidden = locked || isUncertain || !["running", "failed"].includes(run?.state ?? "");
    byId("cancel").hidden = run?.state !== "running";

    if (!pollTimer && run?.state === "running" && ["prepared", "inflight", "received"].includes(run.generationState ?? "")) {
      pollTimer = window.setInterval(() => {
        if (!document.hidden && !composing) void perform(() => load(snapshot.asOfSeq));
      }, 2000);
    }
    if (pollTimer && run?.state !== "running") {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  // Collapsible sidebars with scroll-ratio preservation
  for (const region of ["navigation", "pipeline"] as const) {
    const button = byId<HTMLButtonElement>(`${region}-toggle`);
    button.onclick = () => {
      const scrollBox = document.scrollingElement;
      const span = scrollBox ? scrollBox.scrollHeight - scrollBox.clientHeight : 0;
      const ratio = scrollBox && span > 0 ? scrollBox.scrollTop / span : 0;
      const panel = byId(region);
      panel.hidden = !panel.hidden;
      byId("layout").classList.toggle(`without-${region}`, panel.hidden);
      button.setAttribute("aria-pressed", String(!panel.hidden));
      requestAnimationFrame(() => {
        if (scrollBox) scrollBox.scrollTop = ratio * (scrollBox.scrollHeight - scrollBox.clientHeight);
      });
    };
  }

  // Manuscript editing listeners & Cmd/Ctrl+S shortcut
  editor.addEventListener("input", () => {
    editSequence++;
    updateEditorMetrics();
    window.clearTimeout(stashTimer);
    stashTimer = window.setTimeout(stash, 250);
  });
  editor.addEventListener("compositionstart", () => { composing = true; });
  editor.addEventListener("compositionend", () => { composing = false; stash(); });
  editor.addEventListener("blur", stash);
  window.addEventListener("pagehide", stash);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stash(); });
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      const saveBtn = byId<HTMLButtonElement>("save");
      if (!saveBtn.hidden && !saveBtn.disabled) {
        event.preventDefault();
        void perform(() => change("draft.save", { body: editor.value }, { clearDraft: true }));
      }
    }
  });

  // Conflict banner actions (no native browser dialogs)
  bindClick("conflict-copy", async () => {
    await navigator.clipboard.writeText(editor.value);
    notice("已复制本地稿到剪贴板");
  });
  bindClick("conflict-use-server", async () => {
    const active = snapshot.active;
    if (!active) return;
    const confirmed = await modal.confirm({
      title: "采用服务器版本",
      message: "丢弃当前基于旧版本的本地编辑，并恢复为服务器最新保存的正文？建议先复制本地稿留存。",
      confirmLabel: "采用服务器版本",
      destructive: true,
    });
    if (!confirmed) return;
    vault.write(active.id, null);
    render();
    notice("已恢复为服务器版本");
  });

  // Project & Document navigation
  byId<HTMLSelectElement>("projects").onchange = (event) => {
    const selected = (event.currentTarget as HTMLSelectElement).value;
    void perform(async () => {
      stash();
      projectId = selected;
      documentId = "";
      await load();
    });
  };

  bindForm("new-project", async (values, form) => {
    stash();
    const created = await request<{ id: string }>("project.create", values);
    projectId = created.id;
    documentId = "";
    form.reset();
    form.closest("details")?.removeAttribute("open");
    await load();
    notice("项目已创建");
  });

  byId<HTMLFormElement>("new-document").addEventListener("input", () => {
    const project = snapshot.projects?.find((item) => item.id === projectId);
    for (const [id, session] of sessions) {
      session.onCreateDocumentFormChanged?.(project?.product === id);
    }
  });

  bindForm("new-document", async (values, form) => {
    stash();
    const created = await request<{ id: string }>("document.create", { ...values, projectId });
    documentId = created.id;
    form.reset();
    form.closest("details")?.removeAttribute("open");
    await load();
    notice("稿件已创建");
  });

  bindClick("save", () => change("draft.save", { body: editor.value }, { clearDraft: true }));

  // Candidate adoption & shared run management
  bindForm("start-run", (values, form) => {
    const session = snapshot.active ? sessions.get(snapshot.active.product) : undefined;
    const extra = session?.collectRunStartParams?.(form) ?? {};
    return change(
      "run.start",
      { ...values, tokenLimit: Number(values.tokenLimit), ...extra },
      { savedVersion: true, message: "已创建写作任务" },
    );
  });

  bindClick("estimate-budget", async () => {
    if (dirty()) throw new Error("保存当前正文后即可按该修订核算预算。");
    const form = byId<HTMLFormElement>("start-run");
    const instruction = form.elements.namedItem("instruction") as HTMLTextAreaElement;
    const tokenLimit = form.elements.namedItem("tokenLimit") as HTMLInputElement;
    const session = snapshot.active ? sessions.get(snapshot.active.product) : undefined;
    if (!instruction.reportValidity() || session?.validateRunStartParams?.(form) === false) return;
    const extra = session?.collectRunStartParams?.(form) ?? {};
    const { inputReserve, recommended } = await request<{ inputReserve: number; recommended: number }>(
      "run.preview",
      activeInput({ instruction: instruction.value, ...extra }),
    );
    if (!tokenLimit.value || tokenLimit.value === tokenLimit.dataset.suggested) {
      tokenLimit.value = String(recommended);
    }
    tokenLimit.dataset.suggested = String(recommended);
    const maxOutput = Math.max(0, Number(tokenLimit.value) - inputReserve);
    byId("budget-hint").textContent =
      `首轮写作预留约 ${inputReserve} token，当前额度最多可输出 ${maxOutput}。质检与回改使用任务剩余额度。`;
  });

  bindForm("complete-run", async (values, form) => {
    const current = runningRun();
    if (!current) return;
    await change("run.complete", { ...values, tokens: Number(values.tokens), runId: current.id }, { message: "候选稿已导入" });
    form.reset();
  });

  bindClick("adopt", async () => {
    const pending = pendingCandidate();
    if (!pending) return;
    const confirmed = await modal.confirm({
      title: "采纳候选稿",
      message: "以这份候选稿生成新的工作稿修订？原工作稿修订仍保留在历史记录中，本次操作不会自动定稿。",
      confirmLabel: "采纳为新修订",
    });
    if (confirmed) {
      await change(
        "candidate.adopt",
        { key: pending.candidateId, runId: pending.id },
        { clearDraft: true, savedVersion: true, message: "已采纳候选稿" },
      );
    }
  });

  bindClick("discard", () => {
    const pending = pendingCandidate();
    if (!pending) return;
    return change("run.discard", { runId: pending.id }, { message: "已舍弃候选稿" });
  });

  bindClick("cancel", () => {
    const current = runningRun();
    if (!current) return;
    return change("run.cancel", { runId: current.id }, { message: "已取消写作任务" });
  });

  bindForm("generate-run", async (values) => {
    const run = runningRun() ?? uncertainRun() ?? snapshot.runs?.[0];
    if (!run) return;
    await change(
      "run.generate",
      { ...values, autoQa: values.autoQa === "on", runId: run.id },
      { message: "DsH 正在生成候选稿" },
    );
  });

  bindClick("refresh-run", async () => {
    stash();
    await load();
  });

  (byId<HTMLFormElement>("start-run").elements.namedItem("instruction") as HTMLTextAreaElement)
    .addEventListener("input", updateBudgetHint);

  // Structured run inspector & paginated history
  async function showRunDetail(runId: string): Promise<RunDetailDto> {
    const detail = await request<RunDetailDto>("run.detail", activeInput({ runId }));
    renderRunInspector(byId("run-input"), detail);
    return detail;
  }

  bindClick("run-detail", () => {
    const runId = byId("run-detail").dataset.run;
    if (runId) return showRunDetail(runId);
  });

  bindClick("run-history", async () => {
    const target = byId("run-history-list");
    target.replaceChildren();
    async function loadPage(before?: number): Promise<void> {
      const entries = await request<RunHistoryItem[]>("run.history", activeInput(before !== undefined ? { before } : {}));
      if (entries.length === 0 && before === undefined) {
        target.append(el("p", "暂无历史任务记录。", "muted-copy"));
        return;
      }
      for (const entry of entries) {
        const label = `${RUN_STATE_LABELS[entry.state] ?? entry.state} · ${entry.settled} / ${entry.reserved} token`;
        const button = el("button", label, "history-item");
        button.type = "button";
        button.onclick = () => void perform(() => showRunDetail(entry.id));
        target.append(button);
      }
      if (entries.length === 25) {
        const more = el("button", "加载更早任务");
        more.type = "button";
        more.onclick = () =>
          void perform(async () => {
            await loadPage(entries.at(-1)!.cursor);
            more.remove();
          });
        target.append(more);
      }
    }
    await loadPage();
  });

  bindForm("reconcile", async (values) => {
    const runId = byId("run-detail").dataset.run;
    if (!runId) return;
    const detail = await showRunDetail(runId);
    const attemptId = detail.attempts.find(({ state }) => state === "uncertain")?.id;
    if (!attemptId) throw new Error("未找到待核对的生成尝试。");
    await change("run.reconcile", { runId, attemptId, tokens: Number(values.tokens) }, { message: "用量已完成对账" });
  });

  switchPipelineTab("workflow");
  void perform(load);
}
