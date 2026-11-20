import { randomUUID } from "node:crypto";
import type { AiProposalKind } from "../contracts/workspace-dto.ts";
import { stmt } from "../storage/index.ts";
import {
  DECONSTRUCT_EXTRACT_SYSTEM,
  SETTING_EXTRACT_SYSTEM,
  SUMMARY_DRAFT_SYSTEM,
  sumUsageTuple,
  TECHNIQUE_EXTRACT_SYSTEM,
} from "../workflow/writing-budget.ts";
import type { WritingPhase } from "../workflow/writing-stages.ts";
import { count, invalid, optionalText, text, type Input, type WorkspaceContext } from "./context.ts";

interface ProposalSpec {
  readonly phase: WritingPhase;
  readonly system: string;
}

const PROPOSAL_SPECS: Readonly<Record<AiProposalKind, ProposalSpec>> = {
  deconstruct: { phase: "deconstructExtract", system: DECONSTRUCT_EXTRACT_SYSTEM },
  technique: { phase: "techniqueExtract", system: TECHNIQUE_EXTRACT_SYSTEM },
  setting: { phase: "settingExtract", system: SETTING_EXTRACT_SYSTEM },
  summary: { phase: "summaryDraft", system: SUMMARY_DRAFT_SYSTEM },
};

function parseKind(raw: unknown): AiProposalKind {
  if (typeof raw === "string" && Object.hasOwn(PROPOSAL_SPECS, raw)) {
    return raw as AiProposalKind;
  }
  invalid("kind", "unknown-proposal-kind");
}

/**
 * Orchestrates budget-guarded, strictly author-sovereign AI proposal tasks
 * (deconstruction analysis, technique cards, end-of-chapter lore diffs, and
 * rolling summaries). Results are persisted only as `pending` proposals and
 * never mutate authoritative tables until explicit author confirmation.
 */
export function createProposalService(ctx: WorkspaceContext) {
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

      if (documentId) {
        const doc = ctx.document(documentId);
        resolvedProjectId = doc.projectId;
        if (!sourceText) sourceText = doc.body ?? "";
        if (!sourceRef) sourceRef = doc.title;
      }
      if (!sourceText.trim()) invalid("sourceText", "source-text-required");

      let existingLoreHints: Array<{ factId: string; category: string; entityName: string }> = [];
      if (resolvedProjectId && kind === "setting") {
        existingLoreHints = stmt(db, `
          SELECT fact_id AS factId, category, entity_name AS entityName
          FROM author_lore_current
          WHERE project_id = ?
          ORDER BY decided_seq DESC LIMIT 40;
        `).all(resolvedProjectId) as Array<{ factId: string; category: string; entityName: string }>;
      }

      const spec = PROPOSAL_SPECS[kind];
      const prompt = JSON.stringify({
        kind,
        sourceRef,
        instruction: optionalText(input, "instruction") ?? "",
        existingLoreHints,
        sourceText,
      });

      const id = randomUUID();
      const now = Date.now();
      stmt(db, `
        INSERT INTO author_ai_proposals (
          id, project_id, document_id, kind, status, source_ref,
          payload, provider, model, reserved, settled, usage, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'inflight', ?, '{}', ?, ?, ?, 0, '[]', ?, ?);
      `).run(id, resolvedProjectId, documentId, kind, sourceRef, provider, model, reserved, now, now);

      return {
        id,
        kind,
        phase: spec.phase,
        system: spec.system,
        prompt,
        provider,
        model,
        reserved,
        projectId: resolvedProjectId,
        documentId,
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
      if (payload && !failure) {
        stmt(db, `
          UPDATE author_ai_proposals
          SET status = 'pending', payload = ?, error = NULL, updated_at = ?
          WHERE id = ? AND status = 'inflight';
        `).run(JSON.stringify(payload), now, proposalId);
        return;
      }
      stmt(db, `
        UPDATE author_ai_proposals
        SET status = 'failed', error = ?, updated_at = ?
        WHERE id = ? AND status = 'inflight';
      `).run(failure ?? "generation.failed", now, proposalId);
    });
  }

  function recoverProposals(): void {
    stmt(db, `
      UPDATE author_ai_proposals
      SET status = 'failed', error = 'interrupted', updated_at = ?
      WHERE status = 'inflight';
    `).run(Date.now());
  }

  return {
    beginProposalGeneration,
    recordProposalReceipt,
    finishProposalGeneration,
    recoverProposals,
  };
}
