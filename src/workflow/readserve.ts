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
//      outside it is a contract violation rather than a silently ignored one;
//   3. drive each event the store has not folded yet through the store once —
//      the store feeds every registered unit and no-ops an event at or below its
//      watermark, which is how one shared watermark advances every read
//      together;
//   4. snapshot the requested read, check its value against the read's frozen
//      schema, and stamp the shared watermark into it, because one watermark is
//      enough to compare every read against storage.
//
// Which events a read consumes is its unit's business, declared by the read's
// `concerns` and decided by its `apply`. Filtering at the serve instead would
// break the shared watermark: a unit registered later would never see the
// events below it, because the store advances every unit on one pass.
//
// The fold itself is injected. This module owns no business semantics: what a
// read's value means is its unit's `apply` and `view`, and what it must look
// like is its frozen descriptor. That is deliberate — the vocabulary of the
// six reads' events is not frozen yet, so this joins machinery to machinery and
// leaves the domain's half to the work package that owns it.

import type { SqliteDatabase } from "../storage/driver.ts";
import { StorageError } from "../storage/errors.ts";
import { currentSeq, readEvents, type LoggedEvent } from "../storage/eventlog.ts";
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
}

/** An event as the fold sees it: the logged fields plus its payload's own. */
interface MaterialisedEvent extends Record<string, unknown> {
  readonly seq: number;
  readonly eventId: string;
  readonly kind: string;
  readonly concern: Concern;
}

function materialise(event: LoggedEvent): MaterialisedEvent {
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new StorageError("input.invalid", { field: "payload", reason: "event-payload-malformed" });
  }
  const fields = payload as Record<string, unknown>;
  const concern = fields.concern;
  // The concern vocabulary is closed, so an event naming a word outside it is a
  // contract violation rather than one this read happens not to consume.
  if (!isConcern(concern)) {
    throw new StorageError("input.invalid", { field: "concern", reason: "unknown-concern" });
  }
  return {
    ...fields,
    seq: event.seq,
    eventId: event.eventId,
    kind: event.kind,
    concern,
  };
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
  const unitKey = readKey(definition.id, definition.version);
  store.stateRef(unitKey);
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
    return materialise(event);
  });

  // Only the events the store has not folded yet are driven. `commit` would
  // no-op them anyway; skipping keeps `folded` honest about what this serve did.
  let folded = 0;
  for (const event of materialised) {
    if (event.seq <= startSeq) continue;
    store.commit({ ...event, id: event.eventId, type: event.kind }, event.seq);
    folded += 1;
  }

  const cut = store.snapshot([unitKey]);
  const raw = cut.values[unitKey];
  // The watermark is stamped before the schema check, so the check covers it
  // too: the watermark is part of the served value, not a label beside it.
  const stamped = serveRead(raw as Record<string, unknown>, cut.asOfSeq);
  const problem = validateReadValue(definition, stamped);
  if (problem) {
    throw new StorageError("stage.output_invalid", { stage: unitKey, missing: problem });
  }

  return {
    key: unitKey,
    asOfSeq: cut.asOfSeq,
    value: stamped,
    folded,
  };
}
