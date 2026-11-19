import type { Product, WorkspaceSnapshot } from "../../../contracts/workspace-dto.ts";
import type { ModalController } from "../modal.ts";

export type PipelineTabId = "workflow" | "planning" | "continuity" | "runs";

export interface ShellStateView {
  readonly projectId: string;
  readonly documentId: string;
  readonly snapshot: WorkspaceSnapshot;
  readonly composing: boolean;
}

export interface WorkbenchShellHost {
  getState(): ShellStateView;
  readEditorValue(): string;
  isDirty(): boolean;
  stashEditor(): void;
  perform(work: () => Promise<unknown> | void): Promise<void>;
  load(ifSequence?: number): Promise<void>;
  change<T = Record<string, unknown>>(
    action: string,
    extra?: Record<string, unknown>,
    options?: { clearDraft?: boolean; savedVersion?: boolean; message?: string },
  ): Promise<T>;
  request<T>(action?: string, input?: Record<string, unknown>, ifSequence?: number): Promise<T>;
  notice(message: string, isError?: boolean): void;
  bindForm(
    id: string,
    submit: (values: Record<string, string>, form: HTMLFormElement) => Promise<unknown> | void,
  ): void;
  bindClick(id: string, handler: () => Promise<unknown> | void): void;
  readonly modal: ModalController;
}

export interface ProductLineUiSession {
  /** Called whenever directory/project metadata refreshes in the left sidebar. */
  onDirectoryUpdated?(isActiveProject: boolean, projectId: string, snapshot: WorkspaceSnapshot): void;
  /** Called right before switching away to another document. */
  onDocumentSelected?(): void;
  /** Slot 1: new-document dialog options for this product line. */
  onCreateDocumentFormChanged?(isActiveProject: boolean): void;
  /** Slots 2, 3 & 4: render product-specific header, pipeline panels, and run extras. */
  renderDocumentSlots(isActiveProduct: boolean, snapshot: WorkspaceSnapshot): void;
  /** Optional product-specific validation/payload when previewing or starting a run. */
  validateRunStartParams?(form: HTMLFormElement): boolean;
  collectRunStartParams?(form: HTMLFormElement): Record<string, unknown>;
}

export interface ProductLineUiModule {
  readonly id: Product;
  readonly displayName: string;
  readonly lockedStates: readonly string[];
  readonly stateLabels: Readonly<Record<string, string>>;
  readonly visibleTabs: readonly PipelineTabId[];
  documentTypeLabel(snapshot: WorkspaceSnapshot): string;
  wordCountHint(snapshot: WorkspaceSnapshot): string;
  mount(host: WorkbenchShellHost): ProductLineUiSession;
}
