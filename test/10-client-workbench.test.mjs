import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_JS_MODULES } from "../src/client/manifest.ts";
import { createJobCenter } from "../src/client/workbench/views/job-center.ts";
import { withBrowserGlobals } from "../support/harness.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("CLIENT_JS_MODULES covers every compiled JS module needed by the workbench", () => {
  assert.ok(CLIENT_JS_MODULES.includes("workbench/views/job-center.js"));
  assert.ok(CLIENT_JS_MODULES.includes("workbench/diff-worker.js"));
  assert.ok(CLIENT_JS_MODULES.includes("contracts/protected-rules.js"));
  assert.equal(new Set(CLIENT_JS_MODULES).size, CLIENT_JS_MODULES.length, "Duplicate entries in CLIENT_JS_MODULES");

  const TYPE_ONLY_MODULES = new Set(["workbench/plugins/types.js"]);
  const walk = (dir, base = "") => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(rel.replace(/\.ts$/, ".js"));
    }
    return out;
  };
  const workbenchModules = walk(join(ROOT, "src", "client", "workbench"), "workbench");
  for (const mod of workbenchModules) {
    if (TYPE_ONLY_MODULES.has(mod)) continue;
    assert.ok(CLIENT_JS_MODULES.includes(mod), `CLIENT_JS_MODULES missing ${mod}`);
  }
});

test("client codebase contains zero blocking browser dialogs and zero raw HTML injection sinks", () => {
  const walk = (dir) => {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walk(full));
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
    return files;
  };
  for (const file of walk(join(ROOT, "src", "client"))) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /\bwindow\.(?:alert|confirm|prompt)\s*\(/, `Forbidden dialog in ${file}`);
    assert.doesNotMatch(src, /\.(?:innerHTML|outerHTML)\s*=/, `Forbidden HTML sink in ${file}`);
    assert.doesNotMatch(src, /\b(?:insertAdjacentHTML|document\.write)\s*\(/, `Forbidden HTML sink in ${file}`);
  }
});

test("JobCenter renders unified jobs, triggers cancel, inspect, and recovery-hint callbacks", async () => {
  function makeNode(tag) {
    return {
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      type: "",
      children: [],
      onclick: null,
      get childElementCount() { return this.children.length; },
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = [...items]; },
    };
  }

  const fakeDoc = { createElement: (tag) => makeNode(tag) };
  const container = makeNode("div");
  const events = [];

  await withBrowserGlobals({ document: fakeDoc }, () => {
    const center = createJobCenter(container, {
      onCancelJob: (job) => events.push(["cancel", job.id]),
      onInspectRun: (runId) => events.push(["inspect", runId]),
      onApplyRecoveryHint: (hint) => events.push(["hint", hint.action]),
    });

    center.render(
      [
        {
          id: "job-1",
          kind: "draft_generation",
          subtype: "write",
          projectId: "p1",
          documentId: "d1",
          runId: "run-1",
          proposalId: null,
          provider: "deepseek",
          model: "deepseek-chat",
          state: "inflight",
          stage: "write",
          reserved: 12000,
          settled: 450,
          error: null,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      {
        id: "run-1",
        state: "failed",
        recoveryHints: [{ action: "increase_budget", message: "预算偏紧，建议追加" }],
      },
    );

    const buttons = [];
    const collect = (node) => {
      if (node.tagName === "BUTTON") buttons.push(node);
      for (const child of node.children ?? []) collect(child);
    };
    collect(container);

    assert.equal(buttons.length, 3);
    for (const btn of buttons) btn.onclick?.();
  });

  assert.deepEqual(events, [
    ["hint", "increase_budget"],
    ["cancel", "job-1"],
    ["inspect", "run-1"],
  ]);
});
