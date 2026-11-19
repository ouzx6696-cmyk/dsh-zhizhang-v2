import assert from "node:assert/strict";
import test from "node:test";

// A-01 supporting fixture for read models and event cursors. The semantics
// under test are the host session-projection contract recorded in
// docs/subsystems/session-projection.md (proved byte-identical between the
// installed rc.3 and the target rc.4), written here as an executable
// specification of what contracts.md appendix B.7 records. **Frozen on
// 2026-11-19 as A-class items**: the cursor field name `asOfSeq`, one event log
// per project, and the snapshot-reset and gap-backfill wording (with the
// per-item watermark check). Still open: the eight "adopt" marks on the host's
// own read-model semantics are a B-class author review, and no offline fixture
// can prove the host runtime.

// The recorded unit contract: a pure synchronous fold, a client view computed
// only when the state reference changed, and publication only when that view
// changes by Object.is.
function createProjection() {
  const units = new Map();
  const changedListeners = new Set();
  const eventChangedListeners = new Set();
  let seq = 0;

  function drive(event) {
    const changes = [];
    let failure = null;
    for (const [key, unit] of units) {
      if (failure) break;
      const before = unit.state;
      let after;
      try {
        after = unit.apply(before, event);
      } catch (error) {
        failure = { error };
        break;
      }
      unit.state = after;
      if (!Object.is(before, after)) {
        const view = unit.view(after);
        if (!Object.is(view, unit.lastView)) {
          unit.lastView = view;
          changes.push({ key, val: view });
          for (const listener of changedListeners) listener(key, view, unit.seq);
        }
      }
    }
    if (changes.length > 0) {
      for (const listener of eventChangedListeners) listener(changes.slice());
    }
    if (failure) throw failure.error;
    return changes;
  }

  return {
    register(key, unit) {
      units.set(key, { ...unit, state: unit.init(), lastView: unit.view(unit.init()), seq: 0 });
    },
    // One committed event gets the next sequence number and is folded exactly
    // once, whatever the caller redelivers.
    commit(event, deliverSeq) {
      if (deliverSeq !== undefined) {
        if (deliverSeq <= seq) return { seq: deliverSeq, changes: [] };
        seq = deliverSeq;
      } else {
        seq += 1;
      }
      for (const unit of units.values()) unit.seq = seq;
      return { seq, changes: drive(event) };
    },
    // A consistent cut: one shared watermark covering every served value.
    snapshot(keys) {
      const values = {};
      for (const [key, unit] of units) {
        if (keys && !keys.includes(key)) continue;
        values[key] = unit.view(unit.state);
      }
      return { asOfSeq: seq, values };
    },
    onChanged(listener) {
      changedListeners.add(listener);
      return () => changedListeners.delete(listener);
    },
    onEventChanged(listener) {
      eventChangedListeners.add(listener);
      return () => eventChangedListeners.delete(listener);
    },
    // One durable row per unit: its own version, its watermark and a detached
    // copy of the state.
    checkpoint() {
      return [...units.entries()].map(([key, unit]) => ({
        key,
        ver: unit.version,
        seq: unit.seq,
        val: structuredClone(unit.state),
      }));
    },
    // The tail read starts one event BELOW the lowest usable watermark, so the
    // tail proves how far the stored log still extends.
    restoreFloor(checkpoint) {
      let floor = null;
      for (const row of checkpoint) {
        const unit = units.get(row.key);
        if (!unit || row.ver !== unit.version) continue;
        if (floor === null || row.seq < floor) floor = row.seq;
      }
      return floor === null ? undefined : floor - 1;
    },
    // Cold restore: seed usable rows, fold the supplied suffix, reject a log
    // that shrank below a row's watermark instead of serving a stale row. The
    // returned cut is the last supplied event's seq, or the anchor for an
    // empty tail.
    restore(checkpoint, events, baseSeq) {
      for (const row of checkpoint) {
        const unit = units.get(row.key);
        const usable =
          unit &&
          row.ver === unit.version &&
          row.seq >= baseSeq - 1 &&
          row.seq <= baseSeq + events.length - 1;
        if (!usable) {
          if (baseSeq > 0) {
            throw new Error("stale row requires a full re-read from seq 0");
          }
          unit.state = unit.init();
          unit.seq = 0;
        } else {
          unit.state = structuredClone(row.val);
          unit.seq = row.seq;
        }
      }
      let cursor = baseSeq - 1;
      for (const event of events) {
        cursor += 1;
        for (const unit of units.values()) {
          // Events at or below a seeded row's watermark are already folded.
          if (cursor <= unit.seq) continue;
          unit.state = unit.apply(unit.state, event);
          unit.seq = cursor;
        }
      }
      seq = cursor;
      return this.snapshot();
    },
    seqOf() {
      return seq;
    },
    // The live state reference of one unit, for reference-identity assertions.
    stateRef(key) {
      return units.get(key).state;
    },
  };
}

// A fixed tiny domain: a run's stage progress plus a counter of unrelated
// noise events, so the "event is not this unit's" path is exercised.
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
  return { type: "stage", stage };
}
function noiseEvent() {
  return { type: "noise" };
}

// A minimal client-side read model: it holds the last snapshot it accepted and
// the watermark that snapshot carried. It never folds events itself.
function createClient() {
  let values = null;
  let cursor = null;
  return {
    get cursor() {
      return cursor;
    },
    get values() {
      return values;
    },
    acceptSnapshot(snapshot) {
      values = structuredClone(snapshot.values);
      cursor = snapshot.asOfSeq;
    },
    // A backfill is only applied when it continues exactly after the cursor;
    // anything else forces a full snapshot instead of merging a gap.
    applyBackfill(events) {
      if (values === null) return { applied: false, reason: "no-baseline" };
      if (events.length === 0) return { applied: false, reason: "empty-backfill" };
      if (events[0].seq !== cursor + 1) {
        return { applied: false, reason: "gap", expected: cursor + 1, received: events[0].seq };
      }
      for (const event of events) {
        if (event.seq !== cursor + 1) {
          return { applied: false, reason: "gap", expected: cursor + 1, received: event.seq };
        }
        // Whole-value replacement per key, never a field-level merge.
        values[event.key] = structuredClone(event.value);
        cursor = event.seq;
      }
      return { applied: true, cursor };
    },
  };
}

test("A-01 committed events take monotonic sequence numbers and one snapshot watermark covers every served value", () => {
  const projection = createProjection();
  projection.register("stage", stageUnit);
  projection.register("noise", noiseUnit);
  assert.equal(projection.commit(stageEvent("prepare")).seq, 1);
  assert.equal(projection.commit(noiseEvent()).seq, 2);
  assert.equal(projection.commit(stageEvent("write")).seq, 3);
  const snapshot = projection.snapshot();
  assert.equal(snapshot.asOfSeq, 3);
  assert.deepEqual(snapshot.values, {
    stage: { stage: "write", submitted: 2 },
    noise: { seen: 1 },
  });
  assert.equal(projection.snapshot(["stage"]).values.noise, undefined);
});

test("A-01 an event that is not a unit's returns the same state reference and publishes nothing", () => {
  const projection = createProjection();
  projection.register("stage", stageUnit);
  projection.register("noise", noiseUnit);
  const seen = [];
  const eventSeen = [];
  projection.onChanged((key, value) => seen.push([key, value]));
  projection.onEventChanged((changes) => eventSeen.push(changes));
  projection.commit(stageEvent("prepare"));
  assert.equal(seen.length, 1);
  assert.equal(eventSeen.length, 1);
  // Only the stage unit changed; the noise unit kept its reference, so its
  // cached view was neither recomputed nor republished.
  const before = projection.stateRef("noise");
  projection.commit(stageEvent("write"));
  assert.equal(seen.length, 2);
  assert.equal(eventSeen.length, 2);
  assert.equal(projection.stateRef("noise"), before);
  assert.ok(!seen.some(([key]) => key === "noise"));
});

test("A-01 redelivering an already committed event folds it once, so a retried delivery cannot double-apply", () => {
  const projection = createProjection();
  projection.register("stage", stageUnit);
  projection.commit(stageEvent("prepare"));
  projection.commit(stageEvent("write"));
  const replay = projection.commit(stageEvent("write"), 2);
  assert.equal(replay.seq, 2);
  assert.equal(replay.changes.length, 0);
  assert.deepEqual(projection.snapshot().values.stage, { stage: "write", submitted: 2 });
});

test("A-01 a change feed publishes the whole current value, never a field-level delta", () => {
  const projection = createProjection();
  projection.register("stage", stageUnit);
  const received = [];
  projection.onChanged((key, value) => received.push(value));
  projection.commit(stageEvent("prepare"));
  projection.commit(stageEvent("write"));
  assert.deepEqual(received, [
    { stage: "prepare", submitted: 1 },
    { stage: "write", submitted: 2 },
  ]);
});

test("A-01 a checkpoint plus a forward tail replay reconstructs the same state as a full fold", () => {
  const full = createProjection();
  full.register("stage", stageUnit);
  full.register("noise", noiseUnit);
  full.commit(stageEvent("prepare"));
  full.commit(noiseEvent());
  full.commit(stageEvent("write"));

  const restored = createProjection();
  restored.register("stage", stageUnit);
  restored.register("noise", noiseUnit);
  const checkpoint = full.checkpoint();
  // The suffix read starts one event below the lowest usable watermark, so the
  // tail carries the events from that anchor onward.
  const floor = full.restoreFloor(checkpoint);
  assert.equal(floor, 2);
  restored.restore(checkpoint, [noiseEvent(), stageEvent("write")], floor);

  restored.commit(stageEvent("revise"));
  restored.commit(noiseEvent());
  full.commit(stageEvent("revise"));
  full.commit(noiseEvent());
  assert.deepEqual(restored.snapshot().values, full.snapshot().values);
  assert.equal(restored.snapshot().asOfSeq, full.snapshot().asOfSeq);
});

test("A-01 an empty tail read from the one-below anchor proves a shrunken log and refuses a stale row", () => {
  const source = createProjection();
  source.register("stage", stageUnit);
  source.commit(stageEvent("prepare"));
  source.commit(stageEvent("write"));
  const checkpoint = source.checkpoint();
  const floor = source.restoreFloor(checkpoint);
  assert.equal(floor, 1);

  const restored = createProjection();
  restored.register("stage", stageUnit);
  // The log lost its events: the tail from the anchor is empty, so the end sits
  // below every watermark and the restore must reject rather than serve rows.
  assert.throws(() => restored.restore(checkpoint, [], floor), /full re-read/);
});

test("A-01 a version mismatch or a row claiming past the supplied end is discarded, and discarding above seq 0 demands a full re-read", () => {
  const source = createProjection();
  source.register("stage", stageUnit);
  source.commit(stageEvent("prepare"));
  source.commit(stageEvent("write"));
  const rows = source.checkpoint();

  const bumped = createProjection();
  bumped.register("stage", { ...stageUnit, version: 2 });
  assert.equal(bumped.restoreFloor(rows), undefined);
  assert.throws(() => bumped.restore(rows, [], 1), /full re-read/);

  // From seq 0 a discarded row simply refolds from init, which is sound.
  const cold = createProjection();
  cold.register("stage", stageUnit);
  const snapshot = cold.restore([], [stageEvent("prepare"), stageEvent("write")], 1);
  assert.deepEqual(snapshot.values.stage, { stage: "write", submitted: 2 });
  assert.equal(snapshot.asOfSeq, 2);
});

test("A-01 a version bump discards the old row, and re-stamping it is allowed only after the suffix replay matches the full replay", () => {
  const events = [stageEvent("prepare"), stageEvent("write")];

  const source = createProjection();
  source.register("stage", stageUnit);
  for (const event of events) source.commit(event);
  const rows = source.checkpoint();

  // The bumped unit cannot read the old row: no usable row exists, and a tail
  // read above seq 0 demands a full re-read instead of serving it.
  const bumped = createProjection();
  bumped.register("stage", { ...stageUnit, version: 2 });
  assert.equal(bumped.restoreFloor(rows), undefined);
  assert.throws(() => bumped.restore(rows, [stageEvent("write")], 2), /full re-read/);

  // Before a row is re-stamped with the new version, the fold must be proved
  // equivalent: the full replay under the new version reaches the state the
  // suffix replay over the recorded row also reaches.
  const full = createProjection();
  full.register("stage", { ...stageUnit, version: 2 });
  for (const event of events) full.commit(event);
  const suffix = createProjection();
  suffix.register("stage", { ...stageUnit, version: 2 });
  const restamped = rows.map((row) => ({ ...row, ver: 2 }));
  const fromSuffix = suffix.restore(restamped, [stageEvent("write")], 2);
  assert.deepEqual(fromSuffix.values.stage, full.snapshot().values.stage);
  assert.equal(fromSuffix.asOfSeq, 2);

  // Without that proof the row stays unusable and the unit refolds from init.
  const unproved = createProjection();
  unproved.register("stage", { ...stageUnit, version: 2 });
  const cold = unproved.restore([], events, 1);
  assert.deepEqual(cold.values.stage, full.snapshot().values.stage);
});

test("A-01 the cursor field is asOfSeq and one project keeps one event log, so every value in a snapshot shares it", () => {
  const projection = createProjection();
  projection.register("stage", stageUnit);
  projection.register("noise", noiseUnit);
  // Events of different concerns append to the same project log: a run stage,
  // an unrelated event and another stage.
  projection.commit(stageEvent("prepare"));
  projection.commit(noiseEvent());
  projection.commit(stageEvent("write"));
  const snapshot = projection.snapshot();
  assert.equal(snapshot.asOfSeq, 3);
  assert.deepEqual(Object.keys(snapshot.values).sort(), ["noise", "stage"]);
  // One watermark covers both values, so a client can compare a single number.
  assert.equal(projection.seqOf(), snapshot.asOfSeq);
});

test("A-01 a client whose cursor no longer matches resets to a full snapshot instead of merging a gap", () => {
  const projection = createProjection();
  projection.register("stage", stageUnit);
  projection.commit(stageEvent("prepare"));
  const baseline = projection.snapshot();

  const client = createClient();
  client.acceptSnapshot(baseline);
  assert.equal(client.cursor, 1);
  assert.deepEqual(client.values.stage, { stage: "prepare", submitted: 1 });

  // The host moved on while the client was disconnected: the events in between
  // never reached it, so a backfill starting late is refused.
  projection.commit(stageEvent("write"));
  projection.commit(stageEvent("revise"));
  const current = projection.snapshot();
  assert.equal(current.asOfSeq, 3);

  const late = client.applyBackfill([{ seq: 3, key: "stage", value: current.values.stage }]);
  assert.equal(late.applied, false);
  assert.equal(late.reason, "gap");
  assert.equal(late.expected, 2);
  assert.equal(late.received, 3);

  // The reset is a full snapshot: the client adopts it wholesale and its
  // cursor matches the host watermark again.
  client.acceptSnapshot(current);
  assert.equal(client.cursor, 3);
  assert.deepEqual(client.values.stage, current.values.stage);
});

test("A-01 a gap backfill delivers the missing events in order and the client verifies the watermark before each one", () => {
  const projection = createProjection();
  projection.register("stage", stageUnit);
  projection.register("noise", noiseUnit);
  projection.commit(stageEvent("prepare"));
  const client = createClient();
  client.acceptSnapshot(projection.snapshot());

  // The client missed exactly the next two events; the host replays them from
  // its change feed.
  const changes = [];
  projection.onEventChanged((units) => changes.push(units));
  projection.commit(noiseEvent());
  projection.commit(stageEvent("write"));
  assert.equal(changes.length, 2);

  const backfill = [];
  for (const [index, units] of changes.entries()) {
    for (const unit of units) backfill.push({ seq: 2 + index, key: unit.key, val: unit.val, value: unit.val });
  }
  const applied = client.applyBackfill(backfill);
  assert.equal(applied.applied, true);
  assert.equal(applied.cursor, 3);
  assert.equal(client.cursor, projection.snapshot().asOfSeq);
  assert.deepEqual(client.values, projection.snapshot().values);

  // A backfill that skips an event in the middle is refused wholesale.
  const broken = createClient();
  broken.acceptSnapshot({ asOfSeq: 1, values: { stage: { stage: "prepare", submitted: 1 }, noise: { seen: 0 } } });
  const refused = broken.applyBackfill([
    { seq: 2, key: "noise", value: { seen: 1 } },
    { seq: 4, key: "stage", value: { stage: "write", submitted: 2 } },
  ]);
  assert.equal(refused.applied, false);
  assert.equal(refused.reason, "gap");
  assert.equal(refused.received, 4);
});

test("A-01 when a unit throws mid-drive the event-level feed still receives the changes made before the throw", () => {
  const projection = createProjection();
  projection.register("noise", noiseUnit);
  projection.register("boom", {
    version: 1,
    init: () => ({ hits: 0 }),
    apply() {
      throw new Error("unit failed");
    },
    view: (state) => state,
  });
  const eventSeen = [];
  projection.onEventChanged((changes) => eventSeen.push(changes));
  assert.throws(() => projection.commit(noiseEvent()), /unit failed/);
  assert.deepEqual(eventSeen, [[{ key: "noise", val: { seen: 1 } }]]);
});
