import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { touchBuildArtifacts } from "../scripts/deploy.mjs";
import { createZhizhangAgentTools } from "../src/host/tools.ts";
import {
  createMockDsHHost,
  createScriptedLlm,
  createTestWorkspace,
  withTempDir,
} from "../support/v2-harness.mjs";

test("Sprint 4 #1: author_project_controls keeps authorIntent byte-stable in Prefix and rolling arc_plan updates acts & focus", async (t) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "zhizhang-s4-ctrl-"));
  const llm = createScriptedLlm([
    {
      text: JSON.stringify({
        actSummary: "第一幕完成灰塔档案室摸底并确立铜钥匙疑点。",
        nextActTitle: "第二幕 · 地下钟室",
        nextActGoal: "破解停摆钟表机关",
        nextActSummary: "沿通风管进入地下三层",
        pacingTemplate: "悬疑紧迫",
        currentFocus: "第 3–4 章聚焦地下钟室密码试错",
      }),
    },
  ]);
  const host = createMockDsHHost({ llm });
  t.after(async () => {
    await host.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  const { applyWorkbench } = await import("../src/host/plugin.ts");
  applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });

  const projectId = (await host.mutate("project.create", { product: "fanqie", name: "控制面测试书" })).body.result.id;
  await host.mutate("controls.save", {
    projectId,
    authorIntent: "终局打破灰塔百年时间封锁，严禁主角降智。",
    currentFocus: "第 1–2 章围绕失踪编目员借阅卡试探",
  });
  const volId = (await host.mutate("volume.create", { projectId, title: "第一卷" })).body.result.id;
  const act1 = (
    await host.mutate("act.create", {
      projectId,
      volumeId: volId,
      title: "第一幕 · 入馆",
      arcGoal: "拿到值夜钥匙",
      pacingTemplate: "稳推悬疑",
    })
  ).body.result;

  const ch1 = (await host.mutate("document.create", { projectId, title: "第一章", volumeId: volId, actId: act1.id })).body.result.id;
  const rev1 = (await host.mutate("draft.save", { documentId: ch1, baseRevisionId: null, body: "第一章正文内容。" })).body.result.revisionId;
  await host.mutate("chapter.summary.save", { documentId: ch1, summary: "林砚接手灰塔档案馆。" });

  const ch2 = (await host.mutate("document.create", { projectId, title: "第二章", volumeId: volId, actId: act1.id })).body.result.id;
  const rev2 = (await host.mutate("draft.save", { documentId: ch2, baseRevisionId: null, body: "第二章正文内容。" })).body.result.revisionId;

  const r1 = (await host.mutate("run.start", { documentId: ch1, baseRevisionId: rev1, tokenLimit: 14_000, instruction: "写前情" })).body.result.id;
  const r2 = (await host.mutate("run.start", { documentId: ch2, baseRevisionId: rev2, tokenLimit: 14_000, instruction: "写推进" })).body.result.id;
  const d1 = JSON.parse((await host.mutate("run.detail", { documentId: ch1, runId: r1 })).body.result.frozenInput);
  const d2 = JSON.parse((await host.mutate("run.detail", { documentId: ch2, runId: r2 })).body.result.frozenInput);

  assert.ok(d1.contextBundle.stablePrefix.includes("终局打破灰塔百年时间封锁"));
  assert.equal(d1.contextBundle.stablePrefix, d2.contextBundle.stablePrefix, "Prefix must remain byte-identical across chapters");
  assert.ok(d1.contextBundle.dynamicTail.includes("围绕失踪编目员借阅卡试探"));
  assert.ok(d1.contextBundle.dynamicTail.includes("拿到值夜钥匙"));

  const propRes = await host.mutate("proposal.generate", {
    kind: "arc_plan",
    projectId,
    volumeId: volId,
    actId: act1.id,
    provider: "p",
    model: "m",
  });
  assert.equal(propRes.status, 202);
  const pendingProp = await host.waitFor(async () => {
    const res = await host.mutate("proposal.list", { projectId, kind: "arc_plan", status: "pending" });
    return res.body.result[0] ?? null;
  });

  const decideRes = await host.mutate("proposal.decide", {
    proposalId: pendingProp.id,
    volumeId: volId,
    actId: act1.id,
    accept: true,
  });
  assert.equal(decideRes.status, 200);
  assert.equal(decideRes.body.result.committed.updatedActId, act1.id);
  assert.ok(decideRes.body.result.committed.createdActId);

  const controlsAfter = (await host.mutate("controls.get", { projectId })).body.result;
  assert.equal(controlsAfter.currentFocus, "第 3–4 章聚焦地下钟室密码试错");
  const treeAfter = (await host.mutate("tree.get", { projectId })).body.result;
  assert.equal(treeAfter.acts.length, 2);
  assert.equal(treeAfter.acts[0].arcSummary, "第一幕完成灰塔档案室摸底并确立铜钥匙疑点。");
  assert.equal(treeAfter.acts[1].title, "第二幕 · 地下钟室");
});

test("Sprint 4 #2: DsH 7+3 tools, settings registration, and sanitized /api/zhizhang/diag enforce author sovereignty", async (t) => {
  await withTempDir("zhizhang-s4-host-", async (dataDirectory) => {
    const registeredTools = [];
    const registeredForms = [];
    const secretText = "保密原稿正文：林砚藏起了半块翡翠兵符，值得注意的线索都在暗格里。";

    const host = createMockDsHHost();
    host.ctx.tools = {
      register(tool) {
        registeredTools.push(tool);
        return () => {};
      },
    };
    host.ctx.configForms = {
      register(schema) {
        registeredForms.push(schema);
        return () => {};
      },
    };

    const { applyWorkbench } = await import("../src/host/plugin.ts");
    applyWorkbench(
      host.ctx,
      { dataDirectory, defaultProvider: "deepseek-account", defaultModel: "deepseek-flash", enableAgentTools: true },
      { readAsset: host.readAsset },
    );

    try {
      assert.equal(registeredTools.length, 10);
      const readOnlyTools = registeredTools.filter((tool) => tool.readOnly === true);
      const proposalTools = registeredTools.filter((tool) => tool.readOnly === false && tool.proposalOnly === true);
      assert.equal(readOnlyTools.length, 7);
      assert.equal(proposalTools.length, 3);

      assert.equal(registeredForms.length, 1);
      assert.equal(registeredForms[0].tab, "settings.plugins.tab");
      assert.equal(registeredForms[0].fields.length, 3);

      const projectId = (await host.mutate("project.create", { product: "fanqie", name: "工具边界测试" })).body.result.id;
      const volId = (await host.mutate("volume.create", { projectId, title: "卷一" })).body.result.id;
      const documentId = (await host.mutate("document.create", { projectId, title: "第一章", volumeId: volId })).body.result.id;
      await host.mutate("draft.save", { documentId, baseRevisionId: null, body: secretText });
      await host.mutate("controls.save", { projectId, authorIntent: "只许提议不许直改", currentFocus: "首章" });

      const toolByName = new Map(registeredTools.map((tool) => [tool.name, tool]));

      // Exercise all 7 read-only tools
      assert.equal(toolByName.get("zhizhang_read_tree").execute({ projectId }).volumes.length, 1);
      assert.equal(toolByName.get("zhizhang_read_chapter").execute({ projectId, documentId }).active.body, secretText);
      assert.deepEqual(toolByName.get("zhizhang_read_known_facts").execute({ projectId, character: "林砚", chapterId: documentId }).entries, []);
      assert.ok(toolByName.get("zhizhang_search_workspace").execute({ projectId, query: "翡翠兵符" }).length >= 1);
      assert.ok(Array.isArray(toolByName.get("zhizhang_check_conflicts").execute({ projectId })));
      assert.equal(toolByName.get("zhizhang_diagnose_chapter").execute({ documentId }).documentId, documentId);
      assert.equal(toolByName.get("zhizhang_read_controls").execute({ projectId }).authorIntent, "只许提议不许直改");

      // Exercise all 3 proposal tools and prove zero authoritative direct writes
      toolByName.get("zhizhang_propose_setting").execute({
        projectId,
        documentId,
        factId: "jade-token",
        note: "翡翠兵符藏在暗格",
        source: "对话辅助提议",
      });
      toolByName.get("zhizhang_propose_foreshadow").execute({
        projectId,
        documentId,
        title: "暗格兵符伏笔",
        status: "planted",
        note: "第一章埋设",
      });
      toolByName.get("zhizhang_propose_technique").execute({
        projectId,
        title: "暗格物证留白术",
        executionSteps: "先写触感再揭示物件身份",
      });

      assert.equal((await host.mutate("lore.list", { projectId })).body.result.entries.length, 0);
      assert.equal((await host.mutate("foreshadow.list", { projectId })).body.result.length, 0);
      assert.equal((await host.mutate("technique.list", { projectId })).body.result.length, 0);
      const pendingProps = (await host.mutate("proposal.list", { projectId, status: "pending" })).body.result;
      assert.equal(pendingProps.length, 2);
      const snap = (await host.readState({ projectId, documentId })).body.result;
      assert.equal(snap.settings.filter((s) => s.decision === "pending").length, 1);

      // Verify /api/zhizhang/diag returns non-sensitive operational diagnostics only
      const diagRes = await host.get("/diag");
      assert.equal(diagRes.status, 200);
      const diagJson = await diagRes.json();
      assert.equal(diagJson.ok, true);
      assert.equal(diagJson.result.version, "2.2.0");
      assert.equal(diagJson.result.ftsIntegrityOk, true);
      assert.equal(diagJson.result.counts.projects, 1);
      const diagText = JSON.stringify(diagJson);
      assert.equal(diagText.includes("翡翠兵符"), false, "/diag must never leak manuscript contents");
      assert.equal(diagText.includes(dataDirectory), false, "/diag must never leak host filesystem paths");
    } finally {
      await host.close();
    }
  });
});

test("Sprint 4 #3: createZhizhangAgentTools standalone count and dist/server vs dist/client mtime check", async (t) => {
  const { app } = createTestWorkspace(t);
  const tools = createZhizhangAgentTools(app);
  assert.equal(tools.length, 10);

  // When built artifacts exist under dist/, verify split layout + fresh mtime via deploy.mjs
  const rootDir = join(import.meta.dirname, "..");
  const serverEntry = join(rootDir, "dist", "server", "host", "plugin.js");
  const clientSlot = join(rootDir, "dist", "client", "slot.js");
  if (existsSync(serverEntry) && existsSync(clientSlot)) {
    const summary = touchBuildArtifacts(rootDir);
    assert.ok(summary.touchedCount > 0);
    assert.ok(statSync(clientSlot).mtimeMs > summary.minMtimeMs);
    const loadedServer = await import(pathToFileURL(serverEntry).href);
    assert.equal(typeof loadedServer.applyWorkbench, "function");
  }
});
