import { randomUUID } from "node:crypto";
import type {
  AiProposalDto,
  AiProposalKind,
  DeconstructionDto,
  LibraryItemKind,
  LibraryMountDto,
  LibraryMountMode,
  LibraryMountTarget,
  LibraryScope,
  LibraryStatus,
  TechniqueCardDto,
  TechniqueRecommendationDto,
} from "../../../contracts/workspace-dto.ts";
import {
  normalizeLoreCategory,
  normalizeTags,
  rankTechniquesForChapter,
  resolveEffectiveMount,
  resolveScopedItems,
  validatePacingLabel,
  type SettingFact,
} from "../../../domain/fanqie/index.ts";
import { anchor } from "../../../domain/shared/index.ts";
import { deleteLibraryFts, stmt, syncChapterFts, syncLibraryFts } from "../../../storage/index.ts";
import {
  count,
  invalid,
  optionalText,
  refuse,
  requiredRow,
  text,
  type DocumentRow,
  type Input,
  type WorkspaceContext,
} from "../../context.ts";
import { materializeApprovedLore } from "./lore.ts";
import { approvedFacts, assertFanqieProject } from "./shared.ts";

interface DeconstructRow {
  readonly id: string;
  readonly scope: LibraryScope;
  readonly projectId: string | null;
  readonly overrideOfId: string | null;
  readonly title: string;
  readonly sourceBook: string;
  readonly genre: string;
  readonly pacing: string;
  readonly tagsJson: string;
  readonly excerpt: string;
  readonly hookAnalysis: string;
  readonly conflictBeats: string;
  readonly payoffRhythm: string;
  readonly proseNotes: string;
  readonly status: LibraryStatus;
  readonly sourceKind: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface TechniqueRow {
  readonly id: string;
  readonly scope: LibraryScope;
  readonly projectId: string | null;
  readonly overrideOfId: string | null;
  readonly title: string;
  readonly category: string;
  readonly pacing: string;
  readonly sceneTagsJson: string;
  readonly triggerWhen: string;
  readonly executionSteps: string;
  readonly constraints: string;
  readonly antiPatterns: string;
  readonly exampleExcerpt: string;
  readonly priority: number;
  readonly status: LibraryStatus;
  readonly sourceKind: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function mapDeconstructRow(row: DeconstructRow): DeconstructionDto {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.projectId,
    overrideOfId: row.overrideOfId,
    title: row.title,
    sourceBook: row.sourceBook,
    genre: row.genre,
    pacing: row.pacing,
    tags: parseJsonStringArray(row.tagsJson),
    excerpt: row.excerpt,
    hookAnalysis: row.hookAnalysis,
    conflictBeats: row.conflictBeats,
    payoffRhythm: row.payoffRhythm,
    proseNotes: row.proseNotes,
    status: row.status,
    sourceKind: row.sourceKind,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapTechniqueRow(row: TechniqueRow): TechniqueCardDto {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.projectId,
    overrideOfId: row.overrideOfId,
    title: row.title,
    category: row.category,
    pacing: row.pacing,
    sceneTags: parseJsonStringArray(row.sceneTagsJson),
    triggerWhen: row.triggerWhen,
    executionSteps: row.executionSteps,
    constraints: row.constraints,
    antiPatterns: row.antiPatterns,
    exampleExcerpt: row.exampleExcerpt,
    priority: row.priority,
    status: row.status,
    sourceKind: row.sourceKind,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseScope(input: Input): { readonly scope: LibraryScope; readonly projectId: string | null } {
  const scope = input.scope === "project" ? "project" : "global";
  const projectId = optionalText(input, "projectId") ?? null;
  if (scope === "project" && !projectId) {
    invalid("projectId", "project-required-for-project-scope");
  }
  return { scope, projectId: scope === "project" ? projectId : null };
}

function persistDeconstruction(
  ctx: WorkspaceContext,
  input: Input,
  sourceKind: string,
): DeconstructionDto {
  const { scope, projectId } = parseScope(input);
  if (projectId) assertFanqieProject(ctx, projectId);
  const overrideOfId = optionalText(input, "overrideOfId") ?? null;
  if (overrideOfId && scope !== "project") {
    invalid("overrideOfId", "override-requires-project-scope");
  }

  const title = text(input, "title").trim();
  const excerpt = text(input, "excerpt");
  const sourceBook = typeof input.sourceBook === "string" ? input.sourceBook.trim() : "";
  const genre = typeof input.genre === "string" ? input.genre.trim() : "";
  const pacing = validatePacingLabel(input.pacing);
  const tags = normalizeTags(input.tags);
  const hookAnalysis = typeof input.hookAnalysis === "string" ? input.hookAnalysis.trim() : "";
  const conflictBeats = typeof input.conflictBeats === "string" ? input.conflictBeats.trim() : "";
  const payoffRhythm = typeof input.payoffRhythm === "string" ? input.payoffRhythm.trim() : "";
  const proseNotes = typeof input.proseNotes === "string" ? input.proseNotes.trim() : "";

  let id = optionalText(input, "id");
  if (!id && scope === "project" && overrideOfId && projectId) {
    const existingOverride = stmt(ctx.db, `
      SELECT id FROM library_deconstructions
      WHERE scope = 'project' AND project_id = ? AND override_of_id = ?;
    `).get(projectId, overrideOfId) as { id?: string } | undefined;
    if (existingOverride?.id) id = existingOverride.id;
  }
  id ??= randomUUID();

  const existing = stmt(ctx.db, "SELECT created_at AS createdAt FROM library_deconstructions WHERE id = ?;")
    .get(id) as { createdAt?: number } | undefined;
  const now = Date.now();
  const createdAt = existing?.createdAt ?? now;

  stmt(ctx.db, `
    INSERT INTO library_deconstructions (
      id, scope, project_id, override_of_id, title, source_book, genre, pacing, tags_json,
      excerpt, hook_analysis, conflict_beats, payoff_rhythm, prose_notes, status, source_kind,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      title = excluded.title,
      source_book = excluded.source_book,
      genre = excluded.genre,
      pacing = excluded.pacing,
      tags_json = excluded.tags_json,
      excerpt = excluded.excerpt,
      hook_analysis = excluded.hook_analysis,
      conflict_beats = excluded.conflict_beats,
      payoff_rhythm = excluded.payoff_rhythm,
      prose_notes = excluded.prose_notes,
      status = excluded.status,
      updated_at = excluded.updated_at;
  `).run(
    id,
    scope,
    projectId,
    overrideOfId,
    title,
    sourceBook,
    genre,
    pacing,
    JSON.stringify(tags),
    excerpt,
    hookAnalysis,
    conflictBeats,
    payoffRhythm,
    proseNotes,
    sourceKind,
    createdAt,
    now,
  );

  syncLibraryFts(ctx.db, {
    itemId: id,
    itemKind: "deconstruction",
    scope,
    projectId,
    title,
    body: [sourceBook, genre, tags.join(" "), hookAnalysis, conflictBeats, payoffRhythm, proseNotes, excerpt].join("\n"),
  });

  return {
    id,
    scope,
    projectId,
    overrideOfId,
    title,
    sourceBook,
    genre,
    pacing,
    tags,
    excerpt,
    hookAnalysis,
    conflictBeats,
    payoffRhythm,
    proseNotes,
    status: "approved",
    sourceKind,
    createdAt,
    updatedAt: now,
  };
}

function persistTechniqueCard(
  ctx: WorkspaceContext,
  input: Input,
  sourceKind: string,
): TechniqueCardDto {
  const { scope, projectId } = parseScope(input);
  if (projectId) assertFanqieProject(ctx, projectId);
  const overrideOfId = optionalText(input, "overrideOfId") ?? null;
  if (overrideOfId && scope !== "project") {
    invalid("overrideOfId", "override-requires-project-scope");
  }

  const title = text(input, "title").trim();
  const category = optionalText(input, "category") ?? "narrative";
  const pacing = validatePacingLabel(input.pacing);
  const sceneTags = normalizeTags(input.sceneTags ?? input.tags);
  const triggerWhen = typeof input.triggerWhen === "string" ? input.triggerWhen.trim() : "";
  const executionSteps = text(input, "executionSteps").trim();
  const constraints = typeof input.constraints === "string" ? input.constraints.trim() : "";
  const antiPatterns = typeof input.antiPatterns === "string" ? input.antiPatterns.trim() : "";
  const exampleExcerpt = typeof input.exampleExcerpt === "string" ? input.exampleExcerpt.trim() : "";
  const priority = input.priority !== undefined ? Math.min(100, count(input, "priority")) : 50;

  let id = optionalText(input, "id");
  if (!id && scope === "project" && overrideOfId && projectId) {
    const existingOverride = stmt(ctx.db, `
      SELECT id FROM library_technique_cards
      WHERE scope = 'project' AND project_id = ? AND override_of_id = ?;
    `).get(projectId, overrideOfId) as { id?: string } | undefined;
    if (existingOverride?.id) id = existingOverride.id;
  }
  id ??= randomUUID();

  const existing = stmt(ctx.db, "SELECT created_at AS createdAt FROM library_technique_cards WHERE id = ?;")
    .get(id) as { createdAt?: number } | undefined;
  const now = Date.now();
  const createdAt = existing?.createdAt ?? now;

  stmt(ctx.db, `
    INSERT INTO library_technique_cards (
      id, scope, project_id, override_of_id, title, category, pacing, scene_tags_json,
      trigger_when, execution_steps, constraints, anti_patterns, example_excerpt,
      priority, status, source_kind, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      title = excluded.title,
      category = excluded.category,
      pacing = excluded.pacing,
      scene_tags_json = excluded.scene_tags_json,
      trigger_when = excluded.trigger_when,
      execution_steps = excluded.execution_steps,
      constraints = excluded.constraints,
      anti_patterns = excluded.anti_patterns,
      example_excerpt = excluded.example_excerpt,
      priority = excluded.priority,
      status = excluded.status,
      updated_at = excluded.updated_at;
  `).run(
    id,
    scope,
    projectId,
    overrideOfId,
    title,
    category,
    pacing,
    JSON.stringify(sceneTags),
    triggerWhen,
    executionSteps,
    constraints,
    antiPatterns,
    exampleExcerpt,
    priority,
    sourceKind,
    createdAt,
    now,
  );

  syncLibraryFts(ctx.db, {
    itemId: id,
    itemKind: "technique",
    scope,
    projectId,
    title,
    body: [category, sceneTags.join(" "), triggerWhen, executionSteps, constraints, antiPatterns, exampleExcerpt].join("\n"),
  });

  return {
    id,
    scope,
    projectId,
    overrideOfId,
    title,
    category,
    pacing,
    sceneTags,
    triggerWhen,
    executionSteps,
    constraints,
    antiPatterns,
    exampleExcerpt,
    priority,
    status: "approved",
    sourceKind,
    createdAt,
    updatedAt: now,
  };
}

export function saveDeconstruction(ctx: WorkspaceContext, input: Input): DeconstructionDto {
  return ctx.atomic(() => persistDeconstruction(ctx, input, "manual"));
}

export function queryDeconstructions(
  ctx: WorkspaceContext,
  options: { readonly projectId: string | null; readonly scopeFilter?: string; readonly includeOverridden?: boolean },
): DeconstructionDto[] {
  const scopeFilter = options.scopeFilter ?? "all";
  const sql =
    scopeFilter === "global"
      ? `SELECT id, scope, project_id AS projectId, override_of_id AS overrideOfId, title,
           source_book AS sourceBook, genre, pacing, tags_json AS tagsJson, excerpt,
           hook_analysis AS hookAnalysis, conflict_beats AS conflictBeats, payoff_rhythm AS payoffRhythm,
           prose_notes AS proseNotes, status, source_kind AS sourceKind, created_at AS createdAt, updated_at AS updatedAt
         FROM library_deconstructions WHERE scope = 'global' AND status = 'approved' ORDER BY updated_at DESC;`
      : scopeFilter === "project" && options.projectId
        ? `SELECT id, scope, project_id AS projectId, override_of_id AS overrideOfId, title,
             source_book AS sourceBook, genre, pacing, tags_json AS tagsJson, excerpt,
             hook_analysis AS hookAnalysis, conflict_beats AS conflictBeats, payoff_rhythm AS payoffRhythm,
             prose_notes AS proseNotes, status, source_kind AS sourceKind, created_at AS createdAt, updated_at AS updatedAt
           FROM library_deconstructions WHERE scope = 'project' AND project_id = ? AND status = 'approved' ORDER BY updated_at DESC;`
        : `SELECT id, scope, project_id AS projectId, override_of_id AS overrideOfId, title,
             source_book AS sourceBook, genre, pacing, tags_json AS tagsJson, excerpt,
             hook_analysis AS hookAnalysis, conflict_beats AS conflictBeats, payoff_rhythm AS payoffRhythm,
             prose_notes AS proseNotes, status, source_kind AS sourceKind, created_at AS createdAt, updated_at AS updatedAt
           FROM library_deconstructions
           WHERE status = 'approved' AND (scope = 'global' OR project_id = ?)
           ORDER BY updated_at DESC;`;
  const rows = (
    scopeFilter === "global"
      ? stmt(ctx.db, sql).all()
      : stmt(ctx.db, sql).all(options.projectId ?? "")
  ) as DeconstructRow[];
  const mapped = rows.map(mapDeconstructRow);
  return options.projectId && !options.includeOverridden ? resolveScopedItems(mapped) : mapped;
}

export function listDeconstructions(ctx: WorkspaceContext, input: Input): DeconstructionDto[] {
  const projectId = optionalText(input, "projectId") ?? null;
  const scopeFilter = typeof input.scope === "string" ? input.scope : "all";
  const includeOverridden = input.includeOverridden === true;
  if (projectId) assertFanqieProject(ctx, projectId);
  return ctx.read(() => queryDeconstructions(ctx, { projectId, scopeFilter, includeOverridden }));
}

export function deleteDeconstruction(ctx: WorkspaceContext, input: Input) {
  const id = text(input, "id");
  return ctx.atomic(() => {
    const res = stmt(ctx.db, "DELETE FROM library_deconstructions WHERE id = ?;").run(id);
    if (!res.changes) requiredRow(null, "deconstruction", id);
    stmt(ctx.db, "DELETE FROM author_library_mounts WHERE item_kind = 'deconstruction' AND item_id = ?;").run(id);
    deleteLibraryFts(ctx.db, id, "deconstruction");
    return { deleted: id };
  });
}

export function saveTechnique(ctx: WorkspaceContext, input: Input): TechniqueCardDto {
  return ctx.atomic(() => persistTechniqueCard(ctx, input, "manual"));
}

export function queryTechniques(
  ctx: WorkspaceContext,
  options: { readonly projectId: string | null; readonly scopeFilter?: string; readonly includeOverridden?: boolean },
): TechniqueCardDto[] {
  const scopeFilter = options.scopeFilter ?? "all";
  const sql =
    scopeFilter === "global"
      ? `SELECT id, scope, project_id AS projectId, override_of_id AS overrideOfId, title,
           category, pacing, scene_tags_json AS sceneTagsJson, trigger_when AS triggerWhen,
           execution_steps AS executionSteps, constraints, anti_patterns AS antiPatterns,
           example_excerpt AS exampleExcerpt, priority, status, source_kind AS sourceKind,
           created_at AS createdAt, updated_at AS updatedAt
         FROM library_technique_cards WHERE scope = 'global' AND status = 'approved'
         ORDER BY priority DESC, updated_at DESC;`
      : scopeFilter === "project" && options.projectId
        ? `SELECT id, scope, project_id AS projectId, override_of_id AS overrideOfId, title,
             category, pacing, scene_tags_json AS sceneTagsJson, trigger_when AS triggerWhen,
             execution_steps AS executionSteps, constraints, anti_patterns AS antiPatterns,
             example_excerpt AS exampleExcerpt, priority, status, source_kind AS sourceKind,
             created_at AS createdAt, updated_at AS updatedAt
           FROM library_technique_cards WHERE scope = 'project' AND project_id = ? AND status = 'approved'
           ORDER BY priority DESC, updated_at DESC;`
        : `SELECT id, scope, project_id AS projectId, override_of_id AS overrideOfId, title,
             category, pacing, scene_tags_json AS sceneTagsJson, trigger_when AS triggerWhen,
             execution_steps AS executionSteps, constraints, anti_patterns AS antiPatterns,
             example_excerpt AS exampleExcerpt, priority, status, source_kind AS sourceKind,
             created_at AS createdAt, updated_at AS updatedAt
           FROM library_technique_cards
           WHERE status = 'approved' AND (scope = 'global' OR project_id = ?)
           ORDER BY priority DESC, updated_at DESC;`;
  const rows = (
    scopeFilter === "global"
      ? stmt(ctx.db, sql).all()
      : stmt(ctx.db, sql).all(options.projectId ?? "")
  ) as TechniqueRow[];
  const mapped = rows.map(mapTechniqueRow);
  return options.projectId && !options.includeOverridden ? resolveScopedItems(mapped) : mapped;
}

export function listTechniques(ctx: WorkspaceContext, input: Input): TechniqueCardDto[] {
  const projectId = optionalText(input, "projectId") ?? null;
  const scopeFilter = typeof input.scope === "string" ? input.scope : "all";
  const includeOverridden = input.includeOverridden === true;
  if (projectId) assertFanqieProject(ctx, projectId);
  return ctx.read(() => queryTechniques(ctx, { projectId, scopeFilter, includeOverridden }));
}

export function deleteTechnique(ctx: WorkspaceContext, input: Input) {
  const id = text(input, "id");
  return ctx.atomic(() => {
    const res = stmt(ctx.db, "DELETE FROM library_technique_cards WHERE id = ?;").run(id);
    if (!res.changes) requiredRow(null, "technique", id);
    stmt(ctx.db, "DELETE FROM author_library_mounts WHERE item_kind = 'technique' AND item_id = ?;").run(id);
    deleteLibraryFts(ctx.db, id, "technique");
    return { deleted: id };
  });
}

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
  return {
    projectId,
    targetType: targetType as LibraryMountTarget,
    targetId,
    itemKind,
    itemId,
  };
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
        mode = excluded.mode,
        weight = excluded.weight,
        note = excluded.note;
    `).run(id, projectId, targetType, targetId, itemKind, itemId, mode, weight, note);
    const saved = stmt(ctx.db, `
      SELECT id, project_id AS projectId, target_type AS targetType, target_id AS targetId,
        item_kind AS itemKind, item_id AS itemId, mode, weight, note
      FROM author_library_mounts
      WHERE project_id = ? AND target_type = ? AND target_id = ? AND item_kind = ? AND item_id = ?;
    `).get(projectId, targetType, targetId, itemKind, itemId) as LibraryMountDto;
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
): TechniqueRecommendationDto[] {
  const cards = queryTechniques(ctx, { projectId: row.projectId });
  const mounts = queryLibraryMounts(ctx, row.projectId);
  const order = ctx.chapterOrder(row.projectId);
  const plan = ctx.planning(row.id);
  const outlineText = [
    row.title,
    row.summary,
    instruction,
    plan ? JSON.stringify(plan) : "",
  ].join("\n");
  const ranked = rankTechniquesForChapter({
    cards,
    mounts,
    contextIds: {
      projectId: row.projectId,
      volumeId: row.volumeId,
      actId: row.actId,
      chapterId: row.id,
    },
    pacing,
    outlineText,
    chapterIndex: Math.max(0, order.indexOf(row.id)),
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
  return ctx.read(() => queryTechniqueRecommendations(ctx, row, pacing, instruction));
}

export function resolveMountedLibraryForChapter(
  ctx: WorkspaceContext,
  row: DocumentRow,
  instruction = "",
  pacing = "",
): {
  readonly techniques: TechniqueCardDto[];
  readonly deconstructions: DeconstructionDto[];
} {
  const mounts = queryLibraryMounts(ctx, row.projectId);
  const contextIds = {
    projectId: row.projectId,
    volumeId: row.volumeId,
    actId: row.actId,
    chapterId: row.id,
  };

  const allTechniques = queryTechniques(ctx, { projectId: row.projectId });
  const explicitTechs = allTechniques.filter((card) => {
    const mount = resolveEffectiveMount(mounts, "technique", card.id, contextIds);
    return mount !== null && mount.mode !== "exclude";
  });
  const recommended = queryTechniqueRecommendations(ctx, row, pacing, instruction)
    .filter((entry) => entry.mountedMode === null && entry.score >= 85)
    .slice(0, 2)
    .map((entry) => entry.card);
  const techniques = [
    ...explicitTechs,
    ...recommended.filter((card) => !explicitTechs.some((item) => item.id === card.id)),
  ];

  const allDeconstructs = queryDeconstructions(ctx, { projectId: row.projectId });
  const deconstructions = allDeconstructs.filter((sample) => {
    const mount = resolveEffectiveMount(mounts, "deconstruction", sample.id, contextIds);
    return mount !== null && mount.mode !== "exclude";
  });

  return { techniques, deconstructions };
}

function parseProposalKind(raw: unknown): AiProposalKind {
  if (raw === "deconstruct" || raw === "technique" || raw === "setting" || raw === "summary") {
    return raw;
  }
  invalid("kind", "unknown-proposal-kind");
}

function mapProposalRow(row: {
  id: string;
  projectId: string | null;
  documentId: string | null;
  kind: AiProposalKind;
  status: "pending" | "approved" | "rejected" | "failed";
  sourceRef: string;
  payload: string;
  provider: string | null;
  model: string | null;
  reserved: number;
  settled: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}): AiProposalDto {
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
    `).all(...params) as Parameters<typeof mapProposalRow>[0][];
    return rows.map(mapProposalRow);
  });
}

export function decideProposal(ctx: WorkspaceContext, input: Input) {
  const proposalId = text(input, "proposalId");
  if (typeof input.accept !== "boolean") invalid("accept");

  return ctx.atomic(() => {
    const row = requiredRow<Parameters<typeof mapProposalRow>[0]>(
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
      return { id: proposalId, status: "rejected" as const };
    }

    const basePayload = mapProposalRow(row).payload;
    const edited =
      input.editedPayload && typeof input.editedPayload === "object" && !Array.isArray(input.editedPayload)
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
      const order = ctx.chapterOrder(projectId);
      const fallbackChapterId = row.documentId ?? order[0];
      if (!fallbackChapterId) invalid("documentId", "chapter-required");

      const settingsList = Array.isArray(edited.settings) ? (edited.settings as Input[]) : [];
      const foreshadowList = Array.isArray(edited.foreshadows) ? (edited.foreshadows as Input[]) : [];
      const lockedSet = new Set(approvedFacts(ctx, projectId).filter((f) => f.locked).map((f) => f.id));

      const approvedIds: string[] = [];
      for (const item of settingsList) {
        const factId = text(item, "factId").trim();
        if (lockedSet.has(factId)) refuse("proposal.decide", "setting-is-locked");
        const point = item.point !== undefined && Number.isSafeInteger(item.point) && Number(item.point) >= 1
          ? Number(item.point)
          : 1;
        const from = anchor(fallbackChapterId, point);
        const category = normalizeLoreCategory(item.category, "fact");
        const entityName = typeof item.entityName === "string" ? item.entityName.trim() : "";
        const knownFrom: Record<string, { chapterId: string; point: number }> = {};
        if (Array.isArray(item.people)) {
          for (const p of item.people) {
            if (typeof p === "string" && p.trim()) knownFrom[p.trim()] = from;
            else if (p && typeof p === "object" && typeof (p as Input).character === "string") {
              knownFrom[((p as Input).character as string).trim()] = from;
            }
          }
        } else if (entityName && category === "character") {
          knownFrom[entityName] = from;
        }
        const fact: SettingFact = {
          id: factId,
          note: text(item, "note"),
          source: typeof item.source === "string" && item.source.trim() ? item.source.trim() : "AI章末提取（作者确认）",
          kind: category === "agreement" ? "agreement" : "fact",
          locked: item.locked === true,
          effectiveFrom: from,
          knownFrom,
        };
        const settingId = randomUUID();
        stmt(ctx.db, `
          INSERT INTO author_settings (id, project_id, fact_id, category, entity_name, value, decision)
          VALUES (?, ?, ?, ?, ?, ?, 'approved');
        `).run(settingId, projectId, factId, category, entityName, JSON.stringify(fact));
        const decidedSeq = ctx.event(projectId, "setting", "setting.decided", {
          id: settingId,
          factId,
          decision: "approved",
          fact,
        });
        stmt(ctx.db, "UPDATE author_settings SET decided_seq = ? WHERE id = ?;").run(decidedSeq, settingId);
        materializeApprovedLore(ctx, {
          projectId,
          settingId,
          factId,
          category,
          entityName,
          fact,
          decidedSeq,
        });
        approvedIds.push(settingId);
      }

      const foreshadowIds: string[] = [];
      for (const fs of foreshadowList) {
        const fsTitle = text(fs, "title").trim();
        const fsId = randomUUID();
        const fsFactId = typeof fs.factId === "string" && fs.factId.trim() ? fs.factId.trim() : null;
        const fsNote = typeof fs.note === "string" ? fs.note.trim() : "";
        const fsStatus = fs.status === "hinted" || fs.status === "resolved" ? fs.status : "planted";
        stmt(ctx.db, `
          INSERT INTO author_foreshadows (
            id, project_id, fact_id, title, planted_chapter_id, planted_point,
            resolved_chapter_id, status, note, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?);
        `).run(
          fsId,
          projectId,
          fsFactId,
          fsTitle,
          fallbackChapterId,
          fsStatus === "resolved" ? fallbackChapterId : null,
          fsStatus,
          fsNote,
          now,
        );
        ctx.event(projectId, "setting", "foreshadow.updated", { id: fsId, status: fsStatus });
        foreshadowIds.push(fsId);
      }
      committed = { approvedSettings: approvedIds, foreshadows: foreshadowIds };
    }

    stmt(ctx.db, "UPDATE author_ai_proposals SET status = 'approved', payload = ?, updated_at = ? WHERE id = ?;")
      .run(JSON.stringify(edited), now, proposalId);
    return { id: proposalId, status: "approved" as const, committed };
  });
}
