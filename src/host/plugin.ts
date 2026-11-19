import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ContractError } from "../contracts/index.ts";
import { CLIENT_ENTRY_CSS, CLIENT_ENTRY_HTML, CLIENT_JS_MODULES } from "../client/manifest.ts";
import { createStore, openStore } from "../storage/index.ts";
import { executeGenerationWithRunner, type LlmTransport } from "./writing.ts";
import { openAuthorWorkspace } from "./workspace.ts";

export interface DsHPluginConfig {
  readonly dataDirectory: string;
}

interface DsHRouteRegistration {
  readonly path: string;
  readonly methods: readonly ("GET" | "POST")[];
  readonly requestBody: "buffered" | "streaming";
  readonly fetch: (request: Request) => Promise<Response>;
}

export interface DsHPluginContext {
  readonly connection: {
    readonly fetch: {
      register(route: DsHRouteRegistration): () => void | Promise<void>;
    };
  };
  readonly llm: LlmTransport;
  readonly logger: {
    error(message: string, details?: Record<string, unknown>): void;
  };
  effect(setup: () => () => Promise<void> | void, name: string): void;
}

export interface WorkbenchPluginDeps {
  readonly readAsset?: (kind: "html" | "css" | "js", path: string) => Uint8Array;
}

export const inject = ["connection", "llm"] as const;

const BASE_PATH = "/api/zhizhang";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const CSP_HEADER = "default-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'";

function defaultReadAsset(kind: "html" | "css" | "js", path: string): Uint8Array {
  const url = kind === "js"
    ? new URL(`../client/${path}`, import.meta.url)
    : new URL(`../../src/client/${path}`, import.meta.url);
  return readFileSync(url);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function staticResponse(content: Uint8Array, mimeType: string): Response {
  return new Response(content, {
    headers: {
      "Content-Type": `${mimeType}; charset=utf-8`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": CSP_HEADER,
      "Cache-Control": "no-store",
    },
  });
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

function writeDelivery(directory: string, id: string, contents: string): void {
  const path = join(directory, `${id}.md`);
  if (existsSync(path) && readFileSync(path, "utf8") === contents) return;
  const pending = join(directory, `.${id}.${randomUUID()}.tmp`);
  writeFileSync(pending, contents, { mode: 0o600, flag: "wx", flush: true });
  try {
    // Publish atomically without replacing an author's existing file.
    linkSync(pending, path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "EEXIST") throw error;
    if (readFileSync(path, "utf8") !== contents) {
      throw Object.assign(new Error("Delivery file already exists"), {
        code: "export.conflict",
        retryable: false,
      });
    }
  } finally {
    unlinkSync(pending);
  }
}

export function applyWorkbench(
  ctx: DsHPluginContext,
  config: DsHPluginConfig,
  deps?: WorkbenchPluginDeps,
): void {
  if (typeof config.dataDirectory !== "string" || !config.dataDirectory) {
    throw new Error("织章缺少 dataDirectory");
  }
  const readAsset = deps?.readAsset ?? defaultReadAsset;
  ctx.effect(() => {
    mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
    const exportsDir = join(config.dataDirectory, "deliveries");
    mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
    const database = join(config.dataDirectory, "workspace.sqlite");
    if (!existsSync(database)) createStore(database);
    const db = openStore(database);
    const disposers: (() => void | Promise<void>)[] = [];
    const generations = new Map<string, { controller: AbortController; task: Promise<void> }>();
    let closing = false;
    let workspaceOnClose: () => void = () => {};

    try {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA busy_timeout = 5000;");
      const workspace = openAuthorWorkspace(db, (id, contents) => writeDelivery(exportsDir, id, contents));
      workspaceOnClose = workspace.recoverGenerations;
      workspace.recoverGenerations();
      workspace.recoverStartup();

      const route = (
        path: string,
        methods: readonly ("GET" | "POST")[],
        fetch: (request: Request) => Promise<Response>,
      ) => {
        disposers.push(
          ctx.connection.fetch.register({
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

      route("/state", ["GET"], async (request) => {
        const query = new URL(request.url).searchParams;
        const result = workspace.readState(
          query.get("projectId") ?? undefined,
          query.get("documentId") ?? undefined,
          query.get("ifSequence") ?? undefined,
        );
        return json({ ok: true, result });
      });

      route("/mutate", ["POST"], async (request) => {
        try {
          const { action, ...input } = await requestObject(request);
          if (typeof action !== "string") {
            throw new ContractError("input.invalid", { field: "action", reason: "required" });
          }
          if (closing || request.signal.aborted) return new Response(null, { status: 503 });

          if (action === "run.generate") {
            const runId = typeof input.runId === "string" ? input.runId : "";
            if (runId && generations.has(runId)) {
              throw new ContractError("gate.denied", { action, reason: "generation-in-progress" });
            }
            const run = workspace.generationInput(input, true);
            const attemptId = run.attemptId!;
            const controller = new AbortController();
            const task = executeGenerationWithRunner(
              ctx.llm,
              run,
              controller.signal,
              () => {
                controller.signal.throwIfAborted();
                workspace.reserveRefinement(run.id);
              },
              {
                begin(phase, inputReserve, maxOutput) {
                  return workspace.beginGenerationCall(attemptId, phase, inputReserve, maxOutput);
                },
                receive(callId, usage) {
                  if (!closing) workspace.recordGenerationReceipt(attemptId, callId, usage);
                },
              },
              workspace.generationRunner(run.product),
            )
              .then((result) => {
                if (!closing) workspace.finishGeneration(attemptId, { ...result }, null);
              })
              .catch((error: unknown) => {
                if (!closing) {
                  const reason = error instanceof ContractError
                    ? error.code
                    : controller.signal.aborted
                      ? "cancelled"
                      : "generation.failed";
                  workspace.finishGeneration(attemptId, null, reason);
                }
              })
              .finally(() => {
                generations.delete(run.id);
              });
            generations.set(run.id, { controller, task });
            return json({ ok: true, result: { id: run.id, generating: true } }, 202);
          }

          if (action === "run.complete" && typeof input.runId === "string" && generations.has(input.runId)) {
            throw new ContractError("gate.denied", { action, reason: "generation-in-progress" });
          }
          const result = workspace.mutation(action, input);
          if (action === "run.cancel" && typeof input.runId === "string") {
            generations.get(input.runId)?.controller.abort();
          }
          return json({ ok: true, result });
        } catch (error) {
          if (error instanceof ContractError) {
            const status = error.code === "input.not_found" ? 404 : error.code === "input.invalid" ? 400 : 409;
            return json({ ok: false, ...error.toEnvelope() }, status);
          }
          const diagnosticId = randomUUID();
          const name = error instanceof Error ? error.name : "UnknownError";
          ctx.logger.error("zhizhang: request failed", { diagnosticId, name });
          return json({ ok: false, code: "internal.error", diagnosticId }, 500);
        }
      });
    } catch (error) {
      for (const dispose of disposers.reverse()) void dispose();
      db.close();
      throw error;
    }

    return async () => {
      closing = true;
      for (const { controller } of generations.values()) controller.abort();
      await Promise.all(disposers.map((dispose) => dispose()));
      try {
        workspaceOnClose();
      } finally {
        db.close();
      }
    };
  }, "zhizhang: author workbench");
}

export function apply(ctx: DsHPluginContext, config: DsHPluginConfig): void {
  applyWorkbench(ctx, config);
}
