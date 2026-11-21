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
import { assertStageOutput, WRITING_STAGE_IDS } from "../workflow/writing-stages.ts";
import { writeDeliveryFile } from "./delivery-io.ts";
import {
  describeError,
  getHostService,
  HOST_REQUIRED_SERVICES,
  registerHostRoute,
  runInServiceScope,
  type Disposer,
  type DsHPluginContext,
  type HostToolRegistrar,
} from "./dsh-adapter.ts";
import { buildSanitizedDiagnostics, registerZhizhangSettings, type DsHConfigFormRegistrar } from "./settings.ts";
import { registerZhizhangTools, type ZhizhangAgentToolDefinition } from "./tools.ts";
import {
  buildRecoveryHints,
  createSingleShotCaller,
  executeGenerationWithRunner,
} from "./writing.ts";
import { openAuthorWorkspace } from "./workspace.ts";

export type { DsHPluginContext } from "./dsh-adapter.ts";

export interface DsHPluginConfig {
  readonly dataDirectory: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly enableAgentTools?: boolean;
  /**
   * Test/ops override for the shutdown drain budget. After it expires the
   * plugin force-aborts and logs, but still waits for late receipts before
   * closing SQLite (DSH-08).
   */
  readonly shutdownDrainMs?: number;
}

export interface WorkbenchPluginDeps {
  readonly readAsset?: (kind: "html" | "css" | "js", path: string) => Uint8Array;
}

/**
 * Cordis `inject`: required services only. `tools` and `configForms` are
 * optional and are resolved lazily through `ctx.get()` in their own sub-scopes
 * (DSH-02), so their absence never blocks the workbench routes.
 */
export const inject = HOST_REQUIRED_SERVICES;

const BASE_PATH = "/api/zhizhang";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/**
 * Decision #8: the drain window was widened from 5s to 15s so that a host
 * unload can still persist receipts and finished results instead of dropping
 * them (DSH-08).
 */
const SHUTDOWN_DRAIN_MS = 15_000;
/** DB-02: journal pruning cadence; the function itself is idempotent. */
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
    const generations = new Map<string, { controller: AbortController; task: Promise<void> }>();
    const proposalJobs = new Map<string, { controller: AbortController; task: Promise<void> }>();
    const microJobs = new Map<string, { controller: AbortController; task: Promise<unknown> }>();
    const proposalLocks = new Set<string>();
    /**
     * `accepting` gates new HTTP work; `dbOpen` gates ledger writes. During the
     * drain window the workbench already rejects new requests but still records
     * receipts/results for work that was in flight (DSH-08).
     */
    let accepting = true;
    let dbOpen = true;
    let journalTimer: ReturnType<typeof setInterval> | undefined;
    let workspaceOnClose: () => void = () => {};

    try {
      configureStorePragmas(db, false);
      const bundleExportsRoot = join(config.dataDirectory, "exports");
      const workspace = openAuthorWorkspace(
        db,
        (id, contents) => writeDeliveryFile(exportsDir, id, contents),
        (projectId, files) =>
          writeLocalBundleToDir(join(bundleExportsRoot, sanitizePathSegment(projectId)), files).writtenDir,
      );
      workspaceOnClose = () => {
        // Each recovery must run even if an earlier one throws; otherwise a
        // failed generation recovery leaves micro calls stuck at inflight.
        for (const recover of [
          () => workspace.recoverGenerations(),
          () => workspace.recoverProposals(),
          () => workspace.recoverMicroCalls(),
        ]) {
          try {
            recover();
          } catch (error) {
            ctx.logger.error("zhizhang: shutdown recovery failed", { reason: describeError(error) });
          }
        }
      };
      workspace.recoverStartup();

      // DB-02: the host owns journal maintenance. Run once at startup, then on a
      // slow interval; failures never block the workbench.
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
      // Never let maintenance hold the host process open.
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
      let agentToolsError: string | null = null;
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
              agentToolsRegistered = true;
              return registered;
            },
            (error) => {
              agentToolsError = describeError(error);
              ctx.logger.error("zhizhang: agent tool registration failed", { reason: agentToolsError });
            },
          ),
        );
      }
      disposers.push(
        ...runInServiceScope(
          ctx,
          ["configForms"],
          "zhizhang: settings form",
          (scoped) => {
            const configForms = getHostService<DsHConfigFormRegistrar>(scoped, "configForms");
            return registerZhizhangSettings(configForms, config);
          },
          (error) => {
            ctx.logger.error("zhizhang: settings form registration failed", { reason: describeError(error) });
          },
        ),
      );

      route("/diag", ["GET"], async () => {
        if (!accepting) return new Response(null, { status: 503 });
        try {
          const report = buildSanitizedDiagnostics(db, {
            activeGenerations: generations.size,
            activeProposals: proposalJobs.size,
            activeMicroCalls: microJobs.size,
            agentToolsEnabled,
            agentToolsRegistered,
            agentToolsError,
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

      route("/mutate", ["POST"], async (request) => {
        try {
          const { action, ...input } = await requestObject(request);
          if (typeof action !== "string") {
            throw new ContractError("input.invalid", { field: "action", reason: "required" });
          }
          if (!accepting || request.signal.aborted) return new Response(null, { status: 503 });

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
                  if (dbOpen) workspace.recordGenerationReceipt(attemptId, callId, usage);
                },
              },
              workspace.generationRunner(run.product),
            )
              .then((result) => {
                if (dbOpen) workspace.finishGeneration(attemptId, { ...result }, null);
              })
              .catch((error: unknown) => {
                if (dbOpen) {
                  const reason = error instanceof ContractError
                    ? error.code
                    : controller.signal.aborted
                      ? "cancelled"
                      : "generation.failed";
                  const recoveryKind = error && typeof error === "object" && "recoveryKind" in error
                    ? (error as { recoveryKind?: string }).recoveryKind
                    : undefined;
                  const recoveryHints = buildRecoveryHints(recoveryKind, reason);
                  workspace.finishGeneration(attemptId, null, reason, recoveryHints);
                }
              })
              .finally(() => {
                generations.delete(run.id);
              });
            generations.set(run.id, { controller, task });
            return json({ ok: true, result: { id: run.id, generating: true } }, 202);
          }

          if (action === "proposal.generate") {
            const kindKey = typeof input.kind === "string" ? input.kind : "";
            const scopeKey = typeof input.documentId === "string"
              ? input.documentId
              : typeof input.projectId === "string"
                ? input.projectId
                : "global";
            const lockKey = `${kindKey}:${scopeKey}`;
            if (proposalLocks.has(lockKey)) {
              throw new ContractError("gate.denied", { action, reason: "proposal-in-progress" });
            }

            const job = workspace.beginProposalGeneration(input);
            proposalLocks.add(lockKey);
            const controller = new AbortController();
            const caller = createSingleShotCaller(
              ctx.llm,
              { provider: job.provider, model: job.model, reserved: job.reserved },
              controller.signal,
              {
                begin() {
                  return job.id;
                },
                receive(_callId, usage) {
                  if (dbOpen) workspace.recordProposalReceipt(job.id, usage);
                },
              },
            );
            const task = caller
              .complete({
                phase: job.phase,
                system: job.system,
                prompt: job.prompt,
                maxOutputTokens: 2400,
                disableThinking: job.disableThinking,
              })
              .then((raw) => {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/giu, ""));
                } catch {
                  throw new ContractError("stage.output_invalid", {
                    stage: WRITING_STAGE_IDS[job.phase],
                    missing: "json",
                  });
                }
                assertStageOutput(WRITING_STAGE_IDS[job.phase], parsed, "json");
                if (dbOpen) {
                  workspace.finishProposalGeneration(job.id, parsed as Record<string, unknown>, null);
                }
              })
              .catch((error: unknown) => {
                if (dbOpen) {
                  const reason = error instanceof ContractError
                    ? error.code
                    : controller.signal.aborted
                      ? "cancelled"
                      : "generation.failed";
                  workspace.finishProposalGeneration(job.id, null, reason);
                }
              })
              .finally(() => {
                proposalJobs.delete(job.id);
                proposalLocks.delete(lockKey);
              });
            proposalJobs.set(job.id, { controller, task });
            return json({ ok: true, result: { id: job.id, kind: job.kind, generating: true } }, 202);
          }

          if (action === "proposal.cancel") {
            const proposalId = typeof input.proposalId === "string" ? input.proposalId.trim() : "";
            if (!proposalId) {
              throw new ContractError("input.invalid", { field: "proposalId", reason: "required" });
            }
            proposalJobs.get(proposalId)?.controller.abort();
            const cancelled = workspace.cancelProposalGeneration(proposalId);
            return json({ ok: true, result: { id: proposalId, cancelled } });
          }

          if (action === "selection.rewrite") {
            const req = workspace.buildSelectionRewriteInput(input);
            // The ledger row is the per-document concurrency lock (DSH-10).
            const job = workspace.beginMicroCall(req);
            const controller = new AbortController();
            const signal = AbortSignal.any([request.signal, controller.signal]);
            const caller = createSingleShotCaller(
              ctx.llm,
              { provider: req.provider, model: req.model, reserved: req.reserved },
              signal,
              {
                begin: () => job.id,
                receive: (_callId, usage) => {
                  if (dbOpen) workspace.recordMicroReceipt(job.id, usage);
                },
              },
            );
            const task = (async () => {
              try {
                const text = (
                  await caller.complete({
                    phase: "selectionRewrite",
                    system: req.system,
                    prompt: req.prompt,
                    maxOutputTokens: 2000,
                    cachePrefix: req.cachePrefix,
                    disableThinking: true,
                  })
                ).trim();
                assertStageOutput(WRITING_STAGE_IDS.selectionRewrite, text, "body");
                if (dbOpen) workspace.finishMicroCall(job.id, false);
                return text;
              } catch (error) {
                if (dbOpen) workspace.finishMicroCall(job.id, true);
                throw error;
              } finally {
                microJobs.delete(job.id);
              }
            })();
            microJobs.set(job.id, { controller, task });
            const rewrittenText = await task;
            return json({
              ok: true,
              result: {
                rewrittenText,
                tokens: caller.usedTokens(),
                mode: req.mode,
              },
            });
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
          return handleRouteError(error, ctx.logger);
        }
      });
    } catch (error) {
      accepting = false;
      dbOpen = false;
      if (journalTimer !== undefined) clearInterval(journalTimer);
      for (const dispose of [...disposers].reverse()) void dispose();
      db.close();
      throw error;
    }

    return async () => {
      // Stop accepting new work first; keep the ledger writable until the drain
      // finishes so receipts and finished results are not lost (DSH-08).
      accepting = false;
      for (const { controller } of generations.values()) controller.abort();
      for (const { controller } of proposalJobs.values()) controller.abort();
      for (const { controller } of microJobs.values()) controller.abort();
      if (journalTimer !== undefined) clearInterval(journalTimer);
      await Promise.all(disposers.map((dispose) => dispose()));

      const inFlight = [
        ...Array.from(generations.values(), (entry) => entry.task),
        ...Array.from(proposalJobs.values(), (entry) => entry.task),
        ...Array.from(microJobs.values(), (entry) => entry.task),
      ];
      if (inFlight.length > 0) {
        let timer: unknown;
        const settled = Promise.allSettled(inFlight);
        const drained = await Promise.race([
          settled.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), drainMs);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (!drained) {
          // The budget expired, but closing SQLite here would silently discard
          // every `if (dbOpen)` receipt from a late task (DSH-08). Force a
          // second abort, release the in-memory gates, log, and keep waiting.
          // `writing.ts` has its own 180s LLM timeout, so this cannot hang
          // forever.
          for (const { controller } of [
            ...generations.values(),
            ...proposalJobs.values(),
            ...microJobs.values(),
          ]) controller.abort();
          generations.clear();
          proposalJobs.clear();
          proposalLocks.clear();
          microJobs.clear();
          ctx.logger.error("zhizhang: shutdown drain exceeded budget; waiting for late receipts", {
            drainMs,
            pending: inFlight.length,
          });
          await settled;
        }
      }

      try {
        workspaceOnClose();
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
