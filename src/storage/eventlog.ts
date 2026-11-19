// The project event log and the cursor protocol that reads it.
//
// The rules are frozen in contracts.md B.7 (cursor naming and backfill, frozen
// 2026-11-19) and pinned by `readmodel-a01.test.mjs`:
//
//   - one project keeps ONE event log; events of different concerns append to
//     it and share a single watermark called `asOfSeq`;
//   - sequence numbers are monotonic and a committed event is appended exactly
//     once, so a redelivered event cannot double-apply;
//   - a consumer whose cursor no longer matches resets to a full snapshot
//     instead of merging a gap;
//   - a gap backfill delivers the missing events in order, and the consumer
//     verifies the watermark before each one — a backfill that skips an event
//     in the middle is refused wholesale.
//
// The log is persistence and lives here. The cursor is the read side of the
// log's contract: pure state with no IO, so any consumer can hold one.

import type { SqliteDatabase } from "./driver.ts";
import { canonicalJson } from "./command.ts";
import { StorageError } from "./errors.ts";

/** One committed event as the log returns it. */
export interface LoggedEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly kind: string;
  readonly payload: unknown;
}

/** A consistent cut: one watermark covering every served value. */
export interface SnapshotCut {
  readonly asOfSeq: number;
  readonly values: Readonly<Record<string, unknown>>;
}

/** One change delivered by a backfill. */
export interface BackfillEvent {
  readonly seq: number;
  readonly key: string;
  readonly value: unknown;
}

/** Why a backfill was refused, or that it was applied. */
export type BackfillResult =
  | { readonly applied: true; readonly cursor: number }
  | {
      readonly applied: false;
      readonly reason: "no-baseline" | "empty-backfill" | "gap";
      readonly expected?: number;
      readonly received?: number;
    };

/** The read-side cursor over one project's log. */
export interface Cursor {
  /** The watermark the consumer currently holds. */
  cursor(): number;
  /** Whether the consumer holds a baseline it can merge into. */
  hasBaseline(): boolean;
  /** Adopts a full snapshot wholesale; the cursor becomes its watermark. */
  acceptSnapshot(cut: SnapshotCut): void;
  /** Applies a backfill in order, refusing the whole batch on a gap. */
  applyBackfill(events: readonly BackfillEvent[]): BackfillResult;
  /** The values the consumer currently holds. */
  values(): Readonly<Record<string, unknown>>;
}

const EVENT_LOG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS event_log (
    project_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (project_id, seq)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS event_log_identity
    ON event_log (project_id, event_id);
`;

/** Creates the event-log table. Safe to run on every open. */
export function createEventLogSchema(db: SqliteDatabase): void {
  db.exec(EVENT_LOG_SCHEMA);
}

/** The project's current watermark: 0 when nothing has been committed. */
export function currentSeq(db: SqliteDatabase, projectId: string): number {
  const row = db.prepare("SELECT MAX(seq) AS seq FROM event_log WHERE project_id = ?;").get(projectId);
  const value = (row as { seq?: unknown } | null)?.seq;
  return typeof value === "number" ? value : 0;
}

/**
 * Appends one event, or reports the sequence number it already holds.
 *
 * The `(project_id, event_id)` identity makes an append idempotent: a
 * redelivered event returns its original sequence number and appends nothing,
 * so a retried commit cannot double-apply or leave a hole.
 */
export function appendEvent(
  db: SqliteDatabase,
  event: {
    readonly projectId: string;
    readonly eventId: string;
    readonly kind: string;
    readonly payload: unknown;
  },
): { seq: number; appended: boolean } {
  const existing = db
    .prepare("SELECT seq FROM event_log WHERE project_id = ? AND event_id = ?;")
    .get(event.projectId, event.eventId);
  if (existing !== null && existing !== undefined) {
    const seq = (existing as { seq?: unknown }).seq;
    if (typeof seq !== "number") {
      throw new StorageError("storage.format_unsupported", { reason: "event-log-row-malformed" });
    }
    return { seq, appended: false };
  }
  const next = currentSeq(db, event.projectId) + 1;
  db.prepare(
    "INSERT INTO event_log (project_id, seq, event_id, kind, payload) VALUES (?, ?, ?, ?, ?);",
  ).run(event.projectId, next, event.eventId, event.kind, canonicalJson(event.payload));
  return { seq: next, appended: true };
}

/** Reads events after a sequence number, oldest first. */
export function readEvents(
  db: SqliteDatabase,
  projectId: string,
  { afterSeq = 0, limit }: { readonly afterSeq?: number; readonly limit?: number } = {},
): LoggedEvent[] {
  const sql =
    limit === undefined
      ? "SELECT seq, event_id, kind, payload FROM event_log WHERE project_id = ? AND seq > ? ORDER BY seq;"
      : "SELECT seq, event_id, kind, payload FROM event_log WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?;";
  const rows =
    limit === undefined
      ? db.prepare(sql).all(projectId, afterSeq)
      : db.prepare(sql).all(projectId, afterSeq, limit);
  const events: LoggedEvent[] = [];
  for (const row of rows) {
    const value = row as {
      seq?: unknown;
      event_id?: unknown;
      kind?: unknown;
      payload?: unknown;
    };
    if (
      typeof value.seq !== "number" ||
      typeof value.event_id !== "string" ||
      typeof value.kind !== "string" ||
      typeof value.payload !== "string"
    ) {
      throw new StorageError("storage.format_unsupported", { reason: "event-log-row-malformed" });
    }
    events.push({
      seq: value.seq,
      eventId: value.event_id,
      kind: value.kind,
      payload: JSON.parse(value.payload) as unknown,
    });
  }
  return events;
}

/**
 * Creates a consumer cursor.
 *
 * It starts with no baseline: a backfill merges into values the consumer
 * already holds, so applying one before any snapshot would silently drop the
 * keys that snapshot would have carried. That case, and an empty batch, are
 * both refusals rather than silent successes.
 */
export function createCursor(): Cursor {
  let cursor = 0;
  let held: Record<string, unknown> | null = null;

  return {
    cursor() {
      return cursor;
    },
    hasBaseline() {
      return held !== null;
    },
    acceptSnapshot(cut) {
      cursor = cut.asOfSeq;
      held = { ...cut.values };
    },
    applyBackfill(events) {
      if (held === null) return { applied: false, reason: "no-baseline" };
      if (events.length === 0) return { applied: false, reason: "empty-backfill" };
      let expected = cursor + 1;
      const merged: Record<string, unknown> = { ...held };
      for (const event of events) {
        if (event.seq !== expected) {
          // The whole batch is refused: applying part of it would leave the
          // consumer holding a cut it never received.
          return { applied: false, reason: "gap", expected, received: event.seq };
        }
        merged[event.key] = event.value;
        expected = event.seq + 1;
      }
      held = merged;
      cursor = events[events.length - 1].seq;
      return { applied: true, cursor };
    },
    values() {
      return held === null ? {} : held;
    },
  };
}
