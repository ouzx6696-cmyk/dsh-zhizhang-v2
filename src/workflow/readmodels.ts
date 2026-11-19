// The read-model registry (contracts.md B.7.3, frozen 2026-11-19 as a first
// version).
//
// Six reads are named in section 3, and each has exactly one schema, one
// version, one key and a set of named source concerns. Three rules hold the
// surface together:
//
//   - the concern vocabulary is closed, so an event naming a concern no read
//     consumes is a contract violation rather than a new one;
//   - every read is project-scoped: the key starts at `projectId`, so one
//     project's events never leak into another's read;
//   - every served value carries the shared watermark `asOfSeq` as its own
//     field, and a single watermark compares every read against storage.
//
// A read stays a pure fold of committed events, never a cache owned by a
// Client: the same events give the same value, a fold reads no clock, and a
// served value is the whole value rather than a field-level delta. The folding
// machinery itself lives in `storage/projection.ts`; this module owns the
// frozen surface — the definitions, their validation, and the watermark
// discipline a serve must follow.
//
// The value schemas below are written in a small structural grammar so a served
// value can be checked against the frozen descriptor rather than merely
// documented by it. The grammar is this module's representation; the
// descriptors it encodes are the frozen ones.

import { RUN_STATES, type RunState } from "./runstate.ts";

/** The closed concern vocabulary: every event a read consumes names one. */
export const CONCERNS = [
  "chapter",
  "revision",
  "candidate",
  "setting",
  "evidence",
  "run",
  "approval",
] as const;

export type Concern = (typeof CONCERNS)[number];

const CONCERN_SET: ReadonlySet<string> = new Set(CONCERNS);

/** Whether a word belongs to the concern vocabulary. */
export function isConcern(value: unknown): value is Concern {
  return typeof value === "string" && CONCERN_SET.has(value);
}

/** A structural value schema, the machine-checkable form of a descriptor. */
export type ValueSchema =
  | { readonly kind: "int" }
  | { readonly kind: "text" }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "list"; readonly item: ValueSchema }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, ValueSchema>> }
  | { readonly kind: "optional"; readonly inner: ValueSchema };

/** One frozen read definition. */
export interface ReadDefinition {
  readonly id: string;
  readonly version: number;
  /** The key fields, always starting at `projectId`. */
  readonly key: readonly string[];
  /** The source concerns this read consumes. */
  readonly concerns: readonly Concern[];
  /** The value schema a served value must satisfy. */
  readonly schema: Readonly<Record<string, ValueSchema>>;
}

const anchor: ValueSchema = {
  kind: "object",
  fields: { chapterId: { kind: "text" }, point: { kind: "text" } },
};

/** The six frozen reads, in the order section 3 names them. */
export const READ_MODELS: readonly ReadDefinition[] = [
  {
    id: "navigation",
    version: 1,
    key: ["projectId"],
    concerns: ["chapter"],
    schema: {
      asOfSeq: { kind: "int" },
      projectId: { kind: "text" },
      title: { kind: "text" },
      volumes: {
        kind: "list",
        item: {
          kind: "object",
          fields: {
            volumeId: { kind: "text" },
            title: { kind: "text" },
            chapters: {
              kind: "list",
              item: {
                kind: "object",
                fields: {
                  chapterId: { kind: "text" },
                  title: { kind: "text" },
                  order: { kind: "int" },
                  businessState: { kind: "text" },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    id: "revision-candidate",
    version: 1,
    key: ["projectId", "documentId"],
    concerns: ["revision", "candidate"],
    schema: {
      asOfSeq: { kind: "int" },
      currentRevisionId: { kind: "text" },
      currentTextRef: { kind: "text" },
      candidateId: { kind: "optional", inner: { kind: "text" } },
      candidateTextRef: { kind: "optional", inner: { kind: "text" } },
      diff: {
        kind: "list",
        item: { kind: "object", fields: { kind: { kind: "text" }, anchor } },
      },
    },
  },
  {
    id: "settings-view",
    version: 1,
    key: ["projectId", "asOfChapter", "characterId"],
    concerns: ["setting", "chapter"],
    schema: {
      asOfSeq: { kind: "int" },
      query: {
        kind: "object",
        fields: { asOfChapter: { kind: "text" }, characterId: { kind: "text" } },
      },
      entries: {
        kind: "list",
        item: {
          kind: "object",
          fields: {
            factId: { kind: "text" },
            note: { kind: "text" },
            effectiveFrom: { kind: "text" },
          },
        },
      },
    },
  },
  {
    id: "evidence",
    version: 1,
    key: ["projectId", "factId"],
    concerns: ["evidence", "setting"],
    schema: {
      asOfSeq: { kind: "int" },
      snapshotId: { kind: "text" },
      revisionId: { kind: "text" },
      anchor,
      quoteRange: { kind: "object", fields: { start: { kind: "int" }, end: { kind: "int" } } },
      verification: {
        kind: "object",
        fields: { kind: { kind: "text" }, score: { kind: "optional", inner: { kind: "int" } } },
      },
    },
  },
  {
    id: "run",
    version: 1,
    key: ["projectId", "runId"],
    concerns: ["run"],
    schema: {
      asOfSeq: { kind: "int" },
      state: { kind: "enum", values: RUN_STATES },
      nextStage: { kind: "optional", inner: { kind: "text" } },
      budget: { kind: "object", fields: { reserved: { kind: "int" }, settled: { kind: "int" } } },
      checkpoints: {
        kind: "list",
        item: {
          kind: "object",
          fields: {
            stage: { kind: "text" },
            version: { kind: "int" },
            outputRef: { kind: "text" },
          },
        },
      },
      attempts: {
        kind: "list",
        item: {
          kind: "object",
          fields: {
            stage: { kind: "text" },
            attemptNo: { kind: "int" },
            outcome: { kind: "optional", inner: { kind: "text" } },
          },
        },
      },
    },
  },
  {
    id: "approval-history",
    version: 1,
    key: ["projectId"],
    concerns: ["approval"],
    schema: {
      asOfSeq: { kind: "int" },
      entries: {
        kind: "list",
        item: {
          kind: "object",
          fields: {
            approvalId: { kind: "text" },
            actor: { kind: "text" },
            action: { kind: "text" },
            target: { kind: "text" },
            targetVersion: { kind: "int" },
            decision: { kind: "text" },
            at: { kind: "text" },
          },
        },
      },
    },
  },
];

/** Why a definition is not a valid read model. */
export type ReadRefusal =
  | "invalid-version"
  | "missing-key"
  | "missing-concerns"
  | "unknown-concern"
  | "missing-schema"
  | "missing-watermark"
  | "not-project-scoped"
  | "unknown-id";

/**
 * Validates a definition against the frozen rules. Returns null when the
 * definition is valid, or the reason it is not.
 */
export function validateReadModel(entry: ReadDefinition): ReadRefusal | null {
  if (typeof entry.id !== "string" || entry.id.length === 0) return "invalid-version";
  if (!Number.isInteger(entry.version) || entry.version < 1) return "invalid-version";
  if (!Array.isArray(entry.key) || entry.key.length === 0) return "missing-key";
  if (entry.key[0] !== "projectId") return "not-project-scoped";
  if (!Array.isArray(entry.concerns) || entry.concerns.length === 0) return "missing-concerns";
  for (const concern of entry.concerns) {
    if (!isConcern(concern)) return "unknown-concern";
  }
  if (!entry.schema || Object.keys(entry.schema).length === 0) return "missing-schema";
  if (entry.schema.asOfSeq === undefined) return "missing-watermark";
  return null;
}

/** A read registry. */
export interface ReadRegistry {
  register(definition: ReadDefinition): { ok: true; key: string } | { ok: false; code: ReadRefusal | "idempotency.mismatch"; details: Record<string, unknown> };
  get(id: string, version: number): ReadDefinition | undefined;
  keys(): string[];
}

/** The registry key for one definition. */
export function readKey(id: string, version: number): string {
  return `${id}@${version}`;
}

/** Creates a registry holding the six frozen reads. */
export function createReadRegistry(): ReadRegistry {
  const reads = new Map<string, ReadDefinition>();
  const registry: ReadRegistry = {
    register(definition) {
      const refusal = validateReadModel(definition);
      if (refusal) return { ok: false, code: refusal, details: { id: definition.id } };
      const key = readKey(definition.id, definition.version);
      if (reads.has(key)) {
        return { ok: false, code: "idempotency.mismatch", details: { key } };
      }
      reads.set(key, definition);
      return { ok: true, key };
    },
    get(id, version) {
      return reads.get(readKey(id, version));
    },
    keys() {
      return [...reads.keys()];
    },
  };
  for (const definition of READ_MODELS) registry.register(definition);
  return registry;
}

/** Checks a value against a schema, returning the offending path or null. */
export function validateValue(schema: ValueSchema, value: unknown, path = "$"): string | null {
  switch (schema.kind) {
    case "int":
      return typeof value === "number" && Number.isInteger(value) ? null : path;
    case "text":
      return typeof value === "string" ? null : path;
    case "enum":
      return typeof value === "string" && schema.values.includes(value) ? null : path;
    case "optional":
      return value === null || value === undefined
        ? null
        : validateValue(schema.inner, value, path);
    case "list":
      if (!Array.isArray(value)) return path;
      for (let index = 0; index < value.length; index += 1) {
        const problem = validateValue(schema.item, value[index], `${path}[${index}]`);
        if (problem) return problem;
      }
      return null;
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return path;
      const record = value as Record<string, unknown>;
      for (const [field, fieldSchema] of Object.entries(schema.fields)) {
        const problem = validateValue(fieldSchema, record[field], `${path}.${field}`);
        if (problem) return problem;
      }
      return null;
    }
  }
}

/** Checks a served value against a definition's schema. */
export function validateReadValue(definition: ReadDefinition, value: unknown): string | null {
  return validateValue({ kind: "object", fields: definition.schema }, value);
}

/**
 * Stamps the shared watermark into a served value.
 *
 * The watermark is part of the served value, not of a Client cache, and one
 * watermark is enough to compare every read against storage. A value that
 * already carries a different watermark is refused rather than silently
 * relabelled, because that would mean two reads disagree about where they are.
 */
export function serveRead<T extends Record<string, unknown>>(
  value: T,
  asOfSeq: number,
): T & { asOfSeq: number } {
  if (!Number.isInteger(asOfSeq)) {
    throw new TypeError("the shared watermark must be an integer sequence number");
  }
  if (value.asOfSeq !== undefined && value.asOfSeq !== asOfSeq) {
    throw new TypeError("a served value may not carry a different watermark");
  }
  return { ...value, asOfSeq };
}

/** The events a read consumes, with the ones it does not name removed. */
export function concernEvents<T extends { concern: string }>(
  events: readonly T[],
  concerns: readonly Concern[],
): T[] {
  const wanted = new Set<string>(concerns);
  return events.filter((event) => wanted.has(event.concern));
}

/** The run states the `run` read's schema enumerates. */
export type ReadRunState = RunState;
