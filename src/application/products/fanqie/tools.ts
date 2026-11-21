import type { ProductAgentToolFacade, ProductAgentToolSpec } from "../../product-line.ts";

/**
 * Fanqie-declared DsH conversation tools (7 strict read-only + 3 proposal-only).
 * Owned by the Fanqie product-line module so the Host layer remains strictly
 * product-agnostic. Zero tools may mutate authoritative drafts or approved lore.
 */
export function createFanqieAgentTools(workspace: ProductAgentToolFacade): readonly ProductAgentToolSpec[] {
  return [
    {
      name: "zhizhang_read_tree",
      description: "Read the volume -> act -> chapter hierarchy, char counts, and rolling summaries of a Fanqie project.",
      readOnly: true,
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
      outputDescription: "Fanqie volume/act/chapter tree with char counts and rolling summaries.",
      execute: (args) => workspace.mutation("tree.get", { projectId: args.projectId }),
    },
    {
      name: "zhizhang_read_chapter",
      description: "Read a chapter's current working draft, state, planning metadata, and active context crumb.",
      readOnly: true,
      properties: { projectId: { type: "string" }, documentId: { type: "string" } },
      required: ["projectId", "documentId"],
      outputDescription: "Chapter snapshot: draft body, state, planning metadata, and context crumb.",
      execute: (args) =>
        workspace.snapshot(
          typeof args.projectId === "string" ? args.projectId : undefined,
          typeof args.documentId === "string" ? args.documentId : undefined,
        ),
    },
    {
      name: "zhizhang_read_known_facts",
      description: "Check which approved lore facts a specific character knows at a given chapter and paragraph anchor.",
      readOnly: true,
      properties: {
        projectId: { type: "string" },
        character: { type: "string" },
        chapterId: { type: "string" },
        point: { type: "number" },
      },
      required: ["projectId", "character", "chapterId"],
      outputDescription: "Settings view restricted to facts the character knows at the given anchor.",
      execute: (args) =>
        workspace.mutation("settings.read", {
          projectId: args.projectId,
          character: args.character,
          at: { chapterId: args.chapterId, point: typeof args.point === "number" ? args.point : 1 },
        }),
    },
    {
      name: "zhizhang_search_workspace",
      description: "Full-text BM25+RRF search across chapters, approved lore, deconstructions, and techniques/skills.",
      readOnly: true,
      properties: { projectId: { type: "string" }, query: { type: "string" }, limit: { type: "number" } },
      required: ["projectId", "query"],
      outputDescription: "Ranked workspace search hits with source kind and snippet.",
      execute: (args) =>
        workspace.mutation("workspace.search", {
          projectId: args.projectId,
          query: args.query,
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        }),
    },
    {
      name: "zhizhang_check_conflicts",
      description: "Run deterministic timeline & knownFrom conflict scan on approved Fanqie lore and foreshadows.",
      readOnly: true,
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
      outputDescription: "Deterministic lore conflict list (timeline and knowledge boundaries).",
      execute: (args) => workspace.mutation("lore.conflicts", { projectId: args.projectId }),
    },
    {
      name: "zhizhang_diagnose_chapter",
      description: "Run zero-token offline Golden-3-chapters and AI-slop diagnostics on a Fanqie chapter.",
      readOnly: true,
      properties: { documentId: { type: "string" } },
      required: ["documentId"],
      outputDescription: "Offline diagnostic findings and scores for one chapter.",
      execute: (args) => workspace.mutation("chapter.diagnose", { documentId: args.documentId }),
    },
    {
      name: "zhizhang_read_controls",
      description: "Read the project compass (authorIntent) and near-term writing focus (currentFocus).",
      readOnly: true,
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
      outputDescription: "Project compass and near-term focus controls.",
      execute: (args) => workspace.mutation("controls.get", { projectId: args.projectId }),
    },
    {
      name: "zhizhang_propose_setting",
      description: "Submit a pending setting proposal into author_settings for explicit author approval (never auto-commits).",
      readOnly: false,
      proposalOnly: true,
      properties: {
        projectId: { type: "string" },
        documentId: { type: "string" },
        factId: { type: "string" },
        note: { type: "string" },
        source: { type: "string" },
        point: { type: "number" },
        people: { type: "array" },
      },
      required: ["projectId", "documentId", "factId", "note", "source"],
      outputDescription: "Identifier and pending status of the created setting proposal.",
      execute: (args) =>
        workspace.mutation("setting.propose", {
          projectId: args.projectId,
          documentId: args.documentId,
          factId: args.factId,
          note: args.note,
          source: args.source,
          from: { chapterId: args.documentId, point: typeof args.point === "number" ? args.point : 1 },
          people: Array.isArray(args.people) ? args.people : [],
        }),
    },
    {
      name: "zhizhang_propose_foreshadow",
      description: "Submit a pending foreshadow update proposal into author_ai_proposals inbox for author approval.",
      readOnly: false,
      proposalOnly: true,
      properties: {
        projectId: { type: "string" },
        documentId: { type: "string" },
        id: { type: "string" },
        title: { type: "string" },
        factId: { type: "string" },
        status: { type: "string" },
        note: { type: "string" },
      },
      required: ["projectId", "documentId", "title"],
      outputDescription: "Identifier and pending status of the created foreshadow proposal.",
      execute: (args) =>
        workspace.mutation("proposal.create", {
          kind: "fact_sync",
          origin: "agent-tool",
          projectId: args.projectId,
          documentId: args.documentId,
          sourceRef: typeof args.title === "string" ? args.title : "伏笔提案",
          payload: {
            foreshadowUpdates: [
              {
                ...(typeof args.id === "string" ? { id: args.id } : {}),
                title: args.title,
                ...(typeof args.factId === "string" ? { factId: args.factId } : {}),
                status: typeof args.status === "string" ? args.status : "planted",
                note: typeof args.note === "string" ? args.note : "",
              },
            ],
          },
        }),
    },
    {
      name: "zhizhang_propose_technique",
      description: "Submit a pending writing technique card proposal into author_ai_proposals inbox for author approval.",
      readOnly: false,
      proposalOnly: true,
      properties: {
        projectId: { type: "string" },
        title: { type: "string" },
        category: { type: "string" },
        pacing: { type: "string" },
        triggerWhen: { type: "string" },
        executionSteps: { type: "string" },
        constraints: { type: "string" },
        antiPatterns: { type: "string" },
      },
      required: ["projectId", "title", "executionSteps"],
      outputDescription: "Identifier and pending status of the created technique proposal.",
      execute: (args) =>
        workspace.mutation("proposal.create", {
          kind: "technique",
          origin: "agent-tool",
          projectId: args.projectId,
          sourceRef: typeof args.title === "string" ? args.title : "技法提案",
          payload: {
            title: args.title,
            category: typeof args.category === "string" ? args.category : "narrative",
            pacing: typeof args.pacing === "string" ? args.pacing : "",
            triggerWhen: typeof args.triggerWhen === "string" ? args.triggerWhen : "",
            executionSteps: args.executionSteps,
            constraints: typeof args.constraints === "string" ? args.constraints : "",
            antiPatterns: typeof args.antiPatterns === "string" ? args.antiPatterns : "",
          },
        }),
    },
  ];
}
