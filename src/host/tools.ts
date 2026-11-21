import {
  defineParameters,
  openOutputSchema,
  registerHostTools,
  type AgentToolSpec,
  type HostToolDefinition,
} from "./dsh-tools-adapter.ts";
import type { Disposer, HostToolRegistrar } from "./dsh-adapter.ts";
import type { AuthorWorkspace } from "./workspace.ts";

/** Upstream-shaped tool definition; kept as an alias so existing imports stay valid. */
export type ZhizhangAgentToolDefinition = HostToolDefinition;

/**
 * Product-agnostic Host bridge: collects declarative Agent tools from all
 * registered product-line modules (Fanqie, Toutiao, ...) and maps them onto
 * the upstream DsH ToolRuntime shape via `dsh-tools-adapter.ts`.
 *
 * Zero product-line rules or tool names are hardcoded in the Host layer.
 */
export function createZhizhangAgentTools(workspace: AuthorWorkspace): readonly AgentToolSpec[] {
  return workspace.agentTools().map((spec) => ({
    name: spec.name,
    description: spec.description,
    readOnly: spec.readOnly,
    ...(spec.proposalOnly ? { proposalOnly: true } : {}),
    parameters: defineParameters(spec.properties, spec.required),
    outputSchema: openOutputSchema(spec.outputDescription),
    execute: spec.execute,
  }));
}

/**
 * Registers all-or-nothing: a partial tool surface is worse than none, because
 * the model would silently lose declared capabilities.
 */
export function registerZhizhangTools(
  registrar: HostToolRegistrar<ZhizhangAgentToolDefinition> | undefined,
  workspace: AuthorWorkspace,
  enabled = true,
): Disposer[] {
  if (!registrar || !enabled) return [];
  return registerHostTools(registrar, createZhizhangAgentTools(workspace));
}
