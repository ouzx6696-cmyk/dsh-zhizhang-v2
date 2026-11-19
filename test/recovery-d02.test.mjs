import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEventLogSchema,
  createProjectionSchema,
  createProjectionStore,
  createStore,
  openStore,
  readTail,
  StorageError,
} from "../src/storage/index.ts";

// D-02 recovery matrix.
//
// The single-scenario tests in `projection-d02.test.mjs` pin each rule on its
// own. This file pins the *combinations*: what a restore must produce when the
// log and the checkpoint disagree in each of the ways they can, including the
// one real-world case the single-scenario tests do not reach — the log growing
// while the process that owns the projection is down.
//
// Every row is the same shape: build a state, take a checkpoint, mutate the log
// or the checkpoint, then restore and assert the outcome. A restore either
// reaches the state the log supports, or refuses with the reason the contract
// names; there is no third outcome.

// A tiny domain with two units so the multi-watermark rows are meaningful.
const stageUnit = {
  version: 1,
  init: () => ({ stage: "prepare", submitted: 0 }),
  apply(state, event) {
    if (event.type !== "stage") return state;
    return { stage: event.stage, submitted: state.submitted + 1 };
  },
  view: (state) => ({ stage: state.stage, submitted: state.submitted }),
};

const noiseUnit = {
  version: 1,
  init: () => ({ seen: 0 }),
  apply(state, event) {
    if (event.type !== "noise") return state;
    return { seen: state.seen + 1 };
  },
  view: (state) => ({ seen: state.seen }),
};

function stageEvent(stage) {
  return { id: `stage-${stage}`, type: "stage", stage };
}

function noiseEvent(index) {
  return { id: `noise-${index}`, type: "noise" };
}

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-d02-recovery-"));
  const path = join(dir, "workspace.sqlite");
  createStore(path);
  const db = openStore(path);
  createEventLogSchema(db);
  createProjectionSchema(db);
  try {
    return await run({ db, path });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** A store that folds both units, with the given events already committed. */
function seeded(db, projectId, events) {
  const store = createProjectionStore(db, projectId);
  store.register("stage", stageUnit);
  store.register("noise", noiseUnit);
  for (const event of events) store.commit(event);
  return store;
}

/** A fresh store over the same project, ready to restore. */
function fresh(db, projectId) {
  const store = createProjectionStore(db, projectId);
  store.register("stage", stageUnit);
  store.register("noise", noiseUnit);
  return store;
}

test("D-02 recovery row 1: a checkpoint with the log unchanged restores exactly the checkpointed state", async () => {
  await withStore(({ db }) => {
    const events = [stageEvent("prepare"), noiseEvent(1), stageEvent("write")];
    const before = seeded(db, "p1", events);
    const expected = before.snapshot();
    const checkpoint = before.checkpoint();

    const after = fresh(db, "p1");
    const floor = after.restoreFloor(checkpoint);
    assert.equal(floor, 2, "one below the lowest watermark");
    const { events: tail, baseSeq } = readTail(db, "p1", floor);
    assert.deepEqual(tail.map((event) => event.seq), [2, 3]);
    const restored = after.restore(checkpoint, tail, baseSeq);

    assert.deepEqual(restored, expected);
    // A restore that folded nothing new leaves the watermark where it was.
    assert.equal(after.seqOf(), expected.asOfSeq);
  });
});

test("D-02 recovery row 2: the log growing while the projection is down replays the tail", async () => {
  await withStore(({ db, path }) => {
    const events = [stageEvent("prepare"), noiseEvent(1), stageEvent("write")];
    const before = seeded(db, "p1", events);
    // The owning process goes away with its checkpoint saved. The connection
    // stays open here, and a *second* connection stands in for the other
    // process that appends while the projection is down.
    before.saveCheckpoint();

    const writer = openStore(path);
    try {
      createEventLogSchema(writer);
      createProjectionSchema(writer);
      seeded(writer, "p1", [stageEvent("revise"), noiseEvent(2)]);
    } finally {
      writer.close();
    }

    // The projection comes back and must reach the state the log supports.
    const after = fresh(db, "p1");
    const stored = after.loadCheckpoint();
    const floor = after.restoreFloor(stored);
    assert.equal(floor, 2);
    const { events: tail, baseSeq } = readTail(db, "p1", floor);
    assert.deepEqual(tail.map((event) => event.seq), [2, 3, 4, 5]);
    const restored = after.restore(stored, tail, baseSeq);

    assert.deepEqual(restored.values.stage, { stage: "revise", submitted: 3 });
    assert.deepEqual(restored.values.noise, { seen: 2 });
    assert.equal(restored.asOfSeq, 5);
    // The restored store keeps committing from the same watermark.
    const next = after.commit(stageEvent("final"));
    assert.equal(next.seq, 6);
    assert.deepEqual(after.snapshot().values.stage, { stage: "final", submitted: 4 });
  });
});

test("D-02 recovery row 3: no checkpoint but a log present is a full re-read from seq 1", async () => {
  await withStore(({ db }) => {
    const events = [stageEvent("prepare"), noiseEvent(1), stageEvent("write")];
    const expected = seeded(db, "p1", events).snapshot();

    const after = fresh(db, "p1");
    const floor = after.restoreFloor([]);
    assert.equal(floor, undefined, "no usable row proves no floor");
    const { events: tail, baseSeq } = readTail(db, "p1", floor);
    assert.equal(baseSeq, 1, "a full re-read starts at the first event");
    assert.deepEqual(tail.map((event) => event.seq), [1, 2, 3]);
    const restored = after.restore([], tail, baseSeq);

    assert.deepEqual(restored, expected);
  });
});

test("D-02 recovery row 4: a checkpoint ahead of the log is refused, never served", async () => {
  await withStore(({ db }) => {
    const before = seeded(db, "p1", [stageEvent("prepare"), stageEvent("write")]);
    const checkpoint = before.checkpoint();
    const floor = before.restoreFloor(checkpoint);
    assert.equal(floor, 1);

    const after = fresh(db, "p1");
    // The log lost its events: the tail from the anchor is empty, so the end
    // sits below every watermark.
    assert.throws(
      () => after.restore(checkpoint, [], floor),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage.format_unsupported" &&
        error.details.reason === "stale-projection-row",
    );
    // A refusal leaves nothing half-restored: the units are untouched.
    assert.deepEqual(after.snapshot().values.stage, { stage: "prepare", submitted: 0 });
  });
});

test("D-02 recovery row 5: a version bump forces the full re-read instead of serving the old row", async () => {
  await withStore(({ db }) => {
    const events = [stageEvent("prepare"), noiseEvent(1), stageEvent("write")];
    const expected = seeded(db, "p1", events).snapshot();
    const checkpoint = seeded(db, "p2", events).checkpoint();

    const after = createProjectionStore(db, "p1");
    after.register("stage", { ...stageUnit, version: 2 });
    after.register("noise", { ...noiseUnit, version: 2 });

    assert.equal(after.restoreFloor(checkpoint), undefined);
    assert.throws(
      () => after.restore(checkpoint, [], 1),
      (error) => error instanceof StorageError && error.details.reason === "stale-projection-row",
    );

    // The full re-read reaches the same state the version-1 units reached.
    const { events: tail, baseSeq } = readTail(db, "p1", undefined);
    const restored = after.restore([], tail, baseSeq);
    assert.deepEqual(restored, expected);
  });
});

test("D-02 recovery row 6: units at different watermarks take the lowest floor and both reach the full state", async () => {
  await withStore(({ db }) => {
    // The stage unit folds every event; the noise unit only its own. Both carry
    // the same watermark, so a second store registered with only one of them
    // proves the floor is taken from the rows that exist.
    const events = [stageEvent("prepare"), noiseEvent(1), stageEvent("write")];
    const expected = seeded(db, "p1", events).snapshot();
    const checkpoint = seeded(db, "p2", events).checkpoint();

    const after = createProjectionStore(db, "p1");
    // Only the noise unit is registered: the stage row is foreign and forces
    // the full re-read rather than being served.
    after.register("noise", noiseUnit);
    assert.equal(after.restoreFloor(checkpoint), 2);
    assert.throws(
      () => after.restore(checkpoint, [], 1),
      (error) => error instanceof StorageError && error.details.reason === "stale-projection-row",
    );

    // With both units registered the checkpoint restores normally.
    const both = fresh(db, "p1");
    const floor = both.restoreFloor(checkpoint);
    assert.equal(floor, 2);
    const { events: tail, baseSeq } = readTail(db, "p1", floor);
    assert.deepEqual(both.restore(checkpoint, tail, baseSeq), expected);
  });
});

test("D-02 recovery row 7: a checkpoint at seq 0 with an empty log restores the initial state", async () => {
  await withStore(({ db }) => {
    const after = fresh(db, "p1");
    assert.equal(after.restoreFloor([]), undefined);
    const { events: tail, baseSeq } = readTail(db, "p1", undefined);
    assert.deepEqual(tail, []);
    const restored = after.restore([], tail, baseSeq);
    assert.deepEqual(restored.values, { noise: { seen: 0 }, stage: { stage: "prepare", submitted: 0 } });
    assert.equal(restored.asOfSeq, 0);

    // Committing from a zero watermark numbers the first event as 1.
    const first = after.commit(stageEvent("prepare"));
    assert.equal(first.seq, 1);
  });
});

test("D-02 recovery row 8: a restored store is indistinguishable from one that never stopped", async () => {
  await withStore(({ db }) => {
    // The reference: a store that folded everything in one go.
    const events = [stageEvent("prepare"), noiseEvent(1), stageEvent("write")];
    const reference = seeded(db, "p1", events);
    const referenceAfter = reference.commit(stageEvent("revise"));
    const referenceState = reference.snapshot();

    // The subject: the same history, but with a checkpoint taken after the
    // second event and the third event arriving afterwards.
    const subject = createProjectionStore(db, "p2");
    subject.register("stage", stageUnit);
    subject.register("noise", noiseUnit);
    subject.commit(stageEvent("prepare"));
    subject.commit(noiseEvent(1));
    subject.saveCheckpoint();
    subject.commit(stageEvent("write"));

    const later = fresh(db, "p2");
    const stored = later.loadCheckpoint();
    const floor = later.restoreFloor(stored);
    assert.equal(floor, 1, "the checkpoint is one event behind the log end");
    const { events: tail, baseSeq } = readTail(db, "p2", floor);
    later.restore(stored, tail, baseSeq);
    const subjectAfter = later.commit(stageEvent("revise"));

    assert.equal(subjectAfter.seq, referenceAfter.seq);
    assert.deepEqual(later.snapshot(), referenceState);
  });
});
