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
  seq: number;
}

/** Creates the projection-row table. Safe to run on every open. */
export function createProjectionSchema(db: SqliteDatabase): void {
  db.exec(PROJECTION_SCHEMA);
}

/** A projection store over one project's log. */
export interface ProjectionStore {
  register<S>(key: string, unit: ProjectionUnit<S>): void;
  commit(event: { readonly id: string; readonly type: string; readonly [field: string]: unknown }, deliverSeq?: number): { seq: number; changes: ProjectionChange[] };
  snapshot(keys?: readonly string[]): ProjectionCut;
  seqOf(): number;
  stateRef(key: string): unknown;
  checkpoint(): CheckpointRow[];
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

  function drive(event: unknown): ProjectionChange[] {
    const changes: ProjectionChange[] = [];
    let failure: { error: unknown } | null = null;
    for (const unit of units.values()) {
      if (failure) break;
      const before = unit.state;
      let after: unknown;
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
          changes.push({ key: unit.key, val: view });
          for (const listener of changedListeners) listener(unit.key, view, unit.seq);
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
      const initial = unit.init();
      units.set(key, {
        key,
        version: unit.version,
        init: unit.init as () => unknown,
        apply: unit.apply as (state: unknown, event: unknown) => unknown,
        view: unit.view as (state: unknown) => unknown,
        state: initial,
        lastView: unit.view(initial),
        seq: 0,
      });
    },

    commit(event, deliverSeq) {
      if (deliverSeq !== undefined) {
        if (deliverSeq <= seq) return { seq: deliverSeq, changes: [] };
        seq = deliverSeq;
      } else {
        const appended = appendEvent(db, {
          projectId,
          eventId: event.id,
          kind: event.type,
          payload: event,
        });
        if (!appended.appended) {
          // Already in the log: a redelivery folds nothing, so a retried
          // commit cannot double-apply. Catching up a projection that is
          // behind the log is `restore`'s job, not `commit`'s.
          return { seq: appended.seq, changes: [] };
        }
        seq = appended.seq;
      }
      for (const unit of units.values()) unit.seq = seq;
      return { seq, changes: drive(event) };
    },

    snapshot(keys) {
      const values: Record<string, unknown> = {};
      for (const unit of units.values()) {
        if (keys && !keys.includes(unit.key)) continue;
        values[unit.key] = unit.view(unit.state);
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

    saveCheckpoint() {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM projection_rows WHERE project_id = ?;").run(projectId);
        for (const row of this.checkpoint()) {
          db.prepare(
            "INSERT INTO projection_rows (project_id, key, version, seq, state) VALUES (?, ?, ?, ?, ?);",
          ).run(projectId, row.key, row.ver, row.seq, JSON.stringify(row.val));
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Reported through the original failure.
        }
        throw error;
      }
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
      let floor: number | null = null;
      for (const row of checkpoint) {
        const unit = units.get(row.key);
        if (!unit || row.ver !== unit.version) continue;
        if (floor === null || row.seq < floor) floor = row.seq;
      }
      return floor === null ? undefined : floor - 1;
    },

    restore(checkpoint, events, baseSeq) {
      for (const row of checkpoint) {
        const unit = units.get(row.key);
        const usable =
          unit !== undefined &&
          row.ver === unit.version &&
          row.seq >= baseSeq - 1 &&
          row.seq <= baseSeq + events.length - 1;
        if (unit === undefined) {
          // A row for a unit this store does not register cannot be trusted,
          // so it forces the same full re-read a stale row does.
          if (baseSeq > 0) {
            throw new StorageError("storage.format_unsupported", {
              reason: "stale-projection-row",
              key: row.key,
              watermark: row.seq,
              logEnd: baseSeq + events.length - 1,
            });
          }
          continue;
        }
        if (!usable) {
          if (baseSeq > 0) {
            // The log shrank below a stored watermark, or the row was written
            // by a different version: serving it would present state the log
            // no longer supports.
            throw new StorageError("storage.format_unsupported", {
              reason: "stale-projection-row",
              key: row.key,
              watermark: row.seq,
              logEnd: baseSeq + events.length - 1,
            });
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
          unit.state = unit.apply(unit.state, event.payload);
          unit.seq = cursor;
        }
      }
      seq = cursor;
      return this.snapshot();
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
  if (floor === undefined) {
    return {
      events: readEvents(db, projectId).map((event) => ({ seq: event.seq, payload: event.payload })),
      baseSeq: 1,
    };
  }
  return {
    events: readEvents(db, projectId, { afterSeq: floor - 1 }).map((event) => ({
      seq: event.seq,
      payload: event.payload,
    })),
    baseSeq: floor,
  };
}

/** The project's current watermark, for callers that only need the number. */
export function projectWatermark(db: SqliteDatabase, projectId: string): number {
  return currentSeq(db, projectId);
}
