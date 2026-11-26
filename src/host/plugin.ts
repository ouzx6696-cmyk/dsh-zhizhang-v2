import Schema from "@deepseek-ai/schemastery";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ContractError } from "../contracts/index.ts";
import { CLIENT_ENTRY_CSS, CLIENT_ENTRY_HTML, CLIENT_JS_MODULES } from "../client/manifest.ts";
import {
  configureStorePragmas,
  createStore,
  openStore,
  pruneCommandJournal,
  sanitizePathSegment,
  writeLocalBundleToDir,
} from "../storage/index.ts";
import { writeDeliveryFile } from "./delivery-io.ts";
import {
  describeError,
  getHostService,
  HOST_REQUIRED_SERVICES,
  registerHostRoute,
  runInServiceScope,
  type Disposer,
  type DsHPluginContext,
  type HostSystemPromptRegistrar,
  type HostToolRegistrar,
} from "./dsh-adapter.ts";
import { createHostJobEngine } from "./job-engine.ts";
import { buildSanitizedDiagnostics, DEFAULT_MODEL_ROUTE } from "./settings.ts";
import { registerZhizhangSystemPrompt } from "./system-prompt.ts";
import { registerZhizhangTools, type ZhizhangAgentToolDefinition } from "./tools.ts";
import { openAuthorWorkspace } from "./workspace.ts";

export type { DsHPluginContext } from "./dsh-adapter.ts";

export interface DsHPluginConfig {
  readonly dataDirectory: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly enableAgentTools?: boolean;
  /** Test/ops override for the shutdown drain budget before forced abort. */
  readonly shutdownDrainMs?: number;
}

export const Config = Schema.object({
  dataDirectory: Schema.string().required().description("织章工作区目录"),
  defaultProvider: Schema.string().default(DEFAULT_MODEL_ROUTE.provider).description("后台作业默认提供方"),
  defaultModel: Schema.string().default(DEFAULT_MODEL_ROUTE.model).description("后台作业默认模型"),
  enableAgentTools: Schema.boolean().default(true).description("启用 DsH 会话中的织章工具"),
});

export interface WorkbenchPluginDeps {
  readonly readAsset?: (kind: "html" | "css" | "js", path: string) => Uint8Array;
}

/**
 * Cordis plugin identifier and required host services.
 */
export const name = "zhizhang-workbench";
export const inject = HOST_REQUIRED_SERVICES;

const BASE_PATH = "/api/zhizhang";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const SHUTDOWN_DRAIN_MS = 15_000;
const JOURNAL_PRUNE_INTERVAL_MS = 6 * 60 * 60_000;
const CSP_HEADER = "default-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'";

function defaultReadAsset(kind: "html" | "css" | "js", path: string): Uint8Array {
  const candidates = kind === "js"
    ? [
        new URL(`../../client/${path}`, import.meta.url),
        new URL(`../../dist/client/${path}`, import.meta.url),
      ]
    : [
        new URL(`../client/${path}`, import.meta.url),
        new URL(`../../../src/client/${path}`, import.meta.url),
      ];
  const resolved = candidates.find((url) => existsSync(url)) ?? candidates[0];
  return readFileSync(resolved);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function staticResponse(content: Uint8Array, mimeType: string): Response {
  return new Response(content, {
    headers: {
      "Content-Type": `${mimeType}; charset=utf-8`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": CSP_HEADER,
      "Cache-Control": "no-store",
    },
  });
}

function handleRouteError(error: unknown, logger: DsHPluginContext["logger"]): Response {
  if (error instanceof ContractError) {
    const status = error.code === "input.not_found" ? 404 : error.code === "input.invalid" ? 400 : 409;
    return json({ ok: false, ...error.toEnvelope() }, status);
  }
  const diagnosticId = randomUUID();
  const name = error instanceof Error ? error.name : "UnknownError";
  logger.error("zhizhang: request failed", { diagnosticId, name });
  return json({ ok: false, code: "internal.error", diagnosticId }, 500);
}

async function requestObject(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    throw new ContractError("input.invalid", { field: "content-type", reason: "expected-json" });
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request.body ?? []) {
    length += chunk.byteLength;
    if (length > MAX_REQUEST_BYTES) {
      throw new ContractError("input.invalid", { field: "body", reason: "too-large" });
    }
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    throw new ContractError("input.invalid", { field: "body", reason: "invalid-json" });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError("input.invalid", { field: "body", reason: "expected-object" });
  }
  return value as Record<string, unknown>;
}

/**
 * Registers the DsH Workbench plugin:
 * - Static workbench UI & client ESM assets
 * - Clean HTTP API under `/api/zhizhang`:
 *   - `GET  /state`        — project/document snapshot with ETag-like `ifSequence`
 *   - `GET  /jobs`         — unified async job ledger feed
 *   - `GET  /diag`         — sanitized operational diagnostics
 *   - `POST /command`      — synchronous author mutations
 *   - `POST /jobs/preview` — zero-token budget & frozen context preview
 *   - `POST /jobs/start`   — unified LLM job launcher (`draft_generation` | `proposal_extraction` | `selection_rewrite`)
 *   - `POST /jobs/cancel`  — unified LLM job cancellation
 */
export function applyWorkbench(
  ctx: DsHPluginContext,
  config: DsHPluginConfig,
  deps?: WorkbenchPluginDeps,
): void {
  if (typeof config.dataDirectory !== "string" || !config.dataDirectory) {
    throw new Error("织章缺少 dataDirectory");
  }
  const readAsset = deps?.readAsset ?? defaultReadAsset;
  const drainMs = Number.isFinite(config.shutdownDrainMs) && (config.shutdownDrainMs ?? 0) >= 0
    ? config.shutdownDrainMs!
    : SHUTDOWN_DRAIN_MS;

  ctx.effect(() => {
    mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
    const exportsDir = join(config.dataDirectory, "deliveries");
    mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
    const database = join(config.dataDirectory, "workspace.sqlite");
    if (!existsSync(database)) createStore(database);
    const db = openStore(database);
    const disposers: Disposer[] = [];
    let accepting = true;
    let dbOpen = true;
    let journalTimer: ReturnType<typeof setInterval> | undefined;
    let shutdownEngine: (() => Promise<void>) = async () => {};
    let recoverOnClose: () => void = () => {};

    try {
      configureStorePragmas(db, false);
      const bundleExportsRoot = join(config.dataDirectory, "exports");
      const workspace = openAuthorWorkspace(
        db,
        (id, contents) => writeDeliveryFile(exportsDir, id, contents),
        (projectId, files) =>
          writeLocalBundleToDir(join(bundleExportsRoot, sanitizePathSegment(projectId)), files).writtenDir,
      );
      const engine = createHostJobEngine({
        workspace,
        llm: ctx.llm,
        logger: ctx.logger,
        isDbOpen: () => dbOpen,
      });
      shutdownEngine = () => engine.shutdownDrain(drainMs);
      recoverOnClose = () => {
        try {
          workspace.recoverJobs();
        } catch (error) {
          ctx.logger.error("zhizhang: shutdown recovery failed", { reason: describeError(error) });
        }
      };

      workspace.recoverStartup();

      const pruneJournal = () => {
        if (!dbOpen) return;
        try {
          pruneCommandJournal(db);
        } catch (error) {
          ctx.logger.error("zhizhang: command journal prune failed", { reason: describeError(error) });
        }
      };
      pruneJournal();
      journalTimer = setInterval(pruneJournal, JOURNAL_PRUNE_INTERVAL_MS) as unknown as ReturnType<typeof setInterval>;
      (journalTimer as unknown as { unref?: () => void }).unref?.();

      const route = (
        path: string,
        methods: readonly ("GET" | "POST")[],
        fetch: (request: Request) => Promise<Response>,
      ) => {
        disposers.push(
          registerHostRoute(ctx, {
            path: BASE_PATH + path,
            methods,
            requestBody: methods.includes("GET") ? "buffered" : "streaming",
            fetch,
          }),
        );
      };

      const htmlBytes = readAsset("html", CLIENT_ENTRY_HTML);
      const cssBytes = readAsset("css", CLIENT_ENTRY_CSS);
      route("/workbench", ["GET"], async () => staticResponse(htmlBytes, "text/html"));
      route("/workbench.css", ["GET"], async () => staticResponse(cssBytes, "text/css"));

      for (const modulePath of CLIENT_JS_MODULES) {
        const bytes = readAsset("js", modulePath);
        route(`/${modulePath}`, ["GET"], async () => staticResponse(bytes, "text/javascript"));
      }

      const agentToolsEnabled = config.enableAgentTools ?? true;
      let agentToolsRegistered = false;
      let agentToolCount = 0;
      let agentToolsError: string | null = null;
      let systemPromptRegistered = false;
      let systemPromptError: string | null = null;
      if (agentToolsEnabled) {
        disposers.push(
          ...runInServiceScope(
            ctx,
            ["tools"],
            "zhizhang: agent tools",
            (scoped) => {
              const registrar = getHostService<HostToolRegistrar<ZhizhangAgentToolDefinition>>(scoped, "tools");
              if (!registrar) return [];
              const registered = registerZhizhangTools(registrar, workspace, true);
              agentToolsRegistered = registered.length > 0;
              agentToolCount = registered.length;
              return registered;
            },
            (error) => {
              agentToolsError = describeError(error);
              ctx.logger.error("zhizhang: agent tool registration failed", { reason: agentToolsError });
            },
          ),
        );
        disposers.push(
          ...runInServiceScope(
            ctx,
            ["systemPrompt"],
            "zhizhang: system prompt",
            (scoped) => {
              const registrar = getHostService<HostSystemPromptRegistrar>(scoped, "systemPrompt");
              if (!registrar) return [];
              const registered = registerZhizhangSystemPrompt(registrar, workspace, true);
              systemPromptRegistered = registered.length > 0;
              return registered;
            },
            (error) => {
              systemPromptError = describeError(error);
              ctx.logger.error("zhizhang: system prompt registration failed", { reason: systemPromptError });
            },
          ),
        );
      }
      const defaults = {
        provider: config.defaultProvider ?? DEFAULT_MODEL_ROUTE.provider,
        model: config.defaultModel ?? DEFAULT_MODEL_ROUTE.model,
      };
      const withModelRoute = (input: Record<string, unknown>) => ({
        ...input,
        provider: typeof input.provider === "string" && input.provider.trim() ? input.provider : defaults.provider,
        model: typeof input.model === "string" && input.model.trim() ? input.model : defaults.model,
      });
      route("/settings", ["GET"], async () => json({ ok: true, result: { ...defaults, agentToolsEnabled } }));

      route("/diag", ["GET"], async () => {
        if (!accepting) return new Response(null, { status: 503 });
        try {
          const report = buildSanitizedDiagnostics(db, {
            activeJobs: engine.activeCounts(),
            usageConsistencyIssues: workspace.verifyUsageConsistency().length,
            agentToolsEnabled,
            agentToolsRegistered,
            agentToolCount,
            agentToolsError,
            systemPromptRegistered,
            systemPromptError,
          });
          return json({ ok: true, result: report });
        } catch (error) {
          return handleRouteError(error, ctx.logger);
        }
      });

      route("/state", ["GET"], async (request) => {
        if (!accepting || request.signal.aborted) return new Response(null, { status: 503 });
        try {
          const query = new URL(request.url).searchParams;
          const result = workspace.readState(
            query.get("projectId") ?? undefined,
            query.get("documentId") ?? undefined,
            query.get("ifSequence") ?? undefined,
          );
          return json({ ok: true, result });
        } catch (error) {
          return handleRouteError(error, ctx.logger);
        }
      });

      route("/jobs", ["GET"], async (request) => {
        if (!accepting || request.signal.aborted) return new Response(null, { status: 503 });
        try {
          const query = new URL(request.url).searchParams;
          const limitRaw = query.get("limit");
          const result = workspace.listJobs({
            ...(query.get("projectId") ? { projectId: query.get("projectId")! } : {}),
            ...(query.get("documentId") ? { documentId: query.get("documentId")! } : {}),
            ...(query.get("kind") ? { kind: query.get("kind")! } : {}),
            ...(limitRaw !== null ? { limit: Number(limitRaw) } : {}),
          });
          return json({ ok: true, result });
        } catch (error) {
          return handleRouteError(error, ctx.logger);
        }
      });

      route("/jobs/preview", ["POST"], async (request) => {
        try {
          const body = await requestObject(request);
          if (!accepting || request.signal.aborted) return new Response(null, { status: 503 });
          const result = workspace.mutation("run.preview", body);
          return json({ ok: true, result });
        } catch (error) {
          return handleRouteError(error, ctx.logger);
        }
      });

      route("/jobs/start", ["POST"], async (request) => {
        try {
          const { kind, ...input } = await requestObject(request);
          if (!accepting || request.signal.aborted) return new Response(null, { status: 503 });
          if (kind === "draft_generation") {
            return json({ ok: true, result: engine.startDraftGeneration(withModelRoute(input)) }, 202);
          }
          if (kind === "proposal_extraction") {
            return json({ ok: true, result: engine.startProposalExtraction(withModelRoute(input)) }, 202);
          }
          if (kind === "selection_rewrite") {
            const result = await engine.runSelectionRewrite(withModelRoute(input), request.signal);
            return json({ ok: true, result });
          }
          if (kind === "autopilot_pipeline") {
            return json({ ok: true, result: engine.startAutopilotPipeline(withModelRoute(input)) }, 202);
          }
          if (kind === "material_normalize") {
            return json({ ok: true, result: engine.startMaterialNormalize(withModelRoute(input)) }, 202);
          }
          throw new ContractError("input.invalid", { field: "kind", reason: "unknown-job-kind" });
        } catch (error) {
          return handleRouteError(error, ctx.logger);
        }
      });

      route("/jobs/cancel", ["POST"], async (request) => {
        try {
          const body = await requestObject(request);
          if (!accepting || request.signal.aborted) return new Response(null, { status: 503 });
          const result = engine.cancelJob(body);
          return json({ ok: true, result });
        } catch (error) {
          return handleRouteError(error, ctx.logger);
        }
      });

      route("/command", ["POST"], async (request) => {
        try {
          const { action, ...input } = await requestObject(request);
          if (typeof action !== "string") {
            throw new ContractError("input.invalid", { field: "action", reason: "required" });
          }
          if (!accepting || request.signal.aborted) return new Response(null, { status: 503 });
          if (action === "run.complete" && typeof input.runId === "string" && engine.hasActiveRun(input.runId)) {
            throw new ContractError("gate.denied", { action, reason: "generation-in-progress" });
          }
          const result = workspace.mutation(action, input);
          if (action === "run.cancel" && typeof input.runId === "string") {
            engine.abortRun(input.runId);
          }
          if (action === "autopilot.pause" && typeof input.batchId === "string") {
            engine.abortAutopilot(input.batchId.trim());
          }
          return json({ ok: true, result });
        } catch (error) {
          return handleRouteError(error, ctx.logger);
        }
      });
    } catch (error) {
      accepting = false;
      dbOpen = false;
      if (journalTimer !== undefined) clearInterval(journalTimer);
      for (const dispose of [...disposers].reverse()) {
        void Promise.resolve().then(dispose).catch((cause) =>
          ctx.logger.error("zhizhang: startup cleanup failed", { reason: describeError(cause) }));
      }
      db.close();
      throw error;
    }

    return async () => {
      accepting = false;
      if (journalTimer !== undefined) clearInterval(journalTimer);
      try {
        const disposed = await Promise.allSettled(disposers.map(async (dispose) => dispose()));
        for (const result of disposed) {
          if (result.status === "rejected") {
            ctx.logger.error("zhizhang: disposer failed", { reason: describeError(result.reason) });
          }
        }
        await shutdownEngine();
        recoverOnClose();
      } finally {
        dbOpen = false;
        db.close();
      }
    };
  }, "zhizhang: author workbench");
}

export function apply(ctx: DsHPluginContext, config: DsHPluginConfig): void {
  applyWorkbench(ctx, config);
}
