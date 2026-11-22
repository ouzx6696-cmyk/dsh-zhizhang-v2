import { randomUUID } from "node:crypto";
import type {
  DeconstructionDto,
  LibraryItemKind,
  LibraryMountDto,
  LibraryMountMode,
  LibraryMountTarget,
  TechniqueCardDto,
  TechniqueRecommendationDto,
  WritingStageBinding,
} from "../../../contracts/workspace-dto.ts";
import {
  normalizeContextTuning,
  normalizeStageBindings,
  rankTechniquesForChapter,
  resolveEffectiveMount,
  selectNonConflictingTechniques,
  validatePacingLabel,
} from "../../../domain/fanqie/index.ts";
import { stmt } from "../../../storage/index.ts";
import { count, invalid, optionalText, requiredRow, text, type DocumentRow, type Input, type WorkspaceContext } from "../../context.ts";
import { loadProjectControls } from "./controls.ts";
import { queryDeconstructions, queryTechniques } from "./library-crud.ts";
import { markBookPrefixDirty } from "./cache-snapshot.ts";
import { assertFanqieProject } from "./shared.ts";

function parseMountParams(input: Input): {
  readonly projectId: string;
  readonly targetType: LibraryMountTarget;
  readonly targetId: string;
  readonly itemKind: LibraryItemKind;
  readonly itemId: string;
} {
  const projectId = text(input, "projectId");
  const targetType = text(input, "targetType");
  if (!["project", "volume", "act", "chapter"].includes(targetType)) {
    invalid("targetType", "invalid-mount-target");
  }
  const targetId = targetType === "project" ? (optionalText(input, "targetId") ?? projectId) : text(input, "targetId");
  const itemKind = text(input, "itemKind");
  if (itemKind !== "deconstruction" && itemKind !== "technique") {
    invalid("itemKind", "invalid-item-kind");
  }
  const itemId = text(input, "itemId");
  return { projectId, targetType: targetType as LibraryMountTarget, targetId, itemKind, itemId };
}

export function mountLibraryItem(ctx: WorkspaceContext, input: Input): LibraryMountDto {
  const { projectId, targetType, targetId, itemKind, itemId } = parseMountParams(input);
  assertFanqieProject(ctx, projectId);
  const modeRaw = typeof input.mode === "string" ? input.mode : "include";
  if (!["include", "exclude", "pin"].includes(modeRaw)) invalid("mode", "invalid-mount-mode");
  const mode = modeRaw as LibraryMountMode;
  const weight = input.weight !== undefined ? count(input, "weight") : 100;
  const note = typeof input.note === "string" ? input.note.trim() : "";

  return ctx.atomic(() => {
    if (targetType === "volume") {
      requiredRow(
        stmt(ctx.db, "SELECT id FROM author_volumes WHERE id = ? AND project_id = ?;").get(targetId, projectId),
        "volume",
        targetId,
      );
    } else if (targetType === "act") {
      requiredRow(
        stmt(ctx.db, "SELECT id FROM author_acts WHERE id = ? AND project_id = ?;").get(targetId, projectId),
        "act",
        targetId,
      );
    } else if (targetType === "chapter") {
      requiredRow(
        stmt(ctx.db, "SELECT id FROM author_documents WHERE id = ? AND project_id = ?;").get(targetId, projectId),
        "document",
        targetId,
      );
    }
    const libTable = itemKind === "deconstruction" ? "library_deconstructions" : "library_technique_cards";
    requiredRow(
      stmt(ctx.db, `SELECT id FROM ${libTable} WHERE id = ? AND (scope = 'global' OR project_id = ?);`).get(itemId, projectId),
      itemKind,
      itemId,
    );

    const id = randomUUID();
    stmt(ctx.db, `
      INSERT INTO author_library_mounts (id, project_id, target_type, target_id, item_kind, item_id, mode, weight, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, target_type, target_id, item_kind, item_id) DO UPDATE SET
        mode = excluded.mode, weight = excluded.weight, note = excluded.note;
    `).run(id, projectId, targetType, targetId, itemKind, itemId, mode, weight, note);
    const saved = stmt(ctx.db, `
      SELECT id, project_id AS projectId, target_type AS targetType, target_id AS targetId,
        item_kind AS itemKind, item_id AS itemId, mode, weight, note
      FROM author_library_mounts
      WHERE project_id = ? AND target_type = ? AND target_id = ? AND item_kind = ? AND item_id = ?;
    `).get(projectId, targetType, targetId, itemKind, itemId) as LibraryMountDto;
    ctx.event(projectId, "setting", "library.mounted", { id: saved.id, targetType, targetId, itemKind, itemId, mode });
    if (targetType === "project") markBookPrefixDirty(ctx, projectId);
    return saved;
  });
}

export function unmountLibraryItem(ctx: WorkspaceContext, input: Input) {
  const { projectId, targetType, targetId, itemKind, itemId } = parseMountParams(input);
  assertFanqieProject(ctx, projectId);
  return ctx.atomic(() => {
    const res = stmt(ctx.db, `
      DELETE FROM author_library_mounts
      WHERE project_id = ? AND target_type = ? AND target_id = ? AND item_kind = ? AND item_id = ?;
    `).run(projectId, targetType, targetId, itemKind, itemId);
    if (res.changes > 0) {
      ctx.event(projectId, "setting", "library.unmounted", { targetType, targetId, itemKind, itemId });
      if (targetType === "project") markBookPrefixDirty(ctx, projectId);
    }
    return { removed: res.changes > 0 };
  });
}

export function queryLibraryMounts(
  ctx: WorkspaceContext,
  projectId: string,
  targetType?: string,
  targetId?: string,
): LibraryMountDto[] {
  if (targetType && targetId) {
    return stmt(ctx.db, `
      SELECT id, project_id AS projectId, target_type AS targetType, target_id AS targetId,
        item_kind AS itemKind, item_id AS itemId, mode, weight, note
      FROM author_library_mounts
      WHERE project_id = ? AND target_type = ? AND target_id = ?;
    `).all(projectId, targetType, targetId) as LibraryMountDto[];
  }
  return stmt(ctx.db, `
    SELECT id, project_id AS projectId, target_type AS targetType, target_id AS targetId,
      item_kind AS itemKind, item_id AS itemId, mode, weight, note
    FROM author_library_mounts WHERE project_id = ?;
  `).all(projectId) as LibraryMountDto[];
}

export function listLibraryMounts(ctx: WorkspaceContext, input: Input): LibraryMountDto[] {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const targetType = optionalText(input, "targetType");
  const targetId = optionalText(input, "targetId");
  return ctx.read(() => queryLibraryMounts(ctx, projectId, targetType, targetId));
}

export function queryTechniqueRecommendations(
  ctx: WorkspaceContext,
  row: DocumentRow,
  pacing = "",
  instruction = "",
  stage?: WritingStageBinding,
): TechniqueRecommendationDto[] {
  const cards = queryTechniques(ctx, { projectId: row.projectId });
  const mounts = queryLibraryMounts(ctx, row.projectId);
  const controls = loadProjectControls(ctx, row.projectId);
  const order = ctx.chapterOrder(row.projectId);
  const plan = ctx.planning(row.id);
  const outlineText = [row.title, row.summary, instruction, plan ? JSON.stringify(plan) : ""].join("\n");
  const ranked = rankTechniquesForChapter({
    cards,
    mounts,
    contextIds: { projectId: row.projectId, volumeId: row.volumeId, actId: row.actId, chapterId: row.id },
    pacing: pacing || controls.pacingTier || "",
    genreTags: controls.genreTags,
    outlineText,
    chapterIndex: Math.max(0, order.indexOf(row.id)),
    stage,
  });
  return ranked.map((entry) => ({
    card: entry.card as TechniqueCardDto,
    score: entry.score,
    mountedMode: entry.mountedMode,
    mountTarget: entry.mountTarget,
    reasons: entry.reasons,
  }));
}

export function recommendTechniquesForChapter(
  ctx: WorkspaceContext,
  row: DocumentRow,
  input: Input,
): TechniqueRecommendationDto[] {
  if (row.product !== "fanqie") invalid("documentId", "chapter-required");
  const pacing = validatePacingLabel(input.pacing);
  const instruction = typeof input.instruction === "string" ? input.instruction : "";
  const stage = input.stage !== undefined ? normalizeStageBindings([input.stage])[0] : undefined;
  return ctx.read(() => queryTechniqueRecommendations(ctx, row, pacing, instruction, stage));
}

export function resolveMountedLibraryForChapter(
  ctx: WorkspaceContext,
  row: DocumentRow,
  instruction = "",
  pacing = "",
  stage: WritingStageBinding = "write",
): {
  readonly techniques: TechniqueCardDto[];
  readonly deconstructions: DeconstructionDto[];
  readonly autoMatchedIds: readonly string[];
  readonly conflictSkippedIds: readonly string[];
} {
  const controls = loadProjectControls(ctx, row.projectId);
  const tuning = normalizeContextTuning(controls.contextTuning);
  const mounts = queryLibraryMounts(ctx, row.projectId);
  const contextIds = { projectId: row.projectId, volumeId: row.volumeId, actId: row.actId, chapterId: row.id };

  const ranked = queryTechniqueRecommendations(ctx, row, pacing, instruction, stage);
  // Only allow unmounted auto-matched cards that exceed the relevance threshold (>= 85)
  const eligible = ranked.filter((entry) => entry.mountedMode !== null || entry.score >= 85);
  const selection = tuning.maxActiveTechniques > 0
    ? selectNonConflictingTechniques(eligible, tuning.maxActiveTechniques)
    : { selected: [], autoMatchedIds: [], conflictSkippedIds: [] };
  const techniques = selection.selected.map((entry) => entry.card as TechniqueCardDto);

  const allDeconstructs = queryDeconstructions(ctx, { projectId: row.projectId });
  const mountedDeconstructions = allDeconstructs.filter((sample) => {
    const mount = resolveEffectiveMount(mounts, "deconstruction", sample.id, contextIds, sample.overrideOfId);
    return mount !== null && mount.mode !== "exclude";
  });
  const deconstructions = tuning.maxActiveDeconstructions > 0
    ? mountedDeconstructions.slice(0, tuning.maxActiveDeconstructions)
    : [];

  return {
    techniques,
    deconstructions,
    autoMatchedIds: selection.autoMatchedIds,
    conflictSkippedIds: selection.conflictSkippedIds,
  };
}
