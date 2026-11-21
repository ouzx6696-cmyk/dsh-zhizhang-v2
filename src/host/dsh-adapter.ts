import type { DsHConfigFormRegistrar } from "./settings.ts";
import type { LlmTransport } from "./writing.ts";

/**
 * The only module allowed to describe the DeepSeek Harness (DsH) plugin API
 * surface (DSH-14). Everything else in `src/host/` depends on the narrow,
 * locally declared interfaces below instead of the upstream package.
 *
 * IMPORTANT: these shapes are inferred from the public DsH 0.2.x plugin docs
 * and have NOT been verified against a recorded isolated-profile session yet
 * (open author decision #5). Treat any mismatch as an adapter bug: fix it here
 * and keep the rest of the host layer untouched.
 */

export type Disposer = () => void | Promise<void>;

/** `ctx.connection.fetch.register` payload. `auth` is forwarded but never assumed. */
export interface HostRouteRegistration {
  readonly path: string;
  readonly methods: readonly ("GET" | "POST")[];
  readonly requestBody: "buffered" | "streaming";
  readonly auth?: "required" | "optional" | "none";
  readonly fetch: (request: Request, peer?: unknown) => Promise<Response>;
}

export interface HostRouteRegistrar {
  register(route: HostRouteRegistration): Disposer;
}

/** `ctx.connection` is the router facade; only `fetch.register` is used. */
export interface HostConnection {
  readonly fetch: HostRouteRegistrar;
}

export interface HostLogger {
  error(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  info?(message: string, details?: Record<string, unknown>): void;
}

/** `tools.register` accepts the upstream tool shape produced by the tools adapter. */
export interface HostToolRegistrar<TTool = unknown> {
  register(tool: TTool): Disposer;
}

/**
 * Cordis-style plugin context. `get`/`inject` are optional on purpose: older
 * hosts only expose services as properties, and both paths must keep working.
 */
export interface DsHPluginContext {
  readonly connection: HostConnection;
  readonly llm: LlmTransport;
  readonly logger: HostLogger;
  readonly tools?: HostToolRegistrar;
  readonly configForms?: DsHConfigFormRegistrar;
  get?<T = unknown>(name: string): T | undefined;
  inject?(deps: readonly string[], callback: (sub: DsHPluginContext) => void): Disposer | void;
  effect(setup: () => Disposer, name: string): void;
}

export type HostServiceName = "connection" | "llm" | "tools" | "configForms";

export interface HostServiceContract {
  readonly name: HostServiceName;
  readonly required: boolean;
  readonly purpose: string;
  readonly source: string;
}

/**
 * One row per host service, mirrored in `docs/03-architecture.md`.
 * Required services go into `inject`; optional ones are resolved lazily through
 * `ctx.get(name)` and mounted in their own `ctx.inject([...])` sub-scope.
 */
export const HOST_SERVICE_CONTRACTS: readonly HostServiceContract[] = [
  {
    name: "connection",
    required: true,
    purpose: "注册 /api/zhizhang/* HTTP 路由",
    source: "DsH 0.2.x plugin docs · ctx.connection.fetch.register",
  },
  {
    name: "llm",
    required: true,
    purpose: "生成候选稿、提案与微改写所需的流式模型调用",
    source: "DsH 0.2.x plugin docs · ctx.llm.prepareCall",
  },
  {
    name: "tools",
    required: false,
    purpose: "注册 7 个只读工具与 3 个提案工具",
    source: "DsH 0.2.x plugin docs · ctx.tools.register（未录制）",
  },
  {
    name: "configForms",
    required: false,
    purpose: "注册插件设置表单",
    source: "DsH 0.2.x plugin docs · ctx.configForms.register（未录制）",
  },
];

/** Declared in the plugin module as Cordis `inject`; must list required services only. */
export const HOST_REQUIRED_SERVICES = ["connection", "llm"] as const;

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error === "string" ? error : "UnknownError";
}

/**
 * Resolves a service the Cordis way: `ctx.get(name)` first, then the legacy
 * property. A host that implements neither simply yields `undefined`, which
 * callers treat as "optional service unavailable".
 */
export function getHostService<T>(ctx: DsHPluginContext, name: HostServiceName): T | undefined {
  if (typeof ctx.get === "function") {
    const resolved = ctx.get<T>(name);
    if (resolved !== undefined) return resolved;
  }
  const legacy = (ctx as unknown as Record<string, unknown>)[name];
  return legacy === undefined ? undefined : (legacy as T);
}

export function registerHostRoute(ctx: DsHPluginContext, route: HostRouteRegistration): Disposer {
  return ctx.connection.fetch.register(route);
}

function combineDisposers(disposers: readonly Disposer[]): Disposer {
  return async () => {
    for (const dispose of [...disposers].reverse()) {
      try {
        await dispose();
      } catch {
        // A failed sub-disposer must never abort the remaining teardown.
      }
    }
  };
}

/**
 * Mounts optional-service registrations without ever breaking plugin startup:
 * failures are reported through `onError` and the workbench routes stay alive.
 *
 * With `ctx.inject` present the registration lives in its own sub-scope, so it
 * follows the service across hot reload (Cordis semantics). Otherwise it runs
 * inline and returns the disposers for the caller's parent effect.
 */
export function runInServiceScope(
  ctx: DsHPluginContext,
  deps: readonly HostServiceName[],
  effectName: string,
  setup: (scoped: DsHPluginContext) => Disposer[],
  onError?: (error: unknown) => void,
): Disposer[] {
  const guarded = (scoped: DsHPluginContext): Disposer[] => {
    try {
      return setup(scoped);
    } catch (error) {
      onError?.(error);
      return [];
    }
  };

  if (typeof ctx.inject === "function") {
    try {
      const disposeScope = ctx.inject([...deps], (sub) => {
        sub.effect(() => combineDisposers(guarded(sub)), effectName);
      });
      // Cordis returns a scope disposer; without collecting it the parent
      // effect never tears down the sub-scope on hot reload, leaving ten tools
      // registered against a dead service.
      return typeof disposeScope === "function" ? [disposeScope] : [];
    } catch (error) {
      onError?.(error);
      return [];
    }
  }

  return guarded(ctx);
}
