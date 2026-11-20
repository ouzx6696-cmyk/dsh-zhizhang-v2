import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLIENT_ENTRY_CSS, CLIENT_JS_MODULES } from "../src/client/manifest.ts";
import { apiRequest, fetchWorkspaceState } from "../src/client/workbench/api.ts";
import { computeParagraphDiff } from "../src/client/workbench/diff.ts";
import { createDraftVault } from "../src/client/workbench/draft-vault.ts";
import { createRenderGate } from "../src/client/workbench/store.ts";
import { createVirtualList } from "../src/client/workbench/views/virtual-list.ts";
import { createMemoryStorage, withBrowserGlobals } from "../support/v2-harness.mjs";

test("DraftVault handles caching, dirty checks, owner-scoped multi-tab isolation, and storage warning recovery", async () => {
  const local = createMemoryStorage();
  const sessionA = createMemoryStorage();
  const sessionB = createMemoryStorage();
  const warnings = [];

  await withBrowserGlobals({ localStorage: local, sessionStorage: sessionA }, async () => {
    const vaultA = createDraftVault((msg) => warnings.push(msg));
    const base = { id: "doc-1", revisionId: "rev-1", body: "服务器正文" };

    assert.equal(vaultA.read(base.id), null);
    assert.equal(vaultA.isDirty(base, "服务器正文"), false);

    // Editing marks dirty and stores into sessionStorage + owner-tagged localStorage
    vaultA.capture(base, "本地修改稿");
    assert.equal(vaultA.isDirty(base, "本地修改稿"), true);
    assert.deepEqual(vaultA.read(base.id), { body: "本地修改稿", revisionId: "rev-1" });
    assert.ok(sessionA.getItem("zhizhang:draft:doc-1"));
    assert.ok(local.getItem("zhizhang:draft:doc-1"));

    // Returning to clean server base clears tab sessionStorage and its own localStorage backup
    vaultA.capture(base, "服务器正文");
    assert.equal(vaultA.read(base.id), null);
    assert.equal(local.getItem("zhizhang:draft:doc-1"), null);

    // Write again with Tab A, then simulate Tab B taking over localStorage with its own draft
    vaultA.capture(base, "A 的未保存草稿");
    await withBrowserGlobals({ sessionStorage: sessionB }, async () => {
      const vaultB = createDraftVault((msg) => warnings.push(msg));
      vaultB.write(base.id, { body: "B 的较新草稿", revisionId: "rev-1" });
    });

    // When Tab A later saves and clears its own draft, it MUST NOT wipe Tab B's localStorage backup
    vaultA.write(base.id, null);
    assert.equal(vaultA.read(base.id), null);
    assert.match(local.getItem("zhizhang:draft:doc-1") ?? "", /B 的较新草稿/);

    // Simulate stale revision persisted in storage after another client advanced revision
    const advancedBase = { id: "doc-1", revisionId: "rev-2", body: "服务器新版本" };
    assert.equal(vaultA.isDirty(advancedBase, "服务器新版本"), false);
    vaultA.write(base.id, { body: "基于旧修订的草稿", revisionId: "rev-1" });
    assert.equal(vaultA.isDirty(advancedBase, "基于旧修订的草稿"), true);
    assert.equal(vaultA.isDirty(advancedBase, "服务器新版本"), true);

    // Storage failure triggers warning & unavailable flag, and recovery clears flag
    sessionA.failWrite = true;
    local.failWrite = true;
    vaultA.write(base.id, { body: "无法落盘内容", revisionId: "rev-1" });
    assert.equal(vaultA.isUnavailable(), true);
    assert.equal(warnings.length, 1);

    sessionA.failWrite = false;
    local.failWrite = false;
    vaultA.write(base.id, { body: "无法落盘内容", revisionId: "rev-1" });
    assert.equal(vaultA.isUnavailable(), false);
  });
});

test("computeParagraphDiff normalizes CRLF, pairs asymmetric hunks, and falls back linearly past 250,000 cells", () => {
  const crlfSame = computeParagraphDiff("第一段\r\n第二段\r第三段", "第一段\n第二段\n第三段");
  assert.equal(crlfSame.unchanged, 3);
  assert.equal(crlfSame.added + crlfSame.removed + crlfSame.changed, 0);

  const asymmetric = computeParagraphDiff("A\nB\nC\nD", "A\nX\nD");
  assert.equal(asymmetric.unchanged, 2);
  assert.equal(asymmetric.changed, 1);
  assert.equal(asymmetric.removed, 1);
  assert.equal(asymmetric.added, 0);

  const fromEmpty = computeParagraphDiff("", "第一段\n第二段");
  assert.equal(fromEmpty.added, 2);
  assert.equal(fromEmpty.removed, 0);

  // 510 * 510 = 260,100 > 250,000 triggers O(N) linear pairing branch safely.
  const left = Array.from({ length: 510 }, (_, idx) => (idx === 5 ? "左改" : `段-${idx}`)).join("\n");
  const right = Array.from({ length: 510 }, (_, idx) => (idx === 5 ? "右改" : `段-${idx}`)).join("\n");
  const large = computeParagraphDiff(left, right);
  assert.equal(large.unchanged, 509);
  assert.equal(large.changed, 1);
  assert.equal(large.added, 0);
  assert.equal(large.removed, 0);
});

test("workbench API client builds URLs, rejects non-JSON logins or bad packets, and translates errors", async () => {
  const requests = [];
  let nextResponse = () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } });

  await withBrowserGlobals(
    {
      location: { href: "https://dsh.local/api/zhizhang/workbench" },
      fetch: async (url, init) => {
        requests.push({ url: url.toString(), init });
        return nextResponse();
      },
    },
    async () => {
      // 1. Non-JSON response triggers DsH login notice
      await assert.rejects(fetchWorkspaceState({ projectId: "p1", documentId: "d1" }, 42), {
        message: "请从 DsH 已登录页面打开织章。",
      });
      assert.equal(
        requests[0].url,
        "https://dsh.local/api/zhizhang/state?projectId=p1&documentId=d1&ifSequence=42",
      );

      // 2. Malformed packet
      nextResponse = () => Response.json({ unexpected: true });
      await assert.rejects(fetchWorkspaceState({ projectId: "", documentId: "" }), {
        message: "工作台返回了无法识别的结果。",
      });

      // 3. Valid POST /mutate
      nextResponse = () => Response.json({ ok: true, result: { id: "new-doc" } });
      const created = await apiRequest({ projectId: "p1", documentId: "d1" }, "document.create", { title: "第一章" });
      assert.deepEqual(created, { id: "new-doc" });
      assert.equal(requests[2].url, "https://dsh.local/api/zhizhang/mutate?projectId=p1&documentId=d1");
      assert.equal(requests[2].init.method, "POST");
      assert.equal(requests[2].init.headers["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(requests[2].init.body), { action: "document.create", title: "第一章" });

      // 4. Known reason translation + diagnosticId
      nextResponse = () =>
        Response.json({
          ok: false,
          code: "gate.denied",
          details: { action: "run.generate", reason: "generation-in-progress" },
          diagnosticId: "diag-42",
        });
      await assert.rejects(apiRequest({ projectId: "p1", documentId: "d1" }, "run.generate", {}), {
        message: "该稿件已有活动任务，请先完成或取消当前任务。（诊断号 diag-42）",
      });

      // 5. version.conflict friendly message
      nextResponse = () => Response.json({ ok: false, code: "version.conflict" });
      await assert.rejects(apiRequest({ projectId: "p1", documentId: "d1" }, "draft.save", {}), {
        message: "稿件版本已更新。本地编辑已保留，请刷新后核对再保存。",
      });

      // 6. Unknown reason fallback formats code · field
      nextResponse = () => Response.json({ ok: false, code: "input.invalid", details: { field: "title" } });
      await assert.rejects(apiRequest({ projectId: "p1", documentId: "d1" }, "document.create", {}), {
        message: "input.invalid · title",
      });
    },
  );
});

test("DsH slot entry module registers main, sidebar icon, and conversation view with relative iframe URL", async () => {
  let loadedDefinition;
  const mockWindow = {
    __ModuleLoader__: {
      load(definition) {
        loadedDefinition = definition;
      },
    },
  };
  const mockDocument = { baseURI: "https://dsh.local/sub/" };

  await withBrowserGlobals({ window: mockWindow, document: mockDocument }, async () => {
    await import("../src/client/slot.ts");
    assert.ok(loadedDefinition);
    assert.equal(loadedDefinition.id, "@zhizhang/dsh-workbench");

    const loadedModule = loadedDefinition.factory((name) => {
      assert.equal(name, "react");
      return {
        createElement(tag, props, ...children) {
          return { tag, props, children };
        },
      };
    });
    assert.deepEqual(loadedModule.inject, ["slots"]);

    const injected = [];
    loadedModule.apply({
      slots: {
        inject(slotName, factory) {
          injected.push({ slotName, element: factory() });
        },
        register(descriptor, component) {
          return { descriptor, component };
        },
      },
    });

    assert.deepEqual(injected.map((item) => item.slotName), ["main", "sidebar.panellist", "conversation.view"]);
    assert.equal(injected[0].element.descriptor.key, "zhizhang.workbench");
    assert.equal(injected[1].element.descriptor.label, "织章");
    assert.equal(injected[2].element.descriptor.id, "zhizhang.workbench");

    const frame = injected[0].element.component({});
    assert.equal(frame.tag, "iframe");
    assert.equal(frame.props.src, "https://dsh.local/sub/api/zhizhang/workbench");

    const icon = injected[1].element.component({ size: 18 });
    assert.equal(icon.tag, "span");
    assert.equal(icon.children[0], "织");
    assert.equal(icon.props.style.fontSize, 18);
  });
});

test("workbench.html satisfies static DOM ID, pipeline tab, diff mode, and manifest asset contracts", () => {
  const html = readFileSync(new URL("../src/client/workbench.html", import.meta.url), "utf8");

  // 1. Unique HTML id attributes
  const htmlIds = [];
  const seenIds = new Set();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    const id = match[1];
    assert.equal(seenIds.has(id), false, `Duplicate HTML id #${id} in workbench.html`);
    seenIds.add(id);
    htmlIds.push(id);
  }
  assert.ok(htmlIds.length > 40);

  // 2. Every static ID queried by shell/plugins/views exists in workbench.html
  const uiSources = [];
  function walkClientTs(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkClientTs(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) uiSources.push(full);
    }
  }
  walkClientTs(fileURLToPath(new URL("../src/client/workbench/", import.meta.url)));

  const referencedIds = new Set(["navigation", "pipeline", "navigation-toggle", "pipeline-toggle"]);
  for (const filePath of uiSources) {
    const src = readFileSync(filePath, "utf8");
    for (const match of src.matchAll(/\b(?:byId|bindForm|bindClick)(?:<[^>]+>)?\(\s*"([^"]+)"/g)) {
      referencedIds.add(match[1]);
    }
    for (const match of src.matchAll(/\bquerySelector(?:All)?(?:<[^>]+>)?\(\s*"#([a-zA-Z0-9_-]+)"/g)) {
      referencedIds.add(match[1]);
    }
  }
  for (const id of referencedIds) {
    assert.equal(seenIds.has(id), true, `UI code references missing HTML element #${id}`);
  }

  // 3. Pipeline tabs and panels match 1-to-1
  const tabs = new Set([...html.matchAll(/data-pipeline-tab="([^"]+)"/g)].map((m) => m[1]));
  const panels = new Set([...html.matchAll(/data-pipeline-panel="([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...tabs].sort(), ["continuity", "planning", "runs", "workflow"]);
  assert.deepEqual([...panels].sort(), [...tabs].sort());

  // 3b. Workspace views and panels match 1-to-1
  const views = new Set([...html.matchAll(/data-workspace-view="([^"]+)"/g)].map((m) => m[1]));
  const viewPanels = new Set([...html.matchAll(/data-workspace-panel="([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...views].sort(), ["deconstruct", "io", "outline", "techniques", "worldbook", "writing"]);
  assert.deepEqual([...viewPanels].sort(), [...views].sort());

  // 4. Diff display modes present
  const diffModes = new Set([...html.matchAll(/data-diff-mode="([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...diffModes].sort(), ["inline", "raw", "split"]);

  // 5. HTML entrypoint links match client/manifest.ts
  assert.ok(html.includes(`<link rel="stylesheet" href="./${CLIENT_ENTRY_CSS}">`));
  assert.ok(html.includes(`<script src="./${CLIENT_JS_MODULES[0]}" type="module">`));
});

test("renderGate tracks fine-grained dirty keys and virtualList windows 700+ rows cleanly", async () => {
  const gate = createRenderGate();
  assert.equal(gate.changed("projects", "p1"), true);
  assert.equal(gate.changed("projects", "p1"), false);
  assert.equal(gate.changed("projects", "p2"), true);
  gate.reset("proj");
  assert.equal(gate.changed("projects", "p2"), true);

  function makeFakeElement(tag) {
    const node = {
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      style: {},
      children: [],
      clientHeight: 400,
      scrollTop: 0,
      parentElement: null,
      addEventListener() {},
      removeEventListener() {},
      append(...nodes) {
        for (const child of nodes) {
          if (child._isFrag) {
            for (const c of child.children) {
              c.parentElement = node;
              node.children.push(c);
            }
          } else {
            child.parentElement = node;
            node.children.push(child);
          }
        }
      },
      replaceChildren(...nodes) {
        node.children = [];
        node.append(...nodes);
      },
    };
    return node;
  }

  await withBrowserGlobals(
    {
      document: {
        createElement: (tag) => makeFakeElement(tag),
        createDocumentFragment: () => ({ _isFrag: true, children: [], append(...n) { this.children.push(...n); } }),
      },
      requestAnimationFrame: (fn) => fn(),
    },
    async () => {
      const container = makeFakeElement("nav");
      const vlist = createVirtualList(container, {
        rowHeight: 40,
        overscan: 3,
        directThreshold: 80,
        renderItem: (item) => {
          const btn = makeFakeElement("button");
          btn.textContent = item;
          return btn;
        },
      });
      const items = Array.from({ length: 700 }, (_, i) => `第 ${i + 1} 章`);
      vlist.setItems(items);
      assert.equal(container.children.length, 1); // spacer
      const spacer = container.children[0];
      assert.equal(spacer.style.height, `${700 * 40}px`);
      const viewport = spacer.children[0];
      assert.ok(viewport.children.length > 0 && viewport.children.length <= 30);

      vlist.scrollToIndex(500);
      assert.ok(viewport.children.some((btn) => btn.textContent === "第 501 章"));
      assert.ok(viewport.children.length <= 30);
      vlist.destroy();
    },
  );
});
