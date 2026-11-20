// Serving a read from the event log: the missing wire between the log, the
// projection store and the frozen read surface.
//
// The three pieces already exist and each is conformance-tested on its own —
// `storage/eventlog.ts` reads a bounded tail, `storage/projection.ts` folds it
// into durable rows, `readmodels.ts` owns the definitions, their schemas and the
// watermark discipline. What was missing is the join, and this module is only
// that join:
//
//   1. read the tail after a sequence number, oldest first;
//   2. check every event names a concern in the closed vocabulary, so an event
//      outside it is a contract violation rather than a silently ignored one
//      (or infer/quarantine when `tolerateUnknownConcern` is enabled per DB-19);
//   3. drive each event the store has not folded yet through the store once —
//      the store feeds every registered unit and no-ops an event at or below its
//      watermark, which is how one shared watermark advances every read
//      together;
//   4. snapshot the requested read, check its value against the read's frozen
//      schema, and stamp the shared watermark into it, because one watermark is
//      enough to compare every read against storage.

import type { SqliteDatabase } from "../storage/driver.ts";
import { StorageError } from "../storage/errors.ts";
import { currentSeq, readEvents, type LoggedEvent } from "../storage/eventlog.ts";
import { inferEventConcern } from "../storage/author-schema.ts";
import type { ProjectionStore, ProjectionUnit } from "../storage/projection.ts";
import {
  isConcern,
  readKey,
  serveRead,
  validateReadValue,
  type Concern,
  type ReadDefinition,
} from "./readmodels.ts";

/** One read bound for serving: the frozen definition plus its fold. */
export interface ReadServeEntry<S> {
  readonly definition: ReadDefinition;
  readonly unit: ProjectionUnit<S>;
}

/** What one serve reports. */
export interface ServedRead {
  /** The read's registry key, so a caller can tell which value it holds. */
  readonly key: string;
  /** The shared watermark the value is stamped with. */
  readonly asOfSeq: number;
  /** The served value, schema-checked and watermarked. */
  readonly value: Readonly<Record<string, unknown>>;
  /** How many events this serve drove that the store had not folded yet. */
  readonly folded: number;
}

/** Options for one serve. */
export interface ServeReadOptions {
  /** Where to start reading. Defaults to the beginning of the log. */
  readonly afterSeq?: number;
  /** A bound on how much to read at once, for a caller that pages. */
  readonly limit?: number;
  /** Optional custom unit key inside a shared per-project ProjectionStore (DB-03). */
  readonly unitKey?: string;
  /**
   * When `true` (DB-19), missing or unknown concerns in historical events are
   * inferred from `event.kind` or safely bypassed instead of bricking the
   * project's read models. Defaults to `false` (strict contract enforcement).
   */
  readonly tolerateUnknownConcern?: boolean;
}

/** An event as the fold sees it: the logged fields plus its payload's own. */
export interface MaterialisedEvent extends Record<string, unknown> {
  readonly seq: number;
  readonly eventId: string;
  readonly kind: string;
  readonly concern: Concern | "__quarantined__";
}

/** Infers a frozen `Concern` from a committed event kind (DB-19). */
export function inferConcernFromKind(kind: string): Concern | null {
  const inferred = inferEventConcern(kind);
  return inferred && isConcern(inferred) ? inferred : null;
}

/** Materialises a logged event row into the envelope read units consume. */
export function materialiseLoggedEvent(
  event: LoggedEvent,
  tolerateUnknownConcern = false,
): MaterialisedEvent {
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    if (tolerateUnknownConcern) {
      return {
        id: event.eventId,
        type: event.kind,
        seq: event.seq,
        eventId: event.eventId,
        kind: event.kind,
        concern: "__quarantined__",
      };
    }
    throw new StorageError("input.invalid", { field: "payload", reason: "event-payload-malformed" });
  }
  const fields = payload as Record<string, unknown>;
  const rawConcern = fields.concern;
  let concern: Concern | "__quarantined__";
  if (isConcern(rawConcern)) {
    concern = rawConcern;
  } else if (tolerateUnknownConcern) {
    concern = inferConcernFromKind(event.kind) ?? "__quarantined__";
  } else {
    throw new StorageError("input.invalid", { field: "concern", reason: "unknown-concern" });
  }
  // `readEvents` allocates a fresh parsed object per row; mutating the canonical
  // envelope fields directly avoids 2x object spreads on 50k-event cold replays.
  fields.id = event.eventId;
  fields.type = event.kind;
  fields.seq = event.seq;
  fields.eventId = event.eventId;
  fields.kind = event.kind;
  fields.concern = concern;
  return fields as MaterialisedEvent;
}

/**
 * Serves one read from a project's log.
 *
 * The value is checked against the read's frozen schema before it is stamped,
 * so a value that does not match the descriptor is refused with
 * `stage.output_invalid` naming the offending path rather than served. A
 * caller that pages passes the watermark it last saw as `afterSeq`, and the
 * returned watermark is what it should hold next.
 */
export function serveReadFromLog(
  db: SqliteDatabase,
  projectId: string,
  store: ProjectionStore,
  entry: ReadServeEntry<unknown>,
  options: ServeReadOptions = {},
): ServedRead {
  const { definition } = entry;
  if (store.projectId !== projectId) {
    throw new StorageError("input.invalid", { field: "projectId", reason: "projection-project-mismatch" });
  }
  const afterSeq = options.afterSeq ?? 0;
  const startSeq = store.seqOf();
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > startSeq) {
    throw new StorageError("input.invalid", { field: "afterSeq", reason: "projection-baseline-missing" });
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) {
    throw new StorageError("input.invalid", { field: "limit", reason: "invalid-page-limit" });
  }
  if (startSeq > currentSeq(db, projectId)) {
    throw new StorageError("storage.format_unsupported", { reason: "projection-ahead-of-log" });
  }
  const canonicalKey = readKey(definition.id, definition.version);
  const storeUnitKey = options.unitKey ?? canonicalKey;
  store.stateRef(storeUnitKey);
  const tolerateUnknownConcern = options.tolerateUnknownConcern === true;
  const logged = readEvents(db, projectId, {
    afterSeq,
    limit: options.limit,
  });

  // Every event is checked, including the ones below the watermark: a malformed
  // row is a problem with the log, not with this serve.
  const materialised = logged.map((event, index) => {
    if (event.seq !== afterSeq + index + 1) {
      throw new StorageError("storage.format_unsupported", { reason: "event-log-gap" });
    }
    return materialiseLoggedEvent(event, tolerateUnknownConcern);
  });

  // Only the events the store has not folded yet are driven. Using `store.fold`
  // avoids O(N^2) intermediate view materializations on large replays (DB-03).
  const batch: Array<{ readonly seq: number; readonly payload: unknown }> = [];
  for (const event of materialised) {
    if (event.seq <= startSeq) continue;
    batch.push({
      seq: event.seq,
      payload: event,
    });
  }
  const folded = batch.length > 0 ? store.fold(batch) : 0;

  const cut = store.snapshot([storeUnitKey]);
  const raw = cut.values[storeUnitKey];
  // The watermark is stamped before the schema check, so the check covers it
  // too: the watermark is part of the served value, not a label beside it.
  const stamped = serveRead(raw as Record<string, unknown>, cut.asOfSeq);
  const problem = validateReadValue(definition, stamped);
  if (problem) {
    throw new StorageError("stage.output_invalid", { stage: canonicalKey, missing: problem });
  }

  return {
    key: canonicalKey,
    asOfSeq: cut.asOfSeq,
    value: stamped,
    folded,
  };
}
