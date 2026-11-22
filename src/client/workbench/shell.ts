import type {
  CandidateQaReport,
  NovelTreeDto,
  Product,
  RunDetailDto,
  RunHistoryItem,
  RunSummary,
  SearchHitDto,
  WorkspaceSnapshot,
} from "../../contracts/workspace-dto.ts";
import { apiRequest, fetchWorkspaceState } from "./api.ts";
import { createAppearancePopover } from "./appearance.ts";
import { countNonWhitespaceChars } from "./diff.ts";
import { byId } from "./dom.ts";
import { createDraftVault, type EditorBase } from "./draft-vault.ts";
import { createModalController } from "./modal.ts";
import type {
  PipelineTabId,
  ProductLineUiModule,
  ProductLineUiSession,
  WorkbenchShellHost,
  WorkspaceViewId,
} from "./plugins/types.ts";
import { DEMO_BOOK_PRESET } from "./seed-packs.ts";
import { createActionCoordinator, createRenderGate, el, formatCharCount } from "./store.ts";
import { createAgentCompanion } from "./views/agent-companion.ts";
import { createCommandPalette } from "./views/command-palette.ts";
import { createDiffView } from "./views/diff-view.ts";
import { createNewBookWizard } from "./views/new-book-wizard.ts";
import { createJobCenter } from "./views/job-center.ts";
import { renderRunInspector } from "./views/run-inspector.ts";
import { createSelectionMicrobar } from "./views/selection-microbar.ts";
import { createStudyHome, writeLastActiveRef } from "./views/study-home.ts";
import { createTreeSidebar } from "./views/tree-sidebar.ts";
import { enhanceNavbar } from "./ui/primitives.ts";

const RUN_STATE_LABELS: Readonly<Record<string, string>> = {
  running: "等待候选稿",
  "awaiting-author": "等待作者决定",
  applied: "已采纳",
  discarded: "已舍弃",
  failed: "任务失败",
  cancelled: "已取消",
};

const PIPELINE_TABS: readonly PipelineTabId[] = ["workflow", "planning", "continuity", "runs"];

function formFields(form: HTMLFormElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function quickEstimateTokens(text: string): number {
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    total += text.charCodeAt(i) <= 0x7f ? 0.4 : 1.4;
  }
  return Math.ceil(total);
}

export function bootWorkbench(modules: readonly ProductLineUiModule[]): void {
  enhanceNavbar(document.querySelector<HTMLElement>("header.top"));
  createAppearancePopover(byId<HTMLButtonElement>("theme-toggle"));

  const editor = byId<HTMLTextAreaElement>("body");
  const modal = createModalController(byId<HTMLDialogElement>("workbench-dialog"));
  const diffView = createDiffView(byId("comparison"), {
    onLocate: (text, leftIndex) => locateEditorParagraph(text, leftIndex),
  });
  const jobCenter = createJobCenter(byId("job-center"), {
    onCancelJob: (job) => {
      if (job.kind === "draft_generation" && job.runId) {
        void perform(() => change("run.cancel", { runId: job.runId! }, { message: "已取消生成作业" }));
      } else if (job.kind === "proposal_extraction" && job.proposalId) {
        void perform(async () => {
          await request("proposal.cancel", { proposalId: job.proposalId! });
          await load();
          notice("已取消提案抽取作业");
        });
      }
    },
    onInspectRun: (runId) => void perform(() => showRunDetail(runId)),
    onApplyRecoveryHint: (hint) => {
      const form = byId<HTMLFormElement>("start-run");
      const tokenLimit = form.elements.namedItem("tokenLimit") as HTMLInputElement | null;
      if ((hint.action === "increase_budget" || hint.action === "increase_output_limit") && tokenLimit) {
        const currentVal = Number(tokenLimit.value || 12000);
        const nextVal = Math.max(12000, currentVal + 4000);
        tokenLimit.value = String(nextVal);
        tokenLimit.focus();
        notice(`已将令牌预算预填提升至 ${nextVal.toLocaleString("zh-Hans")}，可直接重试或创建新任务。`);
        return;
      }
      notice("建议在模型设置中关闭深度思考后点击“开始生成”原地重试。");
    },
  });
  const modulesById = new Map(modules.map((mod) => [mod.id, mod]));
  const gate = createRenderGate();
  const coordinator = createActionCoordinator();

  const viewMode = new URLSearchParams(window.location.search).get("view") || "main";
  if (viewMode === "conversation") {
    document.body.classList.add("view-conversation");
  } else if (viewMode === "settings") {
    document.body.classList.add("view-settings");
  }

  let snapshot: WorkspaceSnapshot = {};
  let projectId = "";
  let documentId = "";
  let pollTimer: number | undefined;
  let loadSequence = 0;
  let editSequence = 0;
  let editorBase: EditorBase | undefined;
  let stashTimer: number | undefined;
  let budgetTimer: number | undefined;
  let composing = false;
  let toolDocument: string | undefined;
  let activePipelineTab: PipelineTabId = "runs";
  let activeWorkspaceView: WorkspaceViewId = "writing";
  let usingCustomTree = false;
  let lastSyncedFocusKey = "";

  function syncWorkspaceFocus(): void {
    const key = `${projectId}:${documentId}:${viewMode}`;
    if (key === lastSyncedFocusKey) return;
    lastSyncedFocusKey = key;
    if (!projectId && !documentId) return;
    void request("focus.set", {
      projectId: projectId || null,
      documentId: documentId || null,
      viewMode,
    }).catch(() => {
      // Non-fatal: focus sync will retry on next navigation if server is temporarily busy.
    });
  }

  function notice(message: string, isError = false): void {
    const container = byId("notice");
    const textNode = byId("notice-text");
    textNode.textContent = message;
    container.hidden = !message;
    container.classList.toggle("notice-error", isError);
    container.setAttribute("role", isError ? "alert" : "status");
  }

  function locateEditorParagraph(paragraphText: string, leftIndex: number | null): void {
    if (activeWorkspaceView !== "writing") {
      switchWorkspaceView("writing");
    }
    const body = editor.value;
    let start = -1;
    let end = -1;
    const lines = body.replace(/\r\n?/gu, "\n").split("\n");
    if (leftIndex !== null && leftIndex >= 1 && leftIndex <= lines.length) {
      let offset = 0;
      let lineNo = 1;
      while (lineNo < leftIndex && offset <= body.length) {
        const nl = body.indexOf("\n", offset);
        if (nl === -1) break;
        offset = nl + 1;
        lineNo++;
      }
      if (lineNo === leftIndex) {
        const nextNl = body.indexOf("\n", offset);
        let lineEnd = nextNl === -1 ? body.length : nextNl;
        if (lineEnd > offset && body[lineEnd - 1] === "\r") lineEnd--;
        const lineSlice = body.slice(offset, lineEnd);
        if (!paragraphText || lineSlice === paragraphText || lineSlice.includes(paragraphText.slice(0, 16))) {
          start = offset;
          end = lineEnd;
        }
      }
    }
    if (start === -1 && paragraphText) {
      const idx = body.indexOf(paragraphText);
      if (idx !== -1) {
        start = idx;
        end = idx + paragraphText.length;
      } else {
        const probe = paragraphText.slice(0, 24).trim();
        const fallbackIdx = probe ? body.indexOf(probe) : -1;
        if (fallbackIdx !== -1) {
          start = fallbackIdx;
          end = fallbackIdx + probe.length;
        }
      }
    }
    if (start === -1) start = 0;
    if (end < start) end = start;
    editor.focus();
    editor.setSelectionRange(start, end);
    const totalLines = Math.max(1, lines.length);
    const linePos = body.slice(0, start).split("\n").length - 1;
    if (editor.scrollHeight > editor.clientHeight) {
      editor.scrollTop = Math.max(0, Math.round((linePos / totalLines) * editor.scrollHeight - 80));
    }
    notice(leftIndex ? `已定位至原文第 ${leftIndex} 段` : "已在正文编辑器定位该段");
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

  function currentProjectProduct(): Product | undefined {
    return snapshot.projects?.find((item) => item.id === projectId)?.product;
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

  function switchWorkspaceView(viewId: WorkspaceViewId): void {
    activeWorkspaceView = viewId;
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-workspace-view]")) {
      const selected = button.dataset.workspaceView === viewId;
      button.setAttribute("aria-selected", String(selected));
      button.classList.toggle("active", selected);
    }
    for (const panel of document.querySelectorAll<HTMLElement>("[data-workspace-panel]")) {
      panel.hidden = panel.dataset.workspacePanel !== viewId;
    }
    const product = currentProjectProduct();
    for (const [id, session] of sessions) {
      session.onWorkspaceViewChanged?.(viewId, product === id, snapshot);
    }
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-workspace-view]")) {
    button.onclick = () => {
      const viewId = button.dataset.workspaceView as WorkspaceViewId | undefined;
      if (viewId) switchWorkspaceView(viewId);
    };
  }

  const treeSidebar = createTreeSidebar(byId("documents"), (docId) => {
    void perform(async () => {
      await selectDocument(docId);
    });
  });

  async function selectDocument(nextDocumentId: string): Promise<void> {
    stash();
    for (const session of sessions.values()) session.onDocumentSelected?.();
    documentId = nextDocumentId;
    treeSidebar.updateActiveId(nextDocumentId);
    if (activeWorkspaceView !== "writing") {
      switchWorkspaceView("writing");
    }
    await load();
  }

  function setDirectoryTree(tree: NovelTreeDto | null): void {
    if (tree) {
      usingCustomTree = true;
      treeSidebar.renderNovelTree(tree, documentId);
    } else {
      usingCustomTree = false;
      treeSidebar.renderFlat(snapshot.documents ?? [], documentId);
    }
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
    const estimate =
      quickEstimateTokens(active.body ?? "") +
      quickEstimateTokens(active.title) +
      quickEstimateTokens(instruction.value) +
      512;
    const recommended = Math.max(8000, Math.ceil((estimate * 2 + 2400) / 1000) * 1000);
    if (toolDocument !== active.id || !tokenLimit.value || tokenLimit.value === tokenLimit.dataset.suggested) {
      tokenLimit.value = String(recommended);
    }
    tokenLimit.dataset.suggested = String(recommended);
    byId("budget-hint").textContent =
      `校准输入估算约 ${estimate.toLocaleString("zh-Hans")} token · 建议总额 ${recommended.toLocaleString("zh-Hans")}（含输出余量）`;
  }

  async function loadState(ifSequence?: number, background = false): Promise<void> {
    const sequence = ++loadSequence;
    const startEpoch = coordinator.epoch();
    const selection = [projectId, documentId];
    const next = await fetchWorkspaceState({ projectId, documentId }, ifSequence);
    if (sequence !== loadSequence || selection[0] !== projectId || selection[1] !== documentId) return;
    if (background && (coordinator.isUserBusy() || startEpoch !== coordinator.epoch())) return;
    if (!next || typeof next !== "object") {
      throw new Error("工作台响应格式有误，请刷新后重试。");
    }
    if (next.unchanged === true) return;
    if (!Array.isArray(next.projects)) {
      throw new Error("工作台响应格式有误，请刷新后重试。");
    }
    stash();
    if (pollTimer && next.active?.id !== snapshot.active?.id) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
    snapshot = next;
    render();
  }

  function load(ifSequence?: number): Promise<void> {
    return loadState(ifSequence, false);
  }

  async function perform(work: () => Promise<unknown> | void): Promise<void> {
    await coordinator.runUserAction(
      work,
      (error) => notice(error instanceof Error ? error.message : String(error), true),
      () => notice(""),
    );
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
      ? (typeof extra.mergedBody === "string" ? extra.mergedBody : (pendingCandidate()?.candidateBody ?? ""))
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
    getState: () => ({ projectId, documentId, snapshot, composing, activeView: activeWorkspaceView }),
    readEditorValue: () => editor.value,
    isDirty: dirty,
    stashEditor: stash,
    perform,
    load,
    selectDocument,
    setDirectoryTree,
    setTreeFilter(query: string) {
      treeSidebar.setFilter(query);
    },
    switchWorkspaceView,
    switchPipelineTab,
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

  const agentCompanion = createAgentCompanion({
    companionContainer: byId("agent-companion"),
    writeBannerContainer: byId("agent-write-banner"),
    handoffStripContainer: byId("agent-handoff-strip"),
    host,
    onClearLocalDraft: (docId) => {
      vault.write(docId, null);
    },
  });

  const selectionMicrobar = createSelectionMicrobar(editor, host, {
    getProviderModel: () => {
      const form = byId<HTMLFormElement>("generate-run");
      const providerInput = form.elements.namedItem("provider") as HTMLInputElement | HTMLSelectElement | null;
      const modelInput = form.elements.namedItem("model") as HTMLInputElement | HTMLSelectElement | null;
      return {
        provider: providerInput?.value?.trim() || "default",
        model: modelInput?.value?.trim() || "default",
      };
    },
  });

  async function openProjectAndDoc(targetProjectId: string, targetDocId = ""): Promise<void> {
    stash();
    projectId = targetProjectId;
    documentId = targetDocId;
    usingCustomTree = false;
    gate.reset();
    await load();
    if (!documentId && snapshot.documents && snapshot.documents.length > 0) {
      documentId = snapshot.documents[0].id;
      gate.reset();
      await load();
    }
  }

  async function importDemoBook(): Promise<void> {
    stash();
    const proj = await request<{ id: string }>("project.create", {
      product: DEMO_BOOK_PRESET.product,
      name: DEMO_BOOK_PRESET.projectName,
    });
    const newProjectId = proj.id;
    await request("controls.save", {
      projectId: newProjectId,
      authorIntent: DEMO_BOOK_PRESET.authorIntent,
      currentFocus: DEMO_BOOK_PRESET.currentFocus,
      pacingTier: DEMO_BOOK_PRESET.pacingTier,
      genreTags: DEMO_BOOK_PRESET.genreTags,
    });
    const vol = await request<{ id: string }>("volume.create", {
      projectId: newProjectId,
      title: DEMO_BOOK_PRESET.volumeTitle,
    });
    const act = await request<{ id: string }>("act.create", {
      projectId: newProjectId,
      volumeId: vol.id,
      title: DEMO_BOOK_PRESET.actTitle,
    });
    let firstChapterId = "";
    for (const ch of DEMO_BOOK_PRESET.chapters) {
      const doc = await request<{ id: string }>("document.create", {
        projectId: newProjectId,
        title: ch.title,
        volumeId: vol.id,
        actId: act.id,
      });
      if (!firstChapterId) firstChapterId = doc.id;
      await request("draft.save", { documentId: doc.id, baseRevisionId: null, body: ch.body });
      await request("chapter.summary.save", { documentId: doc.id, summary: ch.summary });
    }
    if (firstChapterId && DEMO_BOOK_PRESET.starterForeshadow) {
      await request("foreshadow.create", {
        projectId: newProjectId,
        title: DEMO_BOOK_PRESET.starterForeshadow.title,
        plantedChapterId: firstChapterId,
        status: "planted",
        note: DEMO_BOOK_PRESET.starterForeshadow.note,
      });
    }
    for (const tech of DEMO_BOOK_PRESET.techniques) {
      const savedTech = await request<{ id: string }>("technique.save", {
        scope: "project",
        projectId: newProjectId,
        title: tech.title,
        category: tech.category,
        pacing: tech.pacing,
        sceneTags: tech.sceneTags,
        triggerWhen: tech.triggerWhen,
        executionSteps: tech.executionSteps,
        constraints: tech.constraints,
        antiPatterns: tech.antiPatterns,
        positiveExample: tech.positiveExample,
        negativeExample: tech.negativeExample,
        conflictGroup: tech.conflictGroup,
        assetKind: tech.assetKind,
        stageBindings: tech.stageBindings,
      });
      await request("library.mount", {
        projectId: newProjectId,
        targetType: "project",
        targetId: newProjectId,
        itemKind: "technique",
        itemId: savedTech.id,
        mode: "include",
      });
    }
    await openProjectAndDoc(newProjectId, firstChapterId);
    notice(`已导入示例书「${DEMO_BOOK_PRESET.projectName}」`);
  }

  const wizard = createNewBookWizard(host, {
    onCompleted: (newProjectId, firstDocId) => openProjectAndDoc(newProjectId, firstDocId),
  });

  const studyHome = createStudyHome(byId("empty"), {
    onSelectProject: (pid) => void perform(() => openProjectAndDoc(pid)),
    onResumeDocument: (pid, did) => void perform(() => openProjectAndDoc(pid, did)),
    onOpenWizard: () => wizard.open(),
    onImportDemoBook: () => void perform(importDemoBook),
  });

  function render(): void {
    const projectsSelect = byId<HTMLSelectElement>("projects");
    const project = snapshot.projects?.find((item) => item.id === projectId);
    const active = snapshot.active;
    const mod = activeModule();
    const hasDraft = Boolean(active?.revisionId);
    const locked = Boolean(active && mod?.lockedStates.includes(active.state));

    const projSig = (snapshot.projects ?? []).map((p) => `${p.id}:${p.name}:${p.product}`).join("|");
    if (gate.changed("projects", projSig)) {
      const fragment = document.createDocumentFragment();
      fragment.append(new Option("选择项目", ""));
      for (const item of snapshot.projects ?? []) {
        const displayName = modulesById.get(item.product)?.displayName ?? item.product;
        fragment.append(new Option(`${item.name} · ${displayName}`, item.id));
      }
      projectsSelect.replaceChildren(fragment);
    }
    projectsSelect.value = projectId;

    const docsList = snapshot.documents ?? [];
    const docSig = `${projectId}:${snapshot.asOfSeq ?? 0}:${docsList.length}:${docsList.map((d) => `${d.id}:${d.title}`).join(",")}`;
    const projectMod = project ? modulesById.get(project.product) : undefined;
    if (gate.changed("directory", docSig)) {
      if (!usingCustomTree || !projectMod?.supportsCustomTree) {
        treeSidebar.renderFlat(docsList, documentId);
      }
      for (const [id, session] of sessions) {
        session.onDirectoryUpdated?.(project?.product === id, projectId, snapshot);
      }
    } else {
      treeSidebar.updateActiveId(documentId);
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
    syncWorkspaceFocus();
    if (!active) {
      studyHome.update(snapshot);
      selectionMicrobar.hide();
      agentCompanion.update(snapshot);
      byId("active-tree-crumb").hidden = true;
      for (const session of sessions.values()) session.renderDocumentSlots(false, snapshot);
      return;
    }

    writeLastActiveRef({
      projectId,
      documentId: active.id,
      projectName: project?.name ?? "",
      title: active.title || "微头条",
    });
    agentCompanion.update(snapshot);

    byId("document-label").textContent = mod?.documentTypeLabel(snapshot) ?? active.product;
    byId("heading").textContent = active.title || "微头条";
    byId("state").textContent = mod?.stateLabels[active.state] ?? active.state;

    const crumbEl = byId("active-tree-crumb");
    const ctxCrumb = snapshot.activeContext;
    if (ctxCrumb && (ctxCrumb.volumeTitle || ctxCrumb.actTitle || ctxCrumb.charCount > 0)) {
      crumbEl.hidden = false;
      crumbEl.textContent = [
        ctxCrumb.volumeTitle,
        ctxCrumb.actTitle,
        ctxCrumb.charCount > 0 ? `已存 ${formatCharCount(ctxCrumb.charCount)}` : "",
      ].filter(Boolean).join(" / ");
    } else {
      crumbEl.hidden = true;
    }

    const saved = vault.read(active.id);
    const stale = Boolean(saved && saved.revisionId !== active.revisionId);
    const visibleBody = saved?.body ?? active.body ?? "";
    if (editor.value !== visibleBody && !composing) editor.value = visibleBody;
    editor.readOnly = locked || stale;
    byId<HTMLButtonElement>("save").disabled = locked || stale;
    if (locked || stale) selectionMicrobar.hide();
    else selectionMicrobar.refresh();
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
        candidateId: pending.candidateId,
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
      run?.recoveryHints?.[0]?.message ?? "",
      run?.generationState === "uncertain" ? "请先查 DsH 提供方用量再核对" : "",
    ].filter(Boolean);
    runStatusEl.textContent = statusParts.join(" · ");

    const isUncertain = run?.generationState === "uncertain";
    byId("reconcile").hidden = !isUncertain;
    byId("run-detail").dataset.run = run?.id ?? "";
    byId("complete-run").hidden = run?.state !== "running";
    byId("generate-run").hidden = locked || isUncertain || !["running", "failed"].includes(run?.state ?? "");
    byId("cancel").hidden = run?.state !== "running";

    const jobsList = snapshot.jobs ?? [];
    jobCenter.render(jobsList, run, snapshot.runs ?? []);

    const hasOpenJob =
      (run?.state === "running" && ["prepared", "inflight", "received"].includes(run.generationState ?? "")) ||
      jobsList.some((j) => j.state === "prepared" || j.state === "inflight" || j.state === "received");

    if (!pollTimer && hasOpenJob) {
      pollTimer = window.setInterval(() => {
        if (!document.hidden && !composing) {
          void coordinator.runBackgroundPoll(() => loadState(snapshot.asOfSeq, true));
        }
      }, 2000);
    }
    if (pollTimer && !hasOpenJob) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  function toggleSidebar(region: "navigation" | "pipeline", forceHidden?: boolean): void {
    const scrollBox = document.scrollingElement;
    const span = scrollBox ? scrollBox.scrollHeight - scrollBox.clientHeight : 0;
    const ratio = scrollBox && span > 0 ? scrollBox.scrollTop / span : 0;
    const panel = byId(region);
    const button = byId<HTMLButtonElement>(`${region}-toggle`);
    panel.hidden = forceHidden ?? !panel.hidden;
    byId("layout").classList.toggle(`without-${region}`, panel.hidden);
    button.setAttribute("aria-pressed", String(!panel.hidden));
    requestAnimationFrame(() => {
      if (scrollBox) scrollBox.scrollTop = ratio * (scrollBox.scrollHeight - scrollBox.clientHeight);
    });
  }

  for (const region of ["navigation", "pipeline"] as const) {
    byId<HTMLButtonElement>(`${region}-toggle`).onclick = () => toggleSidebar(region);
  }

  const wideToggle = byId<HTMLButtonElement>("pipeline-wide-toggle");
  wideToggle.onclick = () => {
    const isWide = byId("layout").classList.toggle("pipeline-wide");
    wideToggle.setAttribute("aria-pressed", String(isWide));
    wideToggle.textContent = isWide ? "窄栏" : "宽栏";
  };

  const commandPalette = createCommandPalette({
    dialog: byId<HTMLDialogElement>("command-palette-dialog"),
    getDocuments: () => snapshot.documents ?? [],
    getProjectId: () => projectId,
    supportsStudioViews: () => {
      const product = currentProjectProduct();
      return Boolean(product && modulesById.get(product)?.supportsStudioViews);
    },
    searchRemote: (query) => request<SearchHitDto[]>("workspace.search", { projectId, query }),
    onSelectDocument: (docId) => void perform(() => selectDocument(docId)),
    onSwitchView: (viewId) => switchWorkspaceView(viewId),
    onToggleFocusMode: () => {
      const bothVisible = !byId("navigation").hidden || !byId("pipeline").hidden;
      toggleSidebar("navigation", bothVisible);
      toggleSidebar("pipeline", bothVisible);
    },
  });

  byId("quick-jump").onclick = () => commandPalette.open("jump");
  byId("global-search").onclick = () => commandPalette.open("search");

  // Manuscript editing listeners & global shortcuts
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
    // FE-27: shortcuts must never fire in the middle of an IME composition,
    // otherwise Ctrl+S commits a half-typed Chinese word to the manuscript.
    if (event.isComposing || composing) return;
    const modKey = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (modKey && key === "s") {
      const saveBtn = byId<HTMLButtonElement>("save");
      if (!saveBtn.hidden && !saveBtn.disabled) {
        event.preventDefault();
        void perform(() => change("draft.save", { body: editor.value }, { clearDraft: true }));
      }
    } else if (modKey && event.shiftKey && key === "f") {
      event.preventDefault();
      commandPalette.open("search");
    } else if (modKey && !event.shiftKey && key === "k") {
      event.preventDefault();
      commandPalette.open("jump");
    } else if (modKey && event.key === "\\") {
      event.preventDefault();
      const bothVisible = !byId("navigation").hidden || !byId("pipeline").hidden;
      toggleSidebar("navigation", bothVisible);
      toggleSidebar("pipeline", bothVisible);
    } else if (event.altKey && ["1", "2", "3", "4"].includes(event.key)) {
      const idx = Number(event.key) - 1;
      const targetTab = PIPELINE_TABS[idx];
      if (targetTab) {
        event.preventDefault();
        switchPipelineTab(targetTab);
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
      usingCustomTree = false;
      gate.reset("directory");
      await load();
    });
  };

  bindForm("new-project", async (values, form) => {
    stash();
    const created = await request<{ id: string }>("project.create", values);
    projectId = created.id;
    documentId = "";
    usingCustomTree = false;
    gate.reset();
    form.reset();
    form.closest("details")?.removeAttribute("open");
    await load();
    notice("项目已创建");
  });

  byId<HTMLFormElement>("new-document").addEventListener("input", () => {
    const product = currentProjectProduct();
    for (const [id, session] of sessions) {
      session.onCreateDocumentFormChanged?.(product === id);
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
    const plan = diffView.getAdoptionPayload();
    if (plan?.adoptionMode === "partial" && plan.selectedCount === 0) {
      notice("请至少勾选一处变更，或直接点击舍弃候选稿", true);
      return;
    }
    const partial = plan?.adoptionMode === "partial";
    const confirmed = await modal.confirm({
      title: partial ? "按勾选段落部分采纳" : "采纳候选稿",
      message: partial && plan
        ? `仅采纳勾选的 ${plan.selectedCount} / ${plan.totalHunks} 处变更生成新工作稿修订？原工作稿与完整候选稿均保留在历史记录中。`
        : "以这份候选稿生成新的工作稿修订？原工作稿修订仍保留在历史记录中，本次操作不会自动定稿。",
      confirmLabel: "采纳为新修订",
    });
    if (confirmed) {
      await change(
        "candidate.adopt",
        {
          key: pending.candidateId,
          runId: pending.id,
          adoptionMode: plan?.adoptionMode ?? "full",
          ...(partial && plan ? { mergedBody: plan.mergedBody } : {}),
        },
        { clearDraft: true, savedVersion: true, message: partial ? "已按勾选段落合稿采纳" : "已采纳候选稿" },
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
    .addEventListener("input", () => {
      window.clearTimeout(budgetTimer);
      budgetTimer = window.setTimeout(updateBudgetHint, 250);
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
      const fragment = document.createDocumentFragment();
      for (const entry of entries) {
        const label = `${RUN_STATE_LABELS[entry.state] ?? entry.state} · ${entry.settled} / ${entry.reserved} token`;
        const button = el("button", label, "history-item");
        button.type = "button";
        button.onclick = () => void perform(() => showRunDetail(entry.id));
        fragment.append(button);
      }
      target.append(fragment);
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

  if (viewMode === "conversation") {
    toggleSidebar("navigation", true);
    switchPipelineTab("runs");
  } else {
    switchPipelineTab("runs");
  }
  switchWorkspaceView("writing");
  void perform(load);
}
