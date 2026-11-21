import type { Disposer, HostToolRegistrar } from "./dsh-adapter.ts";

/**
 * Maps the workbench's internal agent-tool spec onto the upstream DsH
 * ToolRuntime shape (DSH-01). Upstream validates every definition before it is
 * registered and rejects tools that do not declare `output.schema` plus an
 * `output.render` function, so this module owns that translation and its
 * self-check (`assertHostToolDefinition`).
 */

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_TOOL_DESCRIPTION_LENGTH = 1024;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface AgentToolParameterSchema {
  readonly type: "object";
  readonly description?: string;
  readonly required?: readonly string[];
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly additionalProperties: false;
}

export interface AgentToolExecution {
  readonly signal?: AbortSignal;
}

export interface AgentToolSpec {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
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
  readonly proposalOnly?: boolean;
  readonly timeoutMs: number;
  readonly parameters: AgentToolParameterSchema;
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>;
    render(
      args: Readonly<Record<string, unknown>>,
      value: unknown,
    ): readonly HostToolRenderBlock[];
  };
  execute(args: Readonly<Record<string, unknown>>, exec?: AgentToolExecution): Promise<unknown>;
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

/**
 * Replicates the upstream `tools.register` preconditions: a bad definition must
 * fail loudly here (and in tests) instead of silently disabling the workbench.
 */
export function assertHostToolDefinition(tool: HostToolDefinition): void {
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
  if (tool.parameters.type !== "object") {
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

export function toHostToolDefinition(spec: AgentToolSpec): HostToolDefinition {
  const definition: HostToolDefinition = {
    name: spec.name,
    description: spec.description,
    readOnly: spec.readOnly,
    ...(spec.proposalOnly === undefined ? {} : { proposalOnly: spec.proposalOnly }),
    timeoutMs: spec.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    parameters: spec.parameters,
    output: {
      schema: spec.outputSchema,
      render: (_args, value) => [{ type: "text", text: serializeToolResult(value) }],
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted();
      const value = await spec.execute(args, { signal: exec?.signal });
      exec?.signal?.throwIfAborted();
      return value;
    },
  };
  assertHostToolDefinition(definition);
  return definition;
}

/**
 * Registers every tool or none of them: a partial registration would leave the
 * model with a silent subset of the promised 7+3 surface.
 */
export function registerHostTools(
  registrar: HostToolRegistrar<HostToolDefinition>,
  specs: readonly AgentToolSpec[],
): Disposer[] {
  const disposers: Disposer[] = [];
  try {
    for (const spec of specs) {
      disposers.push(registrar.register(toHostToolDefinition(spec)));
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) void dispose();
    throw error;
  }
  return disposers;
}
