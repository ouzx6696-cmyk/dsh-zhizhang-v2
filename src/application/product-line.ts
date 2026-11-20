import type { SqliteDatabase } from "../storage/index.ts";
import type { DocumentStatusWord, Product } from "../contracts/workspace-dto.ts";
import type { AuthorReadUnitFactory } from "../workflow/author-reads.ts";
import type { SingleShotLlmCaller } from "../workflow/writing-stages.ts";
import type { DocumentRow, Input, WorkspaceContext } from "./context.ts";

export interface ActionDefinition {
  readonly scope: "global" | "project" | "document";
  readonly handler: (ctx: WorkspaceContext, input: Input, row?: DocumentRow) => unknown;
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
  contributeSnapshot(
    ctx: WorkspaceContext,
    projectId: string,
    active: DocumentRow | undefined,
  ): Record<string, unknown>;

  readonly readModels: Readonly<Record<string, AuthorReadUnitFactory>>;
  onStartupRecover?(ctx: WorkspaceContext): void;
}

export interface ProductLineRegistry {
  get(product: string): ProductLineModule | undefined;
  require(product: Product): ProductLineModule;
  all(): readonly ProductLineModule[];
  isLockedState(product: string, state: string): boolean;
  resolveAction(action: string): ActionDefinition | undefined;
  collectReadModels(): Readonly<Record<string, AuthorReadUnitFactory>>;
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
  };
}
