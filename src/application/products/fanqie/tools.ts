import type { ProductAgentToolFacade, ProductAgentToolSpec } from "../../product-line.ts";

/**
 * Fanqie-declared DsH conversation tools covering 5 co-creation domains:
 * 1. Awareness & 4-Layer Context (on-demand L1/L2/L3 pulling, search, controls)
 * 2. Progressive-Disclosure Skill Library (catalog index -> load full card -> mount)
 * 3. Structure & Planning (create volume/act/chapter, propose/save chapter outline)
 * 4. Diagnostics & Conflict Scans (zero-token offline checks)
 * 5. Author-Sovereign Proposals (settings, foreshadows, techniques, normalized materials)
 *
 * Owned by the Fanqie product-line module so the Host layer remains strictly
 * product-agnostic.
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
      name: "zhizhang_read_context",
      description:
        "Assemble and return the 4-layer long-novel writing context (L1 book bible, L2 volume milestones, L3 rolling summaries, previous chapter tail, POV boundaries, due foreshadows, anti-echo guards, and mounted skills) on demand for a chapter.",
      readOnly: true,
      properties: {
        documentId: { type: "string" },
        instruction: { type: "string" },
        tokenLimit: { type: "number" },
      },
      required: ["documentId"],
      outputDescription: "Assembled stablePrefix + dynamicTail context bundle and token budget report.",
      execute: (args) =>
        workspace.mutation("context.preview", {
          documentId: args.documentId,
          includeText: true,
          ...(typeof args.instruction === "string" ? { instruction: args.instruction } : {}),
          ...(typeof args.tokenLimit === "number" ? { tokenLimit: args.tokenLimit } : {}),
        }),
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
      description: "Run zero-token offline Golden-3-chapters, AI-slop, ending-hook, and POV-leak diagnostics on a Fanqie chapter.",
      readOnly: true,
      properties: { documentId: { type: "string" } },
      required: ["documentId"],
      outputDescription: "Offline diagnostic findings and composite scores for one chapter.",
      execute: (args) => workspace.mutation("chapter.diagnose", { documentId: args.documentId }),
    },
    {
      name: "zhizhang_read_controls",
      description: "Read the project compass (authorIntent), near-term writing focus (currentFocus), and context tuning settings.",
      readOnly: true,
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
      outputDescription: "Project compass, near-term focus, and context tuning parameters.",
      execute: (args) => workspace.mutation("controls.get", { projectId: args.projectId }),
    },
    {
      name: "zhizhang_list_skills",
      description:
        "Progressive-disclosure Skill catalog: list lightweight technique/skill metadata (id, title, category, triggerWhen, conflictGroup, mount status) without full bodies. Pass documentId for chapter-ranked recommendations.",
      readOnly: true,
      properties: {
        projectId: { type: "string" },
        documentId: { type: "string" },
        instruction: { type: "string" },
        limit: { type: "number" },
      },
      required: ["projectId"],
      outputDescription: "Compact index of available skills/techniques; call zhizhang_load_skill with an id to read full execution steps.",
      execute: (args) => {
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.min(30, args.limit)) : 12;
        if (typeof args.documentId === "string" && args.documentId.trim()) {
          const recs = workspace.mutation("technique.recommend", {
            documentId: args.documentId,
            ...(typeof args.instruction === "string" ? { instruction: args.instruction } : {}),
            limit,
          }) as readonly {
            card: {
              id: string;
              title: string;
              category: string;
              pacing: string;
              triggerWhen: string;
              conflictGroup?: string;
              assetKind?: string;
              stageBindings?: readonly string[];
            };
            score: number;
            mountedMode: string | null;
            reasons: readonly string[];
          }[];
          return recs.map((r) => ({
            id: r.card.id,
            title: r.card.title,
            category: r.card.category,
            pacing: r.card.pacing,
            triggerWhen: r.card.triggerWhen,
            conflictGroup: r.card.conflictGroup ?? null,
            assetKind: r.card.assetKind ?? "technique",
            stageBindings: r.card.stageBindings ?? [],
            mountedMode: r.mountedMode,
            score: r.score,
            reasons: r.reasons,
          }));
        }
        const cards = workspace.mutation("technique.list", { projectId: args.projectId }) as readonly {
          id: string;
          title: string;
          category: string;
          pacing: string;
          triggerWhen: string;
          conflictGroup?: string;
          assetKind?: string;
          stageBindings?: readonly string[];
        }[];
        return cards.slice(0, limit).map((c) => ({
          id: c.id,
          title: c.title,
          category: c.category,
          pacing: c.pacing,
          triggerWhen: c.triggerWhen,
          conflictGroup: c.conflictGroup ?? null,
          assetKind: c.assetKind ?? "technique",
          stageBindings: c.stageBindings ?? [],
        }));
      },
    },
    {
      name: "zhizhang_load_skill",
      description:
        "Load the complete execution steps, constraints, positive/negative examples, and reference docs of a specific Skill/Technique card or Deconstruction by id.",
      readOnly: true,
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["technique", "deconstruction"] },
      },
      required: ["id"],
      outputDescription: "Full Skill/Technique card or Deconstruction record.",
      execute: (args) =>
        args.kind === "deconstruction"
          ? workspace.mutation("deconstruct.get", { id: args.id })
          : workspace.mutation("technique.get", { id: args.id }),
    },
    {
      name: "zhizhang_mount_skill",
      description:
        "Mount (include/pin/exclude) or unmount a Skill/Technique card or Deconstruction on a project, volume, act, or chapter.",
      readOnly: false,
      properties: {
        projectId: { type: "string" },
        action: { type: "string", enum: ["mount", "unmount"] },
        mountId: { type: "string" },
        targetType: { type: "string", enum: ["project", "volume", "act", "chapter"] },
        targetId: { type: "string" },
        itemKind: { type: "string", enum: ["technique", "deconstruction"] },
        itemId: { type: "string" },
        mode: { type: "string", enum: ["include", "pin", "exclude"] },
        note: { type: "string" },
      },
      required: ["projectId"],
      outputDescription: "Updated library mount binding or unmount confirmation.",
      execute: (args) => {
        if (args.action === "unmount") {
          return workspace.mutation("library.unmount", {
            projectId: args.projectId,
            id: args.mountId ?? args.id,
          });
        }
        return workspace.mutation("library.mount", {
          projectId: args.projectId,
          targetType: args.targetType ?? "project",
          targetId: args.targetId ?? args.projectId,
          itemKind: args.itemKind ?? "technique",
          itemId: args.itemId,
          mode: args.mode ?? "include",
          ...(typeof args.note === "string" ? { note: args.note } : {}),
        });
      },
    },
    {
      name: "zhizhang_create_structure",
      description: "Create a new volume, act, or chapter node in a Fanqie novel tree.",
      readOnly: false,
      properties: {
        projectId: { type: "string" },
        kind: { type: "string", enum: ["volume", "act", "chapter"] },
        title: { type: "string" },
        volumeId: { type: "string" },
        actId: { type: "string" },
        goal: { type: "string" },
        summary: { type: "string" },
      },
      required: ["projectId", "kind", "title"],
      outputDescription: "Created volume, act, or chapter record with its new ID.",
      execute: (args) => {
        if (args.kind === "volume") {
          return workspace.mutation("volume.create", {
            projectId: args.projectId,
            title: args.title,
            ...(typeof args.goal === "string" ? { goal: args.goal } : {}),
            ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
          });
        }
        if (args.kind === "act") {
          return workspace.mutation("act.create", {
            projectId: args.projectId,
            volumeId: args.volumeId,
            title: args.title,
            ...(typeof args.goal === "string" ? { goal: args.goal } : {}),
            ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
          });
        }
        return workspace.mutation("document.create", {
          projectId: args.projectId,
          title: args.title,
          ...(typeof args.volumeId === "string" ? { volumeId: args.volumeId } : {}),
          ...(typeof args.actId === "string" ? { actId: args.actId } : {}),
        });
      },
    },
    {
      name: "zhizhang_plan_chapter",
      description:
        "Submit or update a chapter outline (viewpoint, target length, sections, lockedFacts, knowledge). Honors book collaborationMode: cautious -> stages outline proposal for approval; co_create -> saves chapter outline directly.",
      readOnly: false,
      properties: {
        documentId: { type: "string" },
        viewpoint: { type: "string" },
        target: { type: "number" },
        sections: { type: "object" },
        lockedFacts: { type: "string" },
        knowledge: { type: "string" },
        forceProposal: { type: "boolean" },
      },
      required: ["documentId"],
      outputDescription: "Either a staged outline proposal ID (cautious) or saved chapter planning object (co_create).",
      execute: (args) =>
        workspace.mutation("chapter.outline.propose", {
          documentId: args.documentId,
          ...(typeof args.viewpoint === "string" ? { viewpoint: args.viewpoint } : {}),
          ...(typeof args.target === "number" ? { target: args.target } : {}),
          ...(args.sections && typeof args.sections === "object" ? { sections: args.sections } : {}),
          ...(typeof args.lockedFacts === "string" ? { lockedFacts: args.lockedFacts } : {}),
          ...(typeof args.knowledge === "string" ? { knowledge: args.knowledge } : {}),
          ...(typeof args.forceProposal === "boolean" ? { forceProposal: args.forceProposal } : {}),
        }),
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
    {
      name: "zhizhang_ingest_preview",
      description: "Read local preprocessed non-standard material chunks or list material ingest sessions for a Fanqie project.",
      readOnly: true,
      properties: {
        projectId: { type: "string" },
        sessionId: { type: "string" },
      },
      required: ["projectId"],
      outputDescription: "Material ingest session detail with local chunks or list of sessions for the project.",
      execute: (args) =>
        typeof args.sessionId === "string" && args.sessionId.trim()
          ? workspace.mutation("material.get", { sessionId: args.sessionId })
          : workspace.mutation("material.list", { projectId: args.projectId }),
    },
    {
      name: "zhizhang_propose_material_bundle",
      description: "Submit an AI/DsH-normalized standard bundle (chapters, lore, foreshadows, compass) into a material ingest session for explicit author preview and commit.",
      readOnly: false,
      proposalOnly: true,
      properties: {
        projectId: { type: "string" },
        sessionId: { type: "string" },
        bundle: { type: "object" },
      },
      required: ["projectId", "bundle"],
      outputDescription: "Updated material ingest session in ready_for_review status with conflict annotations.",
      execute: (args) =>
        workspace.mutation("material.propose_bundle", {
          projectId: args.projectId,
          ...(typeof args.sessionId === "string" ? { sessionId: args.sessionId } : {}),
          bundle: args.bundle,
          sourceOrigin: "dsh_agent",
        }),
    },
  ];
}
