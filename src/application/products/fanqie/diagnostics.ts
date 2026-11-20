import { randomUUID } from "node:crypto";
import type {
  ChapterDiagnosticsReportDto,
  ChapterObservationDto,
  ObservationDimension,
  ObservationStatus,
  SlopConfigDto,
} from "../../../contracts/workspace-dto.ts";
import { diagnoseChapterOffline, OBSERVATION_DIMENSIONS } from "../../../domain/fanqie/index.ts";
import { stmt } from "../../../storage/index.ts";
import {
  invalid,
  optionalText,
  requiredRow,
  text,
  type DocumentRow,
  type Input,
  type WorkspaceContext,
} from "../../context.ts";
import { assertFanqieProject } from "./shared.ts";

const VALID_DIMENSIONS = new Set<string>(OBSERVATION_DIMENSIONS);
const VALID_SEVERITIES = new Set(["info", "warning", "error"]);
const VALID_STATUSES = new Set<ObservationStatus>(["open", "addressed", "dismissed"]);

function normalizeStringList(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
  }
  if (typeof raw === "string") {
    return [...new Set(raw.split(/[\r\n,，、]+/u).map((v) => v.trim()).filter(Boolean))];
  }
  invalid(field, "expected-string-or-list");
}

export function loadSlopConfig(ctx: WorkspaceContext, projectId: string): SlopConfigDto {
  const row = stmt(ctx.db, `
    SELECT custom_banned_json AS customBannedJson, whitelist_json AS whitelistJson
    FROM author_project_slop_config WHERE project_id = ?;
  `).get(projectId) as { customBannedJson?: string; whitelistJson?: string } | undefined;
  let customBanned: string[] = [];
  let whitelist: string[] = [];
  if (row?.customBannedJson) {
    try { customBanned = JSON.parse(row.customBannedJson) as string[]; } catch { customBanned = []; }
  }
  if (row?.whitelistJson) {
    try { whitelist = JSON.parse(row.whitelistJson) as string[]; } catch { whitelist = []; }
  }
  return { projectId, customBanned, whitelist };
}

export function getSlopConfig(ctx: WorkspaceContext, input: Input): SlopConfigDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  return ctx.read(() => loadSlopConfig(ctx, projectId));
}

export function saveSlopConfig(ctx: WorkspaceContext, input: Input): SlopConfigDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const customBanned = normalizeStringList(input.customBanned, "customBanned");
  const whitelist = normalizeStringList(input.whitelist, "whitelist");
  return ctx.atomic(() => {
    stmt(ctx.db, `
      INSERT INTO author_project_slop_config (project_id, custom_banned_json, whitelist_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (project_id) DO UPDATE SET
        custom_banned_json = excluded.custom_banned_json,
        whitelist_json = excluded.whitelist_json,
        updated_at = excluded.updated_at;
    `).run(projectId, JSON.stringify(customBanned), JSON.stringify(whitelist), Date.now());
    ctx.event(projectId, "setting", "slop.config.updated", {
      customCount: customBanned.length,
      whitelistCount: whitelist.length,
    });
    return { projectId, customBanned, whitelist };
  });
}

export function diagnoseChapter(ctx: WorkspaceContext, row: DocumentRow): ChapterDiagnosticsReportDto {
  if (row.product !== "fanqie") invalid("documentId", "chapter-required");
  return ctx.read(() => {
    const order = ctx.chapterOrder(row.projectId);
    const chapterIndex = Math.max(0, order.indexOf(row.id));
    const plan = ctx.planning(row.id);
    const targetLength = typeof plan?.target === "number" ? plan.target : undefined;
    const config = loadSlopConfig(ctx, row.projectId);
    return diagnoseChapterOffline(row.id, row.body ?? "", {
      chapterIndex,
      targetLength,
      customBanned: config.customBanned,
      whitelist: config.whitelist,
    });
  });
}

export function insertObservationsBatch(
  ctx: WorkspaceContext,
  projectId: string,
  documentId: string,
  revisionId: string | null,
  items: readonly Input[],
  source: string,
): ChapterObservationDto[] {
  const now = Date.now();
  const created: ChapterObservationDto[] = [];
  for (const item of items) {
    const dim = typeof item.dimension === "string" && VALID_DIMENSIONS.has(item.dimension)
      ? (item.dimension as ObservationDimension)
      : invalid("dimension", "unknown-observation-dimension");
    const severity = typeof item.severity === "string" && VALID_SEVERITIES.has(item.severity)
      ? (item.severity as "info" | "warning" | "error")
      : "warning";
    const quote = typeof item.quote === "string" ? item.quote.trim() : "";
    const suggestion = text(item, "suggestion").trim();
    const id = randomUUID();
    stmt(ctx.db, `
      INSERT INTO author_chapter_observations (
        id, project_id, document_id, revision_id, dimension, severity,
        quote, suggestion, status, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?);
    `).run(id, projectId, documentId, revisionId, dim, severity, quote, suggestion, source, now, now);
    ctx.event(projectId, "evidence", "observation.created", { id, documentId, dimension: dim });
    created.push({
      id,
      projectId,
      documentId,
      revisionId,
      dimension: dim,
      severity,
      quote,
      suggestion,
      status: "open",
      source,
      createdAt: now,
      updatedAt: now,
    });
  }
  return created;
}

export function listObservations(ctx: WorkspaceContext, row: DocumentRow, input: Input): ChapterObservationDto[] {
  if (row.product !== "fanqie") invalid("documentId", "chapter-required");
  const status = optionalText(input, "status");
  if (status && !VALID_STATUSES.has(status as ObservationStatus)) {
    invalid("status", "invalid-observation-status");
  }
  return ctx.read(() => {
    const sql = status
      ? `SELECT id, project_id AS projectId, document_id AS documentId, revision_id AS revisionId,
           dimension, severity, quote, suggestion, status, source, created_at AS createdAt, updated_at AS updatedAt
         FROM author_chapter_observations WHERE document_id = ? AND status = ? ORDER BY created_at DESC;`
      : `SELECT id, project_id AS projectId, document_id AS documentId, revision_id AS revisionId,
           dimension, severity, quote, suggestion, status, source, created_at AS createdAt, updated_at AS updatedAt
         FROM author_chapter_observations WHERE document_id = ? ORDER BY created_at DESC;`;
    return (status
      ? stmt(ctx.db, sql).all(row.id, status)
      : stmt(ctx.db, sql).all(row.id)) as ChapterObservationDto[];
  });
}

export function createObservation(ctx: WorkspaceContext, row: DocumentRow, input: Input): ChapterObservationDto {
  if (row.product !== "fanqie") invalid("documentId", "chapter-required");
  return ctx.atomic(() =>
    insertObservationsBatch(ctx, row.projectId, row.id, row.revisionId, [input], optionalText(input, "source") ?? "manual")[0],
  );
}

export function updateObservation(ctx: WorkspaceContext, input: Input): ChapterObservationDto {
  const observationId = text(input, "observationId");
  const statusRaw = text(input, "status");
  if (!VALID_STATUSES.has(statusRaw as ObservationStatus)) {
    invalid("status", "invalid-observation-status");
  }
  const status = statusRaw as ObservationStatus;
  return ctx.atomic(() => {
    const existing = requiredRow<ChapterObservationDto>(
      stmt(ctx.db, `
        SELECT id, project_id AS projectId, document_id AS documentId, revision_id AS revisionId,
          dimension, severity, quote, suggestion, status, source, created_at AS createdAt, updated_at AS updatedAt
        FROM author_chapter_observations WHERE id = ?;
      `).get(observationId),
      "observation",
      observationId,
    );
    const suggestion = input.suggestion !== undefined ? text(input, "suggestion").trim() : existing.suggestion;
    const now = Date.now();
    stmt(ctx.db, "UPDATE author_chapter_observations SET status = ?, suggestion = ?, updated_at = ? WHERE id = ?;")
      .run(status, suggestion, now, observationId);
    ctx.event(existing.projectId, "evidence", "observation.updated", {
      id: observationId,
      documentId: existing.documentId,
      status,
    });
    return { ...existing, status, suggestion, updatedAt: now };
  });
}
