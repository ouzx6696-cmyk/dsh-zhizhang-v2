import { canonicalizeJsonKeys } from "../workflow/cache-layer.ts";
import type { Disposer, HostAgent, HostToolRegistrar } from "./dsh-adapter.ts";

/** Maps application tools to DsH 0.2.2-rc.5 runtime definitions. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_TOOL_DESCRIPTION_LENGTH = 1024;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export type HostToolParameterFormat = "json-schema" | "dsh-flat";

export interface AgentToolParameterSchema {
  readonly type: "object";
  readonly description?: string;
  readonly required?: readonly string[];
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly additionalProperties: false;
}

/**
 * Upstream `@deepseek-ai/dsh-tools` flat parameter DSL (`defineTool` shape):
 * each key maps directly to its parameter spec with an optional `required` flag.
 */
export interface FlatParameterFieldSpec {
  readonly type: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly enum?: readonly unknown[];
  readonly items?: Readonly<Record<string, unknown>>;
  readonly minimum?: number;
  readonly maximum?: number;
}

export type FlatParameterSchemaSpec = Readonly<Record<string, FlatParameterFieldSpec>>;

export interface AgentToolExecution {
  readonly agent?: HostAgent;
  readonly callId?: string;
  readonly signal?: AbortSignal;
}

export interface AgentToolSpec {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  /** Internal safety flag — never leaked onto the upstream wire object. */
  readonly proposalOnly?: boolean;
  readonly timeoutMs?: number;
  readonly parameters: AgentToolParameterSchema;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  execute(args: Readonly<Record<string, unknown>>, exec: AgentToolExecution): unknown;
}

export interface HostToolRenderBlock {
  readonly type: "text";
  readonly text: string;
}

export interface HostToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly timeoutMs: number;
  readonly parameters: AgentToolParameterSchema | FlatParameterSchemaSpec;
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>;
    render(
      args: Readonly<Record<string, unknown>>,
      value: unknown,
    ): readonly HostToolRenderBlock[];
  };
  execute(args: Readonly<Record<string, unknown>>, exec?: AgentToolExecution): Promise<unknown>;
}

export interface HostToolAdapterOptions {
  readonly parameterFormat?: HostToolParameterFormat;
  readonly when?: (context: { agent: HostAgent }) => boolean;
}

/** Builds `parameters` with the `additionalProperties: false` that upstream requires. */
export function defineParameters(
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  required: readonly string[] = [],
  description?: string,
): AgentToolParameterSchema {
  return {
    type: "object",
    ...(description ? { description } : {}),
    required: [...required],
    properties,
    additionalProperties: false,
  };
}

/**
 * Translates internal JSON Schema object parameters into upstream
 * `@deepseek-ai/dsh-tools` flat `ParameterSchemaSpec` (`{ field: { type, required, ... } }`).
 */
export function toFlatParameterSpec(schema: AgentToolParameterSchema): FlatParameterSchemaSpec {
  const requiredSet = new Set(schema.required ?? []);
  const flat: Record<string, FlatParameterFieldSpec> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const type = typeof prop.type === "string" ? prop.type : "string";
    const entry: {
      type: string;
      description?: string;
      required?: boolean;
      enum?: readonly unknown[];
      items?: Readonly<Record<string, unknown>>;
      minimum?: number;
      maximum?: number;
    } = { type };
    if (typeof prop.description === "string") entry.description = prop.description;
    if (requiredSet.has(key)) entry.required = true;
    if (Array.isArray(prop.enum)) entry.enum = [...prop.enum];
    if (prop.items && typeof prop.items === "object" && !Array.isArray(prop.items)) {
      entry.items = prop.items as Readonly<Record<string, unknown>>;
    }
    if (typeof prop.minimum === "number") entry.minimum = prop.minimum;
    if (typeof prop.maximum === "number") entry.maximum = prop.maximum;
    flat[key] = entry;
  }
  return flat;
}

/**
 * A permissive JSON schema for tool results. The DTOs returned by the workbench
 * are large discriminated unions; describing them exhaustively here would
 * duplicate `contracts/workspace-dto.ts` and drift. Upstream only needs a valid
 * schema object, so every tool declares an open object and relies on
 * `output.render` for the readable payload.
 */
export function openOutputSchema(description: string): Readonly<Record<string, unknown>> {
  return { type: "object", description, additionalProperties: true };
}

export function serializeToolResult(value: unknown): string {
  if (value === undefined) return "null";
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  } catch {
    return JSON.stringify({ error: "unserializable-tool-result" });
  }
}

export class HostToolContractError extends Error {
  readonly toolName: string;
  readonly field: string;

  constructor(toolName: string, field: string, reason: string) {
    super(`tool "${toolName}" must declare ${field} (${reason})`);
    this.name = "HostToolContractError";
    this.toolName = toolName;
    this.field = field;
  }
}

function assertSchemaObject(toolName: string, field: string, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostToolContractError(toolName, field, "object-required");
  }
}

function isJsonSchemaParameters(value: unknown): value is AgentToolParameterSchema {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && "type" in value
    && "properties" in value,
  );
}

/**
 * Replicates the upstream `tools.register` preconditions: a bad definition must
 * fail loudly here (and in tests) instead of silently disabling the workbench.
 */
export function assertHostToolDefinition(
  tool: HostToolDefinition,
  format: HostToolParameterFormat = "json-schema",
): void {
  const name = typeof tool.name === "string" ? tool.name : "";
  if (!name || name.length > MAX_TOOL_NAME_LENGTH || !TOOL_NAME_PATTERN.test(name)) {
    throw new HostToolContractError(name || "<anonymous>", "name", "lowercase-identifier");
  }
  if (typeof tool.description !== "string" || !tool.description.trim()) {
    throw new HostToolContractError(name, "description", "non-empty");
  }
  if (tool.description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
    throw new HostToolContractError(name, "description", "too-long");
  }
  if (typeof tool.readOnly !== "boolean") {
    throw new HostToolContractError(name, "readOnly", "boolean-required");
  }
  if (tool.timeoutMs !== undefined && (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs <= 0)) {
    throw new HostToolContractError(name, "timeoutMs", "positive-integer");
  }
  assertSchemaObject(name, "parameters", tool.parameters);
  if (format === "dsh-flat") {
    for (const [key, field] of Object.entries(tool.parameters as FlatParameterSchemaSpec)) {
      assertSchemaObject(name, `parameters.${key}`, field);
      if (typeof field.type !== "string" || !field.type) {
        throw new HostToolContractError(name, `parameters.${key}.type`, "string-required");
      }
    }
  } else {
    if (!isJsonSchemaParameters(tool.parameters) || tool.parameters.type !== "object") {
      throw new HostToolContractError(name, "parameters.type", "object-required");
    }
    assertSchemaObject(name, "parameters.properties", tool.parameters.properties);
    if (tool.parameters.additionalProperties !== false) {
      throw new HostToolContractError(name, "parameters.additionalProperties", "must-be-false");
    }
    for (const key of tool.parameters.required ?? []) {
      if (!(key in tool.parameters.properties)) {
        throw new HostToolContractError(name, `parameters.required.${key}`, "unknown-property");
      }
    }
  }
  if (!tool.output || typeof tool.output !== "object") {
    throw new HostToolContractError(name, "output { schema, render }", "object-required");
  }
  assertSchemaObject(name, "output.schema", tool.output.schema);
  if (typeof tool.output.render !== "function") {
    throw new HostToolContractError(name, "output.render", "function-required");
  }
  if (typeof tool.execute !== "function") {
    throw new HostToolContractError(name, "execute", "function-required");
  }
}

export function toHostToolDefinition(
  spec: AgentToolSpec,
  options?: HostToolAdapterOptions,
): HostToolDefinition {
  const format = options?.parameterFormat ?? "json-schema";
  const rawParameters = format === "dsh-flat" ? toFlatParameterSpec(spec.parameters) : spec.parameters;
  const definition: HostToolDefinition = {
    name: spec.name,
    description: spec.description,
    readOnly: spec.readOnly,
    timeoutMs: spec.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    parameters: canonicalizeJsonKeys(rawParameters),
    output: {
      schema: canonicalizeJsonKeys(spec.outputSchema),
      render: (_args, value) => [{ type: "text", text: serializeToolResult(value) }],
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted();
      const value = await spec.execute(args, exec ?? {});
      exec?.signal?.throwIfAborted();
      return value;
    },
  };
  assertHostToolDefinition(definition, format);
  return definition;
}

/**
 * Registers every tool or none of them in deterministic lexicographical order
 * so DsH host tool prompt prefixes remain byte-stable across restarts.
 */
export function registerHostTools(
  registrar: HostToolRegistrar<HostToolDefinition>,
  specs: readonly AgentToolSpec[],
  options?: HostToolAdapterOptions,
): Disposer[] {
  const sortedSpecs = [...specs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const disposers: Disposer[] = [];
  try {
    for (const spec of sortedSpecs) {
      disposers.push(registrar.register(toHostToolDefinition(spec, options), options?.when ? { when: options.when } : undefined));
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) void dispose();
    throw error;
  }
  return disposers;
}
