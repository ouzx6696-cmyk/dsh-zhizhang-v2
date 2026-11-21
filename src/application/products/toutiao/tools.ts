import type { ProductAgentToolFacade, ProductAgentToolSpec } from "../../product-line.ts";

/**
 * Toutiao-declared DsH conversation tools (strictly read-only).
 * Never mutates drafts, QA reports, approvals, or deliveries.
 */
export function createToutiaoAgentTools(workspace: ProductAgentToolFacade): readonly ProductAgentToolSpec[] {
  return [
    {
      name: "zhizhang_read_article",
      description: "Read a Toutiao article's working draft, scenario matrix, latest QA report, and approval/delivery status.",
      readOnly: true,
      properties: { projectId: { type: "string" }, documentId: { type: "string" } },
      required: ["projectId", "documentId"],
      outputDescription: "Toutiao article snapshot with scenario, QA report, and approval state.",
      execute: (args) =>
        workspace.snapshot(
          typeof args.projectId === "string" ? args.projectId : undefined,
          typeof args.documentId === "string" ? args.documentId : undefined,
        ),
    },
  ];
}
