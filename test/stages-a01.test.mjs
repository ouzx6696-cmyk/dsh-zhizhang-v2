import assert from "node:assert/strict";
import test from "node:test";

// A-01 supporting fixture for the stage definitions. The enumeration under
// test is appendix B.5 of contracts.md, recorded from the v1.x pipeline stage
// names (fanqie.book.*, fanqie.chapter.*, fanqie.ledger.*, library.dissect,
// toutiao.article.*) as forensic evidence: the dotted domain.entity.action
// form is kept, versions are added, and one v1.x defect is corrected.
// **Frozen on 2026-11-19 as A-class items**: the ID form, the version
// semantics and the registration rules. The business-line stage sets still
// depend on the author's scenario matrix (C.1 item 8).

// The proposed stage form: exactly three dot-separated segments, each a
// lowercase token, plus a positive integer version.
const STAGE_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2}$/;

function parseStageId(id) {
  if (typeof id !== "string" || !STAGE_ID.test(id)) return null;
  const [domain, entity, action] = id.split(".");
  return { domain, entity, action };
}

function stageKey(id, version) {
  return `${id}@${version}`;
}

// Author-granting actions are commands, never stages.
const AUTHOR_ACTION_WORDS = new Set([
  "adopt",
  "finalize",
  "decide",
  "accept",
  "deliver",
  "approve",
  "save",
]);

function createRegistry() {
  const stages = new Map();
  return {
    register(definition) {
      const parsed = parseStageId(definition.id);
      if (!parsed) {
        return { ok: false, code: "input.invalid", details: { id: definition.id } };
      }
      if (AUTHOR_ACTION_WORDS.has(parsed.action)) {
        return { ok: false, code: "gate.denied", details: { id: definition.id } };
      }
      if (!Number.isInteger(definition.version) || definition.version < 1) {
        return { ok: false, code: "input.invalid", details: { id: definition.id } };
      }
      if (definition.execution !== "deterministic" && definition.execution !== "model") {
        return { ok: false, code: "input.invalid", details: { id: definition.id } };
      }
      if (typeof definition.validateOutput !== "function") {
        return { ok: false, code: "input.invalid", details: { id: definition.id, reason: "output-validator-missing" } };
      }
      const key = stageKey(definition.id, definition.version);
      if (stages.has(key)) {
        return { ok: false, code: "idempotency.mismatch", details: { key } };
      }
      stages.set(key, definition);
      return { ok: true, key };
    },
    get(id, version) {
      return stages.get(stageKey(id, version));
    },
    keys() {
      return [...stages.keys()];
    },
  };
}

// The proposed first-version stage sets, recorded from v1.x. Two v1.x names are
// normalized into the three-segment form: the dissect stage was
// `library.dissect` (two segments) and the health pipeline reused
// `fanqie.chapter.review`. The fanqie ledger and health entries share the
// chapter review stage in v1.x; the proposal keeps one definition per id.
const FANQIE_STAGES = [
  ["fanqie.book.card", "model"],
  ["fanqie.book.foundation", "model"],
  ["fanqie.book.structure", "model"],
  ["fanqie.book.outline", "model"],
  ["fanqie.chapter.beats", "model"],
  ["fanqie.chapter.draft", "model"],
  ["fanqie.chapter.select", "deterministic"],
  ["fanqie.chapter.review", "model"],
  ["fanqie.chapter.revise", "model"],
  ["fanqie.ledger.extract", "deterministic"],
  ["fanqie.library.dissect", "model"],
];

const TOUTIAO_STAGES = [
  ["toutiao.article.card", "model"],
  ["toutiao.article.title", "model"],
  ["toutiao.article.blueprint", "model"],
  ["toutiao.article.draft", "model"],
  ["toutiao.article.facts", "model"],
  ["toutiao.article.review", "model"],
  ["toutiao.article.revise", "model"],
  ["toutiao.article.qa", "deterministic"],
];

function registerAll(registry, entries, version = 1) {
  const results = [];
  for (const [id, execution] of entries) {
    results.push(
      registry.register({
        id,
        version,
        execution,
        validateOutput: (output) => typeof output === "string" && output.length > 0,
      }),
    );
  }
  return results;
}

test("A-01 every proposed stage id keeps the three-segment form and takes a positive version", () => {
  for (const [id] of [...FANQIE_STAGES, ...TOUTIAO_STAGES]) {
    const parsed = parseStageId(id);
    assert.ok(parsed, id);
    assert.equal(parsed.domain.includes("-"), false);
  }
  for (const bad of ["fanqie.book", "fanqie.book.Card", "fanqie..card", "fanqie.book.card.extra", ""]) {
    assert.equal(parseStageId(bad), null, bad);
  }
  const registry = createRegistry();
  assert.equal(
    registry.register({ id: "fanqie.book.card", version: 0, execution: "model", validateOutput: () => true }).code,
    "input.invalid",
  );
});

test("A-01 a stage definition without an execution type or an output validator is refused", () => {
  const registry = createRegistry();
  const base = { id: "fanqie.book.card", version: 1, validateOutput: () => true };
  assert.equal(registry.register(base).code, "input.invalid");
  assert.equal(registry.register({ ...base, execution: "hybrid" }).code, "input.invalid");
  assert.equal(registry.register({ ...base, execution: "model" }).ok, true);
  const noValidator = { id: "fanqie.book.foundation", version: 1, execution: "model" };
  assert.equal(registry.register(noValidator).code, "input.invalid");
  assert.equal(registry.register(noValidator).details.reason, "output-validator-missing");
});

test("A-01 the same id at a new version is a new definition, and a resumed run keeps the version it started with", () => {
  const registry = createRegistry();
  assert.equal(registerAll(registry, FANQIE_STAGES).every((r) => r.ok), true);
  const first = registry.get("fanqie.chapter.draft", 1);
  assert.ok(first);

  // A schema change is a version bump, not an edit of the live definition.
  const bumped = registry.register({
    id: "fanqie.chapter.draft",
    version: 2,
    execution: "model",
    validateOutput: () => true,
  });
  assert.equal(bumped.ok, true);
  assert.equal(bumped.key, "fanqie.chapter.draft@2");
  assert.notEqual(registry.get("fanqie.chapter.draft", 1), registry.get("fanqie.chapter.draft", 2));
  // Registering the same key twice is a mismatch, not a silent overwrite.
  assert.equal(
    registry.register({ id: "fanqie.chapter.draft", version: 2, execution: "model", validateOutput: () => true }).code,
    "idempotency.mismatch",
  );

  // A checkpoint stores the version, so a resumed run continues with the same
  // definition rather than the newest one (W-01 invariant 4).
  const checkpoint = { runId: "run-1", stage: "fanqie.chapter.draft", version: 1 };
  assert.equal(registry.get(checkpoint.stage, checkpoint.version), first);
});

test("A-01 no stage name performs an author action, so the gates stay outside the pipeline", () => {
  for (const [id] of [...FANQIE_STAGES, ...TOUTIAO_STAGES]) {
    const parsed = parseStageId(id);
    assert.equal(AUTHOR_ACTION_WORDS.has(parsed.action), false, id);
  }
  const registry = createRegistry();
  for (const id of ["fanqie.chapter.adopt", "fanqie.chapter.finalize", "toutiao.article.deliver", "toutiao.article.approve"]) {
    assert.equal(
      registry.register({ id, version: 1, execution: "deterministic", validateOutput: () => true }).code,
      "gate.denied",
      id,
    );
  }
});

test("A-01 an incremental fact check is a parameter of the facts stage, not a dynamic stage id", () => {
  // v1.x built the stage name from the step id (`${stepId}-facts`), which breaks
  // the three-segment form and the (run, stage, version) checkpoint identity.
  // The proposal keeps one facts stage and passes the step as input.
  assert.equal(parseStageId("review-facts"), null);
  const registry = createRegistry();
  assert.equal(
    registry.register({ id: "review-facts", version: 1, execution: "model", validateOutput: () => true }).code,
    "input.invalid",
  );
  assert.equal(registerAll(registry, TOUTIAO_STAGES).every((r) => r.ok), true);
  const facts = registry.get("toutiao.article.facts", 1);
  assert.ok(facts);
  const packet = { claims: ["claim-1"], step: "review", incremental: true };
  assert.equal(facts.validateOutput("verified"), true);
  assert.equal(facts.validateOutput(""), false);
  assert.equal(packet.incremental, true);
});

test("A-01 the two proposed stage sets stay disjoint and fully registered", () => {
  const registry = createRegistry();
  assert.equal(registerAll(registry, FANQIE_STAGES).every((r) => r.ok), true);
  assert.equal(registerAll(registry, TOUTIAO_STAGES).every((r) => r.ok), true);
  const fanqieIds = new Set(FANQIE_STAGES.map(([id]) => id));
  const toutiaoIds = new Set(TOUTIAO_STAGES.map(([id]) => id));
  for (const id of toutiaoIds) assert.equal(fanqieIds.has(id), false, id);
  assert.equal(registry.keys().length, FANQIE_STAGES.length + TOUTIAO_STAGES.length);
  // Every registered definition carries a validator and an execution type.
  for (const key of registry.keys()) {
    const definition = registry.get(key.split("@")[0], Number(key.split("@")[1]));
    assert.equal(typeof definition.validateOutput, "function");
    assert.equal(["deterministic", "model"].includes(definition.execution), true);
  }
});
