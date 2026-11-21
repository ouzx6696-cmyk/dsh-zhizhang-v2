import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyWorkbench } from "../src/host/plugin.ts";
import { openAuthorWorkspace } from "../src/host/workspace.ts";
import { createAuthorSchema } from "../src/storage/author-schema.ts";
import {
  createCommandSchema,
  createDeliverySchema,
  createEventLogSchema,
  openDatabase,
  rebuildProjectFts,
  searchWorkspaceFts,
  verifyFtsIntegrity,
} from "../src/storage/index.ts";
import {
  assertThrowsContract,
  createMockDsHHost,
  createScriptedLlm,
  createTestWorkspace,
  withTempDir,
} from "../support/v2-harness.mjs";

test("Sprint 2 FTS5 External Content migrates legacy schemas, maintains integrity on updates/deletes, rebuilds library, and prevents multi-scope starvation", (t) => {
  // 1. Legacy v2.1.0 standalone FTS tables auto-migrate to External Content + views
  const legacyDb = openDatabase(":memory:");
  try {
    createCommandSchema(legacyDb);
    createEventLogSchema(legacyDb);
    createDeliverySchema(legacyDb);
    createAuthorSchema(legacyDb);
    legacyDb.exec(`
      CREATE VIRTUAL TABLE fts_chapters USING fts5(project_id UNINDEXED, document_id UNINDEXED, title, summary, body, tokenize='trigram');
      CREATE VIRTUAL TABLE fts_lore USING fts5(project_id UNINDEXED, fact_id UNINDEXED, entity_name, note, source, tokenize='trigram');
      CREATE VIRTUAL TABLE fts_library USING fts5(item_id UNINDEXED, item_kind UNINDEXED, scope UNINDEXED, project_id UNINDEXED, title, body, tokenize='trigram');
    `);
    const app = openAuthorWorkspace(legacyDb);
    const { id: pId } = app.mutation("project.create", { product: "fanqie", name: "迁移验证" });
    const chId = app.mutation("document.create", { projectId: pId, title: "旧表升级章" }).id;
    app.mutation("draft.save", { documentId: chId, baseRevisionId: null, body: "玄铁令牌暗藏玄机。" });
    verifyFtsIntegrity(legacyDb);
    assert.ok(searchWorkspaceFts(legacyDb, { projectId: pId, query: "玄铁令牌" }).some((h) => h.id === chId));
  } finally {
    legacyDb.close();
  }

  // 2. Updates, deletes, Toutiao article.rename, rebuildProjectFts library coverage, and anti-starvation RRF
  const ws = createTestWorkspace(t);
  const { id: projectId } = ws.app.mutation("project.create", { product: "fanqie", name: "全库检索引擎" });
  const keyword = "青铜罗盘";

  for (let i = 1; i <= 25; i++) {
    const chId = ws.app.mutation("document.create", { projectId, title: `第${i}章` }).id;
    ws.app.mutation("draft.save", {
      documentId: chId,
      baseRevisionId: null,
      body: `第${i}章线索：${keyword}指针颤动。`,
    });
  }
  const tree = ws.app.mutation("tree.get", { projectId });
  const firstChId = tree.chapters[0].id;
  const rev0 = ws.app.snapshot(projectId, firstChId).active.revisionId;
  // Mutate body & summary after initial sync -> trigger maintains external-content consistency
  ws.app.mutation("draft.save", {
    documentId: firstChId,
    baseRevisionId: rev0,
    body: `第1章已改写：只剩星图印记，再无旧器物。`,
  });
  ws.app.mutation("chapter.summary.save", { documentId: firstChId, summary: "星图密文揭示新去向" });

  for (let i = 1; i <= 3; i++) {
    const prop = ws.app.mutation("setting.propose", {
      projectId,
      documentId: firstChId,
      factId: `compass-lore-${i}`,
      category: "item",
      entityName: `${keyword}${i}`,
      note: `${keyword}核心设定第${i}条`,
      source: "档案",
      from: { chapterId: firstChId, point: 1 },
    });
    ws.app.mutation("setting.decide", { projectId, documentId: firstChId, proposalId: prop.id, accept: true });

    ws.app.mutation("deconstruct.save", {
      scope: "project",
      projectId,
      title: `拆书样本${i}·${keyword}`,
      excerpt: `拆解如何用${keyword}牵引全卷悬念。`,
    });
    ws.app.mutation("technique.save", {
      scope: "project",
      projectId,
      title: `技法${i}·${keyword}`,
      executionSteps: `通过${keyword}串联三条线索。`,
    });
  }

  // Delete one technique card -> integrity check stays clean
  const techToDelete = ws.app.mutation("technique.list", { projectId })[0];
  ws.app.mutation("technique.delete", { id: techToDelete.id, scope: techToDelete.scope, projectId });
  verifyFtsIntegrity(ws.db);

  // rebuildProjectFts covers fts_library too
  ws.db.exec("DELETE FROM fts_rowid_map WHERE scope IN ('deconstruction', 'technique');");
  rebuildProjectFts(ws.db, projectId);
  verifyFtsIntegrity(ws.db);

  // Multi-scope anti-starvation search with limit: 10 guarantees >= 2 hits for every non-empty scope
  const hits = ws.app.mutation("workspace.search", { projectId, query: keyword, limit: 10 });
  assert.equal(hits.length, 10);
  const byScope = new Map();
  for (const hit of hits) {
    byScope.set(hit.scope, (byScope.get(hit.scope) ?? 0) + 1);
  }
  for (const scope of ["chapter", "lore", "deconstruction", "technique"]) {
    assert.ok((byScope.get(scope) ?? 0) >= 2, `Scope ${scope} starved: ${JSON.stringify(hits)}`);
  }
  // Old term removed from first chapter while new summary term matches
  const oldHits = searchWorkspaceFts(ws.db, { projectId, query: keyword, scopes: ["chapter"], limit: 50 });
  assert.equal(oldHits.some((h) => h.id === firstChId), false);
  const newSummaryHits = searchWorkspaceFts(ws.db, { projectId, query: "星图密文", scopes: ["chapter"] });
  assert.ok(newSummaryHits.some((h) => h.id === firstChId));

  // Toutiao renameArticle updates FTS title cleanly (old title disappears, new title matches)
  const toutiao = ws.createToutiaoArticle({ title: "旧头条标题测试", body: "文章主体内容若干。" });
  ws.app.mutation("article.rename", {
    documentId: toutiao.documentId,
    baseRevisionId: toutiao.revisionId,
    title: "新头条标题震撼",
  });
  verifyFtsIntegrity(ws.db);
  assert.equal(searchWorkspaceFts(ws.db, { projectId: toutiao.projectId, query: "旧头条标题", scopes: ["chapter"] }).length, 0);
  assert.equal(searchWorkspaceFts(ws.db, { projectId: toutiao.projectId, query: "新头条标题", scopes: ["chapter"] }).length, 1);
});

test("Sprint 2 continuity memory loop runs dirty -> incremental fact_sync -> atomic CHAPTER_COMMIT -> clean and protects locked facts", async () => {
  await withTempDir("zhizhang-sprint2-memory-", async (dataDirectory) => {
    const llm = createScriptedLlm([
      {
        text: JSON.stringify({
          newFacts: [
            {
              category: "item",
              entityName: "残玉印",
              note: "沈青在祠堂暗格取出刻有朱雀纹的残玉印",
              point: 2,
              people: ["沈青"],
              quote: "朱雀纹残玉印",
            },
          ],
          knownFromUpdates: [{ factId: "ancestral-key", character: "沈青", point: 1 }],
          foreshadowUpdates: [{ title: "朱雀印主身份之谜", status: "hinted", note: "暗格中显露一角" }],
          summaryDraft: "沈青持祖先铜钥开启祠堂暗格，获得朱雀纹残玉印。",
        }),
      },
      {
        text: JSON.stringify({
          newFacts: [{ category: "location", entityName: "后山石室", note: "沈青夜探后山石室" }],
          knownFromUpdates: [{ factId: "secret-map", character: "沈青", point: 2 }],
          summaryDraft: "沈青寻得残玉印后夜探后山石室。",
        }),
      },
    ]);

    const host = createMockDsHHost({ llm });
    applyWorkbench(host.ctx, { dataDirectory }, { readAsset: host.readAsset });
    try {
      const projectId = (await host.mutate("project.create", { name: "记忆闭环传", product: "fanqie" })).body.result.id;
      const ch1 = (await host.mutate("document.create", { projectId, title: "第一章" })).body.result.id;

      // Seed one locked lore fact ("ancestral-key") initially unknown to "沈青"
      const lockedProp = (await host.mutate("setting.propose", {
        projectId,
        documentId: ch1,
        factId: "ancestral-key",
        category: "item",
        entityName: "祖先铜钥",
        note: "开启祠堂暗格的唯一铜钥",
        source: "设定集",
        locked: true,
        from: { chapterId: ch1, point: 1 },
        people: [{ character: "老仆", at: { chapterId: ch1, point: 1 } }],
      })).body.result;
      await host.mutate("setting.decide", { projectId, documentId: ch1, proposalId: lockedProp.id, accept: true });

      // Seed one unlocked lore fact ("secret-map") initially unknown to "沈青"
      const unlockedProp = (await host.mutate("setting.propose", {
        projectId,
        documentId: ch1,
        factId: "secret-map",
        category: "item",
        entityName: "后山舆图",
        note: "绘有后山石室密道入口",
        source: "设定集",
        locked: false,
        from: { chapterId: ch1, point: 1 },
        people: [{ character: "老仆", at: { chapterId: ch1, point: 1 } }],
      })).body.result;
      await host.mutate("setting.decide", { projectId, documentId: ch1, proposalId: unlockedProp.id, accept: true });

      const ch2 = (await host.mutate("document.create", { projectId, title: "第二章" })).body.result.id;
      const bodyV1 = [
        "夜色沉沉，沈青攥紧祖先铜钥步入祠堂。",
        "暗格弹开，露出一方冰凉的朱雀纹残玉印。",
        "风吹熄檐角灯笼，廊下只剩呼吸声。",
      ].join("\n");
      const save1 = await host.mutate("draft.save", { documentId: ch2, baseRevisionId: null, body: bodyV1 });
      const rev1 = save1.body.result.revisionId;

      // Draft save marks memory dirty & indexes entity mentions without LLM calls
      const snapDirty = (await host.readState({ projectId, documentId: ch2 })).body.result;
      assert.equal(snapDirty.activeContext.syncStatus, "dirty");
      const treeDirty = (await host.mutate("tree.get", { projectId })).body.result;
      assert.equal(treeDirty.chapters.find((c) => c.id === ch2).syncStatus, "dirty");

      // Run fact_sync proposal (no synced baseline -> sends full body)
      const gen1 = await host.mutate("proposal.generate", {
        kind: "fact_sync",
        documentId: ch2,
        provider: "fixture",
        model: "test",
      });
      assert.equal(gen1.status, 202);
      const prop1 = await host.waitFor(async () => {
        const list = (await host.mutate("proposal.list", { projectId, kind: "fact_sync", status: "pending" })).body.result;
        return list.find((p) => p.id === gen1.body.result.id) ?? null;
      });
      assert.equal((await host.mutate("lore.list", { projectId })).body.result.entries.length, 2);

      // Locked ancestral-key blocks mutation via knownFromUpdates and rolls back the whole tx atomically!
      const blockedCommit = await host.mutate("proposal.decide", { proposalId: prop1.id, accept: true });
      assert.equal(blockedCommit.status, 409);
      assert.equal(blockedCommit.body.code, "gate.denied");
      assert.equal(blockedCommit.body.details.reason, "setting-is-locked");
      assert.equal((await host.mutate("lore.list", { projectId })).body.result.entries.length, 2);
      assert.equal((await host.readState({ projectId, documentId: ch2 })).body.result.activeContext.syncStatus, "dirty");

      // Author unchecks knownFromUpdates (pass selectedKnownFromIndices: []) -> CHAPTER_COMMIT succeeds atomically!
      const okCommit = await host.mutate("proposal.decide", {
        proposalId: prop1.id,
        accept: true,
        selectedKnownFromIndices: [],
      });
      assert.equal(okCommit.status, 200);
      assert.equal(okCommit.body.result.committed.syncStatus, "clean");
      assert.equal(okCommit.body.result.committed.evidenceIds.length, 1);
      assert.equal(okCommit.body.result.committed.summaryUpdated, true);

      // Verify downstream read models, auto-bound evidence, and clean state
      assert.equal((await host.readState({ projectId, documentId: ch2 })).body.result.activeContext.syncStatus, "clean");
      assert.equal(
        (await host.readState({ projectId, documentId: ch2 })).body.result.activeContext.summary,
        "沈青持祖先铜钥开启祠堂暗格，获得朱雀纹残玉印。",
      );
      const loreAfterCommit = (await host.mutate("lore.list", { projectId })).body.result.entries;
      const jadeSeal = loreAfterCommit.find((entry) => entry.entityName === "残玉印").factId;
      assert.match(jadeSeal, /^fq-/);
      const evDetail = (await host.mutate("evidence.detail", { documentId: ch2, factId: jadeSeal })).body.result;
      assert.equal(evDetail.value.snapshotId, okCommit.body.result.committed.evidenceIds[0]);
      assert.equal(evDetail.value.anchor.point, "2");
      const settingsView = (await host.mutate("read.model", {
        projectId,
        model: "settings-view",
        asOfChapter: ch2,
        point: 2,
        characterId: "沈青",
      })).body.result;
      assert.ok(settingsView.value.entries.some((e) => e.factId === jadeSeal));

      // Edit ONLY paragraph 2 -> flips dirty again, second fact_sync sends ONLY changed paragraph, and commits knownFromUpdates cleanly!
      const bodyV2 = [
        "夜色沉沉，沈青攥紧祖先铜钥步入祠堂。",
        "暗格深处竟然绘着后山石室的舆图！",
        "风吹熄檐角灯笼，廊下只剩呼吸声。",
      ].join("\n");
      await host.mutate("draft.save", { documentId: ch2, baseRevisionId: rev1, body: bodyV2 });
      assert.equal((await host.readState({ projectId, documentId: ch2 })).body.result.activeContext.syncStatus, "dirty");

      const gen2 = await host.mutate("proposal.generate", {
        kind: "fact_sync",
        documentId: ch2,
        provider: "fixture",
        model: "test",
      });
      const prop2 = await host.waitFor(async () => {
        const list = (await host.mutate("proposal.list", { projectId, kind: "fact_sync", status: "pending" })).body.result;
        return list.find((p) => p.id === gen2.body.result.id) ?? null;
      });
      const promptPayload = JSON.parse(llm.calls[1].options.messages[0].content[0].text);
      assert.equal(promptPayload.hasBaseline, true);
      assert.equal(promptPayload.changedParagraphCount, 1);
      assert.ok(promptPayload.sourceText.includes("后山石室"));
      assert.equal(promptPayload.sourceText.includes("风吹熄檐角灯笼"), false);

      const commit2 = await host.mutate("proposal.decide", { proposalId: prop2.id, accept: true });
      assert.equal(commit2.status, 200);
      const settingsAfterKnownUpdate = (await host.mutate("read.model", {
        projectId,
        model: "settings-view",
        asOfChapter: ch2,
        point: 2,
        characterId: "沈青",
      })).body.result;
      assert.ok(settingsAfterKnownUpdate.value.entries.some((e) => e.factId === "secret-map"));
    } finally {
      await host.close();
    }
  });
});

test("Sprint 2 4D zero-token related historical chapter recall excludes recent 5 and ranks foreshadow, knownFrom, entity overlap, and BM25", (t) => {
  const ws = createTestWorkspace(t);
  const { id: projectId } = ws.app.mutation("project.create", { product: "fanqie", name: "四维召回传" });

  const chIds = [];
  for (let i = 1; i <= 9; i++) {
    chIds.push(ws.app.mutation("document.create", { projectId, title: `第${i}章` }).id);
  }
  const [ch1, ch2, ch3] = chIds;
  const ch9 = chIds[8];

  // Register characters before saving drafts so author_chapter_entities captures mentions automatically
  for (const [factId, name, chAt] of [
    ["char-lin", "林清风", ch1],
    ["char-su", "苏暮雪", ch2],
  ]) {
    const p = ws.app.mutation("setting.propose", {
      projectId,
      documentId: chAt,
      factId,
      category: "character",
      entityName: name,
      note: `${name}角色设定`,
      source: "大纲",
      from: { chapterId: chAt, point: 1 },
      people: [{ character: name, at: { chapterId: chAt, point: 1 } }],
    });
    ws.app.mutation("setting.decide", { projectId, documentId: chAt, proposalId: p.id, accept: true });
  }

  // KnownFrom origin in ch2 for viewpoint 林清风
  const secretProp = ws.app.mutation("setting.propose", {
    projectId,
    documentId: ch2,
    factId: "blood-jade-secret",
    category: "world_rule",
    entityName: "血玉秘辛",
    note: "血玉唯有林氏后裔可催动",
    source: "传记",
    locked: true,
    from: { chapterId: ch2, point: 1 },
    people: [{ character: "林清风", at: { chapterId: ch2, point: 1 } }],
  });
  ws.app.mutation("setting.decide", { projectId, documentId: ch2, proposalId: secretProp.id, accept: true });

  // Unrecovered foreshadow in ch1 explicitly targeting ch9
  ws.app.mutation("foreshadow.upsert", {
    projectId,
    title: "青铜古匣之约",
    plantedChapterId: ch1,
    targetChapterId: ch9,
    status: "planted",
    note: "留待第九章开启",
  });

  // Historical ch3 has multi-character co-occurrence + shared BM25 phrase
  ws.app.mutation("draft.save", {
    documentId: ch3,
    baseRevisionId: null,
    body: "林清风与苏暮雪在落雁崖合力开启北海玄冰窟，取出旧地图。",
  });
  ws.app.mutation("chapter.summary.save", { documentId: ch3, summary: "林清风与苏暮雪初探北海玄冰窟。" });

  // Recent 5 chapters ch4..ch8 also mention林清风 — must STILL be excluded by recent-5 window!
  for (let i = 3; i < 8; i++) {
    ws.app.mutation("draft.save", {
      documentId: chIds[i],
      baseRevisionId: null,
      body: `第${i + 1}章过渡，林清风赶路途中提到北海玄冰窟。`,
    });
  }

  // Current chapter ch9 setup
  ws.app.mutation("draft.save", {
    documentId: ch9,
    baseRevisionId: null,
    body: "林清风与苏暮雪重临北海玄冰窟。",
  });
  ws.app.mutation("chapter.outline", {
    documentId: ch9,
    viewpoint: "林清风",
    target: 2500,
    lockedFacts: "北海玄冰窟，blood-jade-secret",
    knowledge: "林清风已从血玉秘辛知晓真相",
    剧情梗概: "第九章开启青铜古匣并重探北海玄冰窟",
    核心冲突与看点: "苏暮雪同林清风对峙守门人",
    情节推进节点: "开启古匣",
    章末落点: "冰门开启",
  });

  const preview = ws.app.mutation("context.preview", { documentId: ch9, instruction: "深入北海玄冰窟" });
  const recalledIds = preview.relatedChapters.map((r) => r.chapterId);
  assert.ok(recalledIds.includes(ch1), `Expected ch1 foreshadow recall, got ${JSON.stringify(preview.relatedChapters)}`);
  assert.ok(recalledIds.includes(ch2), `Expected ch2 knownFrom recall, got ${JSON.stringify(preview.relatedChapters)}`);
  assert.ok(recalledIds.includes(ch3), `Expected ch3 co-occurrence/BM25 recall, got ${JSON.stringify(preview.relatedChapters)}`);
  for (const recentId of chIds.slice(3, 8)) {
    assert.equal(recalledIds.includes(recentId), false, `Recent chapter ${recentId} should be excluded`);
  }
  assert.ok(preview.report.slots.find((s) => s.id === "relatedHistory").includedTokens > 0);
});

test("Sprint 2 keyset lore pagination handles >200 entries without truncation and splits + event watermarks match plan gates", (t) => {
  const ws = createTestWorkspace(t);
  const ch = ws.createFanqieChapter({ title: "设定分页章", body: "设定压测正文。" });
  const projectId = ch.projectId;

  for (let i = 1; i <= 215; i++) {
    const p = ws.app.mutation("setting.propose", {
      projectId,
      documentId: ch.documentId,
      factId: `lore-${String(i).padStart(3, "0")}`,
      category: "world_rule",
      entityName: `规则${i}`,
      note: `第${i}条规则说明`,
      source: "批测试",
      from: { chapterId: ch.documentId, point: 1 },
    });
    ws.app.mutation("setting.decide", { projectId, documentId: ch.documentId, proposalId: p.id, accept: true });
  }

  // Paginate with limit: 60 until cursor === null
  const seen = new Set();
  let cursor;
  let pages = 0;
  do {
    const res = ws.app.mutation("lore.list", { projectId, limit: 60, ...(cursor ? { cursor } : {}) });
    pages += 1;
    for (const entry of res.entries) {
      assert.equal(seen.has(entry.factId), false, `Duplicate factId ${entry.factId}`);
      seen.add(entry.factId);
    }
    cursor = res.cursor;
  } while (cursor !== null);

  assert.equal(pages, 4);
  assert.equal(seen.size, 215);

  // Verify split hotspot modules are strictly < 350 lines
  const splitFiles = [
    "../src/application/products/fanqie/library.ts",
    "../src/application/products/fanqie/library-crud.ts",
    "../src/application/products/fanqie/library-mount.ts",
    "../src/application/products/fanqie/proposal-decide.ts",
    "../src/application/products/toutiao/index.ts",
    "../src/application/products/toutiao/generation.ts",
    "../src/application/products/toutiao/workflow.ts",
    "../src/application/products/toutiao/delivery.ts",
  ];
  for (const rel of splitFiles) {
    const lines = readFileSync(new URL(rel, import.meta.url), "utf8").split(/\r?\n/).length;
    assert.ok(lines < 350, `Expected ${rel} < 350 lines, found ${lines}`);
  }

  // Verify every hierarchy / library / proposal operation advances projectSeq
  let seq = ws.app.projectSeq(projectId);
  const vol = ws.app.mutation("volume.create", { projectId, title: "卷一" });
  assert.ok(ws.app.projectSeq(projectId) > seq); seq = ws.app.projectSeq(projectId);

  const act = ws.app.mutation("act.create", { projectId, volumeId: vol.id, title: "幕一" });
  assert.ok(ws.app.projectSeq(projectId) > seq); seq = ws.app.projectSeq(projectId);

  ws.app.mutation("act.update", { projectId, actId: act.id, goal: "更新目标" });
  assert.ok(ws.app.projectSeq(projectId) > seq); seq = ws.app.projectSeq(projectId);

  ws.app.mutation("act.delete", { projectId, actId: act.id });
  assert.ok(ws.app.projectSeq(projectId) > seq); seq = ws.app.projectSeq(projectId);

  ws.app.mutation("volume.update", { projectId, volumeId: vol.id, summary: "更新卷摘要" });
  assert.ok(ws.app.projectSeq(projectId) > seq); seq = ws.app.projectSeq(projectId);

  ws.app.mutation("volume.delete", { projectId, volumeId: vol.id });
  assert.ok(ws.app.projectSeq(projectId) > seq); seq = ws.app.projectSeq(projectId);

  const dec = ws.app.mutation("deconstruct.save", { scope: "project", projectId, title: "拆书", excerpt: "节选" });
  assert.ok(ws.app.projectSeq(projectId) > seq); seq = ws.app.projectSeq(projectId);

  const tech = ws.app.mutation("technique.save", { scope: "project", projectId, title: "技法", executionSteps: "步骤" });
  assert.ok(ws.app.projectSeq(projectId) > seq); seq = ws.app.projectSeq(projectId);

  ws.app.mutation("library.mount", { projectId, targetType: "project", itemKind: "technique", itemId: tech.id });
  assert.ok(ws.app.projectSeq(projectId) > seq); seq = ws.app.projectSeq(projectId);

  ws.app.mutation("library.unmount", { projectId, targetType: "project", itemKind: "technique", itemId: tech.id });
  assert.ok(ws.app.projectSeq(projectId) > seq); seq = ws.app.projectSeq(projectId);

  const mp = ws.app.mutation("proposal.create", { kind: "summary", projectId, documentId: ch.documentId, payload: { summary: "s" } });
  assert.ok(ws.app.projectSeq(projectId) > seq); seq = ws.app.projectSeq(projectId);

  ws.app.mutation("proposal.decide", { proposalId: mp.id, accept: false });
  assert.ok(ws.app.projectSeq(projectId) > seq); seq = ws.app.projectSeq(projectId);

  ws.app.mutation("deconstruct.delete", { id: dec.id, scope: "project", projectId });
  assert.ok(ws.app.projectSeq(projectId) > seq);
});

test("Sprint 2 io.ts bundle export/import restores foreshadows & mounts and is idempotent on repeat imports", (t) => {
  const ws = createTestWorkspace(t);
  const { id: srcProjId } = ws.app.mutation("project.create", { product: "fanqie", name: "无损导入源书" });
  const v1 = ws.app.mutation("volume.create", { projectId: srcProjId, title: "第一卷" });
  const a1 = ws.app.mutation("act.create", { projectId: srcProjId, volumeId: v1.id, title: "第一幕" });
  const ch1 = ws.app.mutation("document.create", { projectId: srcProjId, title: "开端", volumeId: v1.id, actId: a1.id }).id;
  const ch2 = ws.app.mutation("document.create", { projectId: srcProjId, title: "呼应", volumeId: v1.id, actId: a1.id }).id;
  ws.app.mutation("draft.save", { documentId: ch1, baseRevisionId: null, body: "第一章初稿。" });
  ws.app.mutation("draft.save", { documentId: ch2, baseRevisionId: null, body: "第二章初稿。" });

  const prop = ws.app.mutation("setting.propose", {
    projectId: srcProjId,
    documentId: ch1,
    factId: "old-watch",
    category: "item",
    entityName: "怀表",
    note: "怀表停在三点一刻",
    source: "第一章",
    from: { chapterId: ch1, point: 1 },
  });
  ws.app.mutation("setting.decide", { projectId: srcProjId, documentId: ch1, proposalId: prop.id, accept: true });

  ws.app.mutation("foreshadow.upsert", {
    projectId: srcProjId,
    title: "三点一刻之谜",
    factId: "old-watch",
    plantedChapterId: ch1,
    targetChapterId: ch2,
    status: "planted",
    note: "第二章回收",
  });

  const projDec = ws.app.mutation("deconstruct.save", {
    scope: "project",
    projectId: srcProjId,
    title: "本书专属拆书",
    sourceBook: "源书甲",
    excerpt: "开篇节奏示例。",
  });
  const projTech = ws.app.mutation("technique.save", {
    scope: "project",
    projectId: srcProjId,
    title: "本书专属技法",
    category: "foreshadow",
    executionSteps: "章末留半句。",
  });
  ws.app.mutation("library.mount", {
    projectId: srcProjId,
    targetType: "chapter",
    targetId: ch1,
    itemKind: "technique",
    itemId: projTech.id,
    mode: "pin",
  });
  ws.app.mutation("library.mount", {
    projectId: srcProjId,
    targetType: "act",
    targetId: a1.id,
    itemKind: "deconstruction",
    itemId: projDec.id,
    mode: "include",
  });

  const bundle = ws.app.mutation("project.export_bundle", { projectId: srcProjId });

  // 1. First import into fresh cloned project restores chapters, lore, foreshadows, library items, and mounts
  const firstImport = ws.app.mutation("project.import_bundle", { projectName: "复刻新书", files: bundle.files });
  const clonedId = firstImport.projectId;
  assert.equal(firstImport.chaptersCreated, 2);
  assert.equal(firstImport.loreProposed, 1);
  assert.equal(firstImport.foreshadowsImported, 1);
  assert.equal(firstImport.libraryImported, 2);
  assert.equal(firstImport.mountsRestored, 2);

  const clonedTree = ws.app.mutation("tree.get", { projectId: clonedId });
  const clonedCh1 = clonedTree.chapters.find((c) => c.title === "开端").id;
  const clonedFs = ws.app.mutation("foreshadow.list", { projectId: clonedId });
  assert.equal(clonedFs.length, 1);
  assert.equal(clonedFs[0].plantedChapterId, clonedCh1);

  const clonedMounts = ws.app.mutation("library.mounts", { projectId: clonedId });
  assert.equal(clonedMounts.length, 2);
  assert.ok(clonedMounts.some((m) => m.targetType === "chapter" && m.targetId === clonedCh1));

  // 2. Second import of the EXACT same bundle into the cloned project produces ZERO duplicates!
  const secondImport = ws.app.mutation("project.import_bundle", { projectId: clonedId, files: bundle.files });
  assert.equal(secondImport.volumesCreated, 0);
  assert.equal(secondImport.actsCreated, 0);
  assert.equal(secondImport.chaptersCreated, 0);
  assert.equal(secondImport.chaptersUpdated, 0);
  assert.equal(secondImport.loreProposed, 0);
  assert.equal(secondImport.foreshadowsImported, 0);
  assert.equal(secondImport.libraryImported, 0);
  assert.equal(secondImport.mountsRestored, 0);

  assert.equal(ws.app.mutation("tree.get", { projectId: clonedId }).chapters.length, 2);
  assert.equal(ws.app.mutation("foreshadow.list", { projectId: clonedId }).length, 1);
  assert.equal(ws.app.mutation("library.mounts", { projectId: clonedId }).length, 2);
  assert.equal(ws.app.snapshot(clonedId, clonedCh1).settings.length, 1);
});
