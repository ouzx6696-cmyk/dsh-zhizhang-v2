import type {
  RunSummaryView,
  WorkspaceAction,
  WorkspaceSnapshot,
} from "../../contracts/workspace.ts";
import { fetchWorkspaceState, mutateWorkspace, WorkbenchApiError } from "./api.ts";
import { DraftVault, type EditorBaseline } from "./draft-vault.ts";

export interface NoticeState {
  readonly message: string;
  readonly isError: boolean;
  readonly diagnosticId?: string;
}

export type PipelineTab = "flow" | "planning" | "continuity" | "runs";
export type DiffMode = "side-by-side" | "inline";
export type ThemePreference = "system" | "light" | "dark";

export interface ChangeOptions {
  readonly clearDraft?: boolean;
  readonly savedVersion?: boolean;
  readonly message?: string;
}

export class WorkbenchStore {
  snapshot: WorkspaceSnapshot = { projects: [] };
  projectId = "";
  documentId = "";
  loading = false;
  composing = false;
  editSequence = 0;
  editorBase: EditorBaseline | undefined;
  activeTab: PipelineTab = "flow";
  diffMode: DiffMode = "side-by-side";
  noticeState: NoticeState = { message: "", isError: false };

  readonly vault: DraftVault;
  private readonly listeners = new Set<() => void>();
  private loadSequence = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private editorGetter: () => string = () => "";
  private editorSetter: (value: string) => void = () => {};

  constructor() {
    this.vault = new DraftVault(() => {
      this.setNotice("浏览器暂时无法保留本地草稿。请保存正文后再离开。", true);
    });
  }

  bindEditor(getter: () => string, setter: (value: string) => void): void {
    this.editorGetter = getter;
    this.editorSetter = setter;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) listener();
  }

  setNotice(message: string, isError = false, diagnosticId?: string): void {
    this.noticeState = { message, isError, diagnosticId };
    this.notify();
  }

  setActiveTab(tab: PipelineTab): void {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    this.notify();
  }

  setDiffMode(mode: DiffMode): void {
    if (this.diffMode === mode) return;
    this.diffMode = mode;
    this.notify();
  }

  stashCurrentEditor(): void {
    this.vault.stashFromEditor(this.editorBase, this.editorGetter());
  }

  isEditorDirty(): boolean {
    return this.vault.isDirty(this.editorBase, this.editorGetter());
  }

  candidateRun(): RunSummaryView | undefined {
    return this.snapshot.runs?.find((run) => run.state === "awaiting-author");
  }

  uncertainRun(): RunSummaryView | undefined {
    return this.snapshot.runs?.find((run) => run.generationState === "uncertain");
  }

  currentRun(): RunSummaryView | undefined {
    return this.snapshot.runs?.find((run) => run.state === "running");
  }

  activeInput(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      documentId: this.documentId,
      baseRevisionId: this.editorBase?.revisionId ?? null,
      ...extra,
    };
  }

  async perform<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.loading) return undefined;
    this.loading = true;
    this.setNotice("");
    try {
      return await work();
    } catch (error: unknown) {
      if (error instanceof WorkbenchApiError) {
        this.setNotice(error.message, true, error.diagnosticId);
      } else if (error instanceof Error) {
        this.setNotice(error.message, true);
      } else {
        this.setNotice("操作失败，请重试。", true);
      }
      return undefined;
    } finally {
      this.loading = false;
      this.notify();
    }
  }

  async load(ifSequence?: number): Promise<void> {
    const sequence = ++this.loadSequence;
    const selectedProject = this.projectId;
    const selectedDocument = this.documentId;
    const next = await fetchWorkspaceState(selectedProject, selectedDocument, ifSequence);
    if (
      sequence !== this.loadSequence ||
      selectedProject !== this.projectId ||
      selectedDocument !== this.documentId
    ) {
      return;
    }
    if (!next || (!("projects" in next) && !("unchanged" in next))) {
      throw new Error("工作台响应格式有误，请刷新后重试。");
    }
    if ("unchanged" in next && next.unchanged) return;

    this.stashCurrentEditor();
    const nextSnapshot = next as WorkspaceSnapshot;
    if (this.pollTimer && nextSnapshot.active?.id !== this.snapshot.active?.id) {
      this.stopPolling();
    }
    this.snapshot = nextSnapshot;
    this.editorBase = nextSnapshot.active
      ? {
          id: nextSnapshot.active.id,
          revisionId: nextSnapshot.active.revisionId,
          body: nextSnapshot.active.body ?? "",
        }
      : undefined;

    this.syncPolling();
    this.notify();
  }

  async mutate<T = unknown>(action: WorkspaceAction, input: Record<string, unknown>): Promise<T> {
    return mutateWorkspace<T>(action, input, this.projectId, this.documentId);
  }

  async change<T = Record<string, unknown>>(
    action: WorkspaceAction,
    extra: Record<string, unknown> = {},
    options: ChangeOptions = {},
  ): Promise<T> {
    if (options.savedVersion && this.isEditorDirty()) {
      throw new Error("请先保存正文，或复制本地稿后切回已保存版本。");
    }
    const submittedSequence = this.editSequence;
    const committedBody =
      action === "candidate.adopt"
        ? (this.candidateRun()?.candidateBody ?? "")
        : typeof extra.body === "string"
          ? extra.body
          : this.editorGetter();
    this.stashCurrentEditor();

    const result = await this.mutate<T>(action, this.activeInput(extra));
    if (options.clearDraft && this.editorBase) {
      const id = this.editorBase.id;
      const nextRevisionId =
        typeof (result as { revisionId?: unknown })?.revisionId === "string"
          ? ((result as { revisionId: string }).revisionId)
          : null;
      this.editorBase = { id, revisionId: nextRevisionId, body: committedBody };
      if (this.editSequence === submittedSequence && !this.composing && this.editorGetter() !== committedBody) {
        this.editorSetter(committedBody);
      }
      const currentValue = this.editorGetter();
      const remaining = currentValue === committedBody ? null : { body: currentValue, revisionId: nextRevisionId };
      this.vault.write(id, remaining);
    }
    await this.load();
    if (!this.vault.storageUnavailable) {
      this.setNotice(options.message ?? "已保存");
    }
    return result;
  }

  syncPolling(): void {
    const run = this.currentRun() ?? this.uncertainRun() ?? this.snapshot.runs?.[0];
    const shouldPoll =
      run?.state === "running" &&
      run.generationState !== null &&
      ["prepared", "inflight", "received"].includes(run.generationState);

    if (!this.pollTimer && shouldPoll) {
      this.pollTimer = setInterval(() => {
        if (!document.hidden && !this.composing) {
          void this.perform(() => this.load(this.snapshot.asOfSeq));
        }
      }, 2000);
    } else if (this.pollTimer && !shouldPoll) {
      this.stopPolling();
    }
  }

  stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}
