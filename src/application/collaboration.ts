import { randomUUID } from "node:crypto";
import { ContractError } from "../contracts/errors.ts";
import type {
  AgentDraftWriteDto,
  AgentWriteSubmissionResultDto,
  CollaborationMode,
  CollaborationSystemPromptDto,
  Product,
  ProjectCollaborationDto,
  SkillIndexEntryDto,
  WorkspaceFocusDto,
} from "../contracts/workspace-dto.ts";
import { createCandidate, stmt } from "../storage/index.ts";
import {
  countNonWhitespace,
  invalid,
  optionalText,
  refuse,
  requiredRow,
  text,
  type DocumentRow,
  type Input,
  type WorkspaceContext,
} from "./context.ts";
import type { ProductLineRegistry } from "./product-line.ts";

export interface ParagraphPatchInput {
  readonly paragraphIndex: number;
  readonly replacement: string;
}

function parseCollaborationMode(raw: unknown): CollaborationMode {
  if (raw === "cautious" || raw === "co_create") return raw;
  invalid("collaborationMode", "expected-cautious-or-co_create");
}

function parseTechniqueIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<string>();
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) unique.add(item.trim());
  }
  return [...unique].slice(0, 16);
}

function parseTechniqueIdsJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseTechniqueIds(parsed);
  } catch {
    return [];
  }
}

export function getProjectCollaboration(ctx: WorkspaceContext, projectId: string): ProjectCollaborationDto {
  requiredRow(
    stmt(ctx.db, "SELECT id FROM author_projects WHERE id = ?;").get(projectId),
    "project",
    projectId,
  );
  const row = stmt(
    ctx.db,
    `SELECT project_id AS projectId, collaboration_mode AS collaborationMode,
       agent_prompt_injection AS agentPromptInjection, updated_at AS updatedAt
     FROM author_project_collaboration WHERE project_id = ?;`,
  ).get(projectId) as {
    projectId: string;
    collaborationMode: CollaborationMode;
    agentPromptInjection: number;
    updatedAt: number;
  } | undefined;

  if (!row) {
    return {
      projectId,
      collaborationMode: "cautious",
      agentPromptInjection: true,
      updatedAt: 0,
    };
  }
  return {
    projectId: row.projectId,
    collaborationMode: row.collaborationMode === "co_create" ? "co_create" : "cautious",
    agentPromptInjection: row.agentPromptInjection !== 0,
    updatedAt: row.updatedAt,
  };
}

export function setProjectCollaboration(ctx: WorkspaceContext, input: Input): ProjectCollaborationDto {
  const projectId = text(input, "projectId");
  return ctx.atomic(() => {
    const current = getProjectCollaboration(ctx, projectId);
    const nextMode = input.collaborationMode !== undefined
      ? parseCollaborationMode(input.collaborationMode)
      : current.collaborationMode;
    const nextPromptInjection = input.agentPromptInjection !== undefined
      ? (typeof input.agentPromptInjection === "boolean"
        ? input.agentPromptInjection
        : invalid("agentPromptInjection", "boolean-required"))
      : current.agentPromptInjection;
    const now = Date.now();
    stmt(ctx.db, `
      INSERT INTO author_project_collaboration (project_id, collaboration_mode, agent_prompt_injection, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (project_id) DO UPDATE SET
        collaboration_mode = excluded.collaboration_mode,
        agent_prompt_injection = excluded.agent_prompt_injection,
        updated_at = excluded.updated_at;
    `).run(projectId, nextMode, nextPromptInjection ? 1 : 0, now);
    ctx.event(projectId, "chapter", "controls.collaboration", {
      collaborationMode: nextMode,
      agentPromptInjection: nextPromptInjection,
    });
    return {
      projectId,
      collaborationMode: nextMode,
      agentPromptInjection: nextPromptInjection,
      updatedAt: now,
    };
  });
}

function resolveFocusInRead(
  ctx: WorkspaceContext,
  override?: { readonly projectId?: string | null; readonly documentId?: string | null; readonly sessionId?: string },
): { readonly focus: WorkspaceFocusDto; readonly activeDoc: DocumentRow | undefined } {
  const sessionId = override?.sessionId;
  const table = sessionId ? "author_session_focus" : "author_workspace_focus";
  const stored = stmt(ctx.db, `
    SELECT project_id AS projectId, document_id AS documentId, view_mode AS viewMode, updated_at AS updatedAt
    FROM ${table} WHERE id = ?;
  `).get(sessionId ?? "default") as {
    projectId: string | null;
    documentId: string | null;
    viewMode: string;
    updatedAt: number;
  } | undefined;

  let projectId = override?.projectId !== undefined ? override.projectId : (stored?.projectId ?? null);
  let documentId = override?.documentId !== undefined
    ? override.documentId
    : override?.projectId !== undefined && override.projectId !== stored?.projectId
      ? null
      : stored?.documentId ?? null;
  const viewMode = stored?.viewMode || "main";
  const updatedAt = stored?.updatedAt ?? 0;

  let activeDoc: DocumentRow | undefined;
  if (documentId) {
    const exists = stmt(ctx.db, "SELECT id FROM author_documents WHERE id = ?;").get(documentId) as { id?: string } | undefined;
    if (exists?.id) {
      activeDoc = ctx.document(documentId);
      projectId = activeDoc.projectId;
    } else {
      documentId = null;
    }
  }

  let projectRow: { id: string; name: string; product: Product } | undefined;
  if (projectId) {
    projectRow = stmt(ctx.db, "SELECT id, name, product FROM author_projects WHERE id = ?;").get(projectId) as
      | { id: string; name: string; product: Product }
      | undefined;
  }
  if (!projectRow && !sessionId && override?.projectId === undefined) {
    projectRow = stmt(ctx.db, "SELECT id, name, product FROM author_projects ORDER BY rowid DESC LIMIT 1;").get() as
      | { id: string; name: string; product: Product }
      | undefined;
    projectId = projectRow?.id ?? null;
  }

  if (projectId && !activeDoc && !sessionId) {
    const firstDoc = stmt(
      ctx.db,
      "SELECT id FROM author_documents WHERE project_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1;",
    ).get(projectId) as { id?: string } | undefined;
    if (firstDoc?.id) {
      activeDoc = ctx.document(firstDoc.id);
      documentId = activeDoc.id;
    }
  }

  const collab = projectId
    ? getProjectCollaboration(ctx, projectId)
    : { collaborationMode: "cautious" as const, agentPromptInjection: true };

  return {
    activeDoc,
    focus: {
      projectId: projectRow?.id ?? null,
      documentId: activeDoc?.id ?? null,
      product: projectRow?.product ?? null,
      projectName: projectRow?.name ?? null,
      documentTitle: activeDoc?.title ?? null,
      documentState: activeDoc?.state ?? null,
      collaborationMode: collab.collaborationMode,
      agentPromptInjection: collab.agentPromptInjection,
      viewMode,
      updatedAt,
    },
  };
}

export function getWorkspaceFocus(ctx: WorkspaceContext, sessionId?: string): WorkspaceFocusDto {
  return ctx.read(() => resolveFocusInRead(ctx, sessionId ? { sessionId } : undefined).focus);
}

export function setWorkspaceFocus(ctx: WorkspaceContext, input: Input): WorkspaceFocusDto {
  return ctx.atomic(() => {
    const rawDocId = input.documentId === null ? null : optionalText(input, "documentId");
    const rawProjectId = input.projectId === null ? null : optionalText(input, "projectId");
    const rawViewMode = optionalText(input, "viewMode");
    const sessionId = optionalText(input, "sessionId");
    const id = sessionId ?? "default";
    const table = sessionId ? "author_session_focus" : "author_workspace_focus";

    let resolvedDocId: string | null = rawDocId ?? null;
    let resolvedProjectId: string | null = rawProjectId ?? null;

    if (resolvedDocId) {
      const doc = ctx.document(resolvedDocId);
      if (resolvedProjectId && doc.projectId !== resolvedProjectId) {
        invalid("documentId", "project-mismatch");
      }
      resolvedProjectId = doc.projectId;
    } else if (resolvedProjectId) {
      requiredRow(
        stmt(ctx.db, "SELECT id FROM author_projects WHERE id = ?;").get(resolvedProjectId),
        "project",
        resolvedProjectId,
      );
    }

    const prev = stmt(
      ctx.db,
      `SELECT project_id AS projectId, document_id AS documentId, view_mode AS viewMode FROM ${table} WHERE id = ?;`,
    ).get(id) as { projectId: string | null; documentId: string | null; viewMode: string } | undefined;

    const finalProjectId = input.projectId === undefined && !resolvedDocId ? (prev?.projectId ?? null) : resolvedProjectId;
    const finalDocumentId = input.documentId === undefined
      ? (finalProjectId === prev?.projectId ? (prev?.documentId ?? null) : null)
      : resolvedDocId;
    const finalViewMode = rawViewMode ?? prev?.viewMode ?? "main";
    if (sessionId && !finalProjectId) {
      stmt(ctx.db, "DELETE FROM author_session_focus WHERE id = ?;").run(sessionId);
      return resolveFocusInRead(ctx, { sessionId }).focus;
    }

    const now = Date.now();
    stmt(ctx.db, `
      INSERT INTO ${table} (id, project_id, document_id, view_mode, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        project_id = excluded.project_id,
        document_id = excluded.document_id,
        view_mode = excluded.view_mode,
        updated_at = excluded.updated_at;
    `).run(id, finalProjectId, finalDocumentId, finalViewMode, now);

    return resolveFocusInRead(ctx, sessionId ? { sessionId } : undefined).focus;
  });
}

interface AgentWriteRow {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly mode: "candidate" | "direct_write";
  readonly runId: string | null;
  readonly candidateId: string | null;
  readonly previousRevisionId: string | null;
  readonly previousBody: string | null;
  readonly newRevisionId: string | null;
  readonly summary: string;
  readonly techniqueIdsJson: string;
  readonly rolledBack: number;
  readonly createdAt: number;
}

function mapAgentWriteRow(row: AgentWriteRow): AgentDraftWriteDto {
  return {
    id: row.id,
    projectId: row.projectId,
    documentId: row.documentId,
    mode: row.mode,
    runId: row.runId,
    candidateId: row.candidateId,
    previousRevisionId: row.previousRevisionId,
    previousBody: row.previousBody ?? null,
    newRevisionId: row.newRevisionId,
    summary: row.summary,
    techniqueIds: parseTechniqueIdsJson(row.techniqueIdsJson),
    rolledBack: row.rolledBack !== 0,
    createdAt: row.createdAt,
  };
}

export function getLatestAgentWriteForDoc(ctx: WorkspaceContext, documentId: string): AgentDraftWriteDto | null {
  const row = stmt(ctx.db, `
    SELECT w.id, w.project_id AS projectId, w.document_id AS documentId, w.mode,
      w.run_id AS runId, w.candidate_id AS candidateId,
      w.previous_revision_id AS previousRevisionId, prev.body AS previousBody,
      w.new_revision_id AS newRevisionId, w.summary, w.technique_ids_json AS techniqueIdsJson,
      w.rolled_back AS rolledBack, w.created_at AS createdAt
    FROM author_agent_writes w
    LEFT JOIN revisions prev ON prev.revision_id = w.previous_revision_id
    WHERE w.document_id = ?
    ORDER BY w.created_at DESC, w.rowid DESC
    LIMIT 1;
  `).get(documentId) as AgentWriteRow | undefined;
  return row ? mapAgentWriteRow(row) : null;
}

export function listAgentWrites(ctx: WorkspaceContext, input: Input): AgentDraftWriteDto[] {
  const projectId = optionalText(input, "projectId");
  const documentId = optionalText(input, "documentId");
  const rawLimit = typeof input.limit === "number" && Number.isFinite(input.limit) ? Math.floor(input.limit) : 20;
  const limit = Math.max(1, Math.min(100, rawLimit));

  return ctx.read(() => {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (projectId) {
      clauses.push("w.project_id = ?");
      params.push(projectId);
    }
    if (documentId) {
      clauses.push("w.document_id = ?");
      params.push(documentId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = stmt(ctx.db, `
      SELECT w.id, w.project_id AS projectId, w.document_id AS documentId, w.mode,
        w.run_id AS runId, w.candidate_id AS candidateId,
        w.previous_revision_id AS previousRevisionId, prev.body AS previousBody,
        w.new_revision_id AS newRevisionId, w.summary, w.technique_ids_json AS techniqueIdsJson,
        w.rolled_back AS rolledBack, w.created_at AS createdAt
      FROM author_agent_writes w
      LEFT JOIN revisions prev ON prev.revision_id = w.previous_revision_id
      ${where}
      ORDER BY w.created_at DESC, w.rowid DESC
      LIMIT ?;
    `).all(...params, limit) as AgentWriteRow[];
    return rows.map(mapAgentWriteRow);
  });
}

/**
 * Pure surgical paragraph patching: replaces only the specified 1-based paragraph
 * indices while keeping all untouched paragraphs verbatim.
 */
export function applyParagraphPatches(
  originalBody: string,
  patches: readonly ParagraphPatchInput[],
): string {
  if (!Array.isArray(patches) || patches.length === 0) {
    invalid("patches", "non-empty-array-required");
  }
  const fragments = originalBody.trim().length === 0 ? [""] : originalBody.split(/(\r?\n\s*\r?\n)/u);
  const paragraphs = fragments.filter((_, index) => index % 2 === 0);

  const seen = new Set<number>();
  const next = [...paragraphs];
  for (const patch of patches) {
    if (!patch || typeof patch !== "object") invalid("patches", "patch-object-required");
    const idx = patch.paragraphIndex;
    if (typeof idx !== "number" || !Number.isSafeInteger(idx) || idx < 1) {
      invalid("patches", "positive-integer-paragraphIndex-required");
    }
    if (typeof patch.replacement !== "string") {
      invalid("patches", "string-replacement-required");
    }
    if (seen.has(idx)) invalid("patches", "duplicate-paragraphIndex");
    seen.add(idx);

    if (paragraphs.length === 0 && idx === 1) {
      next[0] = patch.replacement.trim();
      continue;
    }
    if (idx > paragraphs.length) {
      invalid("patches", `paragraphIndex-out-of-range:${idx}/${paragraphs.length}`);
    }
    next[idx - 1] = patch.replacement.trim();
  }
  const joined = fragments.map((part, index) => index % 2 === 0 ? next[index / 2] : part).join("");
  if (!joined.trim()) invalid("patches", "resulting-body-empty");
  return joined;
}

export function submitAgentDraft(
  ctx: WorkspaceContext,
  registry: ProductLineRegistry,
  saveDraftForRow: (row: DocumentRow, body: string) => { revisionId: string },
  input: Input,
): AgentWriteSubmissionResultDto {
  const documentId = text(input, "documentId");
  const body = text(input, "body");
  const summary = optionalText(input, "summary") ?? "DsH Agent 提交草稿";
  const techniqueIds = parseTechniqueIds(input.techniqueIds);
  const forceCandidate = input.forceCandidate === true;

  return ctx.atomic(() => {
    let row = ctx.document(documentId);
    if (ctx.isLockedDocument(row)) {
      refuse("agent.submit_draft", "revision-locked");
    }
    const collab = getProjectCollaboration(ctx, row.projectId);
    const mod = registry.require(row.product);
    const effectiveMode: "candidate" | "direct_write" =
      collab.collaborationMode === "co_create" && !forceCandidate ? "direct_write" : "candidate";

    const activeInFlight = stmt(
      ctx.db,
      "SELECT 1 FROM author_runs WHERE document_id = ? AND state IN ('running', 'paused') LIMIT 1;",
    ).get(row.id);
    if (activeInFlight) {
      refuse("agent.submit_draft", "generation-in-progress");
    }

    const now = Date.now();
    const writeId = randomUUID();
    const charCount = countNonWhitespace(body);

    if (effectiveMode === "candidate") {
      // Auto-discard stale Agent-submitted candidates so Agent can iterate smoothly in cautious mode,
      // while refusing to overwrite an active author-initiated run candidate.
      const awaitingRows = stmt(
        ctx.db,
        "SELECT id, frozen_input AS frozenInput, candidate_id AS candidateId FROM author_runs WHERE document_id = ? AND state = 'awaiting-author';",
      ).all(row.id) as readonly { id: string; frozenInput: string; candidateId: string | null }[];

      for (const existing of awaitingRows) {
        let origin: string | null = null;
        try {
          const parsed = JSON.parse(existing.frozenInput) as { origin?: string };
          origin = typeof parsed?.origin === "string" ? parsed.origin : null;
        } catch {
          origin = null;
        }
        if (origin === "dsh_agent") {
          stmt(ctx.db, "UPDATE author_runs SET state = 'discarded' WHERE id = ?;").run(existing.id);
          ctx.event(row.projectId, "run", "run.state", { runId: existing.id, state: "discarded" });
          if (existing.candidateId) {
            ctx.event(row.projectId, "candidate", "candidate.closed", {
              documentId: row.id,
              candidateId: existing.candidateId,
            });
          }
        } else {
          refuse("agent.submit_draft", "generation-in-progress");
        }
      }

      // author_runs.base_revision_id is NOT NULL and candidate.adopt requires a base revision.
      if (!row.revisionId) {
        saveDraftForRow(row, "");
        row = ctx.document(row.id);
      }
      const baseRevisionId = row.revisionId!;
      const runId = randomUUID();
      const candidateId = randomUUID();
      const frozenInput = JSON.stringify({
        origin: "dsh_agent",
        title: row.title,
        revisionId: baseRevisionId,
        summary,
        techniqueIds,
      });

      stmt(ctx.db, `
        INSERT INTO author_runs (
          id, document_id, state, base_revision_id, frozen_input, reserved, settled, candidate_id
        ) VALUES (?, ?, 'awaiting-author', ?, ?, 0, 0, ?);
      `).run(runId, row.id, baseRevisionId, frozenInput, candidateId);
      createCandidate(ctx.db, { candidateId, documentId: row.id, baseRevisionId, body });

      stmt(ctx.db, `
        INSERT INTO author_agent_writes (
          id, project_id, document_id, mode, run_id, candidate_id,
          previous_revision_id, new_revision_id, summary, technique_ids_json, rolled_back, created_at
        ) VALUES (?, ?, ?, 'candidate', ?, ?, ?, NULL, ?, ?, 0, ?);
      `).run(writeId, row.projectId, row.id, runId, candidateId, baseRevisionId, summary, JSON.stringify(techniqueIds), now);

      const diagnosticsSummary = mod.diagnoseForAgent?.(ctx, row, body) ?? null;
      ctx.event(row.projectId, "candidate", "candidate.created", {
        documentId: row.id,
        runId,
        candidateId,
        origin: "dsh_agent",
      });
      return {
        writeId,
        mode: "candidate",
        collaborationMode: collab.collaborationMode,
        projectId: row.projectId,
        documentId: row.id,
        runId,
        candidateId,
        previousRevisionId: baseRevisionId,
        newRevisionId: null,
        charCount,
        diagnosticsSummary,
        message: "已按「审慎模式」写入候选稿区，请作者在工作台 Diff 对比后采纳。",
      };
    }

    // Co-Create mode: snapshot previousRevisionId, directly append working revision, log rollback handle.
    const previousRevisionId = row.revisionId;
    const saved = saveDraftForRow(row, body);
    const updatedRow = ctx.document(row.id);
    stmt(ctx.db, `
      INSERT INTO author_agent_writes (
        id, project_id, document_id, mode, run_id, candidate_id,
        previous_revision_id, new_revision_id, summary, technique_ids_json, rolled_back, created_at
      ) VALUES (?, ?, ?, 'direct_write', NULL, NULL, ?, ?, ?, ?, 0, ?);
    `).run(writeId, row.projectId, row.id, previousRevisionId, saved.revisionId, summary, JSON.stringify(techniqueIds), now);

    const diagnosticsSummary = mod.diagnoseForAgent?.(ctx, updatedRow, body) ?? null;
    mod.onAgentDraftRecorded?.(ctx, updatedRow, techniqueIds, diagnosticsSummary);
    ctx.event(row.projectId, "revision", "agent.draft.written", {
      documentId: row.id,
      writeId,
      previousRevisionId,
      newRevisionId: saved.revisionId,
    });

    return {
      writeId,
      mode: "direct_write",
      collaborationMode: collab.collaborationMode,
      projectId: row.projectId,
      documentId: row.id,
      runId: null,
      candidateId: null,
      previousRevisionId,
      newRevisionId: saved.revisionId,
      charCount,
      diagnosticsSummary,
      message: "已按「共创模式」直写工作草稿并保留版本快照，作者可随时对比 Diff 或一键撤销回滚。",
    };
  });
}

export function patchAgentParagraphs(
  ctx: WorkspaceContext,
  registry: ProductLineRegistry,
  saveDraftForRow: (row: DocumentRow, body: string) => { revisionId: string },
  input: Input,
): AgentWriteSubmissionResultDto {
  const documentId = text(input, "documentId");
  const rawPatches = input.patches;
  if (!Array.isArray(rawPatches)) invalid("patches", "array-required");
  const row = ctx.read(() => ctx.document(documentId));
  if (ctx.isLockedDocument(row)) {
    refuse("agent.patch_paragraphs", "revision-locked");
  }
  const patchedBody = applyParagraphPatches(row.body ?? "", rawPatches as readonly ParagraphPatchInput[]);
  return submitAgentDraft(ctx, registry, saveDraftForRow, {
    ...input,
    documentId,
    body: patchedBody,
    summary: optionalText(input, "summary") ?? `DsH Agent 局部精修（${rawPatches.length} 段）`,
  });
}

export function rollbackAgentWrite(
  ctx: WorkspaceContext,
  saveDraftForRow: (row: DocumentRow, body: string) => { revisionId: string },
  input: Input,
) {
  const writeId = text(input, "writeId");
  return ctx.atomic(() => {
    const record = requiredRow<{
      id: string;
      projectId: string;
      documentId: string;
      mode: string;
      previousRevisionId: string | null;
      newRevisionId: string | null;
      rolledBack: number;
    }>(
      stmt(ctx.db, `
        SELECT id, project_id AS projectId, document_id AS documentId, mode,
          previous_revision_id AS previousRevisionId, new_revision_id AS newRevisionId, rolled_back AS rolledBack
        FROM author_agent_writes WHERE id = ?;
      `).get(writeId),
      "agent-write",
      writeId,
    );

    if (record.mode !== "direct_write") {
      refuse("agent.rollback_write", "rollback-requires-direct-write");
    }
    if (record.rolledBack !== 0) {
      refuse("agent.rollback_write", "already-rolled-back");
    }

    const doc = ctx.document(record.documentId);
    if (ctx.isLockedDocument(doc)) {
      refuse("agent.rollback_write", "revision-locked");
    }

    if (doc.revisionId !== record.newRevisionId) {
      throw new ContractError("version.conflict", {
        documentId: doc.id, baseRevisionId: record.newRevisionId, currentRevisionId: doc.revisionId,
      });
    }

    let previousBody = "";
    if (record.previousRevisionId) {
      const rev = stmt(ctx.db, "SELECT body FROM revisions WHERE revision_id = ?;").get(record.previousRevisionId) as
        | { body?: string }
        | undefined;
      previousBody = rev?.body ?? "";
    }

    const restored = saveDraftForRow(doc, previousBody);
    stmt(ctx.db, "UPDATE author_agent_writes SET rolled_back = 1 WHERE id = ?;").run(writeId);
    ctx.event(doc.projectId, "revision", "agent.draft.rolled_back", {
      documentId: doc.id,
      writeId,
      previousRevisionId: record.previousRevisionId,
      restoredRevisionId: restored.revisionId,
    });

    return {
      writeId,
      documentId: doc.id,
      restoredRevisionId: restored.revisionId,
      previousRevisionId: record.previousRevisionId ?? "",
    };
  });
}

export function buildProgressiveSystemPrompt(
  ctx: WorkspaceContext,
  registry: ProductLineRegistry,
  input?: { readonly projectId?: string; readonly documentId?: string; readonly sessionId?: string },
): CollaborationSystemPromptDto {
  return ctx.read(() => {
    const { focus, activeDoc } = resolveFocusInRead(ctx, {
      ...(input?.projectId ? { projectId: input.projectId } : {}),
      ...(input?.documentId ? { documentId: input.documentId } : {}),
      ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
    });

    if (!focus.projectId || !focus.product) {
      const idleText = input?.sessionId ? "" : [
        "# 织章（Zhizhang）DsH 创作协同插件",
        "当前尚无打开的作品。需要了解工作区状态时请先调用 `zhizhang_read_focus`。",
      ].join("\n");
      return {
        enabled: !input?.sessionId,
        text: idleText,
        tokenEstimate: Math.ceil(idleText.length / 2.2),
        focus,
        mountedSkills: [],
        pendingProposalCount: 0,
        pendingCandidateRunId: null,
      };
    }

    if (!focus.agentPromptInjection) {
      return {
        enabled: false,
        text: "",
        tokenEstimate: 0,
        focus,
        mountedSkills: [],
        pendingProposalCount: 0,
        pendingCandidateRunId: null,
      };
    }

    const mod = registry.get(focus.product);
    const contrib = mod?.contributeSystemPrompt?.(ctx, focus.projectId, activeDoc);
    const mountedSkills: SkillIndexEntryDto[] = (contrib?.mountedSkills ?? []).slice(0, 8);
    const pendingProposalCount = contrib?.pendingProposalCount ?? 0;

    let pendingCandidateRunId: string | null = null;
    if (activeDoc) {
      const runRow = stmt(
        ctx.db,
        "SELECT id FROM author_runs WHERE document_id = ? AND state = 'awaiting-author' ORDER BY rowid DESC LIMIT 1;",
      ).get(activeDoc.id) as { id?: string } | undefined;
      pendingCandidateRunId = runRow?.id ?? null;
    }

    const modeLabel = focus.collaborationMode === "co_create"
      ? "共创模式（未定稿章节允许直写草稿并自动留存快照供一键回滚；已定稿/已验收/锁定设定仍严格保护）"
      : "审慎模式（所有草稿、局部精修、章纲与设定均落入候选区/提案箱，由作者 Diff 审阅采纳）";

    const lines: string[] = [
      "# 织章（Zhizhang）创作协同上下文（渐进披露）",
      `- 当前作品：《${focus.projectName}》（${focus.product} · projectId=\`${focus.projectId}\`）`,
      activeDoc
        ? `- 当前焦点文档：《${activeDoc.title}》（documentId=\`${activeDoc.id}\` · 状态：${activeDoc.state} · 字数：${activeDoc.charCount}）`
        : "- 当前焦点文档：尚未选定章节/文章（可调用 `zhizhang_read_tree` 或 `zhizhang_create_structure`）",
      `- 协作模式：${modeLabel}`,
    ];

    if (contrib?.lines?.length) {
      for (const line of contrib.lines) {
        if (line.trim()) lines.push(line.trim());
      }
    }

    if (mountedSkills.length > 0) {
      lines.push("## 已挂载/推荐技法目录（仅索引，需细则请调 `zhizhang_load_skill` 按需加载）");
      for (const sk of mountedSkills) {
        const trigger = sk.triggerWhen ? ` — ${sk.triggerWhen.slice(0, 48)}` : "";
        const cg = sk.conflictGroup ? ` [互斥组:${sk.conflictGroup}]` : "";
        const pin = sk.mountedMode === "pin" ? " ★置顶" : "";
        lines.push(`- [${sk.id}] ${sk.title}${pin}${trigger}${cg}`);
      }
    }

    if (pendingCandidateRunId || pendingProposalCount > 0) {
      const notes: string[] = [];
      if (pendingCandidateRunId) notes.push(`当前章节存在待审阅候选稿（runId=${pendingCandidateRunId}）`);
      if (pendingProposalCount > 0) notes.push(`待审批提案 ${pendingProposalCount} 条`);
      lines.push(`- 待作者处理：${notes.join("；")}`);
    }

    lines.push("## 协同工作准则");
    lines.push("1. 写稿或精修前，按需调用 `zhizhang_read_context` 拉取四层上下文（L1/L2/L3），调用 `zhizhang_load_skill` 拉取所需技法全文。");
    lines.push("2. 交付正文使用 `zhizhang_submit_draft`，局部段落精修优先使用 `zhizhang_patch_paragraphs`（减少重写干扰），勿在对话中重复粘贴长篇设定库。");
    lines.push("3. 设定、伏笔、技法与非标准材料入库必须通过提案工具提交，由作者确认生效；严禁越过定稿/验收红线。");

    const textOut = lines.join("\n");
    return {
      enabled: true,
      text: textOut,
      tokenEstimate: Math.ceil(textOut.length / 2.2),
      focus,
      mountedSkills,
      pendingProposalCount,
      pendingCandidateRunId,
    };
  });
}
