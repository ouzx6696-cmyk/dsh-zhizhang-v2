import type { ProductAgentToolFacade, ProductAgentToolSpec } from "../../product-line.ts";

/**
 * Toutiao-declared DsH conversation tools.
 * Code enforces protected Toutiao semantics (34-char title cap, micro no-title rule,
 * 84 QA pass line, locked states 已验收/已交稿); Agent owns creative drafting and headline matrices.
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
    {
      name: "zhizhang_plan_toutiao_article",
      description:
        "Save Toutiao article planning metadata (driver, opening, ending, and optional 5-line '标题|母题' titles matrix). Strictly validates the protected 34-char title cap, >=3 motifs requirement, micro-post no-title rule, and locked states in code.",
      readOnly: false,
      properties: {
        documentId: { type: "string" },
        driver: { type: "string" },
        opening: { type: "string" },
        ending: { type: "string" },
        titles: { type: "string" },
      },
      required: ["documentId", "driver", "opening", "ending"],
      outputDescription: "Validated Toutiao planning object persisted on the article.",
      execute: (args) =>
        workspace.mutation("article.plan", {
          documentId: args.documentId,
          driver: args.driver,
          opening: args.opening,
          ending: args.ending,
          ...(typeof args.titles === "string" && args.titles.trim() ? { titles: args.titles } : {}),
        }),
    },
  ];
}
