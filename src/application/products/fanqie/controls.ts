import { randomUUID } from "node:crypto";
import type { ProjectControlsDto } from "../../../contracts/workspace-dto.ts";
import {
  DEFAULT_CONTEXT_TUNING,
  isDefaultContextTuning,
  normalizeContextTuning,
} from "../../../domain/fanqie/index.ts";
import { stmt } from "../../../storage/index.ts";
import { invalid, optionalText, text, type Input, type WorkspaceContext } from "../../context.ts";
import { markBookPrefixDirty } from "./cache-snapshot.ts";
import { assertFanqieProject } from "./shared.ts";

interface RawProjectControlsRow {
  readonly projectId: string;
  readonly authorIntent: string;
  readonly currentFocus: string;
  readonly pacingTier: string;
  readonly genreTagsJson: string;
  readonly agentToolsEnabled: number;
  readonly dailyTarget: number;
  readonly staleForeshadowGap: number;
  readonly tokenCalibrationJson: string;
  readonly contextConfigJson: string;
  readonly updatedAt: number;
}

function safeParseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
      : [];
  } catch {
    return [];
  }
}

function safeParseRecord(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadProjectControls(ctx: WorkspaceContext, projectId: string): ProjectControlsDto {
  const row = stmt(ctx.db, `
    SELECT project_id AS projectId,
      author_intent AS authorIntent,
      current_focus AS currentFocus,
      pacing_tier AS pacingTier,
      genre_tags_json AS genreTagsJson,
      agent_tools_enabled AS agentToolsEnabled,
      daily_target AS dailyTarget,
      stale_foreshadow_gap AS staleForeshadowGap,
      token_calibration_json AS tokenCalibrationJson,
      context_config_json AS contextConfigJson,
      updated_at AS updatedAt
    FROM author_project_controls
    WHERE project_id = ?;
  `).get(projectId) as RawProjectControlsRow | undefined;

  if (!row) {
    return {
      projectId,
      authorIntent: "",
      currentFocus: "",
      pacingTier: "",
      genreTags: [],
      agentToolsEnabled: false,
      dailyTarget: 0,
      staleForeshadowGap: DEFAULT_CONTEXT_TUNING.staleForeshadowGap,
      tokenCalibration: {},
      contextTuning: DEFAULT_CONTEXT_TUNING,
      isDefaultContextTuning: true,
      updatedAt: 0,
    };
  }

  const parsedContext = normalizeContextTuning(row.contextConfigJson);
  // Keep top-level stale_foreshadow_gap aligned with contextTuning if only column was modified
  const staleGap = row.staleForeshadowGap > 0 ? row.staleForeshadowGap : parsedContext.staleForeshadowGap;
  const contextTuning = parsedContext.staleForeshadowGap === DEFAULT_CONTEXT_TUNING.staleForeshadowGap && staleGap !== DEFAULT_CONTEXT_TUNING.staleForeshadowGap
    ? normalizeContextTuning({ ...parsedContext, staleForeshadowGap: staleGap })
    : parsedContext;

  return {
    projectId: row.projectId,
    authorIntent: row.authorIntent,
    currentFocus: row.currentFocus,
    pacingTier: row.pacingTier,
    genreTags: safeParseStringArray(row.genreTagsJson),
    agentToolsEnabled: Boolean(row.agentToolsEnabled),
    dailyTarget: row.dailyTarget,
    staleForeshadowGap: contextTuning.staleForeshadowGap,
    tokenCalibration: safeParseRecord(row.tokenCalibrationJson),
    contextTuning,
    isDefaultContextTuning: isDefaultContextTuning(contextTuning),
    updatedAt: row.updatedAt,
  };
}

export function getProjectControls(ctx: WorkspaceContext, input: Input): ProjectControlsDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  return ctx.read(() => loadProjectControls(ctx, projectId));
}

export function saveProjectControls(ctx: WorkspaceContext, input: Input): ProjectControlsDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  return ctx.atomic(() => {
    const existing = loadProjectControls(ctx, projectId);
    const prevTuning = normalizeContextTuning(existing.contextTuning);

    const authorIntent = typeof input.authorIntent === "string"
      ? input.authorIntent.trim()
      : existing.authorIntent;
    const currentFocus = typeof input.currentFocus === "string"
      ? input.currentFocus.trim()
      : existing.currentFocus;
    const pacingTier = typeof input.pacingTier === "string"
      ? input.pacingTier.trim()
      : (existing.pacingTier ?? "");
    const genreTags = Array.isArray(input.genreTags)
      ? input.genreTags
          .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
          .map((t) => t.trim())
          .slice(0, 12)
      : (existing.genreTags ?? []);
    const agentToolsEnabled = typeof input.agentToolsEnabled === "boolean"
      ? input.agentToolsEnabled
      : Boolean(existing.agentToolsEnabled);
    const dailyTarget = typeof input.dailyTarget === "number" && Number.isFinite(input.dailyTarget) && input.dailyTarget >= 0
      ? Math.round(input.dailyTarget)
      : (existing.dailyTarget ?? 0);

    const rawContextPatch: Record<string, unknown> =
      input.contextTuning && typeof input.contextTuning === "object" && !Array.isArray(input.contextTuning)
        ? { ...(input.contextTuning as Record<string, unknown>) }
        : {};
    if (typeof input.staleForeshadowGap === "number" && Number.isFinite(input.staleForeshadowGap) && rawContextPatch.staleForeshadowGap === undefined) {
      rawContextPatch.staleForeshadowGap = input.staleForeshadowGap;
    }
    const nextTuning = normalizeContextTuning(rawContextPatch, prevTuning);
    const isDefault = isDefaultContextTuning(nextTuning);
    const contextConfigJson = isDefault ? "{}" : JSON.stringify(nextTuning);
    const updatedAt = Date.now();

    stmt(ctx.db, `
      INSERT INTO author_project_controls (
        project_id, author_intent, current_focus, pacing_tier, genre_tags_json,
        agent_tools_enabled, daily_target, stale_foreshadow_gap, context_config_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id) DO UPDATE SET
        author_intent = excluded.author_intent,
        current_focus = excluded.current_focus,
        pacing_tier = excluded.pacing_tier,
        genre_tags_json = excluded.genre_tags_json,
        agent_tools_enabled = excluded.agent_tools_enabled,
        daily_target = excluded.daily_target,
        stale_foreshadow_gap = excluded.stale_foreshadow_gap,
        context_config_json = excluded.context_config_json,
        updated_at = excluded.updated_at;
    `).run(
      projectId,
      authorIntent,
      currentFocus,
      pacingTier,
      JSON.stringify(genreTags),
      agentToolsEnabled ? 1 : 0,
      dailyTarget,
      nextTuning.staleForeshadowGap,
      contextConfigJson,
      updatedAt,
    );

    ctx.event(projectId, "chapter", "controls.saved", { projectId });
    if (authorIntent !== existing.authorIntent || nextTuning.l1BudgetTokens !== prevTuning.l1BudgetTokens) {
      markBookPrefixDirty(ctx, projectId);
    }

    return {
      projectId,
      authorIntent,
      currentFocus,
      pacingTier,
      genreTags,
      agentToolsEnabled,
      dailyTarget,
      staleForeshadowGap: nextTuning.staleForeshadowGap,
      tokenCalibration: existing.tokenCalibration ?? {},
      contextTuning: nextTuning,
      isDefaultContextTuning: isDefault,
      updatedAt,
    };
  });
}

export function resetProjectContextTuning(ctx: WorkspaceContext, input: Input): ProjectControlsDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  return ctx.atomic(() => {
    const existing = loadProjectControls(ctx, projectId);
    const prevTuning = normalizeContextTuning(existing.contextTuning);
    const updatedAt = Date.now();
    stmt(ctx.db, `
      INSERT INTO author_project_controls (
        project_id, author_intent, current_focus, pacing_tier, genre_tags_json,
        agent_tools_enabled, daily_target, stale_foreshadow_gap, context_config_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
      ON CONFLICT (project_id) DO UPDATE SET
        stale_foreshadow_gap = excluded.stale_foreshadow_gap,
        context_config_json = '{}',
        updated_at = excluded.updated_at;
    `).run(
      projectId,
      existing.authorIntent,
      existing.currentFocus,
      existing.pacingTier ?? "",
      JSON.stringify(existing.genreTags ?? []),
      existing.agentToolsEnabled ? 1 : 0,
      existing.dailyTarget ?? 0,
      DEFAULT_CONTEXT_TUNING.staleForeshadowGap,
      updatedAt,
    );

    ctx.event(projectId, "chapter", "controls.context_reset", { projectId });
    if (prevTuning.l1BudgetTokens !== DEFAULT_CONTEXT_TUNING.l1BudgetTokens) {
      markBookPrefixDirty(ctx, projectId);
    }
    return loadProjectControls(ctx, projectId);
  });
}

export function commitArcPlanProposal(
  ctx: WorkspaceContext,
  projectId: string,
  edited: Input,
  input: Input,
): {
  readonly updatedActId: string | null;
  readonly createdActId: string | null;
  readonly updatedFocus: boolean;
} {
  let updatedActId: string | null = null;
  let createdActId: string | null = null;
  let updatedFocus = false;

  const targetActId = optionalText(input, "actId") ?? optionalText(edited, "actId");
  const actSummary = typeof edited.actSummary === "string" ? edited.actSummary.trim() : "";

  if (targetActId && actSummary) {
    const act = stmt(ctx.db, "SELECT id, summary FROM author_acts WHERE id = ? AND project_id = ?;")
      .get(targetActId, projectId) as { id: string; summary: string } | undefined;
    if (act) {
      const nextSummary = act.summary.trim() ? act.summary : actSummary;
      stmt(ctx.db, "UPDATE author_acts SET arc_summary = ?, summary = ? WHERE id = ?;")
        .run(actSummary, nextSummary, targetActId);
      ctx.event(projectId, "chapter", "act.updated", { actId: targetActId, arcSummary: actSummary });
      updatedActId = targetActId;
    }
  }

  const nextActTitle = typeof edited.nextActTitle === "string" ? edited.nextActTitle.trim() : "";
  if (nextActTitle) {
    let volumeId = optionalText(input, "volumeId") ?? optionalText(edited, "volumeId") ?? null;
    if (!volumeId && targetActId) {
      const targetAct = stmt(ctx.db, "SELECT volume_id AS volumeId FROM author_acts WHERE id = ? AND project_id = ?;")
        .get(targetActId, projectId) as { volumeId?: string } | undefined;
      volumeId = targetAct?.volumeId ?? null;
    }
    if (!volumeId) {
      const firstVol = stmt(ctx.db, "SELECT id FROM author_volumes WHERE project_id = ? ORDER BY sort_order ASC, rowid ASC LIMIT 1;")
        .get(projectId) as { id?: string } | undefined;
      volumeId = firstVol?.id ?? null;
    }
    if (!volumeId) invalid("volumeId", "volume-required-for-next-act");
    const vol = stmt(ctx.db, "SELECT id FROM author_volumes WHERE id = ? AND project_id = ?;")
      .get(volumeId, projectId) as { id?: string } | undefined;
    if (!vol) invalid("volumeId", "volume-not-found");

    const maxRow = stmt(ctx.db, "SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM author_acts WHERE volume_id = ?;")
      .get(volumeId) as { maxOrder: number };
    const sortOrder = maxRow.maxOrder + 1;
    const goal = typeof edited.nextActGoal === "string" ? edited.nextActGoal.trim() : "";
    const summary = typeof edited.nextActSummary === "string" ? edited.nextActSummary.trim() : "";
    const pacingTemplate = typeof edited.pacingTemplate === "string" ? edited.pacingTemplate.trim() : "";
    const actId = randomUUID();
    const createdAt = Date.now();

    stmt(ctx.db, `
      INSERT INTO author_acts (
        id, project_id, volume_id, title, goal, summary, arc_goal, arc_summary, pacing_template, sort_order, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `).run(actId, projectId, volumeId, nextActTitle, goal, summary, goal, summary, pacingTemplate, sortOrder, createdAt);
    ctx.event(projectId, "chapter", "act.created", { actId, volumeId, title: nextActTitle, sortOrder });
    createdActId = actId;
  }

  const nextFocus = typeof edited.currentFocus === "string" ? edited.currentFocus.trim() : "";
  if (nextFocus) {
    const existing = loadProjectControls(ctx, projectId);
    const now = Date.now();
    stmt(ctx.db, `
      INSERT INTO author_project_controls (project_id, author_intent, current_focus, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (project_id) DO UPDATE SET
        current_focus = excluded.current_focus,
        updated_at = excluded.updated_at;
    `).run(projectId, existing.authorIntent, nextFocus, now);
    ctx.event(projectId, "chapter", "controls.saved", { projectId });
    updatedFocus = true;
  }

  return { updatedActId, createdActId, updatedFocus };
}
