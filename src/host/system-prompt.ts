import type { Disposer, HostSystemPromptRegistrar } from "./dsh-adapter.ts";
import type { AuthorWorkspace } from "./workspace.ts";

/** Supply the current writing context only to its bound DsH conversation. */
export function registerZhizhangSystemPrompt(
  registrar: HostSystemPromptRegistrar | undefined,
  workspace: AuthorWorkspace,
  enabled = true,
): Disposer[] {
  if (!registrar || !enabled) return [];
  return [registrar.section({
    name: "zhizhang.cocreation",
    order: 40,
    interpolate: false,
    text: ({ agent }) => agent ? workspace.buildSystemPrompt(undefined, undefined, agent.id).text : "",
  })];
}
