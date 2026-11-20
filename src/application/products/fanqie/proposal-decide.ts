import { randomUUID } from "node:crypto";
import type { AiProposalDto, AiProposalKind } from "../../../contracts/workspace-dto.ts";
import { stmt, syncChapterFts } from "../../../storage/index.ts";
import {
  invalid,
  optionalText,
  refuse,
  requiredRow,
  text,
  type Input,
  type WorkspaceContext,
} from "../../context.ts";
import { commitFactBatch, commitFactSyncProposal, commitForeshadowBatch } from "./fact-sync.ts";
import { commitArcPlanProposal } from "./controls.ts";
import { insertObservationsBatch } from "./diagnostics.ts";
import { persistDeconstruction, persistTechniqueCard } from "./library-crud.ts";
import { approvedFacts, assertFanqieProject } from "./shared.ts";

interface ProposalRow {
  readonly id: string;
  readonly projectId: string | null;
  readonly documentId: string | null;
  readonly kind: AiProposalKind;
  readonly status: "pending" | "approved" | "rejected" | "failed";
  readonly sourceRef: string;
  readonly payload: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly reserved: number;
  readonly settled: number;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function parseProposalKind(raw: unknown): AiProposalKind {
  if (
    raw === "deconstruct" ||
    raw === "technique" ||
    raw === "setting" ||
    raw === "summary" ||
    raw === "fact_sync" ||
    raw === "chapter_review" ||
    raw === "arc_plan"
  ) {
    return raw;
  }
  invalid("kind", "unknown-proposal-kind");
}

function mapProposalRow(row: ProposalRow): AiProposalDto {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { ...row, payload: parsed };
}

export function createManualProposal(ctx: WorkspaceContext, input: Input): AiProposalDto {
  const kind = parseProposalKind(input.kind);
  const projectId = optionalText(input, "projectId") ?? null;
  if (projectId) assertFanqieProject(ctx, projectId);
  const documentId = optionalText(input, "documentId") ?? null;
  const sourceRef = optionalText(input, "sourceRef") ?? "";
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    invalid("payload", "object-required");
  }
  const id = randomUUID();
  const now = Date.now();
  return ctx.atomic(() => {
    stmt(ctx.db, `
      INSERT INTO author_ai_proposals (
        id, project_id, document_id, kind, status, source_ref, payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?);
    `).run(id, projectId, documentId, kind, sourceRef, JSON.stringify(input.payload), now, now);
    if (projectId) {
      ctx.event(projectId, "setting", "proposal.created", { id, kind });
    }
    return {
      id,
      projectId,
      documentId,
      kind,
      status: "pending",
      sourceRef,
      payload: input.payload as Record<string, unknown>,
      provider: null,
      model: null,
      reserved: 0,
      settled: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export function listProposals(ctx: WorkspaceContext, input: Input): AiProposalDto[] {
  const projectId = optionalText(input, "projectId") ?? null;
  const kind = optionalText(input, "kind");
  const status = optionalText(input, "status");
  if (kind) parseProposalKind(kind);

  return ctx.read(() => {
    const clauses: string[] = [];
    const params: string[] = [];
    if (projectId) {
      clauses.push("(project_id = ? OR project_id IS NULL)");
      params.push(projectId);
    }
    if (kind) {
      clauses.push("kind = ?");
      params.push(kind);
    }
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = stmt(ctx.db, `
      SELECT id, project_id AS projectId, document_id AS documentId, kind, status,
        source_ref AS sourceRef, payload, provider, model, reserved, settled, error,
        created_at AS createdAt, updated_at AS updatedAt
      FROM author_ai_proposals
      ${where}
      ORDER BY created_at DESC
      LIMIT 100;
    `).all(...params) as ProposalRow[];
    return rows.map(mapProposalRow);
  });
}

export function decideProposal(ctx: WorkspaceContext, input: Input) {
  const proposalId = text(input, "proposalId");
  if (typeof input.accept !== "boolean") invalid("accept");

  return ctx.atomic(() => {
    const row = requiredRow<ProposalRow>(
      stmt(ctx.db, `
        SELECT id, project_id AS projectId, document_id AS documentId, kind, status,
          source_ref AS sourceRef, payload, provider, model, reserved, settled, error,
          created_at AS createdAt, updated_at AS updatedAt
        FROM author_ai_proposals WHERE id = ?;
      `).get(proposalId),
      "ai-proposal",
      proposalId,
    );
    if (row.status !== "pending") refuse("proposal.decide", "decision-already-recorded");

    const now = Date.now();
    if (!input.accept) {
      stmt(ctx.db, "UPDATE author_ai_proposals SET status = 'rejected', updated_at = ? WHERE id = ?;")
        .run(now, proposalId);
      if (row.projectId) {
        ctx.event(row.projectId, "setting", "proposal.decided", { id: proposalId, kind: row.kind, status: "rejected" });
      }
      return { id: proposalId, status: "rejected" as const };
    }

    const basePayload = mapProposalRow(row).payload;
    const edited = input.editedPayload && typeof input.editedPayload === "object" && !Array.isArray(input.editedPayload)
      ? (input.editedPayload as Record<string, unknown>)
      : basePayload;
    const projectId = optionalText(input, "projectId") ?? row.projectId ?? optionalText(edited, "projectId") ?? null;

    let committed: unknown = null;
    if (row.kind === "deconstruct") {
      committed = persistDeconstruction(
        ctx,
        {
          ...edited,
          scope: edited.scope ?? (projectId ? "project" : "global"),
          ...(projectId ? { projectId } : {}),
          excerpt: edited.excerpt ?? (row.documentId ? (ctx.document(row.documentId).body ?? row.sourceRef) : row.sourceRef),
        },
        "ai-confirmed",
      );
    } else if (row.kind === "technique") {
      committed = persistTechniqueCard(
        ctx,
        {
          ...edited,
          scope: edited.scope ?? (projectId ? "project" : "global"),
          ...(projectId ? { projectId } : {}),
        },
        "ai-confirmed",
      );
    } else if (row.kind === "summary") {
      const targetDocId = optionalText(input, "documentId") ?? row.documentId;
      if (!targetDocId) invalid("documentId", "document-required");
      const doc = ctx.document(targetDocId);
      const summary = text(edited, "summary").trim();
      stmt(ctx.db, "UPDATE author_documents SET summary = ?, updated_at = ? WHERE id = ?;")
        .run(summary, now, doc.id);
      syncChapterFts(ctx.db, {
        projectId: doc.projectId,
        documentId: doc.id,
        title: doc.title,
        summary,
        body: doc.body ?? "",
      });
      ctx.event(doc.projectId, "chapter", "chapter.summary", { documentId: doc.id });
      committed = { documentId: doc.id, summary };
    } else if (row.kind === "setting") {
      if (!projectId) invalid("projectId", "project-required");
      assertFanqieProject(ctx, projectId);
      const fallbackChapterId = row.documentId ?? ctx.chapterOrder(projectId)[0];
      if (!fallbackChapterId) invalid("documentId", "chapter-required");
      const currentApproved = approvedFacts(ctx, projectId);
      const lockedSet = new Set(currentApproved.filter((f) => f.locked).map((f) => f.id));
      const factById = new Map(currentApproved.map((f) => [f.id, f]));
      const { approvedSettings } = commitFactBatch(ctx, {
        projectId,
        chapterId: fallbackChapterId,
        defaultSource: "AI章末提取（作者确认）",
        items: Array.isArray(edited.settings) ? (edited.settings as Input[]) : [],
        lockedSet,
        factById,
      });
      const foreshadows = commitForeshadowBatch(
        ctx,
        projectId,
        fallbackChapterId,
        Array.isArray(edited.foreshadows) ? (edited.foreshadows as Input[]) : [],
        false,
      );
      committed = { approvedSettings, foreshadows };
    } else if (row.kind === "fact_sync") {
      committed = commitFactSyncProposal(ctx, row.documentId, projectId, edited, input);
    } else if (row.kind === "chapter_review") {
      if (!projectId) invalid("projectId", "project-required");
      assertFanqieProject(ctx, projectId);
      const targetDocId = optionalText(input, "documentId") ?? row.documentId;
      if (!targetDocId) invalid("documentId", "document-required");
      const doc = ctx.document(targetDocId);
      if (doc.projectId !== projectId) invalid("documentId", "project-mismatch");
      const rawObs = Array.isArray(edited.observations) ? (edited.observations as Input[]) : [];
      const selectedIdx = Array.isArray(input.selectedObservationIndices)
        ? new Set(input.selectedObservationIndices.map(Number))
        : null;
      const picked = selectedIdx ? rawObs.filter((_, idx) => selectedIdx.has(idx)) : rawObs;
      const observations = insertObservationsBatch(ctx, projectId, doc.id, doc.revisionId, picked, "ai-review");
      committed = { documentId: doc.id, observations };
    } else if (row.kind === "arc_plan") {
      if (!projectId) invalid("projectId", "project-required");
      assertFanqieProject(ctx, projectId);
      committed = commitArcPlanProposal(ctx, projectId, edited, input);
    }

    if (projectId && (row.kind === "deconstruct" || row.kind === "technique")) {
      ctx.event(projectId, "setting", "proposal.decided", { id: proposalId, kind: row.kind, status: "approved" });
    }
    stmt(ctx.db, "UPDATE author_ai_proposals SET status = 'approved', payload = ?, updated_at = ? WHERE id = ?;")
      .run(JSON.stringify(edited), now, proposalId);
    return { id: proposalId, status: "approved" as const, committed };
  });
}
