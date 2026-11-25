import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ContractError } from "../src/contracts/index.ts";
import { openAuthorWorkspace } from "../src/host/index.ts";
import { createStore, openDatabase, openStore } from "../src/storage/index.ts";

/**
 * Shared offline test infrastructure for Zhizhang 3.0 (`zhizhang/3.0`).
 *
 * Kept outside `test/` per AGENTS.md so Node's built-in test runner only
 * executes `test/*.test.mjs`.
 */

export async function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function createTestWorkspace(t, options = {}) {
  const { mode = "memory", wal = false, allowExport = false, writer } = options;
  const dir = mode === "file" ? mkdtempSync(join(tmpdir(), "zhizhang-v3-")) : null;
  const dbFile = dir ? join(dir, "workspace.sqlite") : ":memory:";
  const connections = [];
  const writes = [];
  let exportAllowed = allowExport;
  let exportFailure = null;
  let closed = false;

  const activeWriter = writer ?? ((id, data) => {
    if (exportFailure) throw exportFailure;
    if (!exportAllowed) throw new Error("export temporarily unavailable");
    writes.push({ id, data });
  });

  function applyPragmas(conn) {
    if (!dir) return;
    if (wal) conn.exec("PRAGMA journal_mode = WAL;");
    conn.exec("PRAGMA busy_timeout = 5000;");
  }

  const db = dir ? (createStore(dbFile), openStore(dbFile)) : openDatabase(":memory:");
  applyPragmas(db);
  connections.push(db);
  const app = openAuthorWorkspace(db, activeWriter);

  function close() {
    if (closed) return;
    closed = true;
    for (const conn of [...connections].reverse()) {
      try {
        conn.close();
      } catch {
        // Ignore already-closed connection.
      }
    }
    connections.length = 0;
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  t?.after(close);

  return {
    db,
    app,
    dir,
    dbFile,
    writes,
    allowExport() {
      exportAllowed = true;
      exportFailure = null;
    },
    blockExport(error = new Error("export temporarily unavailable")) {
      exportAllowed = false;
      exportFailure = error;
    },
    reopen(customWriter) {
      if (dir) {
        const conn = openStore(dbFile);
        applyPragmas(conn);
        connections.push(conn);
        return openAuthorWorkspace(conn, customWriter ?? activeWriter);
      }
      return openAuthorWorkspace(db, customWriter ?? activeWriter);
    },
    createFanqieChapter({ projectName = "测试小说", title = "第一章", body = "作者原稿", saveDraft = true } = {}) {
      const projectId = app.mutation("project.create", { product: "fanqie", name: projectName }).id;
      const documentId = app.mutation("document.create", { projectId, title }).id;
      let revisionId = null;
      if (saveDraft) {
        revisionId = app.mutation("draft.save", { documentId, baseRevisionId: null, body }).revisionId;
      }
      return { projectId, documentId, revisionId, baseRevisionId: revisionId };
    },
    createToutiaoArticle({
      projectName = "测试专栏",
      title,
      mode = "short",
      line = "资讯线",
      body,
      saveDraft = true,
    } = {}) {
      const resolvedTitle = title !== undefined ? title : mode === "micro" ? "" : "测试短评标题";
      const resolvedBody = body !== undefined
        ? body
        : mode === "long"
          ? "长".repeat(2800)
          : mode === "micro"
            ? "微".repeat(400)
            : "短".repeat(1200);
      const projectId = app.mutation("project.create", { product: "toutiao", name: projectName }).id;
      const documentId = app.mutation("document.create", {
        projectId,
        title: resolvedTitle,
        mode,
        line,
      }).id;
      let revisionId = null;
      if (saveDraft) {
        revisionId = app.mutation("draft.save", { documentId, baseRevisionId: null, body: resolvedBody }).revisionId;
      }
      return { projectId, documentId, revisionId, baseRevisionId: revisionId };
    },
    close,
  };
}

async function waitGateWithAbort(gate, signal) {
  if (signal.aborted) {
    const error = new Error("Aborted");
    error.name = "AbortError";
    throw error;
  }
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(gate).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export function createScriptedLlm(steps = []) {
  const calls = [];
  let cursor = 0;

  return {
    calls,
    async prepareCall(request, signal) {
      const callIndex = cursor++;
      const rawStep = steps[callIndex];
      if (!rawStep) throw new Error(`Unexpected LLM call #${callIndex}`);
      const step = typeof rawStep === "function"
        ? await rawStep(request, undefined, callIndex, signal)
        : rawStep;
      await step.onPrepare?.(request, callIndex, signal);
      if (step.throwOnPrepare) throw step.throwOnPrepare;

      return {
        config: step.config ?? {},
        async *stream(options) {
          calls.push({ index: callIndex, request, options, signal });
          const active = typeof rawStep === "function"
            ? { ...step, ...(await rawStep(request, options, callIndex, signal)) }
            : step;
          await active.onStream?.(options, callIndex, signal);
          if (active.gate) {
            await waitGateWithAbort(active.gate, signal);
          }
          if (active.throwOnStream) throw active.throwOnStream;
          if (Array.isArray(active.chunks)) {
            for (const chunk of active.chunks) {
              if (signal.aborted) break;
              yield chunk;
            }
            return;
          }
          if (typeof active.text === "string") {
            yield { type: "text-delta", index: 0, text: active.text };
          }
          if (active.usage !== null) {
            yield {
              type: "usage",
              usage: active.usage ?? {
                inputTokens: 120,
                outputTokens: 80,
                cacheReadTokens: 10,
                cacheWriteTokens: 5,
              },
            };
          }
          if (active.finishKind !== null) {
            yield { type: "finish", reason: { kind: active.finishKind ?? "stop" } };
          }
        },
      };
    },
  };
}

export function createStrictToolRegistrar({ failOn = null, failWith = null } = {}) {
  const tools = [];
  const disposed = [];
  const conditions = new Map();
  const register = (tool, options) => {
    if (!tool || typeof tool !== "object") throw new TypeError("tool definition must be an object");
    if (failOn === tool.name) throw failWith ?? new TypeError(`tool "${tool.name}" rejected`);
    if (typeof tool.name !== "string" || !/^[a-z][a-z0-9_]{2,63}$/.test(tool.name)) {
      throw new TypeError(`invalid tool name: ${tool?.name}`);
    }
    if (typeof tool.description !== "string" || !tool.description.trim()) {
      throw new TypeError(`tool "${tool.name}" missing description`);
    }
    if (typeof tool.readOnly !== "boolean") {
      throw new TypeError(`tool "${tool.name}" missing readOnly`);
    }
    if (
      !tool.parameters
      || tool.parameters.type !== "object"
      || !tool.parameters.properties
      || tool.parameters.additionalProperties !== false
    ) {
      throw new TypeError(`tool "${tool.name}" invalid parameters schema`);
    }
    if (!tool.output?.schema || typeof tool.output.render !== "function") {
      throw new TypeError(`tool "${tool.name}" missing output schema/render`);
    }
    if (typeof tool.execute !== "function") throw new TypeError(`tool "${tool.name}" missing execute`);
    if (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs <= 0) {
      throw new TypeError(`tool "${tool.name}" invalid timeoutMs`);
    }
    tools.push(tool);
    conditions.set(tool.name, options?.when);
    return () => {
      const idx = tools.indexOf(tool);
      if (idx >= 0) tools.splice(idx, 1);
      disposed.push(tool.name);
      conditions.delete(tool.name);
    };
  };
  return {
    tools,
    disposed,
    register,
    available(name, agent) {
      return conditions.get(name)?.({ agent }) ?? true;
    },
    async invoke(name, args, exec) {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool.execute(args, exec);
    },
  };
}

export function createMockSystemPromptRegistrar({ fail = false } = {}) {
  const sections = [];
  const disposed = [];
  const section = (entry) => {
    if (fail) throw new Error("systemPrompt registrar rejected section");
    if (!entry || typeof entry.name !== "string" || typeof entry.text !== "function") {
      throw new TypeError("invalid systemPrompt section");
    }
    sections.push(entry);
    return () => {
      const idx = sections.indexOf(entry);
      if (idx >= 0) sections.splice(idx, 1);
      disposed.push(entry.name);
    };
  };
  return {
    sections,
    disposed,
    section,
    renderAll(context = {}) {
      return [...sections].sort((a, b) => a.order - b.order)
        .map((entry) => entry.text(context)).filter(Boolean).join("\n\n");
    },
  };
}

export function createMockDsHHost({ llm, readAsset, tools, systemPrompt, cordis = false } = {}) {
  const routes = new Map();
  const disposedPaths = [];
  const logs = [];
  const scopeDisposers = [];
  let effectDisposer = null;
  let closed = false;

  const assetReader = readAsset ?? ((kind, path) => {
    if (kind === "html" || kind === "css") {
      return readFileSync(new URL(`../src/client/${path}`, import.meta.url));
    }
    return new TextEncoder().encode(`export const __zhizhangAsset = ${JSON.stringify(path)};\n`);
  });

  const ctx = {
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return () => {
            routes.delete(route.path);
            disposedPaths.push(route.path);
          };
        },
      },
    },
    llm: llm ?? createScriptedLlm([]),
    logger: {
      error(message, details) {
        logs.push({ message, details });
      },
    },
    effect(setup) {
      effectDisposer = setup();
    },
  };

  if (!cordis && tools !== undefined) ctx.tools = tools;
  if (!cordis && systemPrompt !== undefined) ctx.systemPrompt = systemPrompt;

  if (cordis) {
    const services = { connection: ctx.connection, llm: ctx.llm, tools, systemPrompt };
    ctx.get = (name) => services[name];
    ctx.inject = (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return () => {};
      const scoped = {
        ...ctx,
        effect(setup) {
          scopeDisposers.push(setup());
        },
      };
      callback(scoped);
      return async () => {
        while (scopeDisposers.length > 0) {
          const dispose = scopeDisposers.pop();
          if (typeof dispose === "function") await dispose();
        }
      };
    };
  }

  function route(subPath) {
    const fullPath = subPath.startsWith("/api/zhizhang") ? subPath : `/api/zhizhang${subPath}`;
    const entry = routes.get(fullPath);
    if (!entry) throw new Error(`Route not registered: ${fullPath}`);
    return entry;
  }

  async function get(subPath, query = {}) {
    const url = new URL(`http://dsh.local/api/zhizhang${subPath}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return route(subPath).fetch(new Request(url, { method: "GET" }));
  }

  async function postJson(subPath, payload, signal) {
    const response = await route(subPath).fetch(
      new Request(`http://dsh.local/api/zhizhang${subPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      }),
    );
    const body = response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : null;
    return { status: response.status, headers: response.headers, body };
  }

  async function getJson(subPath, query = {}) {
    const response = await get(subPath, query);
    const body = response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : null;
    return { status: response.status, headers: response.headers, body };
  }

  async function waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
      await delay(5);
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    while (scopeDisposers.length > 0) {
      const dispose = scopeDisposers.pop();
      if (typeof dispose === "function") await dispose();
    }
    if (typeof effectDisposer === "function") await effectDisposer();
  }

  return {
    ctx,
    routes,
    disposedPaths,
    logs,
    readAsset: assetReader,
    route,
    get,
    getState: (query = {}) => getJson("/state", query),
    getJobs: (query = {}) => getJson("/jobs", query),
    getDiag: () => getJson("/diag"),
    command: (action, input = {}) => postJson("/command", { action, ...input }),
    previewJob: (input = {}) => postJson("/jobs/preview", input),
    startJob: (kind, input = {}, signal) => postJson("/jobs/start", { kind, ...input }, signal),
    cancelJob: (input = {}) => postJson("/jobs/cancel", input),
    postRaw: (subPath, { contentType, body, signal } = {}) => {
      const headers = contentType !== undefined ? { "content-type": contentType } : {};
      return route(subPath).fetch(
        new Request(`http://dsh.local/api/zhizhang${subPath}`, { method: "POST", headers, body: body ?? null, signal }),
      );
    },
    waitFor,
    close,
  };
}

export function createMemoryStorage() {
  const store = new Map();
  return {
    get length() { return store.size; },
    key(index) { return [...store.keys()][index] ?? null; },
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(String(key), String(value)); },
    removeItem(key) { store.delete(String(key)); },
    clear() { store.clear(); },
  };
}

export async function withBrowserGlobals(overrides, fn) {
  const saved = Object.entries(overrides).map(([key]) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true, enumerable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [key, descriptor] of saved.reverse()) {
      if (descriptor === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
  }
}

export function assertThrowsContract(fn, code, detailsSubset) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ContractError, `Expected ContractError, got ${error}`);
    assert.equal(error.code, code);
    if (detailsSubset) {
      for (const [key, expected] of Object.entries(detailsSubset)) {
        assert.deepEqual(error.details[key], expected);
      }
    }
    return true;
  });
}

export async function assertRejectsContract(promiseOrFn, code, detailsSubset) {
  await assert.rejects(promiseOrFn, (error) => {
    assert.ok(error instanceof ContractError, `Expected ContractError, got ${error}`);
    assert.equal(error.code, code);
    if (detailsSubset) {
      for (const [key, expected] of Object.entries(detailsSubset)) {
        assert.deepEqual(error.details[key], expected);
      }
    }
    return true;
  });
}
