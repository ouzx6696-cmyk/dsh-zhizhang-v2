import test from "node:test";
import assert from "node:assert/strict";
import { actionTimeoutMs, apiRequest } from "../src/client/workbench/api.ts";
import {
  computeInlineDiff,
  computeParagraphDiff,
  countNonWhitespaceChars,
  countUnicodeCodePoints,
  mergeParagraphSelections,
} from "../src/client/workbench/diff.ts";
import { createDraftVault } from "../src/client/workbench/draft-vault.ts";
import { createActionCoordinator, createRenderGate, formatCharCount } from "../src/client/workbench/store.ts";
import { resolveCapturedSelection } from "../src/client/workbench/views/selection-microbar.ts";
import { createMemoryStorage, withBrowserGlobals } from "../support/harness.mjs";

test("paragraph diff, inline char diff, and partial selection merge preserve CRLF and unchanged text", () => {
  const original = "第一段不变。\r\n\r\n第二段旧写法。\r\n\r\n第三段旧结尾。";
  const candidate = "第一段不变。\r\n\r\n第二段新写法。\r\n\r\n第三段新结尾。";
  const diff = computeParagraphDiff(original, candidate);
  assert.equal(diff.changed, 2);
  assert.equal(diff.lineEnding, "\r\n");

  const changedIndices = diff.rows
    .map((row, idx) => (row.kind === "changed" ? idx : -1))
    .filter((idx) => idx >= 0);
  // Adopt only the first changed paragraph
  const merged = mergeParagraphSelections(diff, new Set([changedIndices[0]]));
  assert.equal(merged, "第一段不变。\r\n\r\n第二段新写法。\r\n\r\n第三段旧结尾。");

  const inline = computeInlineDiff("沈砚拔出旧剑。", "沈砚拔出青铜剑。");
  assert.ok(inline.some((s) => s.kind === "removed" && s.text.includes("旧")));
  assert.ok(inline.some((s) => s.kind === "added" && s.text.includes("青铜")));
  assert.equal(countUnicodeCodePoints("🔥标题"), 3);
  assert.equal(countNonWhitespaceChars("甲 乙\n丙"), 3);
});

test("draft-vault isolates unsaved edits, detects revision conflicts, and clears cleanly on save", async () => {
  const local = createMemoryStorage();
  const session = createMemoryStorage();
  const warnings = [];

  await withBrowserGlobals({ localStorage: local, sessionStorage: session }, () => {
    const vault = createDraftVault((msg) => warnings.push(msg));
    const base = { id: "doc-1", revisionId: "rev-1", body: "原稿" };

    assert.equal(vault.isDirty(base, "原稿"), false);
    vault.capture(base, "未保存新稿");
    assert.equal(vault.isDirty(base, "未保存新稿"), true);
    assert.deepEqual(vault.read("doc-1"), { body: "未保存新稿", revisionId: "rev-1" });

    // Server moved to rev-2 while local draft was based on rev-1 -> still dirty/conflict
    const newerBase = { id: "doc-1", revisionId: "rev-2", body: "新版本" };
    assert.equal(vault.isDirty(newerBase, "新版本"), true);

    vault.write("doc-1", null);
    assert.equal(vault.read("doc-1"), null);
    assert.equal(warnings.length, 0);
  });
});

test("renderGate & actionCoordinator prevent duplicate user clicks and isolate background polls", async () => {
  const gate = createRenderGate();
  assert.equal(gate.changed("tree", "sig-1"), true);
  assert.equal(gate.changed("tree", "sig-1"), false);
  assert.equal(gate.changed("tree", "sig-2"), true);
  gate.reset("tree");
  assert.equal(gate.changed("tree", "sig-2"), true);

  const coord = createActionCoordinator();
  let pollRanDuringUser = false;
  let userGate = Promise.withResolvers();
  const userPromise = coord.runUserAction(
    async () => {
      pollRanDuringUser = await coord.runBackgroundPoll(async () => {});
      await userGate.promise;
    },
    () => {},
    () => {},
  );
  userGate.resolve();
  assert.equal(await userPromise, true);
  assert.equal(pollRanDuringUser, false);
  assert.equal(formatCharCount(12_500), "1.3 万字");
});

test("resolveCapturedSelection relocates unique shifted text and rejects ambiguous or cross-doc matches", () => {
  const cap = { documentId: "d1", revisionId: "r1", start: 4, end: 8, text: "青铜古剑" };
  // Shifted forward by insertion
  const shifted = resolveCapturedSelection(cap, "d1", "雪夜里，门外出现青铜古剑。");
  assert.equal(shifted.ok, true);
  assert.equal(shifted.relocated, true);
  assert.equal(shifted.start, 8);

  // Ambiguous duplicate refuses replacement
  const ambiguous = resolveCapturedSelection(cap, "d1", "青铜古剑与另一把青铜古剑");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, "ambiguous");

  // Document switch refuses replacement
  const switched = resolveCapturedSelection(cap, "d2", "门外出现青铜古剑");
  assert.equal(switched.ok, false);
  assert.equal(switched.reason, "document-changed");
});

test("client api.ts routes actions cleanly to Next-Gen /state, /jobs, /command, /jobs/* endpoints", async () => {
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true, result: { echoed: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await withBrowserGlobals({ location: { href: "http://localhost:3000/api/zhizhang/workbench" }, fetch: mockFetch }, async () => {
    const ctx = { projectId: "p1", documentId: "d1" };
    await apiRequest(ctx);
    await apiRequest(ctx, "jobs.list", { limit: 10 });
    await apiRequest(ctx, "run.preview", { documentId: "d1" });
    await apiRequest(ctx, "run.generate", { runId: "r1" });
    await apiRequest(ctx, "proposal.generate", { kind: "technique", projectId: "p1" });
    await apiRequest(ctx, "selection.rewrite", { documentId: "d1", mode: "polish" });
    await apiRequest(ctx, "run.cancel", { runId: "r1" });
    await apiRequest(ctx, "draft.save", { documentId: "d1", body: "新正文" });
  });

  assert.equal(calls.length, 8);
  assert.match(calls[0].url, /\/api\/zhizhang\/state\?/);
  assert.match(calls[1].url, /\/api\/zhizhang\/jobs\?/);
  assert.match(calls[2].url, /\/api\/zhizhang\/jobs\/preview$/);
  assert.match(calls[3].url, /\/api\/zhizhang\/jobs\/start$/);
  assert.equal(calls[3].body.kind, "draft_generation");
  assert.equal(calls[4].body.kind, "proposal_extraction");
  assert.equal(calls[4].body.proposalKind, "technique");
  assert.equal(calls[5].body.kind, "selection_rewrite");
  assert.match(calls[6].url, /\/api\/zhizhang\/jobs\/cancel$/);
  assert.match(calls[7].url, /\/api\/zhizhang\/command$/);
  assert.equal(calls[7].body.action, "draft.save");

  assert.equal(actionTimeoutMs(undefined), 15_000);
  assert.equal(actionTimeoutMs("draft.save"), 30_000);
  assert.equal(actionTimeoutMs("selection.rewrite"), 120_000);
});
