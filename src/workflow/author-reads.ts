import { ContractError } from "../contracts/errors.ts";
import { settingsAt, type SettingFact } from "../domain/fanqie/index.ts";
import { anchor } from "../domain/shared/index.ts";
import { createProjectionStore, currentSeq, type ProjectionStore, type ProjectionUnit, type SqliteDatabase } from "../storage/index.ts";
import { READ_MODELS, readKey, type ReadDefinition } from "./readmodels.ts";
import { serveReadFromLog } from "./readserve.ts";

type Fields = Record<string, unknown>;
type View = Record<string, unknown>;
type Event = Fields & { kind: string };
type Chapter = { chapterId: string; title: string; businessState: string };
type Reducer<S> = (state: S, event: Event) => S;

function required(input: Fields, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new ContractError("input.invalid", { field: key, reason: "required" });
  return value;
}

function project<S>(definition: ReadDefinition, init: () => S, apply: Reducer<S>, view: (state: S) => View): ProjectionUnit<unknown> {
  return {
    version: definition.version,
    init,
    apply: (state, event) => apply(state as S, event as Event),
    view: (state) => view(state as S),
  };
}

function navigation(definition: ReadDefinition, projectId: string) {
  return project(definition, () => ({ title: "", chapters: [] as Chapter[] }), (state, event) => {
    if (event.kind === "project.created") return { ...state, title: event.name as string };
    if (event.kind === "document.created") {
      return { ...state, chapters: [...state.chapters, {
        chapterId: event.documentId as string, title: event.title as string,
        businessState: event.state as string ?? (event.mode ? "初稿待改" : "planned"),
      }] };
    }
    if (event.kind === "document.state" || event.kind === "chapter.reviewed" || event.kind === "document.renamed") {
      return { ...state, chapters: state.chapters.map((chapter) => chapter.chapterId === event.documentId
        ? { ...chapter, title: (event.title as string | undefined) ?? chapter.title, businessState: (event.state as string | undefined) ?? chapter.businessState } : chapter) };
    }
    if (event.kind === "chapter.reordered") {
      const ids = event.chapterIds as string[];
      const positions = new Map(ids.map((id, index) => [id, index]));
      return { ...state, chapters: [...state.chapters].sort((a, b) => positions.get(a.chapterId)! - positions.get(b.chapterId)!) };
    }
    return state;
  }, ({ title, chapters }) => ({
    projectId, title, volumes: [{ volumeId: projectId, title, chapters: chapters.map((chapter, order) => ({ ...chapter, order: order + 1 })) }],
  }));
}

function revisions(definition: ReadDefinition, documentId: string) {
  return project(definition, () => ({
    currentRevisionId: "", currentTextRef: "", candidateId: null as string | null,
    candidateTextRef: null as string | null, diff: [] as View[],
  }), (state, event) => {
    if (event.documentId !== documentId) return state;
    if (event.kind === "revision.saved" || event.kind === "revision.finalized") {
      const revision = event.revisionId as string;
      return { ...state, currentRevisionId: revision, currentTextRef: revision };
    }
    if (event.kind === "candidate.produced") {
      const id = event.candidateId as string;
      return { ...state, candidateId: id, candidateTextRef: id, diff: [{ kind: "revision", anchor: { chapterId: documentId, point: "1" } }] };
    }
    if (event.kind === "candidate.closed" && event.candidateId === state.candidateId) {
      return { ...state, candidateId: null, candidateTextRef: null, diff: [] };
    }
    return state;
  }, (state) => state);
}

function settings(definition: ReadDefinition, chapterId: string, characterId: string, point: number) {
  return project(definition, () => ({ order: [] as string[], facts: [] as SettingFact[] }), (state, event) => {
    if (event.kind === "document.created") return { ...state, order: [...state.order, event.documentId as string] };
    if (event.kind === "chapter.reordered") return { ...state, order: event.chapterIds as string[] };
    if (event.kind === "setting.decided" && event.decision === "approved" && event.fact) {
      const fact = event.fact as SettingFact;
      return { ...state, facts: [...state.facts, fact] };
    }
    return state;
  }, ({ order, facts }) => ({
    query: { asOfChapter: chapterId, characterId },
    entries: settingsAt(facts, order, anchor(chapterId, point), characterId).map((fact) => ({
      factId: fact.id, note: fact.note, effectiveFrom: fact.effectiveFrom.chapterId,
    })),
  }));
}

function evidence(definition: ReadDefinition, factId: string) {
  return project(definition, () => ({ record: null as View | null }), (state, event) => {
    if (event.kind !== "evidence.recorded" || event.factId !== factId) return state;
    return { record: event.record as View };
  }, ({ record }) => record ?? {});
}

function run(definition: ReadDefinition, runId: string) {
  return project(definition, () => ({
    state: "running", nextStage: "draft.write.candidate" as string | null,
    budget: { reserved: 0, settled: 0 }, checkpoints: [] as View[], attempts: [] as View[], lateSettled: false,
  }), (state, event) => {
    if (event.runId !== runId) return state;
    if (event.kind === "run.started") return { ...state, budget: { ...state.budget, reserved: Number(event.reserved ?? 0) } };
    if (event.kind === "run.attempt") {
      const stage = "draft.write.candidate";
      const attempt = { stage, attemptNo: state.attempts.length + 1, outcome: event.outcome };
      const checkpoints = typeof event.outputRef === "string" ? [{ stage, version: 1, outputRef: event.outputRef }] : state.checkpoints;
      return {
        ...state, checkpoints, attempts: [...state.attempts, attempt],
        budget: { ...state.budget, settled: state.budget.settled + Number(event.usage ?? 0) },
      };
    }
    if (event.kind === "run.usage.late" && !state.lateSettled) {
      return { ...state, lateSettled: true, budget: { ...state.budget, settled: state.budget.settled + Number(event.usage ?? 0) } };
    }
    if (event.kind === "run.state") {
      return { ...state, state: event.state as string, nextStage: event.state === "running" ? "draft.write.candidate" : null };
    }
    return state;
  }, ({ lateSettled: _lateSettled, ...state }) => state);
}

function approvals(definition: ReadDefinition) {
  return project(definition, () => ({ entries: [] as View[] }), (state, event) => {
    if (event.kind !== "delivery.approved" || typeof event.approvalId !== "string") return state;
    return { entries: [...state.entries, {
      approvalId: event.approvalId, actor: "author", action: "article.deliver",
      target: event.documentId, targetVersion: event.versionNumber, decision: "approved", at: event.at,
    }] };
  }, (state) => state);
}

export function createAuthorModelReader(db: SqliteDatabase) {
  const cache = new Map<string, { store: ProjectionStore; unit: ProjectionUnit<unknown> }>();
  return function readAuthorModel(projectId: string, input: Fields) {
    const name = required(input, "model");
    const definition = READ_MODELS.find(({ id }) => id === name);
    if (!definition) throw new ContractError("input.invalid", { field: "model", reason: "unknown-read-model" });
    const identity = definition.key.slice(1).map((field) => required(input, field));
    const point = name === "settings-view" ? input.point ?? 1 : 1;
    if (typeof point !== "number" || !Number.isSafeInteger(point) || point < 1) {
      throw new ContractError("input.invalid", { field: "point", reason: "positive-integer-required" });
    }
    const key = JSON.stringify([projectId, name, ...identity, point]);
    let entry = cache.get(key);
    if (!entry || entry.store.seqOf() > currentSeq(db, projectId)) {
      const [first, second] = identity;
      let unit: ProjectionUnit<unknown>;
      switch (name) {
        case "navigation": unit = navigation(definition, projectId); break;
        case "revision-candidate": unit = revisions(definition, first); break;
        case "settings-view": unit = settings(definition, first, second, point); break;
        case "evidence": unit = evidence(definition, first); break;
        case "run": unit = run(definition, first); break;
        default: unit = approvals(definition); break;
      }
      const store = createProjectionStore(db, projectId);
      store.register(readKey(definition.id, definition.version), unit);
      entry = { store, unit };
    }
    const { store, unit } = entry;
    const result = serveReadFromLog(db, projectId, store, { definition, unit }, { afterSeq: store.seqOf() });
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
    return structuredClone(result);
  };
}
