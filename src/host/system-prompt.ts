import type { Disposer, HostSystemPromptRegistrar } from "./dsh-adapter.ts";
import type { AuthorWorkspace } from "./workspace.ts";

/**
 * Product-agnostic Host bridge for DsH `ctx.systemPrompt`.
 * Injects only a lightweight (~200–380 token) progressive-disclosure summary
 * (active book/chapter focus, collaboration mode, mounted skill index) so the
 * DsH Agent stays cache-friendly and loads full 4-layer context & Skill bodies
 * on demand via tools.
 */
export function registerZhizhangSystemPrompt(
  registrar: HostSystemPromptRegistrar | undefined,
  workspace: AuthorWorkspace,
  enabled = true,
): Disposer[] {
  if (!registrar || !enabled) return [];
  const dispose = registrar.register({
    id: "zhizhang.cocreation",
    weight: 40,
    render: () => {
      const prompt = workspace.buildSystemPrompt();
      return prompt.enabled && prompt.text ? prompt.text : null;
    },
  });
  return [dispose];
}
