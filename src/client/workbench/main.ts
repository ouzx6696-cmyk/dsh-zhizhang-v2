import { apiRequest, fetchWorkspaceState } from "./api.ts";
import { countNonWhitespaceChars, countUnicodeCodePoints } from "./diff.ts";
import { createDraftVault, type EditorBase } from "./draft-vault.ts";
import { createModalController } from "./modal.ts";
import type {
  ActiveDocument,
  AnchorPoint,
  CandidateQaReport,
  RunDetailDto,
  RunHistoryItem,
  RunSummary,
  SettingEntryDto,
  SettingFactDto,
  WorkspaceSnapshot,
} from "./types.ts";
import { createDiffView } from "./views/diff-view.ts";
import { renderRunInspector } from "./views/run-inspector.ts";

const TITLE_MAX = 34;

const CHAPTER_STAGE_LABELS: Readonly<Record<string, string>> = {
  planned: "待写",
  drafting: "写作中",
  drafted: "已有草稿",
  reviewed: "已审稿",
  final: "已定稿",
};

const RUN_STATE_LABELS: Readonly<Record<string, string>> = {
  running: "等待候选稿",
  "awaiting-author": "等待作者决定",
  applied: "已采纳",
  discarded: "已舍弃",
  failed: "任务失败",
  cancelled: "已取消",
};

const DECISION_LABELS: Readonly<Record<string, string>> = {
  approved: "已确认",
  rejected: "已拒绝",
  pending: "待确认",
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

function isLocked(state: string | undefined): boolean {
  return state === "final" || state === "已验收" || state === "已交稿";
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

function bootWorkbench(): void {
  initTheme();

  const editor = byId<HTMLTextAreaElement>("body");
  const modal = createModalController(byId<HTMLDialogElement>("workbench-dialog"));
  const diffView = createDiffView(byId("comparison"));

  let snapshot: WorkspaceSnapshot = {};
  let projectId = "";
  let documentId = "";
  let loading = false;
  let deliveryUrl: string | undefined;
  let pollTimer: number | undefined;
  let planDocument: string | undefined;
  let loadSequence = 0;
  let editSequence = 0;
  let editorBase: EditorBase | undefined;
  let stashTimer: number | undefined;
  let composing = false;
  let directoryKey = "";
  let selectedDirectoryButton: HTMLButtonElement | undefined;
  let directoryButtons = new Map<string, HTMLButtonElement>();
  let chapterTitles = new Map<string, string>();
  let settingProject: string | undefined;
  let settingsKey: string | undefined;
  let toolDocument: string | undefined;
  let activePipelineTab = "workflow";

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

  function settingPoint({ chapterId, point }: AnchorPoint): string {
    return `${chapterTitles.get(chapterId) ?? chapterId}第 ${point} 段`;
  }

  function updateEditorMetrics(): void {
    const chars = countNonWhitespaceChars(editor.value);
    const active = snapshot.active;
    const rangeHint = active?.product === "fanqie"
      ? "建议 2,000–2,500 字"
      : snapshot.scenario
        ? `${snapshot.scenario.label} ${snapshot.scenario.length[0]}–${snapshot.scenario.length[1]} 字`
        : "";
    byId("word-count").textContent = rangeHint
      ? `${chars.toLocaleString("zh-Hans")} 字 · ${rangeHint}`
      : `${chars.toLocaleString("zh-Hans")} 字`;
  }

  function switchPipelineTab(tabId: string): void {
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
      if (button.dataset.pipelineTab) switchPipelineTab(button.dataset.pipelineTab);
    };
  }

  function appendSettings(target: HTMLElement, entries: readonly SettingEntryDto[]): void {
    if (entries.length === 0 && target.childElementCount === 0) {
      target.append(el("p", "暂无设定提案。", "muted-copy"));
      return;
    }
    for (const entry of entries) {
      const row = el("article", "", "setting-item");
      const titleLine = el(
        "p",
        `${entry.fact.id} · ${entry.fact.note} · ${DECISION_LABELS[entry.decision] ?? entry.decision}${entry.fact.locked ? " · 已锁定" : ""}`,
        "setting-title",
      );
      const { source, effectiveFrom, effectiveTo, knownFrom } = entry.fact;
      const metaLine = el(
        "p",
        [
          `来源 ${source}`,
          `${settingPoint(effectiveFrom)}生效`,
          effectiveTo ? `${settingPoint(effectiveTo)}起失效` : "",
          ...Object.entries(knownFrom).map(([name, at]) => `${name}在${settingPoint(at)}知情`),
        ].filter(Boolean).join(" · "),
        "setting-meta",
      );
      row.append(titleLine, metaLine);
      if (entry.decision === "pending") {
        const actions = el("div", "", "actions");
        for (const [label, accept] of [["确认设定", true], ["拒绝提案", false]] as const) {
          const button = el("button", label, accept ? "primary" : undefined);
          button.type = "button";
          button.onclick = () =>
            void perform(() => change("setting.decide", { projectId, proposalId: entry.id, accept }));
          actions.append(button);
        }
        row.append(actions);
      }
      target.append(row);
    }
  }

  function populateSettingChapters(select: HTMLSelectElement): void {
    const value = select.value;
    select.replaceChildren(
      new Option(select.dataset.default ?? "", ""),
      ...Array.from(chapterTitles, ([id, title]) => new Option(title, id)),
    );
    if (chapterTitles.has(value)) select.value = value;
  }

  function syncSettingExpiry(): void {
    const form = byId<HTMLFormElement>("setting-proposal");
    const toChapter = form.elements.namedItem("toChapter") as HTMLSelectElement;
    const toPoint = form.elements.namedItem("toPoint") as HTMLInputElement;
    const expires = Boolean(toChapter.value);
    byId("setting-to-point").hidden = !expires;
    toPoint.disabled = !expires;
  }

  function syncTitleCount(field: HTMLInputElement, output: HTMLOutputElement, titled: boolean): void {
    const length = countUnicodeCodePoints(field.value);
    output.textContent = titled ? `${length} / ${TITLE_MAX} 字符` : "";
    output.classList.toggle("is-over-limit", titled && length > TITLE_MAX);
    field.setCustomValidity(titled && length > TITLE_MAX ? `标题最多 ${TITLE_MAX} 个字符` : "");
  }

  function updateBudgetHint(): void {
    const form = byId<HTMLFormElement>("start-run");
    const active = snapshot.active;
    if (!active) return;
    const instruction = form.elements.namedItem("instruction") as HTMLTextAreaElement;
    const tokenLimit = form.elements.namedItem("tokenLimit") as HTMLInputElement;
    const pointInput = form.elements.namedItem("point") as HTMLInputElement;
    const serialized = JSON.stringify([active.body, active.title, snapshot.planning, snapshot.scenario, instruction.value]);
    const estimate = new TextEncoder().encode(serialized).length + 1024;
    const recommended = Math.max(8000, Math.ceil((estimate * 2 + 2400) / 1000) * 1000);
    if (toolDocument !== active.id || !tokenLimit.value || tokenLimit.value === tokenLimit.dataset.suggested) {
      tokenLimit.value = String(recommended);
    }
    tokenLimit.dataset.suggested = String(recommended);
    byId("budget-hint").textContent =
      `保守输入估算约 ${estimate.toLocaleString("zh-Hans")} token · 建议总额 ${recommended.toLocaleString("zh-Hans")}（含输出余量）`;
    byId("run-point").hidden = active.product !== "fanqie";
    pointInput.disabled = active.product !== "fanqie";
  }

  function render(): void {
    const projectsSelect = byId<HTMLSelectElement>("projects");
    const navigation = byId("documents");
    const project = snapshot.projects?.find((item) => item.id === projectId);
    const active = snapshot.active;
    const article = project?.product === "toutiao";
    const hasDraft = Boolean(active?.revisionId);
    const locked = isLocked(active?.state);

    const nextDirectoryKey = JSON.stringify([projectId, snapshot.projects, snapshot.documents]);
    if (nextDirectoryKey !== directoryKey) {
      directoryKey = nextDirectoryKey;
      projectsSelect.replaceChildren(new Option("选择项目", ""));
      for (const item of snapshot.projects ?? []) {
        const label = `${item.name} · ${item.product === "fanqie" ? "番茄" : "头条"}`;
        projectsSelect.append(new Option(label, item.id));
      }
      directoryButtons = new Map();
      chapterTitles = new Map();
      for (const item of snapshot.documents ?? []) {
        const title = item.title || "微头条";
        const button = el("button", title);
        button.type = "button";
        directoryButtons.set(item.id, button);
        chapterTitles.set(item.id, title);
        button.setAttribute("aria-current", "false");
        button.onclick = () =>
          void perform(async () => {
            stash();
            byId("known-settings").replaceChildren();
            documentId = item.id;
            await load();
          });
      }
      if (directoryButtons.size === 0 && project) {
        navigation.replaceChildren(el("p", "暂无稿件，请先新建。", "muted-copy"));
      } else {
        navigation.replaceChildren(...directoryButtons.values());
      }
      if (settingProject !== projectId) {
        settingProject = projectId;
        byId<HTMLFormElement>("setting-proposal").reset();
        byId("setting-people").replaceChildren();
      }
      for (const select of byId("setting-proposal").querySelectorAll<HTMLSelectElement>("[data-setting-chapters]")) {
        populateSettingChapters(select);
      }
      syncSettingExpiry();
    }

    projectsSelect.value = projectId;
    const selectedButton = directoryButtons.get(documentId);
    if (selectedButton !== selectedDirectoryButton) {
      selectedDirectoryButton?.setAttribute("aria-current", "false");
      selectedButton?.setAttribute("aria-current", "true");
      selectedDirectoryButton = selectedButton;
    }

    byId("document-tools").hidden = !project;
    byId("article-options").hidden = !article;
    updateNewTitle();

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
    if (!active) return;

    byId("document-label").textContent = article
      ? `头条创作${snapshot.scenario ? ` · ${snapshot.scenario.label} · ${active.line ?? ""}` : ""}`
      : "番茄连载";
    byId("heading").textContent = active.title || "微头条";
    byId("state").textContent = CHAPTER_STAGE_LABELS[active.state] ?? active.state;

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

    const renameForm = byId<HTMLFormElement>("rename");
    const renameTitleInput = renameForm.elements.namedItem("title") as HTMLInputElement;
    renameForm.hidden = !article || active.mode === "micro" || locked;
    if (renameForm.dataset.title !== active.title) {
      renameForm.dataset.title = active.title;
      renameTitleInput.value = active.title;
    }
    syncTitleCount(renameTitleInput, byId<HTMLOutputElement>("title-count"), !renameForm.hidden);

    const titlesSelect = byId<HTMLSelectElement>("title-choices");
    const plannedTitles = snapshot.planning?.titleMatrix?.valid?.map(({ text }) => text) ?? [];
    if (titlesSelect.dataset.titles !== JSON.stringify(plannedTitles)) {
      titlesSelect.dataset.titles = JSON.stringify(plannedTitles);
      titlesSelect.replaceChildren(
        new Option("套用标题候选", ""),
        ...plannedTitles.map((title) => new Option(title, title)),
      );
    }

    const report = snapshot.report;
    const reportEl = byId("article-report");
    reportEl.hidden = !report;
    reportEl.textContent = report?.overall !== undefined
      ? [`最近质检 ${report.overall} 分`, ...(report.hardGates ?? []), ...(report.fails ?? [])].join(" · ")
      : report
        ? `验收退回 · ${report.reason || "请修订后重新质检"}`
        : "";

    const exportStatus = snapshot.exportStatus;
    const approvedVersion = byId("approved-version");
    approvedVersion.hidden = !snapshot.approved;
    approvedVersion.textContent = snapshot.approved
      ? `获批修订 ${(exportStatus?.revisionId ?? active.revisionId ?? "").slice(0, 8)}`
      : "";

    const exportStatusEl = byId("export-status");
    exportStatusEl.hidden = !exportStatus;
    exportStatusEl.textContent = exportStatus
      ? ({
        exported: "已写入交稿文件",
        pending: "已记录交稿，等待写入文件",
        failed: String(exportStatus.error).includes("export.conflict")
          ? "存在同名的不同文件，请处理冲突后重试"
          : "已记录交稿，文件写入失败",
      })[exportStatus.state]
      : "";

    byId("chapter-outline").hidden = article;
    byId("article-plan").hidden = !article;
    if (planDocument !== active.id) {
      planDocument = active.id;
      const outline = byId<HTMLFormElement>("chapter-outline");
      const articlePlan = byId<HTMLFormElement>("article-plan");
      outline.reset();
      articlePlan.reset();
      const plan = snapshot.planning ?? {};
      const flatPlan: Record<string, unknown> = { ...plan, ...(plan.sections ?? {}) };
      for (const [key, value] of Object.entries(flatPlan)) {
        const field = outline.elements.namedItem(key);
        if (
          (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
          (typeof value === "string" || typeof value === "number")
        ) {
          field.value = String(value);
        }
      }
      if (snapshot.scenario) {
        for (const [name, key] of [["driver", "drivers"], ["opening", "openings"], ["ending", "endings"]] as const) {
          const select = articlePlan.elements.namedItem(name) as HTMLSelectElement;
          select.replaceChildren(...snapshot.scenario[key].map((word) => new Option(word, word)));
          const selectedValue = plan[name];
          if (selectedValue) select.value = selectedValue;
        }
        byId("title-matrix").hidden = !snapshot.scenario.hasTitle;
        const titlesArea = articlePlan.elements.namedItem("titles") as HTMLTextAreaElement;
        titlesArea.value = plan.titleMatrix?.valid.map(({ text, motif }) => `${text} | ${motif}`).join("\n") ?? "";
      }
    }

    byId("fanqie-actions").hidden = article;
    byId("tab-continuity").hidden = article;
    if (article && activePipelineTab === "continuity") {
      switchPipelineTab("workflow");
    }

    const nextSettingsKey = JSON.stringify([projectId, snapshot.settings, snapshot.settingsCursor]);
    if (nextSettingsKey !== settingsKey) {
      settingsKey = nextSettingsKey;
      const settingList = byId("settings");
      settingList.replaceChildren();
      appendSettings(settingList, snapshot.settings ?? []);
      const moreBtn = byId<HTMLButtonElement>("settings-more");
      moreBtn.hidden = !snapshot.settingsCursor;
      moreBtn.dataset.cursor = snapshot.settingsCursor ? String(snapshot.settingsCursor) : "";
    }

    const position = (snapshot.documents ?? []).findIndex(({ id }) => id === active.id);
    byId<HTMLButtonElement>("move-up").disabled = position < 1;
    byId<HTMLButtonElement>("move-down").disabled = position >= (snapshot.documents?.length ?? 0) - 1;

    byId("toutiao-actions").hidden = !article;
    byId("reviews").textContent = `审稿打回 ${active.editorialRejections} / 2 次`;
    byId<HTMLButtonElement>("review-pass").disabled = !hasDraft || locked || active.state === "reviewed";
    byId<HTMLButtonElement>("review-reject").disabled = !hasDraft || locked || active.editorialRejections >= 2;
    byId<HTMLButtonElement>("finalize").disabled = active.state !== "reviewed";

    byId<HTMLButtonElement>("qa-submit").disabled = !hasDraft || locked;
    byId<HTMLButtonElement>("refine").disabled = !hasDraft || active.state !== "初稿待改" || active.qaRounds >= 2;
    const acceptDisabled = active.state !== "待验收";
    byId<HTMLButtonElement>("accept").disabled = acceptDisabled;
    byId<HTMLButtonElement>("reject").disabled = acceptDisabled;
    const approveBtn = byId<HTMLButtonElement>("approve");
    approveBtn.disabled = active.state !== "已验收" || Boolean(snapshot.approved);
    approveBtn.textContent = snapshot.approved ? "已批准交稿" : "批准交稿";
    const deliverBtn = byId<HTMLButtonElement>("deliver");
    deliverBtn.disabled = !snapshot.approved || !["已验收", "已交稿"].includes(active.state);
    deliverBtn.textContent = active.state === "已交稿" ? "重试或检查导出" : "交稿";

    const download = byId<HTMLAnchorElement>("download");
    if (deliveryUrl) URL.revokeObjectURL(deliveryUrl);
    deliveryUrl = snapshot.delivery
      ? URL.createObjectURL(new Blob([snapshot.delivery], { type: "text/markdown;charset=utf-8" }))
      : undefined;
    download.hidden = !deliveryUrl;
    if (deliveryUrl) download.href = deliveryUrl;

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

    byId("automatic-qa").hidden = !article;
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

  function bindForm(id: string, submit: (values: Record<string, string>, form: HTMLFormElement) => Promise<unknown> | void): void {
    byId<HTMLFormElement>(id).onsubmit = (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      void perform(() => submit(formFields(form), form));
    };
  }

  function bindClick(id: string, handler: () => Promise<unknown> | void): void {
    byId(id).onclick = () => void perform(handler);
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

  // Safe manuscript editing listeners + Cmd/Ctrl+S shortcut
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

  // Conflict banner actions (no native window.confirm!)
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

  const newDocForm = byId<HTMLFormElement>("new-document");
  function updateNewTitle(): void {
    const modeSelect = newDocForm.elements.namedItem("mode") as HTMLSelectElement;
    const titleInput = newDocForm.elements.namedItem("title") as HTMLInputElement;
    const titled = !byId("article-options").hidden && modeSelect.value !== "micro";
    syncTitleCount(titleInput, byId<HTMLOutputElement>("new-title-count"), titled);
  }
  newDocForm.addEventListener("input", updateNewTitle);

  bindForm("new-document", async (values, form) => {
    stash();
    const created = await request<{ id: string }>("document.create", { ...values, projectId });
    documentId = created.id;
    form.reset();
    form.closest("details")?.removeAttribute("open");
    await load();
    notice("稿件已创建");
  });

  // Manuscript save & workflow actions
  bindClick("save", () => change("draft.save", { body: editor.value }, { clearDraft: true }));
  bindClick("review-pass", () => change("chapter.review", { accept: true }, { savedVersion: true, message: "审稿已通过" }));
  bindClick("review-reject", () => change("chapter.review", { accept: false }, { savedVersion: true, message: "已记录审稿打回" }));
  bindClick("finalize", async () => {
    const confirmed = await modal.confirm({
      title: "确认定稿本章",
      message: "定稿后本章正文将锁定为终稿修订，无法继续直接修改。确认将当前修订设为定稿？",
      confirmLabel: "确认定稿",
    });
    if (confirmed) {
      await change("draft.finalize", {}, { savedVersion: true, message: "本章已定稿" });
    }
  });

  bindForm("qa", async (values) => {
    const result = await change<CandidateQaReport>(
      "article.qa",
      {
        score: Number(values.score),
        passed: values.passed === "on",
        fails: values.fails.split("\n").map((line) => line.trim()).filter(Boolean),
      },
      { savedVersion: true },
    );
    notice([...result.hardGates, ...result.fails].join(" · ") || `质检已记录 · ${result.overall} 分`);
  });

  bindClick("refine", () => change("article.refine", { body: editor.value }, { clearDraft: true, message: "已保存回改稿" }));
  bindClick("accept", () => change("article.accept", { accept: true }, { savedVersion: true, message: "稿件已验收" }));

  bindClick("reject", async () => {
    const reason = await modal.prompt({
      title: "验收退回",
      message: "填写本次验收退回原因，便于后续修订和核对。",
      label: "退回原因",
      placeholder: "例如：核心数据需补充来源，结尾过渡偏急",
      confirmLabel: "确认退回",
    });
    if (reason !== null) {
      await change("article.accept", { accept: false, reason }, { savedVersion: true, message: "已退回修订" });
    }
  });

  bindClick("approve", async () => {
    const rev = snapshot.active?.revisionId?.slice(0, 8) ?? "";
    const confirmed = await modal.confirm({
      title: "批准交稿版本",
      message: `确认批准修订 ${rev} 用于本地 Markdown 交稿导出？批准记录将严格绑定至该版本。`,
      confirmLabel: "确认批准",
    });
    if (confirmed) {
      await change("approval.decide", { confirmed: true }, { message: "已批准当前版本交稿" });
    }
  });

  bindClick("deliver", async () => {
    const result = await change<{ state: string }>("article.deliver", {
      key: `delivery:${snapshot.active?.revisionId ?? ""}`,
    });
    notice(
      result.state === "exported" ? "交稿单已生成并写入本地文件" : "已记录交稿，文件导出失败，可从此处重试。",
      result.state !== "exported",
    );
  });

  // Candidate adoption & run management
  bindForm("start-run", (values) =>
    change(
      "run.start",
      { ...values, tokenLimit: Number(values.tokenLimit), point: Number(values.point || 1) },
      { savedVersion: true, message: "已创建写作任务" },
    ),
  );

  bindClick("estimate-budget", async () => {
    if (dirty()) throw new Error("保存当前正文后即可按该修订核算预算。");
    const form = byId<HTMLFormElement>("start-run");
    const instruction = form.elements.namedItem("instruction") as HTMLTextAreaElement;
    const point = form.elements.namedItem("point") as HTMLInputElement;
    const tokenLimit = form.elements.namedItem("tokenLimit") as HTMLInputElement;
    if (!instruction.reportValidity() || !point.reportValidity()) return;
    const { inputReserve, recommended } = await request<{ inputReserve: number; recommended: number }>(
      "run.preview",
      activeInput({ instruction: instruction.value, point: point.disabled ? 1 : Number(point.value || 1) }),
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

  // Planning forms
  bindForm("chapter-outline", async (values) => {
    const result = await change<{ warnings: string[] }>("chapter.outline", {
      ...values,
      target: Number(values.target),
    });
    if (result.warnings.length) notice(result.warnings.join(" · "));
  });

  bindForm("article-plan", (values) => change("article.plan", values, { message: "场景规划已保存" }));

  // Fanqie continuity, multi-character settings & reorder modal
  const settingForm = byId<HTMLFormElement>("setting-proposal");
  (settingForm.elements.namedItem("toChapter") as HTMLSelectElement).onchange = syncSettingExpiry;

  byId("setting-add-person").onclick = () => {
    const template = byId<HTMLTemplateElement>("setting-person-template");
    const person = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
    populateSettingChapters(person.querySelector<HTMLSelectElement>("select")!);
    person.querySelector<HTMLButtonElement>("button")!.onclick = () => person.remove();
    byId("setting-people").append(person);
    person.querySelector<HTMLInputElement>("[data-person]")!.focus();
  };

  bindForm("setting-proposal", async (values, form) => {
    const from = { chapterId: values.fromChapter || documentId, point: Number(values.point) };
    const people = Array.from(byId("setting-people").children, (row) => {
      const character = row.querySelector<HTMLInputElement>("[data-person]")!.value;
      const chapterId = row.querySelector<HTMLSelectElement>("[data-when]")!.value;
      const point = row.querySelector<HTMLInputElement>("[data-point]")!.value;
      return {
        character,
        at: chapterId || point
          ? { chapterId: chapterId || from.chapterId, point: Number(point || (chapterId ? 1 : from.point)) }
          : undefined,
      };
    });
    await change(
      "setting.propose",
      {
        projectId,
        factId: values.factId,
        note: values.note,
        source: values.source,
        from,
        people,
        to: values.toChapter ? { chapterId: values.toChapter, point: Number(values.toPoint) } : undefined,
        locked: values.locked === "on",
      },
      { message: "设定提案已提交，待作者确认后生效" },
    );
    form.reset();
    byId("setting-people").replaceChildren();
    syncSettingExpiry();
  });

  bindForm("settings-read", async (values) => {
    const result = await request<{ entries: readonly SettingFactDto[] }>("settings.read", {
      projectId,
      character: values.character,
      at: { chapterId: documentId, point: Number(values.point) },
    });
    const container = byId("known-settings");
    container.replaceChildren(
      ...(result.entries.length > 0
        ? result.entries.map(({ note, source, locked, effectiveFrom, effectiveTo }) =>
          el(
            "p",
            [
              note,
              `来源 ${source}`,
              locked ? "已锁定" : "",
              `${settingPoint(effectiveFrom)}生效`,
              effectiveTo ? `${settingPoint(effectiveTo)}起失效` : "",
            ].filter(Boolean).join(" · "),
            "known-item",
          ),
        )
        : [el("p", "此时该人物没有已确认的知情设定。", "muted-copy")]),
    );
  });

  for (const [id, offset] of [["move-up", -1], ["move-down", 1]] as const) {
    bindClick(id, async () => {
      const chapterIds = (snapshot.documents ?? []).map(({ id: docId }) => docId);
      const position = chapterIds.indexOf(documentId);
      if (position < 0 || position + offset < 0 || position + offset >= chapterIds.length) return;
      [chapterIds[position], chapterIds[position + offset]] = [chapterIds[position + offset], chapterIds[position]];
      const plan = await request<{
        asOfSeq: number;
        impact: readonly { id: string; relations: readonly { label: string }[] }[];
      }>("reorder.impact", { projectId, chapterIds });
      const impacts = plan.impact.flatMap(({ id: factId, relations }) =>
        relations.map(({ label }) => `${factId} · ${label} 时序将被翻转`),
      );
      const confirmed = await modal.confirm({
        title: "确认调整章节顺序",
        message: impacts.length > 0
          ? "本次章序调整将影响以下已确认设定的时间先后关系，请核对后再提交："
          : "本次章序调整未翻转任何已确认设定的时间先后关系。确认执行调整？",
        details: impacts,
        confirmLabel: "确认调整章序",
      });
      if (confirmed) {
        await change(
          "reorder.commit",
          { projectId, chapterIds, asOfSeq: plan.asOfSeq, confirmed: true },
          { message: "章节顺序已更新" },
        );
      }
    });
  }

  // Toutiao title rename & candidate title selection
  const renameForm = byId<HTMLFormElement>("rename");
  const renameInput = renameForm.elements.namedItem("title") as HTMLInputElement;
  renameInput.addEventListener("input", () =>
    syncTitleCount(renameInput, byId<HTMLOutputElement>("title-count"), true),
  );
  byId<HTMLSelectElement>("title-choices").onchange = (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value) renameInput.value = value;
    syncTitleCount(renameInput, byId<HTMLOutputElement>("title-count"), true);
  };
  bindForm("rename", (values) =>
    change("article.rename", values, { savedVersion: true, clearDraft: true, message: "标题已更新为新修订" }),
  );

  (byId<HTMLFormElement>("start-run").elements.namedItem("instruction") as HTMLTextAreaElement)
    .addEventListener("input", updateBudgetHint);

  // Evidence recording & lookup
  bindForm("record-evidence", async (values) => {
    await change("evidence.record", values, { savedVersion: true, message: "已记录当前修订的正文证据" });
  });

  bindClick("evidence-detail", async () => {
    const form = byId<HTMLFormElement>("record-evidence");
    const factId = (form.elements.namedItem("factId") as HTMLInputElement).value;
    const { value } = await request<{
      value: {
        revisionId?: string;
        anchor?: { chapterId: string; point: string };
        quoteRange?: { start: number; end: number };
      };
    }>("evidence.detail", activeInput({ factId }));
    const output = byId("evidence-result");
    const active = snapshot.active as ActiveDocument | undefined;
    const isCurrent = value.anchor?.chapterId === documentId && value.revisionId === active?.revisionId;
    output.textContent = isCurrent && value.quoteRange && active?.body
      ? `第 ${value.anchor!.point} 段 · ${active.body.slice(value.quoteRange.start, value.quoteRange.end)}`
      : value.revisionId
        ? `第 ${value.anchor?.point ?? "?"} 段 · 修订 ${value.revisionId.slice(0, 8)}`
        : "暂无正文证据";
  });

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

  bindClick("settings-more", async () => {
    const button = byId<HTMLButtonElement>("settings-more");
    const result = await request<{ entries: readonly SettingEntryDto[]; cursor: number | null }>("settings.history", {
      projectId,
      before: Number(button.dataset.cursor),
    });
    appendSettings(byId("settings"), result.entries);
    button.dataset.cursor = result.cursor ? String(result.cursor) : "";
    button.hidden = !result.cursor;
  });

  switchPipelineTab("workflow");
  void perform(load);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootWorkbench, { once: true });
} else {
  bootWorkbench();
}
