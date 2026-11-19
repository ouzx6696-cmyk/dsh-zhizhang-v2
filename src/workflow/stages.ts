// The stage registry (contracts.md B.5, frozen 2026-11-19).
//
// A stage id is three dot-separated lowercase tokens plus a positive integer
// version: `domain.entity.action@version`. The rules the registry enforces:
//
//   - the id form is exact, so a malformed id is refused rather than stored;
//   - the action word may never be an author-granting action — `adopt`,
//     `finalize`, `decide`, `accept`, `deliver`, `approve` and `save` are
//     commands, and a stage that carried one would blur the line between
//     orchestration and an author decision;
//   - the version is a positive integer, and the same `id@version` registers
//     once: a repeat is `idempotency.mismatch`, never a silent overwrite,
//     because a checkpoint records the version and a redefinition would change
//     what that checkpoint means;
//   - a definition needs an execution type and an output validator, since a
//     stage whose output nobody checks is a stage that can fail silently.
//
// The business-line stage sets themselves follow the author's scenario matrix
// (C.1 item 8) and are not part of this registry's frozen surface.

import { ContractError } from "../contracts/errors.ts";

/** The exact stage-id form: three lowercase tokens. */
export const STAGE_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2}$/;

/** Author-granting action words, which may never name a stage. */
export const AUTHOR_ACTION_WORDS: readonly string[] = [
  "adopt",
  "finalize",
  "decide",
  "accept",
  "deliver",
  "approve",
  "save",
];

/** How a stage runs. */
export type StageExecution = "deterministic" | "model";

/** One registered stage definition. */
export interface StageDefinition {
  readonly id: string;
  readonly version: number;
  readonly execution: StageExecution;
  readonly validateOutput: (output: unknown) => boolean;
}

/** The parsed form of a stage id. */
export interface StageIdParts {
  readonly domain: string;
  readonly entity: string;
  readonly action: string;
}

/** Parses a stage id, or returns null when the form is wrong. */
export function parseStageId(id: unknown): StageIdParts | null {
  if (typeof id !== "string" || !STAGE_ID.test(id)) return null;
  const [domain, entity, action] = id.split(".");
  return { domain, entity, action };
}

/** The registry key for one definition. */
export function stageKey(id: string, version: number): string {
  return `${id}@${version}`;
}

/** A stage registry. */
export interface StageRegistry {
  register(definition: StageDefinition): { ok: true; key: string } | { ok: false; code: string; details: Record<string, unknown> };
  get(id: string, version: number): StageDefinition | undefined;
  keys(): string[];
}

/** Creates an empty registry. */
export function createStageRegistry(): StageRegistry {
  const stages = new Map<string, StageDefinition>();
  return {
    register(definition) {
      const parsed = parseStageId(definition.id);
      if (!parsed) {
        return { ok: false, code: "input.invalid", details: { id: definition.id, reason: "stage-id-malformed" } };
      }
      if (AUTHOR_ACTION_WORDS.includes(parsed.action)) {
        return { ok: false, code: "gate.denied", details: { id: definition.id, reason: "author-action-word" } };
      }
      if (!Number.isInteger(definition.version) || definition.version < 1) {
        return { ok: false, code: "input.invalid", details: { id: definition.id, reason: "version-not-positive" } };
      }
      if (definition.execution !== "deterministic" && definition.execution !== "model") {
        return { ok: false, code: "input.invalid", details: { id: definition.id, reason: "execution-unknown" } };
      }
      if (typeof definition.validateOutput !== "function") {
        return {
          ok: false,
          code: "input.invalid",
          details: { id: definition.id, reason: "output-validator-missing" },
        };
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

/**
 * Registers a definition, throwing the frozen error the registry reports.
 * The returning form above is for callers that want the refusal as a value;
 * this one is for call sites where a refusal is exceptional.
 */
export function registerStage(registry: StageRegistry, definition: StageDefinition): string {
  const result = registry.register(definition);
  if (result.ok) return result.key;
  throw new ContractError(result.code as never, result.details);
}
