import type { SqliteDatabase } from "../storage/index.ts";
import type {
  AiProposalKind,
  DocumentStatusWord,
  Product,
  SelectionRewriteMode,
} from "../contracts/workspace-dto.ts";
import type { AuthorReadUnitFactory } from "../workflow/author-reads.ts";
import type { LayeredPromptPayload } from "../workflow/cache-layer.ts";
import type { SingleShotLlmCaller, WritingPhase } from "../workflow/writing-stages.ts";
import type { DocumentRow, Input, WorkspaceContext } from "./context.ts";

export interface ActionDefinition {
  readonly scope: "global" | "project" | "document";
  readonly handler: (ctx: WorkspaceContext, input: Input, row?: DocumentRow) => unknown;
}

export interface ProductAgentToolFacade {
  mutation(action: string, input: Record<string, unknown>): unknown;
  snapshot(projectId?: string, documentId?: string): unknown;
}

export interface ProductAgentToolSpec {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly proposalOnly?: boolean;
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
  readonly outputDescription: string;
  readonly execute: (args: Record<string, unknown>) => unknown;
}

export interface GenerationRunnerInput {
  readonly id?: string;
  readonly product?: string;
  readonly attemptId?: string | null;
  readonly provider: string;
  readonly model: string;
  readonly reserved: number;
  readonly autoQa: boolean;
  readonly frozenInput: string;
}

export interface GenerationRunnerOutput {
  readonly body: string;
  readonly tokens: number;
  readonly qa?: unknown;
  readonly rounds?: number;
}

export type ProductGenerationRunner = (deps: {
  readonly caller: SingleShotLlmCaller;
  readonly run: GenerationRunnerInput;
  readonly signal: AbortSignal;
  readonly reserveRefinement: () => void;
}) => Promise<GenerationRunnerOutput>;

export interface ProductLineModule {
  readonly id: Product;
  readonly initialState: DocumentStatusWord;
  readonly lockedStates: readonly DocumentStatusWord[];
  readonly supportsAutoQa: boolean;

  initSchema(db: SqliteDatabase): void;
  validateCreate(input: Input, title: string): {
    readonly title: string;
    readonly mode: string | null;
    readonly line: string | null;
  };
  onDocumentCreated?(ctx: WorkspaceContext, projectId: string, documentId: string, input: Input): void;
  onDraftSaved(ctx: WorkspaceContext, row: DocumentRow): void;

  buildFrozenContext(ctx: WorkspaceContext, row: DocumentRow, input: Input): Record<string, unknown>;
  onCandidateCreated?(
    ctx: WorkspaceContext,
    row: DocumentRow,
    candidateId: string,
    body: string,
    frozenInput: string,
    input: Input,
  ): void;

  readonly runGeneration?: ProductGenerationRunner;
  reserveRefinement?(ctx: WorkspaceContext, runId: string): void;

  readonly actions: Readonly<Record<string, ActionDefinition>>;
  buildActiveContext?(ctx: WorkspaceContext, active: DocumentRow): Record<string, unknown> | null;
  enrichRunSummaries?(
    ctx: WorkspaceContext,
    active: DocumentRow,
    runs: readonly Record<string, unknown>[],
  ): readonly Record<string, unknown>[];
  buildProposalContext?(
    ctx: WorkspaceContext,
    params: {
      readonly kind: AiProposalKind;
      readonly phase: WritingPhase;
      readonly projectId: string | null;
      readonly documentId: string | null;
      readonly sourceText: string;
      readonly sourceRef: string;
      readonly instruction: string;
      readonly input: Input;
    },
  ): {
    readonly sourceText?: string;
    readonly sourceRef?: string;
    readonly extra?: Readonly<Record<string, unknown>>;
    readonly layered?: LayeredPromptPayload;
  };
  buildSelectionContext?(
    ctx: WorkspaceContext,
    row: DocumentRow,
    params: {
      readonly mode: SelectionRewriteMode;
      readonly instruction: string;
      readonly beforeContext: string;
      readonly selectedText: string;
      readonly afterContext: string;
    },
  ): {
    readonly extra?: Readonly<Record<string, unknown>>;
    readonly layered?: LayeredPromptPayload;
  };
  onJobCacheHit?(ctx: WorkspaceContext, projectId: string): void;
  runMaterialNormalize?(
    ctx: WorkspaceContext,
    params: {
      readonly sessionId: string;
      readonly instruction?: string;
      readonly caller: SingleShotLlmCaller;
      readonly signal: AbortSignal;
    },
  ): Promise<unknown>;
  runAutopilotPipeline?(
    ctx: WorkspaceContext,
    params: {
      readonly batchId: string;
      readonly caller: SingleShotLlmCaller;
      readonly signal: AbortSignal;
      readonly saveDraft: (row: DocumentRow, body: string) => { readonly revisionId: string };
      readonly instruction?: string;
      readonly overrideRedLine?: boolean;
    },
  ): Promise<unknown>;
  contributeSnapshot(
    ctx: WorkspaceContext,
    projectId: string,
    active: DocumentRow | undefined,
  ): Record<string, unknown>;

  /** Optional lightweight progressive-disclosure contribution for DsH ctx.systemPrompt. */
  contributeSystemPrompt?(
    ctx: WorkspaceContext,
    projectId: string,
    active: DocumentRow | undefined,
  ): {
    readonly lines: readonly string[];
    readonly mountedSkills?: readonly {
      readonly id: string;
      readonly title: string;
      readonly category: string;
      readonly triggerWhen: string;
      readonly conflictGroup?: string;
      readonly mountedMode?: string | null;
    }[];
    readonly pendingProposalCount?: number;
  };

  /** Optional deterministic zero-token diagnostics returned to DsH Agent after draft submission. */
  diagnoseForAgent?(ctx: WorkspaceContext, row: DocumentRow, body: string): Readonly<Record<string, unknown>> | null;

  /** Optional hook to record technique effectiveness when Agent writes with techniques. */
  onAgentDraftRecorded?(
    ctx: WorkspaceContext,
    row: DocumentRow,
    techniqueIds: readonly string[],
    diagnosticsSummary: Readonly<Record<string, unknown>> | null,
  ): void;

  readonly readModels: Readonly<Record<string, AuthorReadUnitFactory>>;
  readonly agentTools?: (workspace: ProductAgentToolFacade) => readonly ProductAgentToolSpec[];
  onStartupRecover?(ctx: WorkspaceContext): void;
}

export interface ProductLineRegistry {
  get(product: string): ProductLineModule | undefined;
  require(product: Product): ProductLineModule;
  all(): readonly ProductLineModule[];
  isLockedState(product: string, state: string): boolean;
  resolveAction(action: string): ActionDefinition | undefined;
  collectReadModels(): Readonly<Record<string, AuthorReadUnitFactory>>;
  collectAgentTools(workspace: ProductAgentToolFacade): readonly ProductAgentToolSpec[];
}

export function createProductLineRegistry(modules: readonly ProductLineModule[]): ProductLineRegistry {
  const byId = new Map<string, ProductLineModule>();
  const actionMap = new Map<string, ActionDefinition>();
  const readModels: Record<string, AuthorReadUnitFactory> = {};

  for (const mod of modules) {
    if (byId.has(mod.id)) {
      throw new Error(`Duplicate product line module: ${mod.id}`);
    }
    byId.set(mod.id, mod);
    for (const [name, def] of Object.entries(mod.actions)) {
      if (actionMap.has(name)) {
        throw new Error(`Duplicate product action: ${name}`);
      }
      actionMap.set(name, def);
    }
    for (const [modelId, factory] of Object.entries(mod.readModels)) {
      if (Object.hasOwn(readModels, modelId)) {
        throw new Error(`Duplicate read model factory: ${modelId}`);
      }
      readModels[modelId] = factory;
    }
  }

  return {
    get: (product) => byId.get(product),
    require: (product) => {
      const mod = byId.get(product);
      if (!mod) throw new Error(`Unknown product line: ${product}`);
      return mod;
    },
    all: () => [...byId.values()],
    isLockedState: (product, state) => {
      const mod = byId.get(product);
      return mod ? (mod.lockedStates as readonly string[]).includes(state) : false;
    },
    resolveAction: (action) => actionMap.get(action),
    collectReadModels: () => readModels,
    collectAgentTools(workspace) {
      const specs: ProductAgentToolSpec[] = [];
      const seen = new Set<string>();
      for (const mod of byId.values()) {
        for (const tool of mod.agentTools?.(workspace) ?? []) {
          if (seen.has(tool.name)) {
            throw new Error(`Duplicate agent tool: ${tool.name}`);
          }
          seen.add(tool.name);
          specs.push(tool);
        }
      }
      return specs;
    },
  };
}
