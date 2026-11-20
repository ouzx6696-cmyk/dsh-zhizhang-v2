import { randomUUID } from "node:crypto";
import type { ProjectControlsDto } from "../../../contracts/workspace-dto.ts";
import { stmt } from "../../../storage/index.ts";
import { invalid, optionalText, text, type Input, type WorkspaceContext } from "../../context.ts";
import { assertFanqieProject } from "./shared.ts";

export function loadProjectControls(ctx: WorkspaceContext, projectId: string): ProjectControlsDto {
  const row = stmt(ctx.db, `
    SELECT project_id AS projectId, author_intent AS authorIntent,
      current_focus AS currentFocus, updated_at AS updatedAt
    FROM author_project_controls
    WHERE project_id = ?;
  `).get(projectId) as ProjectControlsDto | undefined;
  return row ?? { projectId, authorIntent: "", currentFocus: "", updatedAt: 0 };
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
    const authorIntent = typeof input.authorIntent === "string"
      ? input.authorIntent.trim()
      : existing.authorIntent;
    const currentFocus = typeof input.currentFocus === "string"
      ? input.currentFocus.trim()
      : existing.currentFocus;
    const updatedAt = Date.now();
    stmt(ctx.db, `
      INSERT INTO author_project_controls (project_id, author_intent, current_focus, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (project_id) DO UPDATE SET
        author_intent = excluded.author_intent,
        current_focus = excluded.current_focus,
        updated_at = excluded.updated_at;
    `).run(projectId, authorIntent, currentFocus, updatedAt);
    ctx.event(projectId, "chapter", "controls.saved", { projectId });
    return { projectId, authorIntent, currentFocus, updatedAt };
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
