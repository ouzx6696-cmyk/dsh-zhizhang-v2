import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, normalize } from "node:path";
import { CLIENT_ENTRY_CSS, CLIENT_ENTRY_HTML, CLIENT_JS_MODULES } from "../src/client/manifest.ts";
import { ContractError } from "../src/contracts/index.ts";
import { writeDeliveryFile } from "../src/host/delivery-io.ts";
import { buildSanitizedDiagnostics } from "../src/host/settings.ts";
import { openAuthorWorkspace } from "../src/host/workspace.ts";
import {
  configureStorePragmas,
  createStore,
  openDatabase,
  openStore,
  sanitizePathSegment,
  writeLocalBundleToDir,
} from "../src/storage/index.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = process.env.ZHIZHANG_DATA_DIR;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const CSP_HEADER = "default-src 'self'; base-uri 'none'; object-src 'none'";

const CLIENT_FILES = new Map([
  ["/", { path: `../src/client/${CLIENT_ENTRY_HTML}`, type: "text/html" }],
  ["/workbench", { path: `../src/client/${CLIENT_ENTRY_HTML}`, type: "text/html" }],
  ["/workbench.css", { path: `../src/client/${CLIENT_ENTRY_CSS}`, type: "text/css" }],
  ["/workbench/diff-worker.js", { path: "../dist/client/workbench/diff-worker.js", type: "text/javascript" }],
  ...CLIENT_JS_MODULES.map((modulePath) => [
    `/${modulePath}`,
    { path: `../dist/client/${modulePath}`, type: "text/javascript" },
  ]),
]);

let db;
const deliveries = new Map();
if (DATA_DIR) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const exportsDir = join(DATA_DIR, "deliveries");
  mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
  const dbPath = join(DATA_DIR, "workspace.sqlite");
  if (!existsSync(dbPath)) createStore(dbPath);
  db = openStore(dbPath);
  configureStorePragmas(db, false);
} else {
  db = openDatabase(":memory:");
  configureStorePragmas(db, true);
}

const workspace = openAuthorWorkspace(
  db,
  (id, contents) => {
    deliveries.set(id, contents);
    if (DATA_DIR) {
      writeDeliveryFile(join(DATA_DIR, "deliveries"), id, contents);
    }
  },
  DATA_DIR
    ? (projectId, files) =>
        writeLocalBundleToDir(join(DATA_DIR, "exports", sanitizePathSegment(projectId)), files).writtenDir
    : undefined,
);
workspace.recoverStartup();

function sendJson(res, value, status = 200) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ContractError("input.invalid", { field: "content-type", reason: "expected-json" });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.byteLength;
    if (length > MAX_REQUEST_BYTES) {
      throw new ContractError("input.invalid", { field: "body", reason: "too-large" });
    }
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    throw new ContractError("input.invalid", { field: "body", reason: "invalid-json" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ContractError("input.invalid", { field: "body", reason: "expected-object" });
  }
  return parsed;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${PORT}`}`);
    const pathname = normalize(url.pathname);

    if (req.method === "GET" && CLIENT_FILES.has(pathname)) {
      const entry = CLIENT_FILES.get(pathname);
      const fileUrl = new URL(entry.path, import.meta.url);
      if (!existsSync(fileUrl)) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Client assets not built. Run `npm run build` first.");
        return;
      }
      const bytes = readFileSync(fileUrl);
      res.writeHead(200, {
        "Content-Type": `${entry.type}; charset=utf-8`,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": CSP_HEADER,
        "Cache-Control": "no-store",
      });
      res.end(bytes);
      return;
    }

    if (req.method === "GET" && pathname === "/state") {
      const result = workspace.readState(
        url.searchParams.get("projectId") ?? undefined,
        url.searchParams.get("documentId") ?? undefined,
        url.searchParams.get("ifSequence") ?? undefined,
      );
      sendJson(res, { ok: true, result });
      return;
    }

    if (req.method === "GET" && pathname === "/jobs") {
      const limitRaw = url.searchParams.get("limit");
      const result = workspace.listJobs({
        ...(url.searchParams.get("projectId") ? { projectId: url.searchParams.get("projectId") } : {}),
        ...(url.searchParams.get("documentId") ? { documentId: url.searchParams.get("documentId") } : {}),
        ...(url.searchParams.get("kind") ? { kind: url.searchParams.get("kind") } : {}),
        ...(limitRaw !== null ? { limit: Number(limitRaw) } : {}),
      });
      sendJson(res, { ok: true, result });
      return;
    }

    if (req.method === "GET" && pathname === "/diag") {
      const report = buildSanitizedDiagnostics(db, {
        activeJobs: { total: 0, draftGeneration: 0, proposalExtraction: 0, selectionRewrite: 0 },
        usageConsistencyIssues: workspace.verifyUsageConsistency().length,
        agentToolsEnabled: true,
        agentToolsRegistered: false,
        agentToolsError: null,
      });
      sendJson(res, { ok: true, result: report });
      return;
    }

    if (req.method === "POST" && pathname === "/jobs/preview") {
      const body = await readJsonBody(req);
      const result = workspace.mutation("run.preview", body);
      sendJson(res, { ok: true, result });
      return;
    }

    if (req.method === "POST" && pathname === "/jobs/start") {
      const body = await readJsonBody(req);
      throw new ContractError("gate.denied", {
        action: typeof body.kind === "string" ? body.kind : "jobs.start",
        reason: "preview-no-llm-transport",
      });
    }

    if (req.method === "POST" && pathname === "/jobs/cancel") {
      const body = await readJsonBody(req);
      if (typeof body.runId === "string" && body.runId.trim()) {
        const result = workspace.mutation("run.cancel", { runId: body.runId.trim() });
        sendJson(res, { ok: true, result: { ...result, cancelled: true } });
        return;
      }
      if (typeof body.proposalId === "string" && body.proposalId.trim()) {
        const cancelled = workspace.cancelProposalGeneration(body.proposalId.trim());
        sendJson(res, { ok: true, result: { id: body.proposalId.trim(), cancelled } });
        return;
      }
      throw new ContractError("input.invalid", { field: "jobId", reason: "required" });
    }

    if (req.method === "POST" && pathname === "/command") {
      const { action, ...input } = await readJsonBody(req);
      if (typeof action !== "string") {
        throw new ContractError("input.invalid", { field: "action", reason: "required" });
      }
      const result = workspace.mutation(action, input);
      sendJson(res, { ok: true, result });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  } catch (error) {
    if (error instanceof ContractError) {
      const status = error.code === "input.not_found" ? 404 : error.code === "input.invalid" ? 400 : 409;
      sendJson(res, { ok: false, ...error.toEnvelope() }, status);
      return;
    }
    const diagnosticId = randomUUID();
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error("zhizhang dev-server: request failed", { diagnosticId, name });
    sendJson(
      res,
      { ok: false, code: "internal.error", diagnosticId },
      500,
    );
  }
});

server.listen(PORT, HOST, () => {
  console.log(`织章工作台（V3.0）本地预览服务已启动: http://localhost:${PORT}/workbench`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
