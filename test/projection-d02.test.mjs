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
  projectWatermark,
  readTail,
  StorageError,
} from "../src/storage/index.ts";

// D-02 conformance for the projection store: the fold driver, the durable
// checkpoints and the cold restore that refuses a stale row, against the
// semantics `readmodel-a01.test.mjs` records and B.7 froze the naming and
// backfill rules for.

// A fixed tiny domain: a run's stage progress plus a counter of unrelated
// noise events, so the "this event is not that unit's" path is exercised.
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

async function withProjection(run) {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-d02-proj-"));
  const path = join(dir, "workspace.sqlite");
  createStore(path);
  const db = openStore(path);
  createEventLogSchema(db);
  createProjectionSchema(db);
  const store = createProjectionStore(db, "proj-1");
  store.register("stage", stageUnit);
  store.register("noise", noiseUnit);
  try {
    return await run({ db, store });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("D-02 committed events take monotonic numbers and one watermark covers every value", async () => {
  await withProjection(({ store }) => {
    store.commit(stageEvent("prepare"));
    store.commit(noiseEvent(1));
    store.commit(stageEvent("write"));

    const snapshot = store.snapshot();
    assert.equal(snapshot.asOfSeq, 3);
    assert.deepEqual(Object.keys(snapshot.values).sort(), ["noise", "stage"]);
    assert.equal(store.seqOf(), snapshot.asOfSeq);
    assert.equal(projectWatermark.length >= 0, true);
  });
});

test("D-02 an event that is not a unit's returns the same state reference and publishes nothing", async () => {
  await withProjection(({ store }) => {
    store.commit(noiseEvent(1));
    const noiseBefore = store.stateRef("noise");
    // A stage event is not the noise unit's event.
    const changes = store.commit(stageEvent("prepare")).changes;
    assert.equal(store.stateRef("noise"), noiseBefore, "an unrelated event must not touch the unit");
    assert.deepEqual(changes, [{ key: "stage", val: { stage: "prepare", submitted: 1 } }]);
  });
});

test("D-02 redelivering an already committed event folds it once", async () => {
  await withProjection(({ store }) => {
    store.commit(stageEvent("prepare"));
    store.commit(stageEvent("write"));
    assert.deepEqual(store.snapshot().values.stage, { stage: "write", submitted: 2 });

    // The same event id is already in the log, so the fold does not run
    // again: nothing is published and the watermark does not move.
    const replay = store.commit(stageEvent("write"));
    assert.deepEqual(replay.changes, []);
    assert.equal(replay.seq, 2);
    assert.equal(store.seqOf(), 2);
    assert.deepEqual(store.snapshot().values.stage, { stage: "write", submitted: 2 });

    // The other redelivery path: a caller that supplies the sequence number
    // of an event at or below the watermark gets nothing folded either.
    const stale = store.commit(stageEvent("write"), 2);
    assert.deepEqual(stale, { seq: 2, changes: [] });
    assert.deepEqual(store.snapshot().values.stage, { stage: "write", submitted: 2 });
  });
});

test("D-02 a change feed publishes the whole current value, never a field-level delta", async () => {
  await withProjection(({ store }) => {
    const seen = [];
    store.onEventChanged((changes) => seen.push(changes));
    store.commit(stageEvent("prepare"));
    store.commit(stageEvent("write"));
    assert.deepEqual(seen, [
      [{ key: "stage", val: { stage: "prepare", submitted: 1 } }],
      [{ key: "stage", val: { stage: "write", submitted: 2 } }],
    ]);
  });
});

test("D-02 a checkpoint plus a forward tail replay reconstructs the same state as a full fold", async () => {
  await withProjection(({ db, store }) => {
    for (const stage of ["prepare", "write", "revise"]) store.commit(stageEvent(stage));
    store.commit(noiseEvent(1));
    const full = store.snapshot();

    const checkpoint = store.checkpoint();
    assert.deepEqual(
      checkpoint.map((row) => row.key).sort(),
      ["noise", "stage"],
    );
    const floor = store.restoreFloor(checkpoint);
    assert.equal(floor, 3, "the floor is one below the lowest stored watermark");

    // The tail starts at the anchor itself; the restore's guard keeps the
    // already-folded anchor from being applied twice.
    const { events, baseSeq } = readTail(db, "proj-1", floor);
    assert.equal(baseSeq, floor);
    assert.deepEqual(events.map((event) => event.seq), [3, 4]);
    const restored = store.restore(checkpoint, events, baseSeq);
    assert.deepEqual(restored, full);
  });
});

test("D-02 an empty tail from the one-below anchor proves a shrunken log and refuses a stale row", async () => {
  await withProjection(({ store }) => {
    store.commit(stageEvent("prepare"));
    store.commit(stageEvent("write"));
    const checkpoint = store.checkpoint();
    const floor = store.restoreFloor(checkpoint);
    assert.equal(floor, 1);

    // The log lost its events: the tail from the anchor is empty, so the end
    // sits below every watermark and the restore must reject rather than
    // serve rows.
    assert.throws(
      () => store.restore(checkpoint, [], floor),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage.format_unsupported" &&
        error.details.reason === "stale-projection-row",
    );
  });
});

test("D-02 a row claiming past the supplied end is refused instead of served", async () => {
  await withProjection(({ store }) => {
    store.commit(stageEvent("prepare"));
    store.commit(stageEvent("write"));
    const checkpoint = store.checkpoint();
    // The supplied tail ends at seq 3, but the row claims seq 5: the row is
    // ahead of the log, so serving it would present unsupported state.
    const ahead = checkpoint.map((row) => ({ ...row, seq: 5 }));
    assert.throws(
      () => store.restore(ahead, [{ seq: 3, payload: stageEvent("revise") }], 3),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage.format_unsupported" &&
        error.details.reason === "stale-projection-row",
    );
  });
});

test("D-02 a version mismatch demands a full re-read, and an empty checkpoint refolds from init", async () => {
  await withProjection(({ db, store }) => {
    store.commit(stageEvent("prepare"));
    store.commit(stageEvent("write"));
    // Only the stage rows: this test is about the version, not the unit set.
    const rows = store.checkpoint().filter((row) => row.key === "stage");

    // The bumped unit cannot read the old row: no usable row exists, and a
    // tail read above seq 0 demands a full re-read instead of serving it.
    const bumped = createProjectionStore(db, "proj-1");
    bumped.register("stage", { ...stageUnit, version: 2 });
    assert.equal(bumped.restoreFloor(rows), undefined);
    assert.throws(
      () => bumped.restore(rows, [], 1),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage.format_unsupported" &&
        error.details.reason === "stale-projection-row" &&
        error.details.key === "stage",
    );

    // From a full re-read a discarded row simply refolds from init, which is
    // sound: an empty checkpoint with the whole log.
    const cold = createProjectionStore(db, "proj-1");
    cold.register("stage", stageUnit);
    const { events, baseSeq } = readTail(db, "proj-1", undefined);
    assert.equal(baseSeq, 1);
    const snapshot = cold.restore([], events, baseSeq);
    assert.deepEqual(snapshot.values.stage, { stage: "write", submitted: 2 });
    assert.equal(snapshot.asOfSeq, 2);
  });
});

test("D-02 a row for a unit this store does not register forces the same full re-read", async () => {
  await withProjection(({ db, store }) => {
    store.commit(stageEvent("prepare"));
    const rows = store.checkpoint();
    // The store below registers only the noise unit, so the stage row is not
    // its own: the noise row still proves a floor, but the foreign row forces
    // the full re-read.
    const partial = createProjectionStore(db, "proj-1");
    partial.register("noise", noiseUnit);
    assert.equal(partial.restoreFloor(rows), 0);
    assert.throws(
      () => partial.restore(rows, [], 1),
      (error) => error instanceof StorageError && error.details.reason === "stale-projection-row",
    );
  });
});

test("D-02 a re-stamped row is usable only once the suffix replay matches the full replay", async () => {
  await withProjection(({ db, store }) => {
    store.commit(stageEvent("prepare"));
    store.commit(stageEvent("write"));
    const rows = store.checkpoint().filter((row) => row.key === "stage");

    // The full replay under the new version: a full re-read from the log,
    // because committing the same event ids again would be a redelivery.
    const { events, baseSeq } = readTail(db, "proj-1", undefined);
    const full = createProjectionStore(db, "proj-1");
    full.register("stage", { ...stageUnit, version: 2 });
    const expected = full.restore([], events, baseSeq).values.stage;
    assert.deepEqual(expected, { stage: "write", submitted: 2 });

    // Re-stamping the rows with the new version and folding only the suffix
    // reaches the same state, which is what makes the re-stamp legitimate.
    const suffix = createProjectionStore(db, "proj-1");
    suffix.register("stage", { ...stageUnit, version: 2 });
    const restamped = rows.map((row) => ({ ...row, ver: 2 }));
    const fromSuffix = suffix.restore(restamped, [{ seq: 2, payload: stageEvent("write") }], 2);
    assert.deepEqual(fromSuffix.values.stage, expected);
    assert.equal(fromSuffix.asOfSeq, 2);
  });
});

test("D-02 when a unit throws mid-drive the event-level feed still receives the earlier changes", async () => {
  await withProjection(({ store }) => {
    store.register("boom", {
      version: 1,
      init: () => ({ hits: 0 }),
      apply() {
        throw new Error("unit failed");
      },
      view: (state) => state,
    });
    const seen = [];
    store.onEventChanged((changes) => seen.push(changes));
    assert.throws(() => store.commit(noiseEvent(1)), /unit failed/);
    assert.deepEqual(seen, [[{ key: "noise", val: { seen: 1 } }]]);
  });
});

test("D-02 a saved checkpoint restores a store after a reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-d02-projreopen-"));
  try {
    const path = join(dir, "workspace.sqlite");
    createStore(path);
    const writer = openStore(path);
    createEventLogSchema(writer);
    createProjectionSchema(writer);
    const first = createProjectionStore(writer, "proj-1");
    first.register("stage", stageUnit);
    first.register("noise", noiseUnit);
    first.commit(stageEvent("prepare"));
    first.commit(noiseEvent(1));
    first.commit(stageEvent("write"));
    first.saveCheckpoint();
    writer.close();

    const reader = openStore(path);
    try {
      createEventLogSchema(reader);
      createProjectionSchema(reader);
      const second = createProjectionStore(reader, "proj-1");
      second.register("stage", stageUnit);
      second.register("noise", noiseUnit);
      const checkpoint = second.loadCheckpoint();
      assert.equal(checkpoint.length, 2);
      const floor = second.restoreFloor(checkpoint);
      assert.equal(floor, 2);
      const { events, baseSeq } = readTail(reader, "proj-1", floor);
      const restored = second.restore(checkpoint, events, baseSeq);
      assert.deepEqual(restored.values, {
        noise: { seen: 1 },
        stage: { stage: "write", submitted: 2 },
      });

      // The restored store keeps committing from the same watermark.
      const after = second.commit(stageEvent("revise"));
      assert.equal(after.seq, 4);
      assert.deepEqual(second.snapshot().values.stage, { stage: "revise", submitted: 3 });
    } finally {
      reader.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-02 a version bump discards the stored row on the next restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-d02-projver-"));
  try {
    const path = join(dir, "workspace.sqlite");
    createStore(path);
    const writer = openStore(path);
    createEventLogSchema(writer);
    createProjectionSchema(writer);
    const first = createProjectionStore(writer, "proj-1");
    first.register("stage", stageUnit);
    first.commit(stageEvent("prepare"));
    first.saveCheckpoint();
    writer.close();

    const reader = openStore(path);
    try {
      createEventLogSchema(reader);
      createProjectionSchema(reader);
      const second = createProjectionStore(reader, "proj-1");
      // The unit's version moved on, so the stored row proves no floor and a
      // tail read above seq 0 is refused: the caller must re-read in full.
      second.register("stage", { ...stageUnit, version: 2 });
      const checkpoint = second.loadCheckpoint();
      assert.equal(second.restoreFloor(checkpoint), undefined);
      assert.throws(() => second.restore(checkpoint, [], 1), (error) => error instanceof StorageError);

      // The full re-read refolds from init and reaches the same state.
      const { events, baseSeq } = readTail(reader, "proj-1", undefined);
      const restored = second.restore([], events, baseSeq);
      assert.deepEqual(restored.values.stage, { stage: "prepare", submitted: 1 });
    } finally {
      reader.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
