import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendEvent,
  createCursor,
  createEventLogSchema,
  createStore,
  currentSeq,
  openStore,
  readEvents,
} from "../src/storage/index.ts";

// D-02 conformance for the event log and its cursor protocol: the rules
// `readmodel-a01.test.mjs` records and contracts.md B.7 froze (cursor naming
// and backfill, 2026-11-19).

async function withLog(run) {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-d02-log-"));
  const path = join(dir, "workspace.sqlite");
  createStore(path);
  const db = openStore(path);
  createEventLogSchema(db);
  try {
    return await run(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function append(db, projectId, eventId, kind, payload) {
  return appendEvent(db, { projectId, eventId, kind, payload });
}

test("D-02 one project keeps one log, and every value shares its watermark", async () => {
  await withLog((db) => {
    // Events of different concerns append to the same project log.
    assert.deepEqual(append(db, "proj-1", "e1", "run.stage", { stage: "prepare" }), { seq: 1, appended: true });
    assert.deepEqual(append(db, "proj-1", "e2", "noise", { seen: 1 }), { seq: 2, appended: true });
    assert.deepEqual(append(db, "proj-1", "e3", "run.stage", { stage: "write" }), { seq: 3, appended: true });
    assert.equal(currentSeq(db, "proj-1"), 3);

    const events = readEvents(db, "proj-1");
    assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
    assert.deepEqual(events.map((event) => event.kind), ["run.stage", "noise", "run.stage"]);
    assert.deepEqual(events[0].payload, { stage: "prepare" });

    // A different project has its own log and its own watermark.
    assert.equal(currentSeq(db, "proj-2"), 0);
    assert.deepEqual(append(db, "proj-2", "e1", "run.stage", { stage: "prepare" }), { seq: 1, appended: true });
    assert.equal(currentSeq(db, "proj-1"), 3);
  });
});

test("D-02 a redelivered event appends nothing and keeps its sequence number", async () => {
  await withLog((db) => {
    const first = append(db, "proj-1", "e1", "run.stage", { stage: "prepare" });
    const replay = append(db, "proj-1", "e1", "run.stage", { stage: "prepare" });
    assert.deepEqual(replay, { seq: first.seq, appended: false });
    assert.equal(currentSeq(db, "proj-1"), 1);
    assert.equal(readEvents(db, "proj-1").length, 1);

    // The next event takes the following number, so no hole is left.
    assert.deepEqual(append(db, "proj-1", "e2", "noise", { seen: 1 }), { seq: 2, appended: true });
  });
});

test("D-02 sequence numbers are monotonic and reads are bounded and ordered", async () => {
  await withLog((db) => {
    for (let index = 1; index <= 5; index += 1) {
      append(db, "proj-1", `e${index}`, "noise", { index });
    }
    assert.deepEqual(readEvents(db, "proj-1").map((event) => event.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(readEvents(db, "proj-1", { afterSeq: 2 }).map((event) => event.seq), [3, 4, 5]);
    assert.deepEqual(readEvents(db, "proj-1", { afterSeq: 4, limit: 1 }).map((event) => event.seq), [5]);
    assert.deepEqual(readEvents(db, "proj-1", { afterSeq: 5 }), []);
  });
});

test("D-02 the log survives a reopen with its watermark intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-d02-logreopen-"));
  try {
    const path = join(dir, "workspace.sqlite");
    createStore(path);
    const writer = openStore(path);
    createEventLogSchema(writer);
    append(writer, "proj-1", "e1", "run.stage", { stage: "prepare" });
    append(writer, "proj-1", "e2", "run.stage", { stage: "write" });
    writer.close();

    const reader = openStore(path);
    try {
      createEventLogSchema(reader);
      assert.equal(currentSeq(reader, "proj-1"), 2);
      assert.equal(readEvents(reader, "proj-1").length, 2);
      // A replay after the reopen still appends nothing.
      assert.deepEqual(append(reader, "proj-1", "e1", "run.stage", { stage: "prepare" }), {
        seq: 1,
        appended: false,
      });
    } finally {
      reader.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-02 a snapshot replaces the consumer's values and sets its cursor", () => {
  const cursor = createCursor();
  assert.equal(cursor.cursor(), 0);
  assert.deepEqual(cursor.values(), {});

  cursor.acceptSnapshot({ asOfSeq: 3, values: { stage: { stage: "write" }, noise: { seen: 1 } } });
  assert.equal(cursor.cursor(), 3);
  assert.deepEqual(cursor.values(), { stage: { stage: "write" }, noise: { seen: 1 } });

  // A later snapshot replaces everything wholesale.
  cursor.acceptSnapshot({ asOfSeq: 7, values: { stage: { stage: "revise" } } });
  assert.equal(cursor.cursor(), 7);
  assert.deepEqual(cursor.values(), { stage: { stage: "revise" } });
});

test("D-02 a backfill that continues the cursor is applied in order", () => {
  const cursor = createCursor();
  cursor.acceptSnapshot({ asOfSeq: 1, values: { stage: { stage: "prepare" } } });

  const applied = cursor.applyBackfill([
    { seq: 2, key: "noise", value: { seen: 1 } },
    { seq: 3, key: "stage", value: { stage: "write" } },
  ]);
  assert.deepEqual(applied, { applied: true, cursor: 3 });
  assert.equal(cursor.cursor(), 3);
  assert.deepEqual(cursor.values(), { noise: { seen: 1 }, stage: { stage: "write" } });

  // An empty batch is a refusal, not a silent success.
  assert.deepEqual(cursor.applyBackfill([]), { applied: false, reason: "empty-backfill" });
  assert.equal(cursor.cursor(), 3);
});

test("D-02 a backfill before any snapshot is refused as no-baseline", () => {
  const cursor = createCursor();
  assert.equal(cursor.hasBaseline(), false);
  // Merging into nothing would drop the keys a snapshot would have carried.
  assert.deepEqual(cursor.applyBackfill([{ seq: 1, key: "stage", value: { stage: "prepare" } }]), {
    applied: false,
    reason: "no-baseline",
  });
  assert.equal(cursor.cursor(), 0);

  cursor.acceptSnapshot({ asOfSeq: 1, values: { stage: { stage: "prepare" } } });
  assert.equal(cursor.hasBaseline(), true);
  assert.deepEqual(cursor.applyBackfill([{ seq: 2, key: "stage", value: { stage: "write" } }]), {
    applied: true,
    cursor: 2,
  });
});

test("D-02 a backfill that starts late is refused wholesale as a gap", () => {
  const cursor = createCursor();
  cursor.acceptSnapshot({ asOfSeq: 1, values: { stage: { stage: "prepare" } } });

  const late = cursor.applyBackfill([{ seq: 3, key: "stage", value: { stage: "write" } }]);
  assert.deepEqual(late, { applied: false, reason: "gap", expected: 2, received: 3 });
  // Nothing was applied: the consumer still holds the snapshot it accepted.
  assert.equal(cursor.cursor(), 1);
  assert.deepEqual(cursor.values(), { stage: { stage: "prepare" } });
});

test("D-02 a backfill that skips an event in the middle is refused wholesale", () => {
  const cursor = createCursor();
  cursor.acceptSnapshot({ asOfSeq: 1, values: { stage: { stage: "prepare" }, noise: { seen: 0 } } });

  const refused = cursor.applyBackfill([
    { seq: 2, key: "noise", value: { seen: 1 } },
    { seq: 4, key: "stage", value: { stage: "write" } },
  ]);
  assert.deepEqual(refused, { applied: false, reason: "gap", expected: 3, received: 4 });
  assert.equal(cursor.cursor(), 1);
  // The first, in-order event was not kept either.
  assert.deepEqual(cursor.values(), { stage: { stage: "prepare" }, noise: { seen: 0 } });

  // The remedy is a full snapshot, not a merge.
  cursor.acceptSnapshot({ asOfSeq: 4, values: { stage: { stage: "write" }, noise: { seen: 1 } } });
  assert.equal(cursor.cursor(), 4);
  assert.deepEqual(cursor.values(), { stage: { stage: "write" }, noise: { seen: 1 } });
});

test("D-02 a backfill repeats an already-held value without moving the cursor", () => {
  const cursor = createCursor();
  cursor.acceptSnapshot({ asOfSeq: 2, values: { stage: { stage: "write" } } });
  // A duplicate of an already-applied event is a gap at the cursor, not a
  // silent no-op: the consumer must be told the batch does not continue.
  const duplicate = cursor.applyBackfill([{ seq: 2, key: "stage", value: { stage: "write" } }]);
  assert.deepEqual(duplicate, { applied: false, reason: "gap", expected: 3, received: 2 });
  assert.equal(cursor.cursor(), 2);
});

test("D-02 the log and the cursor agree on the watermark after a backfill", async () => {
  await withLog((db) => {
    append(db, "proj-1", "e1", "run.stage", { stage: "prepare" });
    append(db, "proj-1", "e2", "noise", { seen: 1 });
    append(db, "proj-1", "e3", "run.stage", { stage: "write" });

    // A consumer that saw only the first event catches up from the change
    // feed: every event after its cursor, in order, one at a time.
    const cursor = createCursor();
    cursor.acceptSnapshot({ asOfSeq: 1, values: { stage: { stage: "prepare" } } });
    for (const event of readEvents(db, "proj-1", { afterSeq: 1 })) {
      const applied = cursor.applyBackfill([
        { seq: event.seq, key: event.kind === "noise" ? "noise" : "stage", value: event.payload },
      ]);
      assert.equal(applied.applied, true);
    }
    assert.equal(cursor.cursor(), currentSeq(db, "proj-1"));
    assert.deepEqual(cursor.values(), {
      stage: { stage: "write" },
      noise: { seen: 1 },
    });
  });
});
