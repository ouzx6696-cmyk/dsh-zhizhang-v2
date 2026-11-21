import { randomUUID } from "node:crypto";
import type { ForeshadowDto, LoreConflictDto, LoreEntryDto } from "../../../contracts/workspace-dto.ts";
import { ContractError } from "../../../contracts/index.ts";
import {
  assertForeshadowStatus,
  assertForeshadowTransition,
  detectLoreConflicts,
  LORE_CATEGORIES,
  mergeFactVersion,
  normalizeLoreCategory,
  planReorder,
  settingsAt,
  type ChapterOutlineFacts,
  type ForeshadowState,
  type LoreForeshadowEntry,
  type SettingFact,
} from "../../../domain/fanqie/index.ts";
import { anchor, precedes, type Anchor } from "../../../domain/shared/index.ts";
import { currentSeq, stmt, syncLoreFts } from "../../../storage/index.ts";
import {
  count,
  invalid,
  optionalText,
  refuse,
  requiredRow,
  text,
  type Input,
  type WorkspaceContext,
} from "../../context.ts";
import { approvedFacts, assertChapterInProject, assertFanqieProject, reorderRelations } from "./shared.ts";
import { refreshEntityMentionsForFact } from "./memory-sync.ts";

function settingAnchor(input: Input, field: string, order: readonly string[]): Anchor {
  const value = input[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  const fields = value as Input;
  const id = text(fields, "chapterId");
  const point = count(fields, "point");
  if (!order.includes(id) || point === 0) invalid(field, "unknown-chapter-or-point");
  return anchor(id, point);
}

function knownFrom(input: Input, from: Anchor, order: readonly string[]): SettingFact["knownFrom"] {
  if (input.people === undefined) {
    const character = typeof input.character === "string" ? input.character.trim() : "";
    return character ? { [character]: input.knownAt ? settingAnchor(input, "knownAt", order) : from } : {};
  }
  if (!Array.isArray(input.people)) invalid("people", "expected-character-list");
  const characters = new Map<string, Anchor>();
  for (const person of input.people) {
    if (!person || typeof person !== "object" || Array.isArray(person)) {
      invalid("people", "invalid-character");
    }
    const record = person as Input;
    const character = text(record, "character").trim();
    if (characters.has(character)) invalid("people", "duplicate-character");
    characters.set(character, record.at === undefined ? from : settingAnchor(record, "at", order));
  }
  return Object.fromEntries(characters);
}

function proposedOrder(input: Input, before: readonly string[]): string[] {
  const next = input.chapterIds;
  const known = new Set(before);
  if (
    !Array.isArray(next) ||
    next.length !== before.length ||
    new Set(next).size !== before.length ||
    next.some((id) => typeof id !== "string" || !known.has(id))
  ) {
    invalid("chapterIds", "order-must-contain-every-chapter-once");
  }
  return next as string[];
}

export function computeReorder(ctx: WorkspaceContext, projectId: string, input: Input) {
  const before = ctx.chapterOrder(projectId);
  const after = proposedOrder(input, before);
  const relations = reorderRelations(approvedFacts(ctx, projectId));
  return { ...planReorder(relations, before, after), chapterIds: after, asOfSeq: currentSeq(ctx.db, projectId) };
}

export function settingsPage(ctx: WorkspaceContext, projectId: string, before = Number.MAX_SAFE_INTEGER) {
  const rows = stmt(ctx.db, `
    SELECT sequence, id, decision, value FROM author_settings
    WHERE project_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 51;
  `).all(projectId, before) as readonly { sequence: number; id: string; decision: string; value: string }[];
  return {
    entries: rows.slice(0, 50).map(({ id, decision, value }) => ({
      id,
      decision,
      fact: JSON.parse(value) as SettingFact,
    })),
    cursor: rows.length > 50 ? rows[49].sequence : null,
  };
}

/**
 * Synchronizes an approved setting record into `author_lore_current` and `fts_lore`.
 * Used both by `setting.decide` and AI setting proposal confirmation.
 */
export function materializeApprovedLore(
  ctx: WorkspaceContext,
  params: {
    readonly projectId: string;
    readonly settingId: string;
    readonly factId: string;
    readonly category: string;
    readonly entityName: string;
    readonly fact: SettingFact;
    readonly decidedSeq: number;
  },
): void {
  const normalizedCategory = normalizeLoreCategory(params.category, params.fact.kind);
  stmt(ctx.db, `
    INSERT INTO author_lore_current
      (project_id, fact_id, category, entity_name, latest_setting_id, locked, value, decided_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id, fact_id) DO UPDATE SET
      category = excluded.category,
      entity_name = CASE WHEN excluded.entity_name != '' THEN excluded.entity_name ELSE author_lore_current.entity_name END,
      latest_setting_id = excluded.latest_setting_id,
      locked = excluded.locked,
      value = excluded.value,
      decided_seq = excluded.decided_seq;
  `).run(
    params.projectId,
    params.factId,
    normalizedCategory,
    params.entityName,
    params.settingId,
    params.fact.locked ? 1 : 0,
    JSON.stringify(params.fact),
    params.decidedSeq,
  );
  syncLoreFts(ctx.db, {
    projectId: params.projectId,
    factId: params.factId,
    entityName: params.entityName,
    note: params.fact.note,
    source: params.fact.source,
  });
  refreshEntityMentionsForFact(
    ctx,
    params.projectId,
    params.factId,
    params.entityName,
    normalizedCategory,
  );
}

export function handleContinuity(action: string, ctx: WorkspaceContext, input: Input) {
  const { db } = ctx;
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);

  if (action === "settings.history") return settingsPage(ctx, projectId, count(input, "before"));
  if (action === "reorder.impact") return ctx.read(() => computeReorder(ctx, projectId, input));
  if (action === "settings.read") {
    return ctx.read(() => {
      const order = ctx.chapterOrder(projectId);
      const at = settingAnchor(input, "at", order);
      const characterId = text(input, "character");
      return {
        entries: settingsAt(approvedFacts(ctx, projectId), order, at, characterId),
        asOfSeq: currentSeq(db, projectId),
      };
    });
  }
  if (action === "reorder.commit") {
    return ctx.atomic(() => {
      const plan = computeReorder(ctx, projectId, input);
      if (input.asOfSeq !== plan.asOfSeq) {
        throw new ContractError("version.conflict", {
          documentId: projectId,
          baseRevisionId: String(input.asOfSeq),
          currentRevisionId: String(plan.asOfSeq),
        });
      }
      if (input.confirmed !== true) refuse(action, "author-confirmation-required");
      stmt(db, `
        INSERT INTO author_chapter_order (project_id, chapter_ids) VALUES (?, ?)
        ON CONFLICT (project_id) DO UPDATE SET chapter_ids = excluded.chapter_ids;
      `).run(projectId, JSON.stringify(plan.chapterIds));
      ctx.event(projectId, "chapter", "chapter.reordered", { chapterIds: plan.chapterIds });
      return { chapterIds: plan.chapterIds };
    });
  }

  const row = ctx.document(text(input, "documentId"));
  if (row.projectId !== projectId) invalid("documentId", "project-mismatch");

  if (action === "setting.propose") {
    return ctx.atomic(() => {
      const id = randomUUID();
      const factId = text(input, "factId").trim();
      const order = ctx.chapterOrder(projectId);
      const effectiveFrom = settingAnchor(input, "from", order);
      const effectiveTo = input.to ? settingAnchor(input, "to", order) : undefined;
      if (effectiveTo && !precedes(effectiveFrom, effectiveTo, order)) {
        invalid("to", "empty-validity-interval");
      }
      const kind = input.kind === "agreement" ? "agreement" : "fact";
      const category = normalizeLoreCategory(input.category, kind);
      const entityName = optionalText(input, "entityName") ?? "";
      const value: SettingFact = {
        id: factId,
        note: text(input, "note"),
        source: text(input, "source"),
        kind,
        locked: input.locked === true,
        effectiveFrom,
        effectiveTo,
        knownFrom: knownFrom(input, effectiveFrom, order),
      };
      stmt(db, `
        INSERT INTO author_settings (id, project_id, fact_id, category, entity_name, value)
        VALUES (?, ?, ?, ?, ?, ?);
      `).run(id, projectId, factId, category, entityName, JSON.stringify(value));
      ctx.event(projectId, "setting", "setting.proposed", { id, factId });
      return { id };
    });
  }

  return ctx.dispatch(action, row, input, () => {
    const id = text(input, "proposalId");
    const proposal = requiredRow<{
      fact_id: string;
      decision: string;
      category: string;
      entity_name: string;
      value: string;
    }>(
      stmt(db, "SELECT fact_id, decision, category, entity_name, value FROM author_settings WHERE id = ? AND project_id = ?;")
        .get(id, projectId),
      "setting-proposal",
      id,
    );
    if (proposal.decision !== "pending") refuse(action, "decision-already-recorded");
    if (typeof input.accept !== "boolean") invalid("accept");
    if (input.accept && approvedFacts(ctx, projectId).some((fact) => fact.id === proposal.fact_id && fact.locked)) {
      refuse(action, "setting-is-locked");
    }
    const decision = input.accept ? "approved" : "rejected";
    const parsedFact = JSON.parse(proposal.value) as SettingFact;
    // FQ-01: keep each character's earliest "already knew it" anchor across
    // versions, while the author's explicit `from` marks when this version
    // becomes true. The stored decision keeps the merged fact so later reads
    // do not fall back to the raw proposal's later knowledge anchor.
    const decidedFact = decision === "approved"
      ? mergeFactVersion(
          approvedFacts(ctx, projectId).find((fact) => fact.id === proposal.fact_id),
          parsedFact,
          ctx.chapterOrder(projectId),
          { overrideEffectiveFrom: true },
        )
      : parsedFact;
    const decidedSeq = ctx.event(projectId, "setting", "setting.decided", {
      id,
      factId: proposal.fact_id,
      decision,
      fact: decidedFact,
    });
    stmt(db, "UPDATE author_settings SET decision = ?, decided_seq = ?, value = ? WHERE id = ?;")
      .run(decision, decidedSeq, JSON.stringify(decidedFact), id);
    if (decision === "approved") {
      materializeApprovedLore(ctx, {
        projectId,
        settingId: id,
        factId: proposal.fact_id,
        category: proposal.category,
        entityName: proposal.entity_name,
        fact: decidedFact,
        decidedSeq,
      });
    }
    return { id, decision };
  });
}

function parseLoreCursor(raw: string): { readonly decidedSeq: number; readonly factId: string } {
  const colon = raw.indexOf(":");
  if (colon <= 0 || colon >= raw.length - 1) invalid("cursor", "invalid-lore-cursor");
  const seqStr = raw.slice(0, colon);
  const factId = raw.slice(colon + 1);
  if (!/^\d+$/u.test(seqStr)) invalid("cursor", "invalid-lore-cursor");
  const decidedSeq = Number(seqStr);
  if (!Number.isSafeInteger(decidedSeq)) invalid("cursor", "invalid-lore-cursor");
  return { decidedSeq, factId };
}

export function queryLore(
  ctx: WorkspaceContext,
  projectId: string,
  options: {
    readonly category?: string;
    readonly entityName?: string;
    readonly lockedOnly?: boolean;
    readonly limit?: number;
    readonly cursor?: string;
    readonly all?: boolean;
  } = {},
): { readonly entries: LoreEntryDto[]; readonly cursor: string | null } {
  const clauses = ["project_id = ?"];
  const params: (string | number)[] = [projectId];
  if (options.category) {
    clauses.push("category = ?");
    params.push(options.category);
  }
  if (options.entityName) {
    clauses.push("entity_name LIKE ?");
    params.push(`%${options.entityName}%`);
  }
  if (options.lockedOnly) {
    clauses.push("locked = 1");
  }
  if (options.cursor && !options.all) {
    const parsed = parseLoreCursor(options.cursor);
    clauses.push("(decided_seq < ? OR (decided_seq = ? AND fact_id < ?))");
    params.push(parsed.decidedSeq, parsed.decidedSeq, parsed.factId);
  }

  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const limitSql = options.all ? "" : " LIMIT ?";
  if (!options.all) params.push(limit + 1);

  const rows = stmt(ctx.db, `
    SELECT fact_id AS factId, category, entity_name AS entityName,
      latest_setting_id AS latestSettingId, locked, value, decided_seq AS decidedSeq
    FROM author_lore_current
    WHERE ${clauses.join(" AND ")}
    ORDER BY decided_seq DESC, fact_id DESC${limitSql};
  `).all(...params) as readonly {
    factId: string;
    category: string;
    entityName: string;
    latestSettingId: string;
    locked: number;
    value: string;
    decidedSeq: number;
  }[];

  const hasMore = !options.all && rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  return {
    entries: pageRows.map((row) => ({
      factId: row.factId,
      category: normalizeLoreCategory(row.category, "fact"),
      entityName: row.entityName,
      latestSettingId: row.latestSettingId,
      locked: row.locked === 1,
      fact: JSON.parse(row.value),
      decidedSeq: row.decidedSeq,
    })),
    cursor: hasMore && lastRow ? `${lastRow.decidedSeq}:${lastRow.factId}` : null,
  };
}

export function listLore(
  ctx: WorkspaceContext,
  input: Input,
): { readonly entries: LoreEntryDto[]; readonly cursor: string | null } {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const category = optionalText(input, "category");
  if (category && !(LORE_CATEGORIES as readonly string[]).includes(category)) {
    invalid("category", "unknown-lore-category");
  }
  const entityName = optionalText(input, "entityName");
  const lockedOnly = input.lockedOnly === true;
  const limit = input.limit !== undefined ? count(input, "limit") : undefined;
  if (limit === 0) invalid("limit", "positive-integer-required");
  const cursor = optionalText(input, "cursor");
  if (cursor) parseLoreCursor(cursor);
  return ctx.read(() => queryLore(ctx, projectId, { category, entityName, lockedOnly, limit, cursor }));
}

export function queryForeshadows(ctx: WorkspaceContext, projectId: string, status?: string): ForeshadowDto[] {
  const sql = status
    ? `SELECT id, project_id AS projectId, fact_id AS factId, title, planted_chapter_id AS plantedChapterId,
         planted_point AS plantedPoint, target_chapter_id AS targetChapterId,
         resolved_chapter_id AS resolvedChapterId, status, note, updated_at AS updatedAt
       FROM author_foreshadows WHERE project_id = ? AND status = ? ORDER BY updated_at DESC;`
    : `SELECT id, project_id AS projectId, fact_id AS factId, title, planted_chapter_id AS plantedChapterId,
         planted_point AS plantedPoint, target_chapter_id AS targetChapterId,
         resolved_chapter_id AS resolvedChapterId, status, note, updated_at AS updatedAt
       FROM author_foreshadows WHERE project_id = ? ORDER BY updated_at DESC;`;
  return (status
    ? stmt(ctx.db, sql).all(projectId, status)
    : stmt(ctx.db, sql).all(projectId)) as ForeshadowDto[];
}

export function listForeshadows(ctx: WorkspaceContext, input: Input): ForeshadowDto[] {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const status = optionalText(input, "status");
  if (status) assertForeshadowStatus(status);
  return ctx.read(() => queryForeshadows(ctx, projectId, status));
}

const FORESHADOW_SELECT = `
  id, project_id AS projectId, fact_id AS factId, title,
  planted_chapter_id AS plantedChapterId, planted_point AS plantedPoint,
  target_chapter_id AS targetChapterId, resolved_chapter_id AS resolvedChapterId,
  status, note, updated_at AS updatedAt
`;

function readForeshadowRow(ctx: WorkspaceContext, id: string): ForeshadowDto | undefined {
  return stmt(ctx.db, `SELECT ${FORESHADOW_SELECT} FROM author_foreshadows WHERE id = ?;`)
    .get(id) as ForeshadowDto | undefined;
}

export function createForeshadow(ctx: WorkspaceContext, input: Input): ForeshadowDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const title = text(input, "title").trim();
  const status = input.status !== undefined ? assertForeshadowStatus(input.status) : "planted";
  const id = optionalText(input, "id") ?? randomUUID();
  const factId = optionalText(input, "factId") ?? null;
  const plantedChapterId = optionalText(input, "plantedChapterId") ?? null;
  const targetChapterId = optionalText(input, "targetChapterId") ?? null;
  const resolvedChapterId = optionalText(input, "resolvedChapterId") ?? null;
  const plantedPoint = input.plantedPoint !== undefined ? Math.max(1, count(input, "plantedPoint")) : 1;
  const note = typeof input.note === "string" ? input.note.trim() : "";

  return ctx.atomic(() => {
    if (readForeshadowRow(ctx, id)) invalid("id", "already-exists");
    if (plantedChapterId) assertChapterInProject(ctx, projectId, plantedChapterId, "plantedChapterId");
    if (targetChapterId) assertChapterInProject(ctx, projectId, targetChapterId, "targetChapterId");
    if (resolvedChapterId) assertChapterInProject(ctx, projectId, resolvedChapterId, "resolvedChapterId");
    const updatedAt = Date.now();
    stmt(ctx.db, `
      INSERT INTO author_foreshadows (
        id, project_id, fact_id, title, planted_chapter_id, planted_point,
        target_chapter_id, resolved_chapter_id, status, note, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `).run(
      id,
      projectId,
      factId,
      title,
      plantedChapterId,
      plantedPoint,
      targetChapterId,
      resolvedChapterId,
      status,
      note,
      updatedAt,
    );
    ctx.event(projectId, "setting", "foreshadow.created", { id, status });
    return {
      id,
      projectId,
      factId,
      title,
      plantedChapterId,
      plantedPoint,
      targetChapterId,
      resolvedChapterId,
      status,
      note,
      updatedAt,
    };
  });
}

export function patchForeshadow(ctx: WorkspaceContext, input: Input): ForeshadowDto {
  const id = text(input, "id");
  const existing = requiredRow<ForeshadowDto>(readForeshadowRow(ctx, id), "foreshadow", id);
  const requestedProject = optionalText(input, "projectId");
  if (requestedProject && requestedProject !== existing.projectId) invalid("projectId", "project-mismatch");
  const projectId = existing.projectId;

  const status: ForeshadowState = input.status !== undefined
    ? assertForeshadowStatus(input.status)
    : existing.status;
  // The domain table intentionally has no self-loops; a patch that only edits
  // a note must not be treated as an illegal `planted → planted` transition.
  if (status !== existing.status) {
    assertForeshadowTransition(existing.status, status, { reopen: input.reopen === true });
  }

  const title = input.title !== undefined ? text(input, "title").trim() : existing.title;
  const factId = input.factId !== undefined ? (optionalText(input, "factId") ?? null) : existing.factId;
  const plantedChapterId = input.plantedChapterId !== undefined
    ? (optionalText(input, "plantedChapterId") ?? null)
    : existing.plantedChapterId;
  const targetChapterId = input.targetChapterId !== undefined
    ? (optionalText(input, "targetChapterId") ?? null)
    : existing.targetChapterId;
  const resolvedChapterId = input.resolvedChapterId !== undefined
    ? (optionalText(input, "resolvedChapterId") ?? null)
    : existing.resolvedChapterId;
  const plantedPoint = input.plantedPoint !== undefined
    ? Math.max(1, count(input, "plantedPoint"))
    : existing.plantedPoint;
  const note = typeof input.note === "string" ? input.note.trim() : existing.note;

  return ctx.atomic(() => {
    if (plantedChapterId) assertChapterInProject(ctx, projectId, plantedChapterId, "plantedChapterId");
    if (targetChapterId) assertChapterInProject(ctx, projectId, targetChapterId, "targetChapterId");
    if (resolvedChapterId) assertChapterInProject(ctx, projectId, resolvedChapterId, "resolvedChapterId");
    const updatedAt = Date.now();
    stmt(ctx.db, `
      UPDATE author_foreshadows
      SET fact_id = ?, title = ?, planted_chapter_id = ?, planted_point = ?,
          target_chapter_id = ?, resolved_chapter_id = ?, status = ?, note = ?, updated_at = ?
      WHERE id = ? AND project_id = ?;
    `).run(
      factId,
      title,
      plantedChapterId,
      plantedPoint,
      targetChapterId,
      resolvedChapterId,
      status,
      note,
      updatedAt,
      id,
      projectId,
    );
    ctx.event(projectId, "setting", "foreshadow.updated", { id, from: existing.status, to: status });
    return {
      id,
      projectId,
      factId,
      title,
      plantedChapterId,
      plantedPoint,
      targetChapterId,
      resolvedChapterId,
      status,
      note,
      updatedAt,
    };
  });
}

/**
 * Backwards-compatible entry point: an existing id patches the row (preserving
 * fields the caller did not send), a new id creates it.
 */
export function upsertForeshadow(ctx: WorkspaceContext, input: Input): ForeshadowDto {
  const id = optionalText(input, "id");
  if (id) {
    const existing = readForeshadowRow(ctx, id);
    if (existing) {
      // FQ-06: an upsert carrying another project's foreshadow id must fail
      // loudly instead of editing that project's row.
      const projectId = text(input, "projectId");
      if (projectId !== existing.projectId) invalid("projectId", "project-mismatch");
      return patchForeshadow(ctx, input);
    }
  }
  return createForeshadow(ctx, input);
}

export function scanLoreConflicts(ctx: WorkspaceContext, input: Input): LoreConflictDto[] {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  return ctx.read(() => {
    const facts = approvedFacts(ctx, projectId);
    const foreshadows = queryForeshadows(ctx, projectId) as unknown as readonly LoreForeshadowEntry[];
    const order = ctx.chapterOrder(projectId);
    const outlineRows = stmt(ctx.db, `
      SELECT p.document_id AS chapterId, p.value
      FROM author_planning p
      JOIN author_documents a ON a.id = p.document_id
      WHERE a.project_id = ?;
    `).all(projectId) as readonly { chapterId: string; value: string }[];
    const outlines: ChapterOutlineFacts[] = outlineRows.map((row) => {
      try {
        const parsed = JSON.parse(row.value) as { lockedFacts?: unknown };
        return {
          chapterId: row.chapterId,
          lockedFacts: typeof parsed.lockedFacts === "string" ? parsed.lockedFacts : "",
        };
      } catch {
        return { chapterId: row.chapterId, lockedFacts: "" };
      }
    });
    return detectLoreConflicts(facts, foreshadows, order, outlines);
  });
}
