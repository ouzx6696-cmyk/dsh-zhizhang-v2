import assert from "node:assert/strict";
import test from "node:test";
import { assertThrowsContract, createTestWorkspace } from "../support/v2-harness.mjs";

function prepareFactSync(ws, chapter, payload) {
  const begun = ws.app.beginProposalGeneration({
    kind: "fact_sync",
    projectId: chapter.projectId,
    documentId: chapter.documentId,
    provider: "fixture",
    model: "test",
  });
  ws.app.finishProposalGeneration(begun.id, payload, null);
  return begun.id;
}

function storedPayload(ws, proposalId) {
  return JSON.parse(ws.db.prepare("SELECT payload FROM author_ai_proposals WHERE id = ?;").get(proposalId).payload);
}

function loreEntries(ws, projectId) {
  return ws.app.mutation("lore.list", { projectId }).entries;
}

function seedFact(ws, chapter, factId, entityName, note) {
  const proposal = ws.app.mutation("setting.propose", {
    projectId: chapter.projectId,
    documentId: chapter.documentId,
    factId,
    category: "item",
    entityName,
    note,
    source: "设定集",
    from: { chapterId: chapter.documentId, point: 1 },
    people: [],
  });
  ws.app.mutation("setting.decide", {
    projectId: chapter.projectId,
    documentId: chapter.documentId,
    proposalId: proposal.id,
    accept: true,
  });
}

test("FQ-10 normalisation assigns fq- ids and remaps intra-payload references", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "祠堂暗格里躺着朱雀纹残玉印。" });
  const proposalId = prepareFactSync(ws, chapter, {
    newFacts: [{
      factId: "dup",
      category: "item",
      entityName: "残玉印",
      note: "刻有朱雀纹",
      point: 1,
      people: ["沈青"],
      quote: "朱雀纹残玉印",
    }],
    foreshadowUpdates: [{ title: "印主身份", factId: "dup", status: "planted", note: "暗格" }],
    knownFromUpdates: [{ factId: "dup", character: "沈青", point: 1 }],
  });

  const payload = storedPayload(ws, proposalId);
  const generated = payload.newFacts[0].factId;
  assert.match(generated, /^fq-/);
  assert.notEqual(generated, "dup");
  assert.equal(payload.newFacts[0].originalFactId, "dup");
  assert.equal(payload.foreshadowUpdates[0].factId, generated);
  assert.equal(payload.knownFromUpdates[0].factId, generated);

  const decided = ws.app.mutation("proposal.decide", { proposalId, accept: true });
  assert.equal(decided.status, "approved");
  const foreshadow = ws.app.mutation("foreshadow.list", { projectId: chapter.projectId })
    .find((row) => row.title === "印主身份");
  assert.equal(foreshadow.factId, generated);
});

test("FQ-10 commit generates an id when an edited payload drops factId", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "夜色沉沉。" });
  const proposalId = prepareFactSync(ws, chapter, { newFacts: [] });

  ws.app.mutation("proposal.decide", {
    proposalId,
    accept: true,
    editedPayload: {
      newFacts: [{ category: "location", entityName: "后山石室", note: "夜探石室", point: 1 }],
    },
  });

  const entry = loreEntries(ws, chapter.projectId).find((row) => row.entityName === "后山石室");
  assert.ok(entry);
  assert.match(entry.factId, /^fq-/);
});

test("FQ-10 updates create a new version without moving effectiveFrom or losing metadata", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "第一章正文" });
  seedFact(ws, chapter, "old-fact", "祖先铜钥", "开启祠堂暗格的唯一铜钥");
  const before = loreEntries(ws, chapter.projectId).find((row) => row.factId === "old-fact");
  assert.equal(before.fact.effectiveFrom.point, 1);

  const proposalId = prepareFactSync(ws, chapter, {
    updates: [{ factId: "old-fact", note: "铜钥表面出现新的裂纹", point: 2, people: ["沈青"] }],
  });
  const decided = ws.app.mutation("proposal.decide", { proposalId, accept: true });
  assert.equal(decided.status, "approved");

  const after = loreEntries(ws, chapter.projectId).find((row) => row.factId === "old-fact");
  assert.equal(after.fact.note, "铜钥表面出现新的裂纹");
  assert.equal(after.fact.effectiveFrom.chapterId, chapter.documentId);
  assert.equal(after.fact.effectiveFrom.point, 1);
  assert.equal(after.category, "item");
  assert.equal(after.entityName, "祖先铜钥");
  assert.deepEqual(after.fact.knownFrom["沈青"], { chapterId: chapter.documentId, point: 2 });
});

test("FQ-10 an unknown updates factId refuses the whole decision", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "第一章正文" });
  seedFact(ws, chapter, "old-fact", "祖先铜钥", "唯一铜钥");
  const proposalId = prepareFactSync(ws, chapter, {
    updates: [{ factId: "ghost", note: "并不存在的设定", point: 1 }],
  });

  assertThrowsContract(
    () => ws.app.mutation("proposal.decide", { proposalId, accept: true }),
    "gate.denied",
    { action: "proposal.decide", reason: "unknown-fact-id", factId: "ghost" },
  );

  assert.equal(loreEntries(ws, chapter.projectId).length, 1);
  assert.equal(ws.app.snapshot(chapter.projectId, chapter.documentId).activeContext.syncStatus, "dirty");
});

test("FQ-10 every model-supplied fact id is replaced, including unique ones", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "第一章正文" });
  seedFact(ws, chapter, "dup", "既有设定", "不得被覆写");

  const collision = prepareFactSync(ws, chapter, { newFacts: [] });
  ws.app.mutation("proposal.decide", {
    proposalId: collision,
    accept: true,
    editedPayload: {
      newFacts: [{ factId: "dup", category: "item", entityName: "新实体", note: "撞 id 的提案" }],
    },
  });

  const entries = loreEntries(ws, chapter.projectId);
  assert.equal(entries.find((row) => row.factId === "dup").entityName, "既有设定");
  const created = entries.find((row) => row.entityName === "新实体");
  assert.ok(created);
  assert.match(created.factId, /^fq-/);

  const legacy = prepareFactSync(ws, chapter, { newFacts: [] });
  ws.app.mutation("proposal.decide", {
    proposalId: legacy,
    accept: true,
    editedPayload: {
      newFacts: [{ factId: "legacy-id", category: "item", entityName: "旧提案事实", note: "模型自造 id" }],
    },
  });
  const finalEntries = loreEntries(ws, chapter.projectId);
  assert.equal(finalEntries.some((row) => row.factId === "legacy-id"), false);
  const rewritten = finalEntries.find((row) => row.entityName === "旧提案事实");
  assert.ok(rewritten);
  assert.match(rewritten.factId, /^fq-/);
});

test("B2-5 FQ-10: a hand-written fact_sync proposal gets server-issued ids", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "第一章正文" });
  const created = ws.app.mutation("proposal.create", {
    kind: "fact_sync",
    projectId: chapter.projectId,
    documentId: chapter.documentId,
    payload: {
      newFacts: [{ factId: "model-id", category: "item", entityName: "手工提案实体", note: "模型自造 id" }],
      foreshadowUpdates: [{ title: "引用", factId: "model-id", status: "planted", note: "" }],
      knownFromUpdates: [],
      updates: [],
    },
  });

  const storedId = created.payload.newFacts[0].factId;
  assert.match(storedId, /^fq-/);
  assert.notEqual(storedId, "model-id");
  assert.equal(
    created.payload.foreshadowUpdates[0].factId,
    storedId,
    "intra-payload references must follow the server-issued id",
  );

  // Normalisation is idempotent: deciding the same proposal keeps that id.
  ws.app.mutation("proposal.decide", { proposalId: created.id, accept: true });
  const entries = loreEntries(ws, chapter.projectId);
  assert.ok(entries.some((row) => row.factId === storedId && row.entityName === "手工提案实体"));
  assert.equal(entries.some((row) => row.factId === "model-id"), false);
});

test("FQ-10 retiredFacts are surfaced as unapplied and selected indices filter new facts", (t) => {
  const ws = createTestWorkspace(t);
  const chapter = ws.createFanqieChapter({ body: "第一章正文" });
  seedFact(ws, chapter, "old-fact", "祖先铜钥", "唯一铜钥");

  const retiredId = prepareFactSync(ws, chapter, {
    retiredFacts: [{ factId: "old-fact", point: 2, reason: "下落不明" }],
    newFacts: [
      { category: "item", entityName: "残玉印", note: "第一件" },
      { category: "location", entityName: "后山石室", note: "第二处" },
    ],
  });

  const decided = ws.app.mutation("proposal.decide", {
    proposalId: retiredId,
    accept: true,
    selectedNewFactIndices: [0],
  });
  assert.equal(decided.status, "approved");
  assert.deepEqual(decided.committed.unapplied, ["retiredFacts"]);
  const event = ws.db.prepare(
    "SELECT payload FROM event_log WHERE kind = 'proposal.unapplied' ORDER BY seq DESC LIMIT 1;",
  ).get();
  assert.ok(event);

  const entries = loreEntries(ws, chapter.projectId);
  assert.ok(entries.some((row) => row.entityName === "残玉印"));
  assert.ok(!entries.some((row) => row.entityName === "后山石室"));
  assert.ok(entries.some((row) => row.factId === "old-fact"), "retiredFacts must not delete the fact yet");
});
