import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { READ_MODELS, readKey } from "../src/workflow/readmodels.ts";
import { serveReadFromLog } from "../src/workflow/readserve.ts";
import {
  StorageError,
  appendEvent,
  createEventLogSchema,
  createProjectionSchema,
  createProjectionStore,
  createStore,
  currentSeq,
  openStore,
  readTail,
} from "../src/storage/index.ts";

// W-02 conformance for `serveReadFromLog`: the join between the event log, the
// projection store and the frozen read surface, pinned by `readmodel-a01` and
// `readmodel-d02`.
//
// The fold here is a deliberately trivial test unit. The point of these tests is
// the join — that a read folds only its own concerns, at the log's own sequence,
// against its own frozen schema, under the shared watermark — not any read's
// meaning, which is the domain's half and is not frozen yet.

const RUN_DEFINITION = READ_MODELS.find((entry) => entry.id === "run");
const NAV_DEFINITION = READ_MODELS.find((entry) => entry.id === "navigation");
const APPROVAL_DEFINITION = READ_MODELS.find((entry) => entry.id === "approval-history");
assert.ok(RUN_DEFINITION && NAV_DEFINITION && APPROVAL_DEFINITION);

/**
 * A fold whose view satisfies the `run` read's frozen schema, and which records
 * each folded event as an attempt so a test can count what was folded.
 */
function runUnit() {
  return {
    version: RUN_DEFINITION.version,
    init: () => ({
      state: "running",
      nextStage: null,
      budget: { reserved: 0, settled: 0 },
      checkpoints: [],
      attempts: [],
    }),
    apply: (state, event) => {
      // A unit consumes the events its read names a concern for and ignores the
      // rest; that filtering is the unit's job, not the serve's.
      if (event.concern !== "run") return state;
      const value = event;
      return {
        ...state,
        attempts: [
          ...state.attempts,
          { stage: typeof value.kind === "string" ? value.kind : "unknown", attemptNo: state.attempts.length + 1, outcome: null },
        ],
      };
    },
    view: (state) => state,
  };
}

/**
 * A fold whose view satisfies the `navigation` read's frozen schema, and which
 * records each folded event as a volume so a test can count what was folded.
 */
function navUnit() {
  return {
    version: NAV_DEFINITION.version,
    init: () => ({ projectId: "", title: "", volumes: [] }),
    apply: (state, event) => {
      // A unit consumes the events its read names a concern for and ignores the
      // rest; that filtering is the unit's job, not the serve's.
      if (event.concern !== "chapter") return state;
      return {
        projectId: "project-1",
        title: "项目",
        volumes: [
          ...state.volumes,
          {
            volumeId: `v${state.volumes.length + 1}`,
            title: "卷一",
            chapters: [
              {
                chapterId: String(event.eventId),
                title: "章",
                order: state.volumes.length + 1,
                businessState: "draft",
              },
            ],
          },
        ],
      };
    },
    view: (state) => state,
  };
}

function unitKeyFor(definition) {
  return readKey(definition.id, definition.version);
}

async function withRead(run) {
  const dir = await mkdtemp(join(tmpdir(), "zhizhang-w02-readserve-"));
  const path = join(dir, "workspace.sqlite");
  createStore(path);
  const db = openStore(path);
  createEventLogSchema(db);
  createProjectionSchema(db);
  try {
    return await run(db, "project-1");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function storeFor(db, projectId, definition, unit) {
  const store = createProjectionStore(db, projectId);
  store.register(unitKeyFor(definition), unit);
  return store;
}

function log(db, projectId, eventId, concern, extra = {}) {
  appendEvent(db, {
    projectId,
    eventId,
    kind: `${concern}.changed`,
    payload: { concern, eventId, ...extra },
  });
}

test("W-02 one serve drives every event once, and each unit consumes only its own concerns", async () => {
  await withRead((db, projectId) => {
    log(db, projectId, "e1", "run");
    log(db, projectId, "e2", "chapter");
    log(db, projectId, "e3", "run", { seq: 300, eventId: "payload-label", kind: "payload-label" });
    log(db, projectId, "e4", "revision");

    const unit = runUnit();
    const store = storeFor(db, projectId, RUN_DEFINITION, unit);
    const served = serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit });

    // The serve drives the whole tail, because one shared watermark advances
    // every registered unit on a single pass.
    assert.equal(served.folded, 4);
    // The unit itself consumes only the two `run` events.
    assert.equal(served.value.attempts.length, 2);
    assert.equal(served.value.attempts[1].stage, "run.changed");
  });
});

test("W-02 a served value is stamped with the shared watermark the log is at", async () => {
  await withRead((db, projectId) => {
    log(db, projectId, "e1", "run");
    log(db, projectId, "e2", "run");
    const unit = runUnit();
    const store = storeFor(db, projectId, RUN_DEFINITION, unit);
    const served = serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit });

    assert.equal(served.asOfSeq, currentSeq(db, projectId));
    assert.equal(served.asOfSeq, 2);
    // The watermark is part of the value, so one watermark compares every read.
    assert.equal(served.value.asOfSeq, 2);
    assert.equal(served.key, unitKeyFor(RUN_DEFINITION));
  });
});

test("W-02 a redelivered event folds nothing, so a re-serve is a no-op", async () => {
  await withRead((db, projectId) => {
    log(db, projectId, "e1", "run");
    const unit = runUnit();
    const store = storeFor(db, projectId, RUN_DEFINITION, unit);

    const first = serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit });
    assert.equal(first.value.attempts.length, 1);

    // Serving again over the same log must not double-apply.
    const second = serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit });
    assert.equal(second.folded, 0, "a redelivered event folds nothing");
    assert.equal(second.value.attempts.length, 1);
    assert.equal(second.asOfSeq, first.asOfSeq);
  });
});

test("W-02 paging with afterSeq continues from the watermark the caller holds", async () => {
  await withRead((db, projectId) => {
    log(db, projectId, "e1", "run");
    log(db, projectId, "e2", "run");
    const unit = runUnit();
    const store = storeFor(db, projectId, RUN_DEFINITION, unit);

    const first = serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit });
    assert.equal(first.folded, 2);

    const cold = storeFor(db, projectId, RUN_DEFINITION, unit);
    assert.throws(
      () => serveReadFromLog(db, projectId, cold, { definition: RUN_DEFINITION, unit }, { afterSeq: first.asOfSeq }),
      (error) => error instanceof StorageError && error.details.field === "afterSeq",
    );
    assert.equal(cold.seqOf(), 0);

    log(db, projectId, "e3", "run");
    const second = serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit }, { afterSeq: first.asOfSeq });

    assert.equal(second.folded, 1, "only the events after the caller's watermark");
    assert.equal(second.value.attempts.length, 3);
    assert.equal(second.asOfSeq, 3);
  });
});

test("W-02 a bounded read serves what it read and reports where it stopped", async () => {  await withRead((db, projectId) => {
    for (let index = 1; index <= 4; index += 1) log(db, projectId, `e${index}`, "run");
    const unit = runUnit();
    const store = storeFor(db, projectId, RUN_DEFINITION, unit);

    const first = serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit }, { limit: 2 });

    assert.equal(first.folded, 2);
    assert.equal(first.asOfSeq, 2);
    assert.equal(first.value.attempts.length, 2);
    // The caller pages on from the watermark it was given.
    const rest = serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit }, { afterSeq: first.asOfSeq });
    assert.equal(rest.folded, 2);
    assert.equal(rest.value.attempts.length, 4);

    const cold = storeFor(db, projectId, RUN_DEFINITION, unit);
    db.prepare("DELETE FROM event_log WHERE project_id = ? AND seq = 2;").run(projectId);
    assert.throws(
      () => serveReadFromLog(db, projectId, cold, { definition: RUN_DEFINITION, unit }),
      (error) => error instanceof StorageError && error.details.reason === "event-log-gap",
    );
    assert.equal(cold.seqOf(), 0, "a page with a gap must be refused before folding");
    assert.equal(rest.asOfSeq, 4);
  });
});

test("W-02 a value that does not match the read's frozen schema is refused, not served", async () => {
  await withRead((db, projectId) => {
    log(db, projectId, "e1", "run");
    // A fold whose view does not match the `run` read's schema.
    const wrongUnit = {
      version: RUN_DEFINITION.version,
      init: () => ({ oops: "not a run value" }),
      apply: (state) => state,
      view: (state) => ({ oops: state.oops }),
    };
    const store = createProjectionStore(db, projectId);
    store.register(unitKeyFor(RUN_DEFINITION), wrongUnit);

    assert.throws(
      () => serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit: wrongUnit }),
      (error) => {
        assert.ok(error instanceof StorageError);
        assert.equal(error.code, "stage.output_invalid");
        assert.equal(error.details.stage, unitKeyFor(RUN_DEFINITION));
        assert.match(String(error.details.missing), /^\$/);
        return true;
      },
    );
  });
});

test("W-02 an event whose payload is not an object is refused as input.invalid", async () => {
  await withRead((db, projectId) => {
    // Written directly so the payload is a scalar the serve must refuse.
    db.prepare(
      "INSERT INTO event_log (project_id, seq, event_id, kind, payload) VALUES (?, 1, 'bad', 'run.changed', '\"scalar\"');",
    ).run(projectId);
    const unit = runUnit();
    const store = storeFor(db, projectId, RUN_DEFINITION, unit);
    assert.throws(
      () => serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit }),
      (error) => {
        assert.ok(error instanceof StorageError);
        assert.equal(error.code, "input.invalid");
        assert.equal(error.details.field, "payload");
        assert.equal(error.details.reason, "event-payload-malformed");
        return true;
      },
    );
  });
});

test("W-02 an event naming a concern outside the closed vocabulary is refused", async () => {
  await withRead((db, projectId) => {
    // The concern vocabulary is closed, so a word outside it is a contract
    // violation rather than one this read happens not to consume.
    appendEvent(db, { projectId, eventId: "e1", kind: "run.changed", payload: { concern: "marketing", eventId: "e1" } });
    const unit = runUnit();
    const store = storeFor(db, projectId, RUN_DEFINITION, unit);
    assert.throws(
      () => serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit }),
      (error) => {
        assert.ok(error instanceof StorageError);
        assert.equal(error.code, "input.invalid");
        assert.equal(error.details.field, "concern");
        assert.equal(error.details.reason, "unknown-concern");
        return true;
      },
    );
  });
});

test("W-02 a serve over an empty log reports the initial watermark and folds nothing", async () => {
  await withRead((db, projectId) => {
    const unit = runUnit();
    const store = storeFor(db, projectId, RUN_DEFINITION, unit);
    const served = serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit });
    assert.equal(served.folded, 0);
    assert.equal(served.asOfSeq, 0);
    assert.equal(served.value.asOfSeq, 0);
    assert.equal(served.value.attempts.length, 0);
  });
});

test("W-02 two reads over one log share a single drive pass and one watermark", async () => {
  await withRead((db, projectId) => {
    log(db, projectId, "e1", "run");
    log(db, projectId, "e2", "chapter");
    log(db, projectId, "e3", "run");

    const runUnitInstance = runUnit();
    const navUnitInstance = navUnit();
    const store = createProjectionStore(db, projectId);
    store.register(unitKeyFor(RUN_DEFINITION), runUnitInstance);
    store.register(unitKeyFor(NAV_DEFINITION), navUnitInstance);

    // The first serve drives the whole tail, feeding both units.
    const run = serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit: runUnitInstance });
    assert.equal(run.folded, 3);
    assert.equal(run.value.attempts.length, 2, "the run unit consumed only its own concern");

    // The second serve drives nothing new, because the watermark already covers
    // the tail — and the navigation unit has already seen the chapter event.
    const nav = serveReadFromLog(db, projectId, store, { definition: NAV_DEFINITION, unit: navUnitInstance });
    assert.equal(nav.folded, 0);
    assert.equal(nav.value.volumes.length, 1);

    // Both are stamped with the same watermark, so they are comparable.
    assert.equal(run.asOfSeq, nav.asOfSeq);
    assert.equal(run.value.asOfSeq, nav.value.asOfSeq);

    assert.throws(
      () => serveReadFromLog(db, "project-2", store, { definition: NAV_DEFINITION, unit: navUnitInstance }),
      (error) => error instanceof StorageError && error.details.reason === "projection-project-mismatch",
    );
  });
});

test("W-02 a checkpoint restored mid-serve keeps folding from where it stopped", async () => {
  await withRead((db, projectId) => {
    log(db, projectId, "e1", "run");
    const unit = runUnit();
    const store = storeFor(db, projectId, RUN_DEFINITION, unit);
    const first = serveReadFromLog(db, projectId, store, { definition: RUN_DEFINITION, unit });
    assert.equal(first.value.attempts.length, 1);

    // A durable checkpoint row for this unit, at this watermark.
    store.saveCheckpoint();
    const checkpoint = store.loadCheckpoint();
    assert.equal(checkpoint.length, 1);
    assert.equal(checkpoint[0].key, unitKeyFor(RUN_DEFINITION));
    assert.equal(checkpoint[0].seq, first.asOfSeq);

    // Restore the persisted cut, then serve new events from its watermark.
    const restored = createProjectionStore(db, projectId);
    const restoredUnit = runUnit();
    restored.register(unitKeyFor(RUN_DEFINITION), restoredUnit);
    const floor = restored.restoreFloor(checkpoint);
    assert.equal(floor, 0, "the row sits at the log's start, so there is no gap");

    const { events, baseSeq } = readTail(db, projectId, floor);
    const cut = restored.restore(checkpoint, events, baseSeq);
    assert.equal(cut.asOfSeq, first.asOfSeq);
    assert.deepEqual(cut.values[unitKeyFor(RUN_DEFINITION)].attempts, first.value.attempts);
    log(db, projectId, "e2", "run");
    const served = serveReadFromLog(db, projectId, restored, { definition: RUN_DEFINITION, unit: restoredUnit }, { afterSeq: cut.asOfSeq });
    assert.equal(served.folded, 1);
    assert.equal(served.asOfSeq, 2);
    assert.deepEqual(served.value.attempts.map(({ stage }) => stage), ["run.changed", "run.changed"]);
  });
});
