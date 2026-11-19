import { ContractError } from "../contracts/errors.ts";
import {
  createProjectionStore,
  currentSeq,
  readTail,
  type CheckpointRow,
  type ProjectionStore,
  type ProjectionUnit,
  type SqliteDatabase,
} from "../storage/index.ts";
import { READ_MODELS, readKey, type ReadDefinition } from "./readmodels.ts";
import { serveReadFromLog } from "./readserve.ts";

export type Fields = Record<string, unknown>;
type View = Record<string, unknown>;
export type AuthorReadEvent = Fields & { kind: string };
type Chapter = { chapterId: string; title: string; businessState: string };
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

function navigation(definition: ReadDefinition, projectId: string) {
  return projectReadUnit(
    definition,
    () => ({ title: "", chapters: [] as Chapter[] }),
    (state, event) => {
      if (event.kind === "project.created") return { ...state, title: event.name as string };
      if (event.kind === "document.created") {
        return {
          ...state,
          chapters: [
            ...state.chapters,
            {
              chapterId: event.documentId as string,
              title: event.title as string,
              businessState: typeof event.state === "string" ? event.state : "planned",
            },
          ],
        };
      }
      if (event.kind === "document.state" || event.kind === "chapter.reviewed" || event.kind === "document.renamed") {
        return {
          ...state,
          chapters: state.chapters.map((chapter) =>
            chapter.chapterId === event.documentId
              ? {
                ...chapter,
                title: (event.title as string | undefined) ?? chapter.title,
                businessState: (event.state as string | undefined) ?? chapter.businessState,
              }
              : chapter,
          ),
        };
      }
      if (event.kind === "chapter.reordered") {
        const ids = event.chapterIds as string[];
        const positions = new Map(ids.map((id, index) => [id, index]));
        return {
          ...state,
          chapters: [...state.chapters].sort((a, b) => positions.get(a.chapterId)! - positions.get(b.chapterId)!),
        };
      }
      return state;
    },
    ({ title, chapters }) => ({
      projectId,
      title,
      volumes: [
        {
          volumeId: projectId,
          title,
          chapters: chapters.map((chapter, order) => ({ ...chapter, order: order + 1 })),
        },
      ],
    }),
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
        const checkpoints =
          typeof event.outputRef === "string"
            ? [{ stage, version: 1, outputRef: event.outputRef }]
            : state.checkpoints;
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
  unitKey: string,
): CheckpointRow[] {
  const row = db
    .prepare(`
      SELECT version, seq, state FROM author_read_checkpoints
      WHERE project_id = ? AND cache_key = ?;
    `)
    .get(projectId, cacheKey) as { version: number; seq: number; state: string } | undefined;
  if (!row) return [];
  return [{ key: unitKey, ver: row.version, seq: row.seq, val: JSON.parse(row.state) as unknown }];
}

function saveDurableCheckpointRow(
  db: SqliteDatabase,
  projectId: string,
  cacheKey: string,
  row: CheckpointRow,
): void {
  db.prepare(`
    INSERT INTO author_read_checkpoints (project_id, cache_key, version, seq, state)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (project_id, cache_key)
    DO UPDATE SET version = excluded.version, seq = excluded.seq, state = excluded.state
    WHERE excluded.seq >= author_read_checkpoints.seq OR excluded.version != author_read_checkpoints.version;
  `).run(projectId, cacheKey, row.ver, row.seq, JSON.stringify(row.val));
}

export interface ReadTransactionRunner {
  readonly read: <T>(query: () => T) => T;
  readonly atomic: <T>(apply: () => T) => T;
}

/**
 * Author read-model reader backed by durable SQLite projection checkpoints
 * (`author_read_checkpoints`) and an in-memory LRU cache. Cold opens restore
 * from the checkpoint and replay only the event-log tail via `ProjectionStore`.
 */
export function createAuthorModelReader(
  db: SqliteDatabase,
  tx: ReadTransactionRunner = { read: (fn) => fn(), atomic: (fn) => fn() },
  extraFactories: Readonly<Record<string, AuthorReadUnitFactory>> = {},
) {
  const cache = new Map<string, { store: ProjectionStore; unit: ProjectionUnit<unknown> }>();

  return function readAuthorModel(projectId: string, input: Fields) {
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
    const unitKey = readKey(definition.id, definition.version);

    const computed = tx.read(() => {
      const logHead = currentSeq(db, projectId);
      let entry = cache.get(cacheKey);
      let hydratedFromCheckpoint = false;

      if (!entry || entry.store.seqOf() > logHead) {
        const unit = buildUnit(name, definition, projectId, identity, point, extraFactories);
        const store = createProjectionStore(db, projectId);
        store.register(unitKey, unit);

        const saved = loadDurableCheckpoint(db, projectId, cacheKey, unitKey);
        if (saved.length > 0 && saved[0].seq <= logHead) {
          const floor = store.restoreFloor(saved);
          if (floor !== undefined && floor >= 0) {
            const tail = readTail(db, projectId, floor);
            if (tail.events.length > 0 || saved[0].seq === 0) {
              store.restore(saved, tail.events, tail.baseSeq);
              hydratedFromCheckpoint = true;
            }
          }
        }
        entry = { store, unit };
      }

      const { store, unit } = entry;
      const result = serveReadFromLog(db, projectId, store, { definition, unit }, { afterSeq: store.seqOf() });
      const checkpointToPersist = result.folded > 0 || hydratedFromCheckpoint
        ? store.checkpoint()[0]
        : undefined;

      cache.delete(cacheKey);
      cache.set(cacheKey, entry);
      if (cache.size > 32) cache.delete(cache.keys().next().value!);

      return {
        result: structuredClone(result),
        checkpointToPersist,
      };
    });

    if (computed.checkpointToPersist) {
      const row = computed.checkpointToPersist;
      tx.atomic(() => saveDurableCheckpointRow(db, projectId, cacheKey, row));
    }

    return computed.result;
  };
}
