// The projection store: folding a project's event log into materialised read
// models, with durable checkpoints and a cold restore that refuses a stale row
// instead of serving one.
//
// The semantics are the ones `readmodel-a01.test.mjs` records and contracts.md
// B.7 froze the naming and backfill rules for (2026-11-19). Storage owns the
// mechanics — the fold driver, the durable rows, the tail replay — while the
// units a domain registers carry that domain's own `apply` and `view`.
//
// The rules that matter most:
//
//   - one committed event is folded exactly once, whatever the caller
//     redelivers;
//   - a view is recomputed only when the state reference changed, and
//     published only when the view itself changed by `Object.is`, so a
//     redelivered event publishes nothing;
//   - a change feed carries the whole current value, never a field delta;
//   - a unit that throws mid-drive still lets the event-level feed see the
//     changes made before the throw;
//   - a cold restore seeds usable rows, folds the supplied suffix, and rejects
//     a log that shrank below a row's watermark rather than serving a stale
//     row.

import type { SqliteDatabase } from "./driver.ts";
import { appendEvent, currentSeq, readEvents } from "./eventlog.ts";
import { StorageError } from "./errors.ts";
import { withWriteTx } from "./tx.ts";

/** One registered read model. */
export interface ProjectionUnit<S> {
  /** Bumping it discards every stored row for this unit. */
  readonly version: number;
  init(): S;
  apply(state: S, event: unknown): S;
  view(state: S): unknown;
}

/** One durable projection row. */
export interface CheckpointRow {
  readonly key: string;
  readonly ver: number;
  readonly seq: number;
  readonly val: unknown;
}

/** A consistent cut over the registered units. */
export interface ProjectionCut {
  readonly asOfSeq: number;
  readonly values: Readonly<Record<string, unknown>>;
}

/** One published change. */
export interface ProjectionChange {
  readonly key: string;
  readonly val: unknown;
}

const PROJECTION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS projection_rows (
    project_id TEXT NOT NULL,
    key TEXT NOT NULL,
    version INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (project_id, key)
  );
`;

interface UnitEntry {
  readonly key: string;
  readonly version: number;
  readonly init: () => unknown;
  readonly apply: (state: unknown, event: unknown) => unknown;
  readonly view: (state: unknown) => unknown;
  state: unknown;
  lastView: unknown;
  viewDirty: boolean;
  seq: number;
}

/** Creates the projection-row table. Safe to run on every open. */
export function createProjectionSchema(db: SqliteDatabase): void {
  db.exec(PROJECTION_SCHEMA);
}

/** A projection store over one project's log. */
export interface ProjectionStore {
  readonly projectId: string;
  register<S>(key: string, unit: ProjectionUnit<S>): void;
  /** Attaches an additional unit to a live per-project store (DB-03). */
  attachUnit<S>(key: string, unit: ProjectionUnit<S>, initialState?: S, initialSeq?: number): void;
  /** Removes a dynamically attached unit from memory (for LRU eviction). */
  detachUnit(key: string): boolean;
  /** Whether a unit with `key` is currently registered/attached. */
  hasUnit(key: string): boolean;
  /** Current sequence watermark of a specific unit, or undefined if absent. */
  unitSeq(key: string): number | undefined;
  /** Catches up one newly attached unit up to the store watermark without touching other units. */
  catchUpUnit(key: string, events: readonly { readonly seq: number; readonly payload: unknown }[]): number;
  /** Folds a contiguous batch of events across all units without per-event view overhead when no listeners exist. */
  fold(events: readonly { readonly seq: number; readonly payload: unknown }[]): number;
  commit(event: { readonly id: string; readonly type: string; readonly [field: string]: unknown }, deliverSeq?: number): { seq: number; changes: ProjectionChange[] };
  snapshot(keys?: readonly string[]): ProjectionCut;
  seqOf(): number;
  stateRef(key: string): unknown;
  checkpoint(): CheckpointRow[];
  /** Returns a single unit's durable checkpoint row without cloning unrelated units. */
  unitCheckpoint(key: string): CheckpointRow | undefined;
  saveCheckpoint(): void;
  loadCheckpoint(): CheckpointRow[];
  restoreFloor(checkpoint: readonly CheckpointRow[]): number | undefined;
  restore(checkpoint: readonly CheckpointRow[], events: readonly { seq: number; payload: unknown }[], baseSeq: number): ProjectionCut;
  onChanged(listener: (key: string, value: unknown, seq: number) => void): () => void;
  onEventChanged(listener: (changes: readonly ProjectionChange[]) => void): () => void;
}

/** Creates a projection store bound to one project's event log. */
export function createProjectionStore(db: SqliteDatabase, projectId: string): ProjectionStore {
  const units = new Map<string, UnitEntry>();
  const changedListeners = new Set<(key: string, value: unknown, seq: number) => void>();
  const eventChangedListeners = new Set<(changes: readonly ProjectionChange[]) => void>();
  let seq = 0;

  function materializeView(unit: UnitEntry): unknown {
    if (unit.viewDirty) {
      unit.lastView = unit.view(unit.state);
      unit.viewDirty = false;
    }
    return unit.lastView;
  }

  function drive(event: unknown, eventSeq: number): ProjectionChange[] {
    const changes: ProjectionChange[] = [];
    let failure: { error: unknown } | null = null;
    for (const unit of units.values()) {
      if (unit.seq >= eventSeq) continue;
      if (unit.viewDirty) {
        unit.lastView = unit.view(unit.state);
        unit.viewDirty = false;
      }
      const before = unit.state;
      let after: unknown;
      let view: unknown;
      try {
        after = unit.apply(before, event);
        view = Object.is(before, after) ? unit.lastView : unit.view(after);
      } catch (error) {
        failure = { error };
        break;
      }
      unit.state = after;
      unit.seq = eventSeq;
      if (!Object.is(view, unit.lastView)) {
        unit.lastView = view;
        changes.push({ key: unit.key, val: view });
        for (const listener of changedListeners) listener(unit.key, view, eventSeq);
      }
    }
    if (!failure) seq = eventSeq;
    if (changes.length > 0) {
      for (const listener of eventChangedListeners) listener(changes.slice());
    }
    if (failure) throw failure.error;
    return changes;
  }

  return {
    get projectId() {
      return projectId;
    },

    register(key, unit) {
      if (seq !== 0 || units.has(key) || [...units.values()].some((entry) => entry.seq > seq)) {
        throw new StorageError("input.invalid", { field: "key", reason: "projection-registration-closed" });
      }
      const initial = unit.init();
      units.set(key, {
        key,
        version: unit.version,
        init: unit.init as () => unknown,
        apply: unit.apply as (state: unknown, event: unknown) => unknown,
        view: unit.view as (state: unknown) => unknown,
        state: initial,
        lastView: unit.view(initial),
        viewDirty: false,
        seq: 0,
      });
    },

    attachUnit(key, unit, initialState, initialSeq = 0) {
      if (units.has(key)) {
        throw new StorageError("input.invalid", { field: "key", reason: "projection-unit-exists" });
      }
      if (!Number.isSafeInteger(initialSeq) || initialSeq < 0) {
        throw new StorageError("input.invalid", { field: "initialSeq", reason: "invalid-unit-seq" });
      }
      const state = initialState !== undefined ? structuredClone(initialState) : unit.init();
      units.set(key, {
        key,
        version: unit.version,
        init: unit.init as () => unknown,
        apply: unit.apply as (state: unknown, event: unknown) => unknown,
        view: unit.view as (state: unknown) => unknown,
        state,
        lastView: undefined,
        viewDirty: true,
        seq: initialSeq,
      });
      if (units.size === 1 && seq === 0 && initialSeq > 0) {
        seq = initialSeq;
      }
    },

    detachUnit(key) {
      return units.delete(key);
    },

    hasUnit(key) {
      return units.has(key);
    },

    unitSeq(key) {
      return units.get(key)?.seq;
    },

    catchUpUnit(key, events) {
      const unit = units.get(key);
      if (!unit) throw new StorageError("input.not_found", { objectType: "projection-unit", objectId: key });
      let folded = 0;
      for (const item of events) {
        if (item.seq <= unit.seq) continue;
        if (item.seq !== unit.seq + 1) {
          throw new StorageError("storage.format_unsupported", { reason: "event-log-gap" });
        }
        const before = unit.state;
        const after = unit.apply(before, item.payload);
        unit.state = after;
        unit.seq = item.seq;
        if (!Object.is(before, after)) unit.viewDirty = true;
        folded += 1;
      }
      if (unit.seq > seq && units.size === 1) {
        seq = unit.seq;
      }
      return folded;
    },

    fold(events) {
      if (events.length === 0) return 0;
      const hasListeners = changedListeners.size > 0 || eventChangedListeners.size > 0;
      let folded = 0;
      for (const item of events) {
        if (item.seq <= seq) continue;
        if (item.seq !== seq + 1) {
          throw new StorageError("input.invalid", { field: "deliverSeq", reason: "projection-event-gap" });
        }
        if (hasListeners) {
          drive(item.payload, item.seq);
        } else {
          for (const unit of units.values()) {
            if (unit.seq >= item.seq) continue;
            const before = unit.state;
            const after = unit.apply(before, item.payload);
            unit.state = after;
            unit.seq = item.seq;
            if (!Object.is(before, after)) unit.viewDirty = true;
          }
          seq = item.seq;
        }
        folded += 1;
      }
      return folded;
    },

    commit(event, deliverSeq) {
      if (deliverSeq !== undefined) {
        if (deliverSeq <= seq) return { seq: deliverSeq, changes: [] };
        if (deliverSeq !== seq + 1) {
          throw new StorageError("input.invalid", { field: "deliverSeq", reason: "projection-event-gap" });
        }
        return { seq: deliverSeq, changes: drive(event, deliverSeq) };
      }

      const appended = appendEvent(db, {
        projectId,
        eventId: event.id,
        kind: event.type,
        payload: event,
      });
      if (!appended.appended) return { seq: appended.seq, changes: [] };

      // Another connection may have appended events since the last fold.
      const missing = appended.seq - seq - 1;
      if (missing > 0) {
        const tail = readEvents(db, projectId, { afterSeq: seq, limit: missing });
        if (tail.length !== missing || tail.some((row, index) => row.seq !== seq + index + 1)) {
          throw new StorageError("storage.format_unsupported", { reason: "event-log-gap" });
        }
        for (const row of tail) drive(row.payload, row.seq);
      }
      return { seq: appended.seq, changes: drive(event, appended.seq) };
    },

    snapshot(keys) {
      const values: Record<string, unknown> = {};
      if (keys) {
        for (const key of keys) {
          const unit = units.get(key);
          if (!unit) continue;
          if (unit.seq !== seq) {
            throw new StorageError("stage.output_invalid", { stage: unit.key, missing: "complete-projection" });
          }
          values[unit.key] = unit.view(unit.state);
          unit.lastView = values[unit.key];
          unit.viewDirty = false;
        }
        return { asOfSeq: seq, values };
      }
      for (const unit of units.values()) {
        if (unit.seq !== seq) {
          throw new StorageError("stage.output_invalid", { stage: unit.key, missing: "complete-projection" });
        }
        values[unit.key] = materializeView(unit);
      }
      return { asOfSeq: seq, values };
    },

    seqOf() {
      return seq;
    },

    stateRef(key) {
      const unit = units.get(key);
      if (!unit) throw new StorageError("input.not_found", { objectType: "projection-unit", objectId: key });
      return unit.state;
    },

    checkpoint() {
      return [...units.values()].map((unit) => ({
        key: unit.key,
        ver: unit.version,
        seq: unit.seq,
        val: structuredClone(unit.state),
      }));
    },

    unitCheckpoint(key) {
      const unit = units.get(key);
      if (!unit) return undefined;
      return {
        key: unit.key,
        ver: unit.version,
        seq: unit.seq,
        val: structuredClone(unit.state),
      };
    },

    saveCheckpoint() {
      withWriteTx(db, () => {
        db.prepare("DELETE FROM projection_rows WHERE project_id = ?;").run(projectId);
        for (const row of this.checkpoint()) {
          db.prepare(
            "INSERT INTO projection_rows (project_id, key, version, seq, state) VALUES (?, ?, ?, ?, ?);",
          ).run(projectId, row.key, row.ver, row.seq, JSON.stringify(row.val));
        }
      });
    },

    loadCheckpoint() {
      const rows = db
        .prepare("SELECT key, version, seq, state FROM projection_rows WHERE project_id = ?;")
        .all(projectId);
      const result: CheckpointRow[] = [];
      for (const row of rows) {
        const value = row as { key?: unknown; version?: unknown; seq?: unknown; state?: unknown };
        if (
          typeof value.key !== "string" ||
          typeof value.version !== "number" ||
          typeof value.seq !== "number" ||
          typeof value.state !== "string"
        ) {
          throw new StorageError("storage.format_unsupported", { reason: "projection-row-malformed" });
        }
        result.push({
          key: value.key,
          ver: value.version,
          seq: value.seq,
          val: JSON.parse(value.state) as unknown,
        });
      }
      return result;
    },

    restoreFloor(checkpoint) {
      const rows = new Map(checkpoint.map((row) => [row.key, row]));
      let floor: number | null = null;
      for (const unit of units.values()) {
        const row = rows.get(unit.key);
        if (!row || row.ver !== unit.version) return undefined;
        if (floor === null || row.seq < floor) floor = row.seq;
      }
      return floor === null ? undefined : floor - 1;
    },

    restore(checkpoint, events, baseSeq) {
      if (!Number.isSafeInteger(baseSeq)) {
        throw new StorageError("input.invalid", { field: "baseSeq", reason: "invalid-replay-baseline" });
      }
      const baseline = Math.max(0, baseSeq - 1);
      const logEnd = baseline + events.length;
      if (events.some((event, index) => event.seq !== baseline + index + 1)) {
        throw new StorageError("storage.format_unsupported", { reason: "event-log-gap" });
      }
      const rows = new Map<string, CheckpointRow>();
      for (const row of checkpoint) {
        const unit = units.get(row.key);
        if (unit && row.ver === unit.version && Number.isSafeInteger(row.seq) && row.seq >= baseline && row.seq <= logEnd) {
          rows.set(row.key, row);
        } else if (baseSeq > 0) {
          throw new StorageError("storage.format_unsupported", {
            reason: "stale-projection-row", key: row.key, watermark: row.seq, logEnd,
          });
        }
      }

      // Stage the rebuild separately so a bad row or a failed fold leaves the
      // live store at its previous consistent cut.
      const restored = new Map<string, UnitEntry>();
      for (const unit of units.values()) {
        const row = rows.get(unit.key);
        if (!row && baseline > 0) {
          throw new StorageError("storage.format_unsupported", { reason: "missing-projection-row", key: unit.key });
        }
        restored.set(unit.key, {
          ...unit,
          state: row ? structuredClone(row.val) : unit.init(),
          lastView: undefined,
          viewDirty: true,
          seq: row?.seq ?? 0,
        });
      }
      for (const event of events) {
        for (const unit of restored.values()) {
          if (event.seq <= unit.seq) continue;
          unit.state = unit.apply(unit.state, event.payload);
          unit.seq = event.seq;
        }
      }
      const values = Object.fromEntries([...restored.values()].map((unit) => {
        unit.lastView = unit.view(unit.state);
        unit.viewDirty = false;
        return [unit.key, unit.lastView];
      }));
      for (const unit of restored.values()) units.set(unit.key, unit);
      seq = logEnd;
      return { asOfSeq: seq, values };
    },

    onChanged(listener) {
      changedListeners.add(listener);
      return () => {
        changedListeners.delete(listener);
      };
    },

    onEventChanged(listener) {
      eventChangedListeners.add(listener);
      return () => {
        eventChangedListeners.delete(listener);
      };
    },
  };
}

/**
 * Reads the log tail a restore needs.
 *
 * The tail starts one event BELOW the lowest usable watermark, so its first
 * event is the anchor itself: a seeded row has already folded everything up to
 * its own watermark, and the restore's `cursor <= unit.seq` guard makes
 * replaying the anchor harmless. With no usable row at all the tail is the
 * whole log from seq 1, which is the full re-read path.
 */
export function readTail(
  db: SqliteDatabase,
  projectId: string,
  floor: number | undefined,
): { events: { seq: number; payload: unknown }[]; baseSeq: number } {
  const baseSeq = Math.max(1, floor ?? 1);
  return {
    events: readEvents(db, projectId, { afterSeq: baseSeq - 1 }).map((event) => ({
      seq: event.seq,
      payload: event.payload,
    })),
    baseSeq,
  };
}

/** The project's current watermark, for callers that only need the number. */
export function projectWatermark(db: SqliteDatabase, projectId: string): number {
  return currentSeq(db, projectId);
}
