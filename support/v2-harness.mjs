import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ContractError } from "../src/contracts/index.ts";
import { openAuthorWorkspace } from "../src/host/index.ts";
import { createStore, openDatabase, openStore } from "../src/storage/index.ts";

/**
 * Shared offline test infrastructure for V2 suites.
 *
 * Kept outside `test/` per AGENTS.md so Node's built-in test discovery does
 * not execute helpers as a test file.
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
  const dir = mode === "file" ? mkdtempSync(join(tmpdir(), "zhizhang-v2-")) : null;
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

  let db;
  if (dir) {
    createStore(dbFile);
    db = openStore(dbFile);
  } else {
    db = openDatabase(":memory:");
  }
  applyPragmas(db);
  connections.push(db);
  const app = openAuthorWorkspace(db, activeWriter);

  function close() {
    if (closed) return;
    closed = true;
    // Close all SQLite connections in LIFO order BEFORE removing the temp directory (Windows EPERM guard).
    for (const conn of [...connections].reverse()) {
      try {
        conn.close();
      } catch {
        // Ignore already-closed connections during teardown.
      }
    }
    connections.length = 0;
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
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
    openConnection(customWriter) {
      if (!dir) throw new Error("openConnection() requires mode: 'file'");
      const conn = openStore(dbFile);
      applyPragmas(conn);
      connections.push(conn);
      return { db: conn, app: openAuthorWorkspace(conn, customWriter ?? activeWriter) };
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
      if (!rawStep) {
        throw new Error(`Unexpected LLM call #${callIndex}`);
      }
      const step = typeof rawStep === "function"
        ? await rawStep(request, undefined, callIndex, signal)
        : rawStep;

      await step.onPrepare?.(request, callIndex, signal);
      if (step.throwOnPrepare) {
        throw step.throwOnPrepare;
      }

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
          if (active.throwOnStream) {
            throw active.throwOnStream;
          }
          if (Array.isArray(active.chunks)) {
            for (const chunk of active.chunks) {
              if (signal.aborted) break;
              yield chunk;
            }
            return;
          }
          if (Array.isArray(active.blocks)) {
            for (const block of active.blocks) {
              const blockIndex = block.index ?? 0;
              if (Array.isArray(block.deltas)) {
                for (const delta of block.deltas) {
                  yield { type: "text-delta", index: blockIndex, text: delta };
                }
              } else if (typeof block.text === "string" && block.text.length > 0) {
                yield { type: "text-delta", index: blockIndex, text: block.text };
              }
              if (block.blockEndText !== undefined) {
                yield {
                  type: "block-end",
                  index: blockIndex,
                  block: { type: block.blockType ?? "text", text: block.blockEndText },
                };
              }
            }
          } else if (typeof active.text === "string") {
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

export function createReceiptLedger() {
  const entries = [];
  return {
    entries,
    begin(phase, inputReserve, maxOutput) {
      const id = `call-${entries.length + 1}`;
      entries.push({ id, phase, inputReserve, maxOutput, usage: null });
      return id;
    },
    receive(callId, usage) {
      const entry = entries.find((item) => item.id === callId);
      if (entry) entry.usage = [...usage];
    },
  };
}

/**
 * Mirrors the upstream `tools.register` preconditions (DSH-01): every tool must
 * declare `output.schema` + `output.render`, an object parameter schema with
 * `additionalProperties: false`, and a positive `timeoutMs`. Without this
 * fixture a mock host accepts anything and hides real-host load failures.
 */
export function createStrictToolRegistrar({ failOn = null, failWith = null } = {}) {
  const tools = [];
  const disposed = [];
  const register = (tool) => {
    if (!tool || typeof tool !== "object") {
      throw new TypeError("tool definition must be an object");
    }
    if (failOn === tool.name) {
      throw failWith ?? new TypeError(`tool "${tool.name}" registration rejected by host`);
    }
    if (typeof tool.name !== "string" || !/^[a-z][a-z0-9_]{2,63}$/.test(tool.name)) {
      throw new TypeError(`tool "${tool?.name}" must declare a lowercase snake_case name`);
    }
    if (typeof tool.description !== "string" || !tool.description.trim() || tool.description.length > 1024) {
      throw new TypeError(`tool "${tool.name}" must declare a description`);
    }
    if (typeof tool.readOnly !== "boolean") {
      throw new TypeError(`tool "${tool.name}" must declare readOnly`);
    }
    if (
      !tool.parameters
      || tool.parameters.type !== "object"
      || !tool.parameters.properties
      || tool.parameters.additionalProperties !== false
    ) {
      throw new TypeError(`tool "${tool.name}" must declare an object parameters schema with additionalProperties:false`);
    }
    if (!tool.output || typeof tool.output !== "object" || !tool.output.schema || typeof tool.output.render !== "function") {
      throw new TypeError(`tool "${tool.name}" must declare output { schema, render }`);
    }
    if (typeof tool.execute !== "function") {
      throw new TypeError(`tool "${tool.name}" must declare execute`);
    }
    if (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs <= 0) {
      throw new TypeError(`tool "${tool.name}" must declare a positive timeoutMs`);
    }
    tools.push(tool);
    return () => {
      const index = tools.indexOf(tool);
      if (index >= 0) tools.splice(index, 1);
      disposed.push(tool.name);
    };
  };
  return {
    tools,
    disposed,
    register,
    async invoke(name, args, exec) {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool.execute(args, exec);
    },
  };
}

export function createMockDsHHost({ llm, readAsset, tools, configForms, cordis = false } = {}) {
  const routes = new Map();
  const disposedPaths = [];
  const logs = [];
  const injectedScopes = [];
  const effectNames = [];
  const scopeDisposers = [];
  let effectName = null;
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
    effect(setup, name) {
      effectName = name;
      effectNames.push(name);
      effectDisposer = setup();
    },
  };

  if (!cordis && tools !== undefined) ctx.tools = tools;
  if (!cordis && configForms !== undefined) ctx.configForms = configForms;

  if (cordis) {
    const services = { connection: ctx.connection, llm: ctx.llm, tools, configForms };
    ctx.get = (name) => services[name];
    ctx.inject = (deps, callback) => {
      injectedScopes.push([...deps]);
      if (!deps.every((dep) => services[dep] !== undefined)) return () => {};
      const scoped = {
        ...ctx,
        effect(setup, name) {
          effectNames.push(name);
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
    const request = new Request(url, { method: "GET" });
    return route(subPath).fetch(request);
  }

  async function postRaw(subPath, { contentType, body, signal, url = `http://dsh.local/api/zhizhang${subPath}` } = {}) {
    const headers = {};
    if (contentType !== undefined) headers["content-type"] = contentType;
    const request = new Request(url, {
      method: "POST",
      headers,
      body: body ?? null,
      signal,
    });
    return route(subPath).fetch(request);
  }

  async function readState(params = {}) {
    const response = await get("/state", params);
    const body = response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : null;
    return { status: response.status, headers: response.headers, body };
  }

  async function mutate(action, input = {}) {
    const payload = action === undefined ? { ...input } : { action, ...input };
    const response = await postRaw("/mutate", {
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
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
      if (Date.now() >= deadline) {
        throw new Error(`waitFor timed out after ${timeoutMs}ms`);
      }
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
    if (typeof effectDisposer === "function") {
      await effectDisposer();
    }
  }

  return {
    ctx,
    routes,
    disposedPaths,
    logs,
    injectedScopes,
    effectNames,
    readAsset: assetReader,
    get effectName() {
      return effectName;
    },
    route,
    get,
    postRaw,
    readState,
    mutate,
    waitFor,
    close,
  };
}

export function createMemoryStorage({ failRead = false, failWrite = false } = {}) {
  const store = new Map();
  const storage = {
    failRead,
    failWrite,
    get length() {
      return store.size;
    },
    key(index) {
      return [...store.keys()][index] ?? null;
    },
    getItem(key) {
      if (storage.failRead) throw new Error("Storage read disabled");
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      if (storage.failWrite) throw new Error("Storage write quota exceeded");
      store.set(String(key), String(value));
    },
    removeItem(key) {
      if (storage.failWrite) throw new Error("Storage remove disabled");
      store.delete(String(key));
    },
    clear() {
      if (storage.failWrite) throw new Error("Storage clear disabled");
      store.clear();
    },
    snapshot() {
      return new Map(store);
    },
  };
  return storage;
}

export async function withBrowserGlobals(overrides, fn) {
  const saved = Object.entries(overrides).map(([key]) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]);
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }
  try {
    return await fn();
  } finally {
    for (const [key, descriptor] of saved.reverse()) {
      if (descriptor === undefined) {
        delete globalThis[key];
      } else {
        Object.defineProperty(globalThis, key, descriptor);
      }
    }
  }
}

function checkContractError(error, code, detailsSubset) {
  assert.ok(error instanceof ContractError, `Expected ContractError, got ${error?.constructor?.name ?? error}`);
  assert.equal(error.code, code);
  if (detailsSubset) {
    for (const [key, expected] of Object.entries(detailsSubset)) {
      assert.deepEqual(error.details[key], expected);
    }
  }
  return true;
}

export function assertThrowsContract(fn, code, detailsSubset) {
  assert.throws(fn, (error) => checkContractError(error, code, detailsSubset));
}

export async function assertRejectsContract(promiseOrFn, code, detailsSubset) {
  await assert.rejects(promiseOrFn, (error) => checkContractError(error, code, detailsSubset));
}
