import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLIENT_JS_MODULES } from "../src/client/manifest.ts";
import { createWorkbenchFrameProps, registerWorkbenchSlots, resolveWorkbenchUrl } from "../src/client/slot.ts";
import {
  defineParameters,
  openOutputSchema,
  toFlatParameterSpec,
  toHostToolDefinition,
} from "../src/host/dsh-tools-adapter.ts";
import { applyWorkbench, name as pluginName } from "../src/host/plugin.ts";
import {
  createMockDsHHost,
  createStrictToolRegistrar,
  withTempDir,
} from "../support/harness.mjs";

test("applyWorkbench serves Next-Gen HTTP routes, static assets, security headers, and sanitized /diag", async () => {
  assert.equal(pluginName, "zhizhang-workbench");
  const patchYml = readFileSync(new URL("../src/bundle/cordis.patch.yml", import.meta.url), "utf8");
  assert.match(patchYml, /dshHomePath\('zhizhang-v3'\)/);

  await withTempDir("zhizhang-host-", async (dataDirectory) => {
    const toolReg = createStrictToolRegistrar();
    const configForms = { forms: [], register(form) { this.forms.push(form); return () => {}; } };
    const host = createMockDsHHost({ tools: toolReg, configForms, cordis: true });

    applyWorkbench(
      host.ctx,
      { dataDirectory, defaultProvider: "deepseek", defaultModel: "deepseek-chat" },
      { readAsset: host.readAsset },
    );

    try {
      assert.equal(host.routes.has("/api/zhizhang/state"), true);
      assert.equal(host.routes.has("/api/zhizhang/jobs"), true);
      assert.equal(host.routes.has("/api/zhizhang/diag"), true);
      assert.equal(host.routes.has("/api/zhizhang/command"), true);
      assert.equal(host.routes.has("/api/zhizhang/jobs/preview"), true);
      assert.equal(host.routes.has("/api/zhizhang/jobs/start"), true);
      assert.equal(host.routes.has("/api/zhizhang/jobs/cancel"), true);
      assert.equal(host.routes.has("/api/zhizhang/mutate"), false);

      for (const [path, entry] of host.routes.entries()) {
        assert.equal(entry.auth, "required", `Route ${path} must explicitly declare auth: "required"`);
      }

      const htmlRes = await host.get("/workbench");
      assert.equal(htmlRes.status, 200);
      assert.match(htmlRes.headers.get("content-security-policy") ?? "", /default-src 'self'/);
      assert.equal(htmlRes.headers.get("x-content-type-options"), "nosniff");
      assert.equal(htmlRes.headers.get("referrer-policy"), "no-referrer");
      assert.equal(htmlRes.headers.get("cache-control"), "no-store");

      for (const mod of CLIENT_JS_MODULES) {
        const res = await host.get(`/${mod}`);
        assert.equal(res.status, 200, `Missing route for ${mod}`);
      }

      const badCt = await host.postRaw("/command", { contentType: "text/plain", body: "{}" });
      assert.equal(badCt.status, 400);
      assert.equal(badCt.headers.get("x-content-type-options"), "nosniff");

      const diag = await host.getDiag();
      assert.equal(diag.status, 200);
      assert.equal(diag.body.result.version, "3.0.0");
      assert.equal(diag.body.result.schemaId, "zhizhang/3.0");
      assert.equal(diag.body.result.agentToolsRegistered, true);
      assert.equal(JSON.stringify(diag.body).includes(dataDirectory), false);

      assert.equal(configForms.forms.length, 1);
    } finally {
      await host.close();
    }
    assert.equal(host.routes.size, 0);
  });
});

test("declarative product Agent tools register 11 strict tools (7+3 Fanqie, 1 Toutiao) and never mutate drafts", async () => {
  await withTempDir("zhizhang-tools-", async (dataDirectory) => {
    const toolReg = createStrictToolRegistrar();
    const host = createMockDsHHost({ tools: toolReg });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });

    try {
      const names = toolReg.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        "zhizhang_check_conflicts",
        "zhizhang_diagnose_chapter",
        "zhizhang_propose_foreshadow",
        "zhizhang_propose_setting",
        "zhizhang_propose_technique",
        "zhizhang_read_article",
        "zhizhang_read_chapter",
        "zhizhang_read_controls",
        "zhizhang_read_known_facts",
        "zhizhang_read_tree",
        "zhizhang_search_workspace",
      ]);

      // Upstream wire objects must never leak non-standard proposalOnly keys
      for (const tool of toolReg.tools) {
        assert.equal("proposalOnly" in tool, false, `Tool ${tool.name} leaked non-standard proposalOnly key`);
      }

      const writeTools = toolReg.tools.filter((t) => !t.readOnly).map((t) => t.name).sort();
      assert.deepEqual(writeTools, [
        "zhizhang_propose_foreshadow",
        "zhizhang_propose_setting",
        "zhizhang_propose_technique",
      ]);

      const fanqieProj = (await host.command("project.create", { product: "fanqie", name: "测试书" })).body.result.id;
      const chId = (await host.command("document.create", { projectId: fanqieProj, title: "第一章" })).body.result.id;
      await host.command("draft.save", { documentId: chId, baseRevisionId: null, body: "作者原文不可被工具直写。" });

      const treeOut = await toolReg.invoke("zhizhang_read_tree", { projectId: fanqieProj });
      assert.equal(treeOut.chapters.length, 1);

      const propOut = await toolReg.invoke("zhizhang_propose_setting", {
        projectId: fanqieProj,
        documentId: chId,
        factId: "agent-fact",
        note: "来自对话助手的待审设定",
        source: "Agent 提案",
      });
      assert.ok(propOut.id);

      // Author draft unchanged and proposed setting remains pending (unconfirmed)
      const st = (await host.getState({ projectId: fanqieProj, documentId: chId })).body.result;
      assert.equal(st.active.body, "作者原文不可被工具直写。");
      assert.equal(st.settings[0].decision, "pending");

      // Toutiao read tool
      const ttProj = (await host.command("project.create", { product: "toutiao", name: "头条号" })).body.result.id;
      const artId = (await host.command("document.create", { projectId: ttProj, title: "时评", mode: "short", line: "资讯线" })).body.result.id;
      const artOut = await toolReg.invoke("zhizhang_read_article", { projectId: ttProj, documentId: artId });
      assert.equal(artOut.active.title, "时评");
    } finally {
      await host.close();
    }
    assert.equal(toolReg.tools.length, 0);
  });
});

test("dsh-tools-adapter supports DsH flat parameter DSL and client slot mounts settings.plugins.tab", () => {
  const schema = defineParameters(
    {
      projectId: { type: "string", description: "项目 ID" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["projectId"],
  );
  const flat = toFlatParameterSpec(schema);
  assert.deepEqual(flat, {
    projectId: { type: "string", description: "项目 ID", required: true },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  });

  const flatTool = toHostToolDefinition(
    {
      name: "zhizhang_sample_tool",
      description: "测试平铺参数工具",
      readOnly: true,
      proposalOnly: true,
      parameters: schema,
      outputSchema: openOutputSchema("测试返回"),
      execute: () => ({ ok: true }),
    },
    { parameterFormat: "dsh-flat" },
  );
  assert.equal("proposalOnly" in flatTool, false);
  assert.equal(flatTool.parameters.projectId.required, true);

  // Client slot registration covers main, sidebar.panellist, conversation.view, and settings.plugins.tab
  const registered = [];
  const fakeReact = {
    createElement(tag, props, ...children) {
      return { tag, props, children };
    },
  };
  const fakeCtx = {
    apiBase: "https://dsh.example.com/sub/",
    slots: {
      inject(_name, factory) {
        factory();
      },
      register(descriptor, component) {
        registered.push({ descriptor, rendered: component({}) });
      },
    },
  };
  registerWorkbenchSlots(fakeCtx, fakeReact);
  assert.deepEqual(
    registered.map((item) => item.descriptor.name),
    ["main", "sidebar.panellist", "conversation.view", "settings.plugins.tab"],
  );
  const settingsSlot = registered.find((item) => item.descriptor.name === "settings.plugins.tab");
  assert.equal(
    settingsSlot.rendered.props.src,
    "https://dsh.example.com/sub/api/zhizhang/workbench?view=settings",
  );
  assert.equal(resolveWorkbenchUrl({ view: "settings", apiBase: "https://dsh.example.com" }).searchParams.get("view"), "settings");
  assert.equal(createWorkbenchFrameProps({ view: "settings" })["data-zhizhang-view"], "settings");
});
