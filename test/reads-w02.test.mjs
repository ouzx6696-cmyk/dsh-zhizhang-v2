import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONCERNS,
  READ_MODELS,
  RUN_STATES,
  concernEvents,
  createReadRegistry,
  isConcern,
  readKey,
  serveRead,
  validateReadModel,
  validateReadValue,
} from "../src/workflow/index.ts";
import {
  createEventLogSchema,
  createProjectionSchema,
  createProjectionStore,
  createStore,
  openStore,
} from "../src/storage/index.ts";

// W-02 conformance for the read-model surface, against the six reads
// `reads-a01` records and the rules appendix B.7.3 froze.

const REQUIRED_READS = [
  "navigation",
  "revision-candidate",
  "settings-view",
  "evidence",
  "run",
  "approval-history",
];

test("W-02 every read named in section 3 has one schema, one version, one key and named concerns", () => {
  const ids = READ_MODELS.map((entry) => entry.id);
  assert.deepEqual(ids, REQUIRED_READS);
  for (const entry of READ_MODELS) {
    assert.equal(validateReadModel(entry), null, entry.id);
    // The key is project-scoped: every read starts from the project.
    assert.equal(entry.key[0], "projectId", entry.id);
    assert.equal(entry.version, 1, entry.id);
  }
  // A single registry holds exactly the six frozen reads.
  const registry = createReadRegistry();
  assert.deepEqual(registry.keys(), REQUIRED_READS.map((id) => readKey(id, 1)));
  for (const entry of READ_MODELS) {
    assert.equal(registry.get(entry.id, entry.version), entry);
  }
  assert.equal(registry.get("navigation", 2), undefined);
});

test("W-02 the concern vocabulary is closed, so an unknown concern is a contract violation", () => {
  assert.deepEqual([...CONCERNS], [
    "chapter",
    "revision",
    "candidate",
    "setting",
    "evidence",
    "run",
    "approval",
  ]);
  assert.equal(isConcern("chapter"), true);
  assert.equal(isConcern("budget"), false);
  assert.equal(isConcern(42), false);

  const registry = createReadRegistry();
  const broken = [
    { ...READ_MODELS[0], concerns: ["chapter", "budget"] },
    { ...READ_MODELS[0], concerns: [] },
    { ...READ_MODELS[0], key: [] },
    { ...READ_MODELS[0], version: 0 },
    { ...READ_MODELS[0], schema: {} },
    { ...READ_MODELS[0], key: ["documentId"] },
    { ...READ_MODELS[0], schema: { projectId: { kind: "text" } } },
  ];
  for (const entry of broken) {
    assert.notEqual(validateReadModel(entry), null, JSON.stringify(entry));
    const result = registry.register(entry);
    assert.equal(result.ok, false);
  }
});

test("W-02 a read model registers once, so a redefinition is refused rather than overwriting", () => {
  const registry = createReadRegistry();
  const repeat = registry.register(READ_MODELS[0]);
  assert.equal(repeat.ok, false);
  assert.equal(repeat.code, "idempotency.mismatch");
  assert.equal(repeat.details.key, "navigation@1");
  // The frozen definition is still the one served.
  assert.equal(registry.get("navigation", 1), READ_MODELS[0]);
});

test("W-02 the run read's state enumeration is the frozen run state machine's", () => {
  const run = READ_MODELS.find((entry) => entry.id === "run");
  const state = run.schema.state;
  assert.equal(state.kind, "enum");
  assert.deepEqual(state.values, [...RUN_STATES]);
});

test("W-02 every read carries the shared watermark, and one watermark covers several reads", () => {
  const asOfSeq = 12;
  const served = {
    navigation: serveRead({ projectId: "p1", title: "书名", volumes: [] }, asOfSeq),
    run: serveRead(
      { state: "running", budget: { reserved: 0, settled: 0 }, checkpoints: [], attempts: [] },
      asOfSeq,
    ),
  };
  for (const [id, value] of Object.entries(served)) {
    assert.equal(value.asOfSeq, asOfSeq, id);
    const definition = READ_MODELS.find((entry) => entry.id === id);
    assert.equal(validateReadValue(definition, value), null, id);
  }
  // A value that already carries a different watermark is refused, because
  // that would mean two reads disagree about where they are.
  assert.throws(() => serveRead({ asOfSeq: 11 }, 12));
  assert.throws(() => serveRead({}, 1.5));
});

test("W-02 a served read is a whole value, never a field-level delta", () => {
  const previous = { projectId: "p1", title: "旧题", volumes: [] };
  const next = serveRead({ projectId: "p1", title: "新题", volumes: [{ volumeId: "v1", title: "卷一", chapters: [] }] }, 3);
  // The old value is not merged into the new one.
  assert.notEqual(next.volumes, previous.volumes);
  assert.equal(previous.title, "旧题");
  assert.equal(next.title, "新题");
  const definition = READ_MODELS[0];
  assert.equal(validateReadValue(definition, next), null);
});

test("W-02 the concern filter drops the events a read does not name", () => {
  const events = [
    { concern: "chapter", type: "chapter.created", chapterId: "c1" },
    { concern: "run", type: "run.started", runId: "r1" },
    { concern: "approval", type: "approval.recorded", approvalId: "a1" },
  ];
  assert.deepEqual(concernEvents(events, ["chapter"]), [events[0]]);
  assert.deepEqual(concernEvents(events, ["run", "approval"]), [events[1], events[2]]);
  assert.deepEqual(concernEvents(events, []), []);
});

test("W-02 a read is a pure fold, so the same events give the same value and a fold reads no clock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-w02-reads-"));
  const path = join(dir, "workspace.sqlite");
  createStore(path);
  const db = openStore(path);
  try {
    createEventLogSchema(db);
    createProjectionSchema(db);

    // The navigation read, folded through the projection store.
    const chapterUnit = {
      version: 1,
      init: () => ({ chapters: [] }),
      apply(state, event) {
        if (event.type === "chapter.created") {
          return {
            chapters: [...state.chapters, { chapterId: event.chapterId, title: event.title, order: event.order }],
          };
        }
        if (event.type === "chapter.renamed") {
          return {
            chapters: state.chapters.map((chapter) =>
              chapter.chapterId === event.chapterId ? { ...chapter, title: event.title } : chapter,
            ),
          };
        }
        return state;
      },
      view: (state) => ({ chapters: state.chapters }),
    };
    const events = [
      { id: "e1", type: "chapter.created", chapterId: "c1", title: "一", order: 1 },
      { id: "e2", type: "chapter.created", chapterId: "c2", title: "二", order: 2 },
      { id: "e3", type: "chapter.renamed", chapterId: "c2", title: "贰" },
      { id: "e4", type: "run.started", runId: "r1" },
    ];

    const navigation = createProjectionStore(db, "p1");
    navigation.register("navigation", chapterUnit);
    for (const event of events) navigation.commit(event);
    const first = navigation.snapshot();

    // The same events over another project give the same value: a fold is pure
    // and reads no clock, so nothing but the events decides the result.
    const replay = createProjectionStore(db, "p2");
    replay.register("navigation", chapterUnit);
    for (const event of events) replay.commit(event);
    assert.deepEqual(replay.snapshot().values.navigation, first.values.navigation);
    assert.equal(replay.snapshot().asOfSeq, first.asOfSeq);

    // Events for different concerns are skipped, not applied by accident.
    assert.deepEqual(first.values.navigation.chapters, [
      { chapterId: "c1", title: "一", order: 1 },
      { chapterId: "c2", title: "贰", order: 2 },
    ]);
    assert.equal(first.asOfSeq, 4);

    // Events for the same key keep their order: a rename before the create it
    // names is not the same history.
    const reordered = createProjectionStore(db, "p3");
    reordered.register("navigation", chapterUnit);
    for (const event of [events[0], events[2], events[1]]) reordered.commit(event);
    assert.notDeepEqual(reordered.snapshot().values.navigation, first.values.navigation);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("W-02 read keys are project-scoped, so one project's events never leak into another's read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-w02-scope-"));
  const path = join(dir, "workspace.sqlite");
  createStore(path);
  const db = openStore(path);
  try {
    createEventLogSchema(db);
    createProjectionSchema(db);

    const unit = {
      version: 1,
      init: () => ({ titles: [] }),
      apply: (state, event) => ({ titles: [...state.titles, event.title] }),
      view: (state) => ({ titles: state.titles }),
    };
    // One store per project, each holding its own watermark.
    const first = createProjectionStore(db, "p1");
    first.register("navigation", unit);
    const second = createProjectionStore(db, "p2");
    second.register("navigation", unit);

    first.commit({ id: "a", type: "chapter.created", title: "甲" });
    second.commit({ id: "b", type: "chapter.created", title: "乙" });

    assert.deepEqual(first.snapshot().values.navigation, { titles: ["甲"] });
    assert.deepEqual(second.snapshot().values.navigation, { titles: ["乙"] });
    // A third project's store sees neither.
    const third = createProjectionStore(db, "p3");
    third.register("navigation", unit);
    assert.deepEqual(third.snapshot().values.navigation, { titles: [] });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("W-02 a served value that does not satisfy the frozen schema is refused", () => {
  const navigation = READ_MODELS[0];
  // A missing watermark, a wrong type and a non-integer order are each refused.
  assert.equal(validateReadValue(navigation, { projectId: "p1", title: "t", volumes: [] }), "$.asOfSeq");
  assert.equal(validateReadValue(navigation, { asOfSeq: 1, projectId: 1, title: "t", volumes: [] }), "$.projectId");
  assert.equal(
    validateReadValue(navigation, {
      asOfSeq: 1,
      projectId: "p1",
      title: "t",
      volumes: [{ volumeId: "v1", title: "卷一", chapters: [{ chapterId: "c1", title: "一", order: "1", businessState: "初稿待改" }] }],
    }),
    "$.volumes[0].chapters[0].order",
  );
  const run = READ_MODELS.find((entry) => entry.id === "run");
  assert.equal(
    validateReadValue(run, { asOfSeq: 1, state: "finished", budget: { reserved: 0, settled: 0 }, checkpoints: [], attempts: [] }),
    "$.state",
  );
});
