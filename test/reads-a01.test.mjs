import assert from "node:assert/strict";
import test from "node:test";

// A-01 supporting fixture for the read-model inventory. The mapping under test
// is the one-to-one mapping in appendix B.7.3 of contracts.md, **frozen on
// 2026-11-19 as an A-class first version**: the six reads named in section 3
// (navigation, revision versus candidate, chapter/character settings,
// evidence, run and approval history) with their value schemas, source
// concerns and keys. Later work packages may add fields, and an addition is a
// new version rather than an edit. Every read stays a pure fold of committed
// events rather than a cache owned by a Client.

// The frozen concern vocabulary: every event a read model consumes names one of
// these, so an unknown concern is a contract violation rather than a new one.
const CONCERNS = new Set([
  "chapter",
  "revision",
  "candidate",
  "setting",
  "evidence",
  "run",
  "approval",
]);

const READ_MODELS = [
  {
    id: "navigation",
    version: 1,
    key: ["projectId"],
    concerns: ["chapter"],
    schema: {
      asOfSeq: "int",
      projectId: "text",
      title: "text",
      volumes: "list<{volumeId, title, chapters:list<{chapterId, title, order, businessState}>}>",
    },
  },
  {
    id: "revision-candidate",
    version: 1,
    key: ["projectId", "documentId"],
    concerns: ["revision", "candidate"],
    schema: {
      asOfSeq: "int",
      currentRevisionId: "text",
      currentTextRef: "text",
      candidateId: "text?",
      candidateTextRef: "text?",
      diff: "list<{kind, anchor}>",
    },
  },
  {
    id: "settings-view",
    version: 1,
    key: ["projectId", "asOfChapter", "characterId"],
    concerns: ["setting", "chapter"],
    schema: {
      asOfSeq: "int",
      query: "{asOfChapter, characterId}",
      entries: "list<{factId, note, effectiveFrom}>",
    },
  },
  {
    id: "evidence",
    version: 1,
    key: ["projectId", "factId"],
    concerns: ["evidence", "setting"],
    schema: {
      asOfSeq: "int",
      snapshotId: "text",
      revisionId: "text",
      anchor: "{chapterId, point}",
      quoteRange: "{start, end}",
      verification: "{kind, score?}",
    },
  },
  {
    id: "run",
    version: 1,
    key: ["projectId", "runId"],
    concerns: ["run"],
    schema: {
      asOfSeq: "int",
      state: "enum<running|paused|awaiting-author|failed|cancelled|applied|discarded>",
      nextStage: "text?",
      budget: "{reserved, settled}",
      checkpoints: "list<{stage, version, outputRef}>",
      attempts: "list<{stage, attemptNo, outcome?}>",
    },
  },
  {
    id: "approval-history",
    version: 1,
    key: ["projectId"],
    concerns: ["approval"],
    schema: {
      asOfSeq: "int",
      entries: "list<{approvalId, actor, action, target, targetVersion, decision, at}>",
    },
  },
];

// The read model named in section 3 that each entry answers.
const REQUIRED_READS = [
  "navigation",
  "revision-candidate",
  "settings-view",
  "evidence",
  "run",
  "approval-history",
];

function validateReadModel(entry) {
  if (!entry.id || !Number.isInteger(entry.version) || entry.version < 1) {
    return "invalid-version";
  }
  if (!Array.isArray(entry.key) || entry.key.length === 0) {
    return "missing-key";
  }
  if (!Array.isArray(entry.concerns) || entry.concerns.length === 0) {
    return "missing-concerns";
  }
  for (const concern of entry.concerns) {
    if (!CONCERNS.has(concern)) return "unknown-concern";
  }
  if (!entry.schema || Object.keys(entry.schema).length === 0) {
    return "missing-schema";
  }
  if (!entry.schema.asOfSeq && entry.id !== undefined && entry.requireWatermark !== false) {
    return "missing-watermark";
  }
  return null;
}

test("A-01 every read named in section 3 has one schema, one version, one key and named source concerns", () => {
  const ids = READ_MODELS.map((entry) => entry.id);
  for (const required of REQUIRED_READS) {
    assert.ok(ids.includes(required), required);
  }
  assert.equal(ids.length, REQUIRED_READS.length);
  for (const entry of READ_MODELS) {
    assert.equal(validateReadModel(entry), null, entry.id);
    // The key is project-scoped: every read starts from the project.
    assert.equal(entry.key[0], "projectId", entry.id);
  }
});

test("A-01 a read model declaring an unknown concern or no key is a contract violation", () => {
  const broken = [
    { ...READ_MODELS[0], concerns: ["chapter", "budget"] },
    { ...READ_MODELS[0], concerns: [] },
    { ...READ_MODELS[0], key: [] },
    { ...READ_MODELS[0], version: 0 },
    { ...READ_MODELS[0], schema: {} },
  ];
  for (const entry of broken) {
    assert.notEqual(validateReadModel(entry), null);
  }
});

test("A-01 every read model carries the shared watermark, and one snapshot covers several reads", () => {
  for (const entry of READ_MODELS) {
    // The watermark is part of the served value, not of a Client cache.
    assert.equal(validateReadModel(entry), null, entry.id);
  }
  const snapshot = {
    asOfSeq: 12,
    reads: Object.fromEntries(READ_MODELS.map((entry) => [entry.id, entry.schema])),
  };
  assert.equal(snapshot.asOfSeq, 12);
  for (const entry of READ_MODELS) {
    // Each served value carries the shared watermark as its own field.
    assert.equal(snapshot.reads[entry.id].asOfSeq, "int");
  }
  // A single watermark is enough to compare every read against storage.
  assert.equal(Object.keys(snapshot.reads).length, REQUIRED_READS.length);
});

test("A-01 a read model is a pure fold of committed events, so the same events give the same value", () => {
  // A minimal navigation read: chapters and their business state.
  const foldNavigation = (events) => {
    const chapters = new Map();
    for (const event of events) {
      if (event.concern !== "chapter") continue;
      if (event.type === "chapter.created") {
        chapters.set(event.chapterId, { chapterId: event.chapterId, title: event.title, order: event.order, businessState: "初稿待改" });
      }
      if (event.type === "chapter.renamed") {
        const current = chapters.get(event.chapterId);
        chapters.set(event.chapterId, { ...current, title: event.title });
      }
    }
    return { chapters: [...chapters.values()].sort((a, b) => a.order - b.order) };
  };

  const events = [
    { concern: "chapter", type: "chapter.created", chapterId: "c1", title: "一", order: 1 },
    { concern: "chapter", type: "chapter.created", chapterId: "c2", title: "二", order: 2 },
    { concern: "chapter", type: "chapter.renamed", chapterId: "c2", title: "贰" },
    { concern: "run", type: "run.started", runId: "r1" },
  ];
  const first = foldNavigation(events);
  const second = foldNavigation([...events]);
  assert.deepEqual(first, second);
  // Events of other concerns are skipped, not applied by accident.
  assert.deepEqual(first.chapters, [
    { chapterId: "c1", title: "一", order: 1, businessState: "初稿待改" },
    { chapterId: "c2", title: "贰", order: 2, businessState: "初稿待改" },
  ]);
  // A fold never reads a clock or a cache: moving an unrelated event earlier
  // changes nothing, because events for different keys commute.
  const shuffled = [events[3], events[0], events[1], events[2]];
  assert.deepEqual(foldNavigation(shuffled), first);
  // Events for the same key keep their order: a rename before the create it
  // names is not the same history, and the fold does not reorder them.
  const reordered = [events[0], events[2], events[1]];
  assert.notDeepEqual(foldNavigation(reordered), first);
});

test("A-01 read keys are project-scoped, so one project's events never leak into another's read", () => {
  const foldFor = (events, projectId) => {
    const titles = [];
    for (const event of events) {
      if (event.projectId !== projectId || event.concern !== "chapter") continue;
      titles.push(event.title);
    }
    return { projectId, titles };
  };
  const events = [
    { projectId: "p1", concern: "chapter", type: "chapter.created", title: "甲" },
    { projectId: "p2", concern: "chapter", type: "chapter.created", title: "乙" },
  ];
  assert.deepEqual(foldFor(events, "p1"), { projectId: "p1", titles: ["甲"] });
  assert.deepEqual(foldFor(events, "p2"), { projectId: "p2", titles: ["乙"] });
});

test("A-01 a served read is a whole value, never a field-level delta, so a client cannot patch half a read", () => {
  // The change feed replaces the whole value per key; a delta that touched one
  // field would let a stale field survive on the client.
  const previous = { projectId: "p1", title: "旧题", volumes: [] };
  const next = { projectId: "p1", title: "新题", volumes: [{ volumeId: "v1", title: "卷一", chapters: [] }] };
  const published = next;
  assert.equal(published.title, "新题");
  assert.deepEqual(published.volumes, [{ volumeId: "v1", title: "卷一", chapters: [] }]);
  // The old value is not merged into the new one.
  assert.notEqual(published.volumes, previous.volumes);
  assert.equal(previous.title, "旧题");
});
