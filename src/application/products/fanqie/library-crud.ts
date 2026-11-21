import { randomUUID } from "node:crypto";
import type {
  DeconstructionDto,
  LibraryAssetKind,
  LibraryScope,
  LibraryStatus,
  SkillReferenceDocDto,
  TechniqueCardDto,
  WritingStageBinding,
} from "../../../contracts/workspace-dto.ts";
import {
  normalizeStageBindings,
  normalizeTags,
  validatePacingLabel,
} from "../../../domain/fanqie/index.ts";
import { deleteLibraryFts, stmt, syncLibraryFts } from "../../../storage/index.ts";
import { count, invalid, optionalText, requiredRow, text, type Input, type WorkspaceContext } from "../../context.ts";
import { assertFanqieProject, assertLibraryWriteScope } from "./shared.ts";

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
  readonly assetKind: LibraryAssetKind;
  readonly stageBindingsJson: string;
  readonly referencesJson: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const DECONSTRUCT_COLS = `id, scope, project_id AS projectId, override_of_id AS overrideOfId, title,
  source_book AS sourceBook, genre, pacing, tags_json AS tagsJson, excerpt,
  hook_analysis AS hookAnalysis, conflict_beats AS conflictBeats, payoff_rhythm AS payoffRhythm,
  prose_notes AS proseNotes, status, source_kind AS sourceKind, created_at AS createdAt, updated_at AS updatedAt`;

const TECHNIQUE_COLS = `id, scope, project_id AS projectId, override_of_id AS overrideOfId, title,
  category, pacing, scene_tags_json AS sceneTagsJson, trigger_when AS triggerWhen,
  execution_steps AS executionSteps, constraints, anti_patterns AS antiPatterns,
  example_excerpt AS exampleExcerpt, priority, status, source_kind AS sourceKind,
  asset_kind AS assetKind, stage_bindings_json AS stageBindingsJson, references_json AS referencesJson,
  created_at AS createdAt, updated_at AS updatedAt`;

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function parseReferencesJson(raw: string): SkillReferenceDocDto[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is SkillReferenceDocDto => Boolean(entry && typeof entry === "object" && typeof (entry as SkillReferenceDocDto).path === "string" && typeof (entry as SkillReferenceDocDto).content === "string"));
  } catch {
    return [];
  }
}

function normalizeReferencesInput(raw: unknown): SkillReferenceDocDto[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is { path: unknown; content: unknown } => Boolean(entry && typeof entry === "object"))
    .filter((entry) => typeof entry.path === "string" && typeof entry.content === "string")
    .map((entry) => ({ path: (entry.path as string).trim(), content: entry.content as string }))
    .filter((entry) => entry.path.length > 0);
}

function mapDeconstructRow(row: DeconstructRow): DeconstructionDto {
  return { ...row, tags: parseJsonStringArray(row.tagsJson) };
}

function mapTechniqueRow(row: TechniqueRow): TechniqueCardDto {
  return {
    ...row,
    sceneTags: parseJsonStringArray(row.sceneTagsJson),
    assetKind: row.assetKind === "skill" ? "skill" : "technique",
    stageBindings: parseJsonStringArray(row.stageBindingsJson) as WritingStageBinding[],
    references: parseReferencesJson(row.referencesJson),
  };
}

function parseScope(input: Input): { readonly scope: LibraryScope; readonly projectId: string | null } {
  const scope = input.scope === "project" ? "project" : "global";
  const projectId = optionalText(input, "projectId") ?? null;
  if (scope === "project" && !projectId) invalid("projectId", "project-required-for-project-scope");
  return { scope, projectId: scope === "project" ? projectId : null };
}

export function persistDeconstruction(
  ctx: WorkspaceContext,
  input: Input,
  sourceKind: string,
): DeconstructionDto {
  const { scope, projectId } = parseScope(input);
  if (projectId) assertFanqieProject(ctx, projectId);
  const overrideOfId = optionalText(input, "overrideOfId") ?? null;
  if (overrideOfId && scope !== "project") invalid("overrideOfId", "override-requires-project-scope");

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
      SELECT id FROM library_deconstructions WHERE scope = 'project' AND project_id = ? AND override_of_id = ?;
    `).get(projectId, overrideOfId) as { id?: string } | undefined;
    if (existingOverride?.id) id = existingOverride.id;
  }
  id ??= randomUUID();
  const now = Date.now();
  const createdAt = assertLibraryWriteScope(ctx, "library_deconstructions", id, scope, projectId) ?? now;

  stmt(ctx.db, `
    INSERT INTO library_deconstructions (
      id, scope, project_id, override_of_id, title, source_book, genre, pacing, tags_json,
      excerpt, hook_analysis, conflict_beats, payoff_rhythm, prose_notes, status, source_kind, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      title = excluded.title, source_book = excluded.source_book, genre = excluded.genre, pacing = excluded.pacing,
      tags_json = excluded.tags_json, excerpt = excluded.excerpt, hook_analysis = excluded.hook_analysis,
      conflict_beats = excluded.conflict_beats, payoff_rhythm = excluded.payoff_rhythm,
      prose_notes = excluded.prose_notes, status = excluded.status, updated_at = excluded.updated_at;
  `).run(id, scope, projectId, overrideOfId, title, sourceBook, genre, pacing, JSON.stringify(tags),
    excerpt, hookAnalysis, conflictBeats, payoffRhythm, proseNotes, sourceKind, createdAt, now);

  syncLibraryFts(ctx.db, {
    itemId: id, itemKind: "deconstruction", scope, projectId, title,
    body: [sourceBook, genre, tags.join(" "), hookAnalysis, conflictBeats, payoffRhythm, proseNotes, excerpt].join("\n"),
  });
  if (projectId) ctx.event(projectId, "setting", "library.deconstruction.saved", { id, scope });

  return {
    id, scope, projectId, overrideOfId, title, sourceBook, genre, pacing, tags, excerpt,
    hookAnalysis, conflictBeats, payoffRhythm, proseNotes, status: "approved", sourceKind, createdAt, updatedAt: now,
  };
}

export function persistTechniqueCard(
  ctx: WorkspaceContext,
  input: Input,
  sourceKind: string,
): TechniqueCardDto {
  const { scope, projectId } = parseScope(input);
  if (projectId) assertFanqieProject(ctx, projectId);
  const overrideOfId = optionalText(input, "overrideOfId") ?? null;
  if (overrideOfId && scope !== "project") invalid("overrideOfId", "override-requires-project-scope");

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
  const assetKind: LibraryAssetKind = input.assetKind === "skill" ? "skill" : "technique";
  const stageBindings = normalizeStageBindings(input.stageBindings);
  const references = normalizeReferencesInput(input.references);

  let id = optionalText(input, "id");
  if (!id && scope === "project" && overrideOfId && projectId) {
    const existingOverride = stmt(ctx.db, `
      SELECT id FROM library_technique_cards WHERE scope = 'project' AND project_id = ? AND override_of_id = ?;
    `).get(projectId, overrideOfId) as { id?: string } | undefined;
    if (existingOverride?.id) id = existingOverride.id;
  }
  id ??= randomUUID();
  const now = Date.now();
  const createdAt = assertLibraryWriteScope(ctx, "library_technique_cards", id, scope, projectId) ?? now;

  stmt(ctx.db, `
    INSERT INTO library_technique_cards (
      id, scope, project_id, override_of_id, title, category, pacing, scene_tags_json,
      trigger_when, execution_steps, constraints, anti_patterns, example_excerpt,
      priority, status, source_kind, asset_kind, stage_bindings_json, references_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      title = excluded.title, category = excluded.category, pacing = excluded.pacing,
      scene_tags_json = excluded.scene_tags_json, trigger_when = excluded.trigger_when,
      execution_steps = excluded.execution_steps, constraints = excluded.constraints,
      anti_patterns = excluded.anti_patterns, example_excerpt = excluded.example_excerpt,
      priority = excluded.priority, status = excluded.status, asset_kind = excluded.asset_kind,
      stage_bindings_json = excluded.stage_bindings_json, references_json = excluded.references_json,
      updated_at = excluded.updated_at;
  `).run(
    id, scope, projectId, overrideOfId, title, category, pacing, JSON.stringify(sceneTags),
    triggerWhen, executionSteps, constraints, antiPatterns, exampleExcerpt, priority,
    sourceKind, assetKind, JSON.stringify(stageBindings), JSON.stringify(references), createdAt, now,
  );

  syncLibraryFts(ctx.db, {
    itemId: id, itemKind: "technique", scope, projectId, title,
    body: [category, sceneTags.join(" "), triggerWhen, executionSteps, constraints, antiPatterns, exampleExcerpt, ...references.map((r) => r.content)].join("\n"),
  });
  if (projectId) ctx.event(projectId, "setting", "library.technique.saved", { id, scope, assetKind });

  return {
    id, scope, projectId, overrideOfId, title, category, pacing, sceneTags, triggerWhen,
    executionSteps, constraints, antiPatterns, exampleExcerpt, priority, status: "approved",
    sourceKind, assetKind, stageBindings, references, createdAt, updatedAt: now,
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
  const rows = (scopeFilter === "global"
    ? stmt(ctx.db, `SELECT ${DECONSTRUCT_COLS} FROM library_deconstructions WHERE scope = 'global' AND status = 'approved' ORDER BY updated_at DESC;`).all()
    : scopeFilter === "project" && options.projectId
      ? stmt(ctx.db, `SELECT ${DECONSTRUCT_COLS} FROM library_deconstructions WHERE scope = 'project' AND project_id = ? AND status = 'approved' ORDER BY updated_at DESC;`).all(options.projectId)
      : stmt(ctx.db, `SELECT ${DECONSTRUCT_COLS} FROM library_deconstructions WHERE status = 'approved' AND (scope = 'global' OR project_id = ?) ORDER BY updated_at DESC;`).all(options.projectId ?? "")
  ) as DeconstructRow[];
  const mapped = rows.map(mapDeconstructRow);
  if (!options.projectId || options.includeOverridden) return mapped;
  const overridden = new Set(mapped.map((item) => item.overrideOfId).filter((id): id is string => Boolean(id)));
  return mapped.filter((item) => !overridden.has(item.id));
}

export function listDeconstructions(ctx: WorkspaceContext, input: Input): DeconstructionDto[] {
  const projectId = optionalText(input, "projectId") ?? null;
  if (projectId) assertFanqieProject(ctx, projectId);
  return ctx.read(() => queryDeconstructions(ctx, {
    projectId,
    scopeFilter: typeof input.scope === "string" ? input.scope : "all",
    includeOverridden: input.includeOverridden === true,
  }));
}

export function deleteDeconstruction(ctx: WorkspaceContext, input: Input) {
  const id = text(input, "id");
  return ctx.atomic(() => {
    const existing = requiredRow<{ projectId: string | null }>(
      stmt(ctx.db, "SELECT project_id AS projectId FROM library_deconstructions WHERE id = ?;").get(id),
      "deconstruction",
      id,
    );
    stmt(ctx.db, "DELETE FROM library_deconstructions WHERE id = ?;").run(id);
    stmt(ctx.db, "DELETE FROM author_library_mounts WHERE item_kind = 'deconstruction' AND item_id = ?;").run(id);
    deleteLibraryFts(ctx.db, id, "deconstruction");
    if (existing.projectId) ctx.event(existing.projectId, "setting", "library.deconstruction.deleted", { id });
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
  const rows = (scopeFilter === "global"
    ? stmt(ctx.db, `SELECT ${TECHNIQUE_COLS} FROM library_technique_cards WHERE scope = 'global' AND status = 'approved' ORDER BY priority DESC, updated_at DESC;`).all()
    : scopeFilter === "project" && options.projectId
      ? stmt(ctx.db, `SELECT ${TECHNIQUE_COLS} FROM library_technique_cards WHERE scope = 'project' AND project_id = ? AND status = 'approved' ORDER BY priority DESC, updated_at DESC;`).all(options.projectId)
      : stmt(ctx.db, `SELECT ${TECHNIQUE_COLS} FROM library_technique_cards WHERE status = 'approved' AND (scope = 'global' OR project_id = ?) ORDER BY priority DESC, updated_at DESC;`).all(options.projectId ?? "")
  ) as TechniqueRow[];
  const mapped = rows.map(mapTechniqueRow);
  if (!options.projectId || options.includeOverridden) return mapped;
  const overridden = new Set(mapped.map((item) => item.overrideOfId).filter((id): id is string => Boolean(id)));
  return mapped.filter((item) => !overridden.has(item.id));
}

export function listTechniques(ctx: WorkspaceContext, input: Input): TechniqueCardDto[] {
  const projectId = optionalText(input, "projectId") ?? null;
  if (projectId) assertFanqieProject(ctx, projectId);
  return ctx.read(() => queryTechniques(ctx, {
    projectId,
    scopeFilter: typeof input.scope === "string" ? input.scope : "all",
    includeOverridden: input.includeOverridden === true,
  }));
}

export function deleteTechnique(ctx: WorkspaceContext, input: Input) {
  const id = text(input, "id");
  return ctx.atomic(() => {
    const existing = requiredRow<{ projectId: string | null }>(
      stmt(ctx.db, "SELECT project_id AS projectId FROM library_technique_cards WHERE id = ?;").get(id),
      "technique",
      id,
    );
    stmt(ctx.db, "DELETE FROM library_technique_cards WHERE id = ?;").run(id);
    stmt(ctx.db, "DELETE FROM author_library_mounts WHERE item_kind = 'technique' AND item_id = ?;").run(id);
    deleteLibraryFts(ctx.db, id, "technique");
    if (existing.projectId) ctx.event(existing.projectId, "setting", "library.technique.deleted", { id });
    return { deleted: id };
  });
}
