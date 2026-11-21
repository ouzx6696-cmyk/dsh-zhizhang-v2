import { randomUUID } from "node:crypto";
import type { AiProposalKind } from "../contracts/workspace-dto.ts";
import { stmt } from "../storage/index.ts";
import {
  ARC_PLAN_SYSTEM,
  CHAPTER_REVIEW_SYSTEM,
  DECONSTRUCT_EXTRACT_SYSTEM,
  FACT_SYNC_SYSTEM,
  SETTING_EXTRACT_SYSTEM,
  SUMMARY_DRAFT_SYSTEM,
  sumUsageTuple,
  TECHNIQUE_EXTRACT_SYSTEM,
} from "../workflow/writing-budget.ts";
import type { WritingPhase } from "../workflow/writing-stages.ts";
import { count, invalid, optionalText, text, type Input, type Product, type WorkspaceContext } from "./context.ts";
import { sha256Text } from "./digest.ts";
import type { ProductLineRegistry } from "./product-line.ts";

interface ProposalSpec {
  readonly phase: WritingPhase;
  readonly system: string;
}

const PROPOSAL_SPECS: Readonly<Record<AiProposalKind, ProposalSpec>> = {
  deconstruct: { phase: "deconstructExtract", system: DECONSTRUCT_EXTRACT_SYSTEM },
  technique: { phase: "techniqueExtract", system: TECHNIQUE_EXTRACT_SYSTEM },
  setting: { phase: "settingExtract", system: SETTING_EXTRACT_SYSTEM },
  summary: { phase: "summaryDraft", system: SUMMARY_DRAFT_SYSTEM },
  fact_sync: { phase: "factSync", system: FACT_SYNC_SYSTEM },
  chapter_review: { phase: "chapterReview", system: CHAPTER_REVIEW_SYSTEM },
  arc_plan: { phase: "arcPlan", system: ARC_PLAN_SYSTEM },
};

function parseKind(raw: unknown): AiProposalKind {
  if (typeof raw === "string" && Object.hasOwn(PROPOSAL_SPECS, raw)) {
    return raw as AiProposalKind;
  }
  invalid("kind", "unknown-proposal-kind");
}

/**
 * Orchestrates budget-guarded, strictly author-sovereign AI proposal tasks
 * (deconstruction analysis, technique cards, end-of-chapter lore diffs,
 * continuity memory sync, and rolling summaries). Results are persisted only as
 * `pending` proposals and never mutate authoritative tables until explicit
 * author confirmation.
 */
export function createProposalService(ctx: WorkspaceContext, registry: ProductLineRegistry) {
  const { db } = ctx;

  function beginProposalGeneration(input: Input) {
    const kind = parseKind(input.kind);
    const provider = text(input, "provider");
    const model = text(input, "model");
    const projectId = optionalText(input, "projectId") ?? null;
    const documentId = optionalText(input, "documentId") ?? null;
    const reserved = input.tokenLimit === undefined ? 12_000 : count(input, "tokenLimit");
    if (reserved === 0) invalid("tokenLimit", "positive-budget-required");

    return ctx.atomic(() => {
      let sourceText = optionalText(input, "sourceText") ?? "";
      let sourceRef = optionalText(input, "sourceRef") ?? "";
      let resolvedProjectId = projectId;
      let baseRevisionId: string | null = null;
      let sourceSha = "";

      if (documentId) {
        const doc = ctx.document(documentId);
        resolvedProjectId = doc.projectId;
        baseRevisionId = doc.revisionId ?? null;
        sourceSha = sha256Text(doc.body ?? "");
        if (!sourceText) sourceText = doc.body ?? "";
        if (!sourceRef) sourceRef = doc.title;
      }

      let extraContext: Readonly<Record<string, unknown>> = {};
      if (resolvedProjectId) {
        const project = stmt(db, "SELECT product FROM author_projects WHERE id = ?;").get(resolvedProjectId) as
          | { product: Product }
          | undefined;
        const mod = project ? registry.get(project.product) : undefined;
        const built = mod?.buildProposalContext?.(ctx, {
          kind,
          projectId: resolvedProjectId,
          documentId,
          input,
        });
        if (built) {
          if (built.sourceText !== undefined) sourceText = built.sourceText;
          if (built.sourceRef !== undefined && !sourceRef) sourceRef = built.sourceRef;
          if (built.extra) extraContext = built.extra;
        }
      }
      if (!sourceText.trim()) invalid("sourceText", "source-text-required");

      const spec = PROPOSAL_SPECS[kind];
      const prompt = JSON.stringify({
        kind,
        sourceRef,
        instruction: optionalText(input, "instruction") ?? "",
        ...extraContext,
        sourceText,
      });

      const id = randomUUID();
      const now = Date.now();
      stmt(db, `
        INSERT INTO author_ai_proposals (
          id, project_id, document_id, kind, status, source_ref,
          payload, provider, model, reserved, settled, usage,
          base_revision_id, source_sha256, origin, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'inflight', ?, '{}', ?, ?, ?, 0, '[]', ?, ?, 'ai-generate', ?, ?);
      `).run(
        id,
        resolvedProjectId,
        documentId,
        kind,
        sourceRef,
        provider,
        model,
        reserved,
        baseRevisionId,
        sourceSha,
        now,
        now,
      );

      return {
        id,
        kind,
        phase: spec.phase,
        system: spec.system,
        prompt,
        provider,
        model,
        reserved,
        disableThinking: true,
        projectId: resolvedProjectId,
        documentId,
        baseRevisionId,
      };
    });
  }

  function recordProposalReceipt(proposalId: string, usage: readonly number[]): void {
    ctx.atomic(() => {
      const tokens = sumUsageTuple(usage);
      stmt(db, `
        UPDATE author_ai_proposals
        SET settled = settled + ?,
            usage = json_insert(usage, '$[#]', json(?)),
            updated_at = ?
        WHERE id = ? AND status = 'inflight';
      `).run(tokens, JSON.stringify(usage), Date.now(), proposalId);
    });
  }

  function finishProposalGeneration(
    proposalId: string,
    payload: Record<string, unknown> | null,
    failure: string | null,
  ): void {
    ctx.atomic(() => {
      const now = Date.now();
      const target = stmt(db, "SELECT project_id AS projectId FROM author_ai_proposals WHERE id = ?;")
        .get(proposalId) as { projectId?: string | null } | undefined;
      const nextStatus = payload && !failure ? "pending" : "failed";
      const res = payload && !failure
        ? stmt(db, `
            UPDATE author_ai_proposals
            SET status = 'pending', payload = ?, error = NULL, updated_at = ?
            WHERE id = ? AND status = 'inflight';
          `).run(JSON.stringify(payload), now, proposalId)
        : stmt(db, `
            UPDATE author_ai_proposals
            SET status = 'failed', error = ?, updated_at = ?
            WHERE id = ? AND status = 'inflight';
          `).run(failure ?? "generation.failed", now, proposalId);
      if (res.changes > 0 && target?.projectId) {
        ctx.event(target.projectId, "setting", "proposal.ready", { id: proposalId, status: nextStatus });
      }
    });
  }

  function cancelProposalGeneration(proposalId: string): boolean {
    return ctx.atomic(() => {
      const res = stmt(db, `
        UPDATE author_ai_proposals
        SET status = 'failed', error = 'cancelled', updated_at = ?
        WHERE id = ? AND status = 'inflight';
      `).run(Date.now(), proposalId);
      return Boolean(res.changes);
    });
  }

  function recoverProposals(): void {
    ctx.atomic(() => {
      stmt(db, `
        UPDATE author_ai_proposals
        SET status = 'failed', error = 'interrupted', updated_at = ?
        WHERE status = 'inflight';
      `).run(Date.now());
    });
  }

  return {
    beginProposalGeneration,
    recordProposalReceipt,
    finishProposalGeneration,
    cancelProposalGeneration,
    recoverProposals,
  };
}
