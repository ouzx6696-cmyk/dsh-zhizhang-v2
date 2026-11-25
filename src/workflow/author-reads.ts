import { ContractError } from "../contracts/errors.ts";
import {
  createProjectionStore,
  currentSeq,
  readDatabaseUuid,
  readEvents,
  stmt,
  type ProjectionStore,
  type ProjectionUnit,
  type SqliteDatabase,
} from "../storage/index.ts";
import { READ_MODELS, readKey, serveRead, validateReadValue, type ReadDefinition } from "./readmodels.ts";
import { materialiseLoggedEvent, type ServedRead } from "./readserve.ts";

export type Fields = Record<string, unknown>;
type View = Record<string, unknown>;
export type AuthorReadEvent = Fields & { kind: string };
type Chapter = { chapterId: string; title: string; businessState: string; volumeId?: string | null };
type Volume = { volumeId: string; title: string };
type Reducer<S> = (state: S, event: AuthorReadEvent) => S;

export type AuthorReadUnitFactory = (
  definition: ReadDefinition,
  projectId: string,
  identity: readonly string[],
  point: number,
) => ProjectionUnit<unknown>;

function required(input: Fields, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ContractError("input.invalid", { field: key, reason: "required" });
  }
  return value;
}

export function projectReadUnit<S>(
  definition: ReadDefinition,
  init: () => S,
  apply: Reducer<S>,
  view: (state: S) => View,
): ProjectionUnit<unknown> {
  return {
    version: definition.version,
    init,
    apply: (state, event) => apply(state as S, event as AuthorReadEvent),
    view: (state) => view(state as S),
  };
}

/**
 * O(1)-indexed internal state for the `navigation` read model (DB-03).
 * Uses plain JSON-serializable records + ordered ID arrays so durable
 * checkpoints roundtrip cleanly via JSON without O(N^2) array copying.
 */
interface IndexedNavState {
  title: string;
  volumesById: Record<string, Volume>;
  volumeOrder: string[];
  chaptersById: Record<string, Chapter>;
  chapterOrder: string[];
  rev: number;
}

function navigation(definition: ReadDefinition, projectId: string) {
  return projectReadUnit<IndexedNavState>(
    definition,
    () => ({
      title: "",
      volumesById: {},
      volumeOrder: [],
      chaptersById: {},
      chapterOrder: [],
      rev: 0,
    }),
    (state, event) => {
      if (event.concern !== undefined && event.concern !== "chapter") return state;
      if (event.kind === "project.created") {
        const nextTitle = event.name as string;
        if (state.title === nextTitle) return state;
        state.title = nextTitle;
        return { ...state, rev: state.rev + 1 };
      }
      if (event.kind === "volume.created") {
        const volumeId = event.volumeId as string;
        if (Object.hasOwn(state.volumesById, volumeId)) return state;
        state.volumesById[volumeId] = { volumeId, title: event.title as string };
        state.volumeOrder.push(volumeId);
        return { ...state, rev: state.rev + 1 };
      }
      if (event.kind === "volume.renamed") {
        const volumeId = event.volumeId as string;
        const existing = Object.hasOwn(state.volumesById, volumeId) ? state.volumesById[volumeId] : undefined;
        if (!existing) return state;
        state.volumesById[volumeId] = { volumeId, title: event.title as string };
        return { ...state, rev: state.rev + 1 };
      }
      if (event.kind === "document.created") {
        const chapterId = event.documentId as string;
        if (Object.hasOwn(state.chaptersById, chapterId)) return state;
        state.chaptersById[chapterId] = {
          chapterId,
          title: event.title as string,
          businessState: typeof event.state === "string" ? event.state : "planned",
          volumeId: typeof event.volumeId === "string" ? event.volumeId : null,
        };
        state.chapterOrder.push(chapterId);
        return { ...state, rev: state.rev + 1 };
      }
      if (event.kind === "document.state" || event.kind === "chapter.reviewed" || event.kind === "document.renamed") {
        const chapterId = event.documentId as string;
        const existing = Object.hasOwn(state.chaptersById, chapterId) ? state.chaptersById[chapterId] : undefined;
        if (!existing) return state;
        state.chaptersById[chapterId] = {
          ...existing,
          title: (event.title as string | undefined) ?? existing.title,
          businessState: (event.state as string | undefined) ?? existing.businessState,
        };
        return { ...state, rev: state.rev + 1 };
      }
      if (event.kind === "chapter.moved") {
        const chapterId = event.documentId as string;
        const existing = Object.hasOwn(state.chaptersById, chapterId) ? state.chaptersById[chapterId] : undefined;
        if (!existing) return state;
        state.chaptersById[chapterId] = {
          ...existing,
          volumeId: typeof event.volumeId === "string" ? event.volumeId : null,
        };
        return { ...state, rev: state.rev + 1 };
      }
      if (event.kind === "chapter.reordered") {
        const ids = event.chapterIds as string[];
        const seen = new Set<string>();
        const nextOrder: string[] = [];
        for (const id of ids) {
          if (Object.hasOwn(state.chaptersById, id) && !seen.has(id)) {
            seen.add(id);
            nextOrder.push(id);
          }
        }
        for (const id of state.chapterOrder) {
          if (!seen.has(id)) {
            seen.add(id);
            nextOrder.push(id);
          }
        }
        state.chapterOrder = nextOrder;
        return { ...state, rev: state.rev + 1 };
      }
      return state;
    },
    (state) => {
      const { title, volumesById, volumeOrder, chaptersById, chapterOrder } = state;

      if (volumeOrder.length === 0) {
        const chapters: Array<{ chapterId: string; title: string; order: number; businessState: string }> = [];
        for (let i = 0; i < chapterOrder.length; i += 1) {
          const ch = chaptersById[chapterOrder[i]];
          if (!ch) continue;
          chapters.push({
            chapterId: ch.chapterId,
            title: ch.title,
            order: i + 1,
            businessState: ch.businessState,
          });
        }
        return {
          projectId,
          title,
          volumes: [{ volumeId: projectId, title, chapters }],
        };
      }

      const buckets = new Map<string, Array<{ chapterId: string; title: string; order: number; businessState: string }>>();
      for (const volId of volumeOrder) {
        buckets.set(volId, []);
      }
      const ungrouped: Array<{ chapterId: string; title: string; order: number; businessState: string }> = [];

      for (let i = 0; i < chapterOrder.length; i += 1) {
        const ch = chaptersById[chapterOrder[i]];
        if (!ch) continue;
        const entry = {
          chapterId: ch.chapterId,
          title: ch.title,
          order: i + 1,
          businessState: ch.businessState,
        };
        const bucket = ch.volumeId ? buckets.get(ch.volumeId) : undefined;
        if (bucket) {
          bucket.push(entry);
        } else {
          ungrouped.push(entry);
        }
      }

      const mapped = volumeOrder.map((volId) => {
        const vol = volumesById[volId];
        return {
          volumeId: vol.volumeId,
          title: vol.title,
          chapters: buckets.get(volId) ?? [],
        };
      });

      if (ungrouped.length > 0) {
        mapped.push({
          volumeId: `${projectId}:ungrouped`,
          title: "未分卷",
          chapters: ungrouped,
        });
      }
      return { projectId, title, volumes: mapped };
    },
  );
}

function revisions(definition: ReadDefinition, documentId: string) {
  return projectReadUnit(
    definition,
    () => ({
      currentRevisionId: "",
      currentTextRef: "",
      candidateId: null as string | null,
      candidateTextRef: null as string | null,
      diff: [] as View[],
    }),
    (state, event) => {
      if (event.documentId !== documentId) return state;
      if (event.kind === "revision.saved" || event.kind === "revision.finalized") {
        const revision = event.revisionId as string;
        return { ...state, currentRevisionId: revision, currentTextRef: revision };
      }
      if (event.kind === "candidate.produced") {
        const id = event.candidateId as string;
        return {
          ...state,
          candidateId: id,
          candidateTextRef: id,
          diff: [{ kind: "revision", anchor: { chapterId: documentId, point: "1" } }],
        };
      }
      if (event.kind === "candidate.closed" && event.candidateId === state.candidateId) {
        return { ...state, candidateId: null, candidateTextRef: null, diff: [] };
      }
      return state;
    },
    (state) => state,
  );
}

function run(definition: ReadDefinition, runId: string) {
  return projectReadUnit(
    definition,
    () => ({
      state: "running",
      nextStage: "draft.write.candidate" as string | null,
      budget: { reserved: 0, settled: 0 },
      checkpoints: [] as View[],
      attempts: [] as View[],
      lateSettled: false,
    }),
    (state, event) => {
      if (event.runId !== runId) return state;
      if (event.kind === "run.started") {
        return { ...state, budget: { ...state.budget, reserved: Number(event.reserved ?? 0) } };
      }
      if (event.kind === "run.attempt") {
        const stage = typeof event.stage === "string" ? event.stage : "draft.write.candidate";
        const attempt = { stage, attemptNo: state.attempts.length + 1, outcome: event.outcome };
        let checkpoints = state.checkpoints;
        if (typeof event.outputRef === "string") {
          const entry = { stage, version: 1, outputRef: event.outputRef };
          const idx = state.checkpoints.findIndex((cp) => cp.stage === stage);
          checkpoints = idx >= 0
            ? state.checkpoints.map((cp, index) => (index === idx ? entry : cp))
            : [...state.checkpoints, entry];
        }
        return {
          ...state,
          checkpoints,
          attempts: [...state.attempts, attempt],
          budget: { ...state.budget, settled: state.budget.settled + Number(event.usage ?? 0) },
        };
      }
      if (event.kind === "run.usage.late" && !state.lateSettled) {
        return {
          ...state,
          lateSettled: true,
          budget: { ...state.budget, settled: state.budget.settled + Number(event.usage ?? 0) },
        };
      }
      if (event.kind === "run.state") {
        return {
          ...state,
          state: event.state as string,
          nextStage: event.state === "running" ? "draft.write.candidate" : null,
        };
      }
      return state;
    },
    ({ lateSettled: _lateSettled, ...state }) => state,
  );
}

function buildUnit(
  name: string,
  definition: ReadDefinition,
  projectId: string,
  identity: readonly string[],
  point: number,
  extraFactories: Readonly<Record<string, AuthorReadUnitFactory>>,
): ProjectionUnit<unknown> {
  const [first] = identity;
  switch (name) {
    case "navigation":
      return navigation(definition, projectId);
    case "revision-candidate":
      return revisions(definition, first);
    case "run":
      return run(definition, first);
    default: {
      const factory = extraFactories[name];
      if (!factory) {
        throw new ContractError("input.invalid", { field: "model", reason: "unknown-read-model" });
      }
      return factory(definition, projectId, identity, point);
    }
  }
}

function loadDurableCheckpoint(
  db: SqliteDatabase,
  projectId: string,
  cacheKey: string,
): { readonly version: number; readonly seq: number; readonly val: unknown } | null {
  const row = stmt(
    db,
    `
      SELECT version, seq, state FROM author_read_checkpoints
      WHERE project_id = ? AND cache_key = ?;
    `,
  ).get(projectId, cacheKey) as { version: number; seq: number; state: string } | undefined;
  if (!row) return null;
  try {
    return { version: row.version, seq: row.seq, val: JSON.parse(row.state) as unknown };
  } catch {
    return null;
  }
}

function hasCheckpointLastUsedColumn(db: SqliteDatabase): boolean {
  const rows = db.prepare("PRAGMA table_info(author_read_checkpoints);").all() as readonly { name?: unknown }[];
  return rows.some((row) => row.name === "last_used_at");
}

function saveDurableCheckpointsBatch(
  db: SqliteDatabase,
  projectId: string,
  items: readonly { readonly cacheKey: string; readonly version: number; readonly seq: number; readonly stateJson: string }[],
  maxDurableCheckpoints: number,
): void {
  const now = Date.now();
  const hasLastUsed = hasCheckpointLastUsedColumn(db);
  if (hasLastUsed) {
    const upsert = stmt(
      db,
      `
        INSERT INTO author_read_checkpoints (project_id, cache_key, version, seq, state, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (project_id, cache_key)
        DO UPDATE SET
          version = excluded.version,
          seq = excluded.seq,
          state = excluded.state,
          last_used_at = excluded.last_used_at
        WHERE excluded.seq >= author_read_checkpoints.seq OR excluded.version != author_read_checkpoints.version;
      `,
    );
    for (const item of items) {
      upsert.run(projectId, item.cacheKey, item.version, item.seq, item.stateJson, now);
    }
    if (maxDurableCheckpoints > 0) {
      const total = (
        stmt(db, "SELECT COUNT(*) AS count FROM author_read_checkpoints;").get() as { count?: number } | undefined
      )?.count ?? 0;
      if (total > maxDurableCheckpoints) {
        const overflow = total - maxDurableCheckpoints;
        stmt(
          db,
          `
            DELETE FROM author_read_checkpoints
            WHERE rowid IN (
              SELECT rowid FROM author_read_checkpoints
              ORDER BY last_used_at ASC, rowid ASC
              LIMIT ?
            );
          `,
        ).run(overflow);
      }
    }
  } else {
    const upsertLegacy = stmt(
      db,
      `
        INSERT INTO author_read_checkpoints (project_id, cache_key, version, seq, state)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (project_id, cache_key)
        DO UPDATE SET version = excluded.version, seq = excluded.seq, state = excluded.state
        WHERE excluded.seq >= author_read_checkpoints.seq OR excluded.version != author_read_checkpoints.version;
      `,
    );
    for (const item of items) {
      upsertLegacy.run(projectId, item.cacheKey, item.version, item.seq, item.stateJson);
    }
  }
}

export interface ReadTransactionRunner {
  readonly read: <T>(query: () => T) => T;
  readonly atomic: <T>(apply: () => T) => T;
}

export interface AuthorModelReaderOptions {
  /** Minimum newly folded events since last save before persisting a checkpoint (default 1; 0 new events NEVER writes). */
  readonly checkpointMinEvents?: number;
  /** Optional minimum interval in ms before flushing checkpoints with fewer than `checkpointMinEvents` (default 0). */
  readonly checkpointMinIntervalMs?: number;
  /** Maximum rows retained in `author_read_checkpoints` via LRU eviction (default 2000). */
  readonly maxDurableCheckpoints?: number;
  /** Maximum in-memory units retained across all projects (default 256). */
  readonly maxMemoryUnits?: number;
}

interface AttachedUnitMeta {
  readonly cacheKey: string;
  readonly modelName: string;
  readonly definition: ReadDefinition;
  readonly unit: ProjectionUnit<unknown>;
  lastSavedSeq: number;
  lastSavedAt: number;
  hasDurableRow: boolean;
  lastAccessTick: number;
  served?: ServedRead;
}

interface ProjectProjectionHub {
  readonly projectId: string;
  readonly dbUuid: string;
  readonly store: ProjectionStore;
  readonly units: Map<string, AttachedUnitMeta>;
}

const REPLAY_PAGE_LIMIT = 1000;

/**
 * Author read-model reader backed by a per-project shared `ProjectionStore`
 * (DB-03), O(1) incremental `navigation` reducer, throttled & LRU-bounded
 * durable SQLite checkpoints (`author_read_checkpoints`), `db_uuid`-keyed
 * memory cache (DB-25), and concern self-check tolerance (DB-19).
 *
 * Guarantees zero write transactions on read requests when no new events exist.
 */
export function createAuthorModelReader(
  db: SqliteDatabase,
  tx: ReadTransactionRunner = { read: (fn) => fn(), atomic: (fn) => fn() },
  extraFactories: Readonly<Record<string, AuthorReadUnitFactory>> = {},
  options: AuthorModelReaderOptions = {},
) {
  const checkpointMinEvents = Math.max(1, Math.floor(options.checkpointMinEvents ?? 1));
  const checkpointMinIntervalMs = Math.max(0, Math.floor(options.checkpointMinIntervalMs ?? 0));
  const maxDurableCheckpoints = Math.max(1, Math.floor(options.maxDurableCheckpoints ?? 2000));
  const maxMemoryUnits = Math.max(8, Math.floor(options.maxMemoryUnits ?? 256));

  const projectHubs = new Map<string, ProjectProjectionHub>();
  let accessClock = 0;

  function totalCachedUnits(): number {
    let count = 0;
    for (const hub of projectHubs.values()) count += hub.units.size;
    return count;
  }

  function evictMemoryUnitsIfNeeded(protectedHubKey: string, protectedCacheKey: string): void {
    while (totalCachedUnits() > maxMemoryUnits) {
      let oldestTick = Number.POSITIVE_INFINITY;
      let victimHubKey: string | null = null;
      let victimCacheKey: string | null = null;
      for (const [hubKey, hub] of projectHubs) {
        for (const [ck, meta] of hub.units) {
          if (hubKey === protectedHubKey && ck === protectedCacheKey) continue;
          if (meta.lastAccessTick < oldestTick) {
            oldestTick = meta.lastAccessTick;
            victimHubKey = hubKey;
            victimCacheKey = ck;
          }
        }
      }
      if (!victimHubKey || !victimCacheKey) break;
      const victimHub = projectHubs.get(victimHubKey);
      if (!victimHub) break;
      victimHub.store.detachUnit(victimCacheKey);
      victimHub.units.delete(victimCacheKey);
      if (victimHub.units.size === 0) {
        projectHubs.delete(victimHubKey);
      }
    }
  }

  function foldStoreToTarget(
    projectId: string,
    store: ProjectionStore,
    targetSeq: number,
  ): number {
    let totalFolded = 0;
    while (store.seqOf() < targetSeq) {
      const cursor = store.seqOf();
      const remaining = targetSeq - cursor;
      const logged = readEvents(db, projectId, {
        afterSeq: cursor,
        limit: Math.min(REPLAY_PAGE_LIMIT, remaining),
      });
      if (logged.length === 0) break;
      const batch = new Array<{ readonly seq: number; readonly payload: unknown }>(logged.length);
      for (let i = 0; i < logged.length; i += 1) {
        const event = logged[i];
        if (event.seq !== cursor + i + 1) {
          throw new ContractError("storage.format_unsupported", { reason: "event-log-gap" });
        }
        const mat = materialiseLoggedEvent(event, true);
        batch[i] = { seq: mat.seq, payload: mat };
      }
      totalFolded += store.fold(batch);
    }
    return totalFolded;
  }

  function catchUpSingleUnitToTarget(
    projectId: string,
    store: ProjectionStore,
    cacheKey: string,
    targetSeq: number,
  ): number {
    let unitFolded = 0;
    let cursor = store.unitSeq(cacheKey) ?? 0;
    while (cursor < targetSeq) {
      const remaining = targetSeq - cursor;
      const logged = readEvents(db, projectId, {
        afterSeq: cursor,
        limit: Math.min(REPLAY_PAGE_LIMIT, remaining),
      });
      if (logged.length === 0) break;
      const batch = new Array<{ readonly seq: number; readonly payload: unknown }>(logged.length);
      for (let i = 0; i < logged.length; i += 1) {
        const event = logged[i];
        if (event.seq !== cursor + i + 1) {
          throw new ContractError("storage.format_unsupported", { reason: "event-log-gap" });
        }
        const mat = materialiseLoggedEvent(event, true);
        batch[i] = { seq: mat.seq, payload: mat };
      }
      unitFolded += store.catchUpUnit(cacheKey, batch);
      cursor = store.unitSeq(cacheKey) ?? cursor;
    }
    return unitFolded;
  }

  function readAuthorModel(projectId: string, input: Fields): ServedRead {
    const name = required(input, "model");
    const definition = READ_MODELS.find(({ id }) => id === name);
    if (!definition) {
      throw new ContractError("input.invalid", { field: "model", reason: "unknown-read-model" });
    }
    const identity = definition.key.slice(1).map((field) => required(input, field));
    const point = name === "settings-view" ? input.point ?? 1 : 1;
    if (typeof point !== "number" || !Number.isSafeInteger(point) || point < 1) {
      throw new ContractError("input.invalid", { field: "point", reason: "positive-integer-required" });
    }
    const cacheKey = JSON.stringify([projectId, name, ...identity, point]);
    const canonicalKey = readKey(definition.id, definition.version);

    const computed = tx.read(() => {
      const logHead = currentSeq(db, projectId);
      const dbUuid = readDatabaseUuid(db);
      const hubKey = `${dbUuid}\0${projectId}`;

      let hub = projectHubs.get(hubKey);
      if (!hub || hub.store.seqOf() > logHead) {
        hub = {
          projectId,
          dbUuid,
          store: createProjectionStore(db, projectId),
          units: new Map(),
        };
        projectHubs.set(hubKey, hub);
      }

      const { store } = hub;
      let meta = hub.units.get(cacheKey);
      let unitCatchUpFolded = 0;

      if (!meta) {
        const unit = buildUnit(name, definition, projectId, identity, point, extraFactories);
        let initialState: unknown = undefined;
        let initialSeq = 0;
        let hasDurableRow = false;

        const saved = loadDurableCheckpoint(db, projectId, cacheKey);
        if (saved && saved.version === definition.version && saved.seq >= 0 && saved.seq <= logHead) {
          if (saved.seq === 0) {
            initialState = saved.val;
            initialSeq = 0;
            hasDurableRow = true;
          } else {
            const anchorEvents = readEvents(db, projectId, { afterSeq: saved.seq - 1, limit: 1 });
            if (anchorEvents.length === 1 && anchorEvents[0].seq === saved.seq) {
              initialState = saved.val;
              initialSeq = saved.seq;
              hasDurableRow = true;
            }
          }
        }

        // If the hub has existing units behind `initialSeq`, bring them up first so shared seq >= initialSeq.
        if (hub.units.size > 0 && initialSeq > store.seqOf()) {
          foldStoreToTarget(projectId, store, initialSeq);
        }

        store.attachUnit(cacheKey, unit, initialState, initialSeq);
        meta = {
          cacheKey,
          modelName: name,
          definition,
          unit,
          lastSavedSeq: hasDurableRow ? initialSeq : 0,
          lastSavedAt: hasDurableRow ? Date.now() : 0,
          hasDurableRow,
          lastAccessTick: ++accessClock,
        };
        hub.units.set(cacheKey, meta);

        // If the shared store is already ahead of this newly attached unit, catch up ONLY this unit.
        if (initialSeq < store.seqOf()) {
          unitCatchUpFolded = catchUpSingleUnitToTarget(projectId, store, cacheKey, store.seqOf());
        }
      } else {
        meta.lastAccessTick = ++accessClock;
      }

      // Advance the entire shared project ProjectionStore in bounded pages, then
      // materialize & schema-validate the requested read ONCE at the final watermark!
      if (meta.served?.asOfSeq === logHead) {
        return {
          result: { ...structuredClone(meta.served), folded: 0 },
          checkpointsToPersist: [],
          persistNow: Date.now(),
        };
      }
      const sharedFolded = store.seqOf() < logHead ? foldStoreToTarget(projectId, store, logHead) : 0;
      const totalFolded = sharedFolded + unitCatchUpFolded;
      const cut = store.snapshot([cacheKey]);
      const stamped = serveRead(cut.values[cacheKey] as Record<string, unknown>, cut.asOfSeq);
      const problem = validateReadValue(definition, stamped);
      if (problem) {
        throw new ContractError("stage.output_invalid", { stage: canonicalKey, missing: problem });
      }
      const served: ServedRead = {
        key: canonicalKey,
        asOfSeq: cut.asOfSeq,
        value: stamped,
        folded: totalFolded,
      };

      const now = Date.now();
      const checkpointsToPersist: Array<{
        readonly cacheKey: string;
        readonly version: number;
        readonly seq: number;
        readonly stateJson: string;
        readonly meta: AttachedUnitMeta;
      }> = [];

      // Hard invariant (DB-03): NEVER schedule a checkpoint write when 0 events were folded!
      if (totalFolded > 0) {
        const currentStoreSeq = store.seqOf();
        for (const unitMeta of hub.units.values()) {
          const delta = currentStoreSeq - unitMeta.lastSavedSeq;
          if (delta <= 0) continue;
          const shouldSave =
            !unitMeta.hasDurableRow ||
            delta >= checkpointMinEvents ||
            (checkpointMinIntervalMs > 0 && now - unitMeta.lastSavedAt >= checkpointMinIntervalMs);
          if (shouldSave) {
            checkpointsToPersist.push({
              cacheKey: unitMeta.cacheKey,
              version: unitMeta.definition.version,
              seq: currentStoreSeq,
              stateJson: JSON.stringify(store.stateRef(unitMeta.cacheKey)),
              meta: unitMeta,
            });
          }
        }
      }

      evictMemoryUnitsIfNeeded(hubKey, cacheKey);

      const safeResult = name === "navigation" ? served : structuredClone(served);
      if (name === "navigation") meta.served = structuredClone(served);

      return {
        result: safeResult,
        checkpointsToPersist,
        persistNow: now,
      };
    });

    if (computed.checkpointsToPersist.length > 0) {
      tx.atomic(() => {
        saveDurableCheckpointsBatch(
          db,
          projectId,
          computed.checkpointsToPersist,
          maxDurableCheckpoints,
        );
      });
      for (const item of computed.checkpointsToPersist) {
        item.meta.lastSavedSeq = item.seq;
        item.meta.lastSavedAt = computed.persistNow;
        item.meta.hasDurableRow = true;
      }
    }

    return computed.result;
  }

  /** Flushes any throttled in-memory checkpoints to disk cleanly (e.g. before shutdown). */
  readAuthorModel.flushCheckpoints = (): number => {
    let flushed = 0;
    const now = Date.now();
    for (const hub of projectHubs.values()) {
      const currentStoreSeq = hub.store.seqOf();
      const due: Array<{
        readonly cacheKey: string;
        readonly version: number;
        readonly seq: number;
        readonly stateJson: string;
        readonly meta: AttachedUnitMeta;
      }> = [];
      for (const unitMeta of hub.units.values()) {
        if (currentStoreSeq > unitMeta.lastSavedSeq) {
          due.push({
            cacheKey: unitMeta.cacheKey,
            version: unitMeta.definition.version,
            seq: currentStoreSeq,
            stateJson: JSON.stringify(hub.store.stateRef(unitMeta.cacheKey)),
            meta: unitMeta,
          });
        }
      }
      if (due.length > 0) {
        tx.atomic(() => {
          saveDurableCheckpointsBatch(db, hub.projectId, due, maxDurableCheckpoints);
        });
        for (const item of due) {
          item.meta.lastSavedSeq = item.seq;
          item.meta.lastSavedAt = now;
          item.meta.hasDurableRow = true;
          flushed += 1;
        }
      }
    }
    return flushed;
  };

  return readAuthorModel;
}
