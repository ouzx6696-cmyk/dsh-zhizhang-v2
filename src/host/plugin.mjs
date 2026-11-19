import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ContractError } from "../../dist/contracts/index.js";
import { createStore, openStore } from "../../dist/storage/index.js";
import { generateCandidate } from "./writing.mjs";
import { openAuthorWorkspace } from "../../dist/host/workspace.js";

export const inject = ["connection", "llm"];
const base = "/api/zhizhang";
const maxRequestBytes = 2 * 1024 * 1024;

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

async function requestObject(request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    throw new ContractError("input.invalid", { field: "content-type", reason: "expected-json" });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.body ?? []) {
    length += chunk.byteLength;
    if (length > maxRequestBytes) throw new ContractError("input.invalid", { field: "body", reason: "too-large" });
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    throw new ContractError("input.invalid", { field: "body", reason: "invalid-json" });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError("input.invalid", { field: "body", reason: "expected-object" });
  }
  return value;
}

function writeDelivery(directory, id, contents) {
  const path = join(directory, `${id}.md`);
  if (existsSync(path) && readFileSync(path, "utf8") === contents) return;
  const pending = join(directory, `.${id}.${randomUUID()}.tmp`);
  writeFileSync(pending, contents, { mode: 0o600, flag: "wx", flush: true });
  try {
    // Publish atomically without replacing an author's existing file.
    linkSync(pending, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (readFileSync(path, "utf8") !== contents) {
      throw Object.assign(new Error("Delivery file already exists"), { code: "export.conflict", retryable: false });
    }
  } finally {
    unlinkSync(pending);
  }
}

export function apply(ctx, config) {
  if (typeof config.dataDirectory !== "string" || !config.dataDirectory) throw new Error("织章缺少 dataDirectory");
  ctx.effect(() => {
    mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
    const exports = join(config.dataDirectory, "deliveries");
    mkdirSync(exports, { recursive: true, mode: 0o700 });
    const database = join(config.dataDirectory, "workspace.sqlite");
    if (!existsSync(database)) createStore(database);
    const db = openStore(database);
    const disposers = [];
    const generations = new Map();
    let closing = false;
    let workspaceOnClose = () => {};
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      const workspace = openAuthorWorkspace(db, (id, contents) => writeDelivery(exports, id, contents));
      workspaceOnClose = workspace.recoverGenerations;
      workspace.recoverGenerations();
      workspace.resumeExports();
      function route(path, methods, fetch) {
        disposers.push(ctx.connection.fetch.register({ path: base + path, methods, requestBody: methods.includes("GET") ? "buffered" : "streaming", fetch }));
      }
      for (const [path, file, type] of [
        ["/workbench", "workbench.html", "text/html"],
        ["/workbench.css", "workbench.css", "text/css"],
        ["/workbench.js", "workbench.js", "text/javascript"],
      ]) {
        const content = readFileSync(new URL(`../client/${file}`, import.meta.url));
        route(path, ["GET"], async () => new Response(content, {
          headers: {
            "Content-Type": `${type}; charset=utf-8`,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'",
            "Cache-Control": "no-store",
          },
        }));
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
          if (typeof action !== "string") throw new ContractError("input.invalid", { field: "action", reason: "required" });
          if (closing || request.signal.aborted) return new Response(null, { status: 503 });
          if (action === "run.generate") {
            if (generations.has(input.runId)) throw new ContractError("gate.denied", { action, reason: "generation-in-progress" });
            const run = workspace.generationInput(input, true);
            const controller = new AbortController();
            const task = generateCandidate(ctx.llm, run, controller.signal, () => {
              controller.signal.throwIfAborted();
              workspace.reserveRefinement(run.id);
            }, {
              begin(phase, inputReserve, maxOutput) {
                return workspace.beginGenerationCall(run.attemptId, phase, inputReserve, maxOutput);
              },
              receive(callId, usage) {
                if (!closing) workspace.recordGenerationReceipt(run.attemptId, callId, usage);
              },
            })
              .then((result) => {
                if (!closing) workspace.finishGeneration(run.attemptId, result, null);
              })
              .catch((error) => {
                if (!closing) workspace.finishGeneration(run.attemptId, null,
                  error instanceof ContractError ? error.code : controller.signal.aborted ? "cancelled" : "generation.failed");
              })
              .finally(() => { generations.delete(run.id); });
            generations.set(run.id, { controller, task });
            return json({ ok: true, result: { id: run.id, generating: true } }, 202);
          }
          if (action === "run.complete" && generations.has(input.runId)) {
            throw new ContractError("gate.denied", { action, reason: "generation-in-progress" });
          }
          const result = workspace.mutation(action, input);
          if (action === "run.cancel") generations.get(input.runId)?.controller.abort();
          return json({ ok: true, result });
        } catch (error) {
          if (error instanceof ContractError) {
            const status = error.code === "input.not_found" ? 404 : error.code === "input.invalid" ? 400 : 409;
            return json({ ok: false, ...error.toEnvelope() }, status);
          }
          const diagnosticId = randomUUID();
          ctx.logger.error("zhizhang: request failed", { diagnosticId, name: error?.name });
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
      try { workspaceOnClose(); } finally { db.close(); }
    };
  }, "zhizhang: author workbench");
}
