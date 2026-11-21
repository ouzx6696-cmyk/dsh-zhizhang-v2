import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_ENTRY_CSS, CLIENT_ENTRY_HTML, CLIENT_JS_MODULES } from "../src/client/manifest.ts";
import { createJobCenter } from "../src/client/workbench/views/job-center.ts";
import { withBrowserGlobals } from "../support/harness.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("workbench.html preserves required 3-zone header, #job-center, and editor mount IDs", () => {
  const html = readFileSync(join(ROOT, "src", "client", CLIENT_ENTRY_HTML), "utf8");
  for (const id of [
    "projects",
    "documents",
    "body",
    "save",
    "job-center",
    "run-status",
    "notice-text",
    "workbench-dialog",
    "quick-jump",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `workbench.html missing required #${id}`);
  }
  assert.ok(html.includes('class="top-left"'), "workbench.html missing 3-zone .top-left");
  assert.ok(html.includes('class="top-center"'), "workbench.html missing 3-zone .top-center");
  assert.ok(html.includes('class="top-actions"'), "workbench.html missing 3-zone .top-actions");
  assert.ok(existsSync(join(ROOT, "src", "client", CLIENT_ENTRY_CSS)));
});

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

test("unified UI foundation primitives (Button, Input, Card, Navbar) apply consistent grammar and events", async () => {
  const { createButton, createCard, createInput, createNavbar } = await import(
    "../src/client/workbench/ui/primitives.ts"
  );

  function makeNode(tag) {
    const attrs = new Map();
    const listeners = new Map();
    return {
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      type: "",
      value: "",
      href: "",
      hidden: false,
      disabled: false,
      dataset: {},
      children: [],
      onclick: null,
      oninput: null,
      onchange: null,
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener(type, fn) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      dispatch(type, evt) {
        for (const fn of listeners.get(type) ?? []) fn(evt);
      },
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = [...items]; },
    };
  }

  await withBrowserGlobals({ document: { createElement: (tag) => makeNode(tag) } }, () => {
    let clicked = 0;
    const btn = createButton({
      label: "保存草稿",
      variant: "primary",
      size: "lg",
      onClick: () => { clicked += 1; },
    });
    assert.equal(btn.getAttribute("data-ui"), "button");
    assert.match(btn.className, /\bui-btn\b/);
    assert.match(btn.className, /\bui-btn--primary\b/);
    assert.match(btn.className, /\bui-btn--lg\b/);
    btn.dispatch("keydown", { key: "Enter" });
    assert.equal(btn.getAttribute("data-pressing"), "true");
    btn.dispatch("keyup", {});
    assert.equal(btn.getAttribute("data-pressing"), null);
    btn.onclick?.({});
    assert.equal(clicked, 1);

    let typed = "";
    const field = createInput({
      kind: "text",
      label: "章节标题",
      placeholder: "输入章名",
      onInput: (val) => { typed = val; },
    });
    assert.equal(field.control.getAttribute("data-ui"), "input");
    assert.match(field.control.className, /\bui-input\b/);
    field.setValue("雨夜归人");
    field.control.oninput?.({});
    assert.equal(typed, "雨夜归人");
    field.setError("标题不能为空");
    assert.equal(field.control.getAttribute("aria-invalid"), "true");
    field.setError(null);
    assert.equal(field.control.getAttribute("aria-invalid"), null);

    let cardClicks = 0;
    const card = createCard({
      variant: "interactive",
      padding: "md",
      eyebrow: "番茄连载",
      title: "灰塔长夜",
      footer: btn,
      onClick: () => { cardClicks += 1; },
    });
    assert.equal(card.getAttribute("data-ui"), "card");
    assert.match(card.className, /\bui-card--interactive\b/);
    card.onclick?.({});
    assert.equal(cardClicks, 1);

    const tabChanges = [];
    const nav = createNavbar({
      brandLabel: "织章",
      breadcrumb: "灰塔长夜",
      tabs: [
        { id: "writing", label: "写作" },
        { id: "outline", label: "大纲" },
      ],
      activeTabId: "writing",
      onTabChange: (id) => tabChanges.push(id),
    });
    assert.equal(nav.root.getAttribute("data-ui"), "navbar");
    assert.match(nav.root.className, /\bui-navbar\b/);
    nav.setScrolled(true);
    assert.equal(nav.root.getAttribute("data-scrolled"), "true");
    nav.setBreadcrumb("灰塔长夜 / 第一章");
    nav.setActiveTab("outline");
    assert.equal(tabChanges.length, 0);
  });
});

