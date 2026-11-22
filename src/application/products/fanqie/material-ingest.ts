import { randomUUID } from "node:crypto";
import type {
  ForeshadowStatus,
  LoreCategory,
  MaterialChunkDto,
  MaterialChunkRole,
  MaterialCommitSummaryDto,
  MaterialIngestSessionDto,
  MaterialIngestStatus,
  MaterialProposedBundleDto,
  MaterialProposedChapterDto,
  MaterialProposedForeshadowDto,
  MaterialProposedLoreDto,
} from "../../../contracts/workspace-dto.ts";
import {
  buildLocalProposedBundle,
  normalizeLoreCategory,
  preprocessNonStandardMaterials,
  validatePacingLabel,
  type ExistingChapterRef,
  type ExistingLoreRef,
  type RawMaterialFileInput,
} from "../../../domain/fanqie/index.ts";
import { anchor } from "../../../domain/shared/index.ts";
import {
  appendRevision,
  createDocument,
  currentSeq,
  rebuildProjectFts,
  stmt,
  syncChapterFts,
} from "../../../storage/index.ts";
import { SHARED_WORKBENCH_SYSTEM_KERNEL } from "../../../workflow/cache-layer.ts";
import { assertStageOutput, WRITING_STAGE_IDS, type SingleShotLlmCaller } from "../../../workflow/writing-stages.ts";
import { invalid, optionalText, requiredRow, text, type Input, type WorkspaceContext } from "../../context.ts";
import { getOrRefreshBookPrefixSnapshot } from "./cache-snapshot.ts";
import { buildFanqieLayeredPayload, buildFanqieSharedLayeredPrefix } from "./context.ts";
import { materializeApprovedLore } from "./lore.ts";
import { syncChapterMemoryAndEntities } from "./memory-sync.ts";
import { assertFanqieProject } from "./shared.ts";

interface IngestRow {
  readonly id: string;
  readonly projectId: string;
  readonly sourceOrigin: "workbench_upload" | "dsh_agent";
  readonly status: MaterialIngestStatus;
  readonly totalFiles: number;
  readonly totalChars: number;
  readonly cleaningWarningsJson: string;
  readonly chunksJson: string;
  readonly proposedBundleJson: string | null;
  readonly committedReportJson: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const INGEST_COLS = `
  id, project_id AS projectId, source_origin AS sourceOrigin, status,
  total_files AS totalFiles, total_chars AS totalChars,
  cleaning_warnings_json AS cleaningWarningsJson, chunks_json AS chunksJson,
  proposed_bundle_json AS proposedBundleJson, committed_report_json AS committedReportJson,
  error, created_at AS createdAt, updated_at AS updatedAt
`;

const VALID_CHUNK_ROLES = new Set<MaterialChunkRole>([
  "completed_chapter",
  "rough_draft",
  "lore_note",
  "outline_note",
  "foreshadow_note",
  "ignore",
]);

const VALID_FORESHADOW_STATUSES = new Set<ForeshadowStatus>([
  "proposed",
  "planted",
  "hinted",
  "resolved",
  "abandoned",
]);

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseJsonPayload(raw: string): Record<string, unknown> {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/giu, "").trim();
  const parsed = JSON.parse(cleaned) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object payload");
  }
  return parsed as Record<string, unknown>;
}

function mapIngestRow(row: IngestRow): MaterialIngestSessionDto {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceOrigin: row.sourceOrigin === "dsh_agent" ? "dsh_agent" : "workbench_upload",
    status: row.status,
    totalFiles: row.totalFiles,
    totalChars: row.totalChars,
    cleaningWarnings: safeJsonParse<string[]>(row.cleaningWarningsJson, []),
    chunks: safeJsonParse<MaterialChunkDto[]>(row.chunksJson, []),
    proposedBundle: safeJsonParse<MaterialProposedBundleDto | null>(row.proposedBundleJson, null),
    committedReport: safeJsonParse<MaterialCommitSummaryDto | null>(row.committedReportJson, null),
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function loadExistingRefs(ctx: WorkspaceContext, projectId: string): {
  readonly chapters: readonly ExistingChapterRef[];
  readonly lore: readonly ExistingLoreRef[];
} {
  const chapters = stmt(ctx.db, `
    SELECT title, state FROM author_documents WHERE project_id = ? ORDER BY rowid ASC;
  `).all(projectId) as ExistingChapterRef[];
  const lore = stmt(ctx.db, `
    SELECT fact_id AS factId, entity_name AS entityName, locked
    FROM author_lore_current WHERE project_id = ?;
  `).all(projectId) as readonly { factId: string; entityName: string; locked: number }[];
  return {
    chapters,
    lore: lore.map((r) => ({ factId: r.factId, entityName: r.entityName, locked: r.locked === 1 })),
  };
}

function normalizeTitleKey(title: string): string {
  return title.replace(/[\s:：·\-—_]+/gu, "").trim().toLowerCase();
}

/**
 * Validates and annotates a raw bundle (from AI extraction, DsH agent tool, or
 * author edit) against the live project state so locked lore and finalized
 * chapters are always protected.
 */
function normalizeAndAnnotateBundle(
  raw: Record<string, unknown>,
  existingChapters: readonly ExistingChapterRef[],
  existingLore: readonly ExistingLoreRef[],
): MaterialProposedBundleDto {
  const chapterByTitle = new Map(existingChapters.map((c) => [normalizeTitleKey(c.title), c]));
  const loreByFactId = new Map(existingLore.map((l) => [l.factId, l]));
  const loreByName = new Map(existingLore.map((l) => [l.entityName.trim().toLowerCase(), l]));
  const warnings: string[] = Array.isArray(raw.warnings)
    ? raw.warnings.map((w) => String(w).trim()).filter(Boolean)
    : [];

  const chapters: MaterialProposedChapterDto[] = [];
  const rawChapters = Array.isArray(raw.chapters) ? raw.chapters : [];
  for (let i = 0; i < rawChapters.length; i += 1) {
    const item = rawChapters[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    if (!title) continue;
    const existing = chapterByTitle.get(normalizeTitleKey(title));
    const conflictStatus: MaterialProposedChapterDto["conflictStatus"] = existing
      ? existing.state === "final"
        ? "skip_locked_final"
        : "update_draft"
      : "new";
    if (conflictStatus === "skip_locked_final") {
      warnings.push(`章节「${title}」已定稿（final），已自动锁定跳过覆盖。`);
    }
    const rawState = typeof rec.state === "string" ? rec.state.trim() : "drafting";
    const state: MaterialProposedChapterDto["state"] =
      rawState === "planned" || rawState === "drafted" ? rawState : "drafting";
    const selected = conflictStatus === "skip_locked_final" ? false : rec.selected !== false;
    chapters.push({
      id: typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : `mch-${i + 1}`,
      volumeTitle: typeof rec.volumeTitle === "string" && rec.volumeTitle.trim() ? rec.volumeTitle.trim() : "第一卷",
      actTitle: typeof rec.actTitle === "string" && rec.actTitle.trim() ? rec.actTitle.trim() : "第一幕",
      title,
      state,
      summary: typeof rec.summary === "string" ? rec.summary.trim().slice(0, 400) : "",
      body: typeof rec.body === "string" ? rec.body : "",
      viewpoint: typeof rec.viewpoint === "string" && rec.viewpoint.trim() ? rec.viewpoint.trim() : undefined,
      conflictStatus,
      selected,
    });
  }

  const lore: MaterialProposedLoreDto[] = [];
  const rawLore = Array.isArray(raw.lore) ? raw.lore : [];
  for (let i = 0; i < rawLore.length; i += 1) {
    const item = rawLore[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const entityName = typeof rec.entityName === "string" ? rec.entityName.trim() : "";
    const note = typeof rec.note === "string" ? rec.note.trim() : "";
    if (!entityName && !note) continue;
    const rawFactId = typeof rec.factId === "string" && rec.factId.trim() ? rec.factId.trim() : "";
    const existing =
      (rawFactId ? loreByFactId.get(rawFactId) : undefined) ??
      (entityName ? loreByName.get(entityName.toLowerCase()) : undefined);
    const conflictStatus: MaterialProposedLoreDto["conflictStatus"] = existing
      ? existing.locked
        ? "skip_locked"
        : "update_unlocked"
      : "new";
    if (conflictStatus === "skip_locked") {
      warnings.push(`设定「${entityName || rawFactId}」已锁定（locked），已自动保护跳过。`);
    }
    let category: LoreCategory = "world_rule";
    try {
      category = normalizeLoreCategory(rec.category, "fact") as LoreCategory;
    } catch {
      category = "world_rule";
    }
    const aliases = Array.isArray(rec.aliases)
      ? [...new Set(rec.aliases.map((a) => String(a).trim()).filter(Boolean))]
      : [];
    const knownBy = Array.isArray(rec.knownBy)
      ? rec.knownBy
          .filter((k): k is Record<string, unknown> => Boolean(k && typeof k === "object"))
          .map((k) => ({
            character: typeof k.character === "string" ? k.character.trim() : "",
            chapterTitle: typeof k.chapterTitle === "string" && k.chapterTitle.trim() ? k.chapterTitle.trim() : undefined,
          }))
          .filter((k) => k.character.length > 0)
      : [];
    const factId = existing?.factId ?? (rawFactId || `mat-${randomUUID().slice(0, 8)}`);
    const selected = conflictStatus === "skip_locked" ? false : rec.selected !== false;
    lore.push({
      id: typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : `mlore-${i + 1}`,
      factId,
      category,
      entityName: entityName || factId,
      note,
      aliases,
      lockedSuggested: rec.lockedSuggested === true,
      effectiveChapterTitle:
        typeof rec.effectiveChapterTitle === "string" && rec.effectiveChapterTitle.trim()
          ? rec.effectiveChapterTitle.trim()
          : undefined,
      knownBy,
      conflictStatus,
      conflictNote:
        conflictStatus === "skip_locked"
          ? "目标设定已锁定，不可自动覆盖"
          : conflictStatus === "update_unlocked"
            ? "将更新已有未锁定设定"
            : undefined,
      selected,
    });
  }

  const foreshadows: MaterialProposedForeshadowDto[] = [];
  const rawFs = Array.isArray(raw.foreshadows) ? raw.foreshadows : [];
  for (let i = 0; i < rawFs.length; i += 1) {
    const item = rawFs[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    if (!title) continue;
    const rawStatus = typeof rec.status === "string" ? rec.status.trim() : "planted";
    const status: ForeshadowStatus = VALID_FORESHADOW_STATUSES.has(rawStatus as ForeshadowStatus)
      ? (rawStatus as ForeshadowStatus)
      : "planted";
    foreshadows.push({
      id: typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : `mfs-${i + 1}`,
      title,
      status,
      plantedChapterTitle:
        typeof rec.plantedChapterTitle === "string" && rec.plantedChapterTitle.trim()
          ? rec.plantedChapterTitle.trim()
          : undefined,
      targetChapterTitle:
        typeof rec.targetChapterTitle === "string" && rec.targetChapterTitle.trim()
          ? rec.targetChapterTitle.trim()
          : undefined,
      note: typeof rec.note === "string" ? rec.note.trim() : "",
      selected: rec.selected !== false,
    });
  }

  let pacingTier: string | undefined;
  if (typeof raw.pacingTier === "string" && raw.pacingTier.trim()) {
    try {
      pacingTier = validatePacingLabel(raw.pacingTier) || undefined;
    } catch {
      pacingTier = undefined;
    }
  }
  const genreTags = Array.isArray(raw.genreTags)
    ? [...new Set(raw.genreTags.map((g) => String(g).trim()).filter(Boolean))].slice(0, 10)
    : undefined;

  return {
    authorIntent: typeof raw.authorIntent === "string" && raw.authorIntent.trim() ? raw.authorIntent.trim() : undefined,
    currentFocus: typeof raw.currentFocus === "string" && raw.currentFocus.trim() ? raw.currentFocus.trim() : undefined,
    pacingTier,
    genreTags: genreTags && genreTags.length > 0 ? genreTags : undefined,
    chapters,
    lore,
    foreshadows,
    warnings: [...new Set(warnings)],
  };
}

/** Stage 1: Zero-token local preprocessing, cleaning, splitting, and baseline preview. */
export function preprocessMaterialIngest(ctx: WorkspaceContext, input: Input): MaterialIngestSessionDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  if (!Array.isArray(input.files) || input.files.length === 0) {
    invalid("files", "non-empty-file-list-required");
  }
  const files: RawMaterialFileInput[] = [];
  for (const entry of input.files) {
    if (!entry || typeof entry !== "object") invalid("files", "invalid-file-entry");
    const rec = entry as Record<string, unknown>;
    const path = typeof rec.path === "string" && rec.path.trim() ? rec.path.trim() : `材料-${files.length + 1}.txt`;
    const content = typeof rec.content === "string" ? rec.content : "";
    files.push({ path, content });
  }
  const sourceOrigin = input.sourceOrigin === "dsh_agent" ? "dsh_agent" : "workbench_upload";

  return ctx.atomic(() => {
    const existing = loadExistingRefs(ctx, projectId);
    const preprocessed = preprocessNonStandardMaterials(
      files,
      existing.chapters.map((c) => c.title),
    );
    const baselineBundle = buildLocalProposedBundle(preprocessed.chunks, existing.chapters, existing.lore);
    const id = randomUUID();
    const now = Date.now();
    stmt(ctx.db, `
      INSERT INTO author_material_ingests (
        id, project_id, source_origin, status, total_files, total_chars,
        cleaning_warnings_json, chunks_json, proposed_bundle_json,
        committed_report_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, 'chunked', ?, ?, ?, ?, ?, NULL, NULL, ?, ?);
    `).run(
      id,
      projectId,
      sourceOrigin,
      preprocessed.totalFiles,
      preprocessed.totalChars,
      JSON.stringify(preprocessed.cleaningWarnings),
      JSON.stringify(preprocessed.chunks),
      JSON.stringify(baselineBundle),
      now,
      now,
    );
    ctx.event(projectId, "setting", "material.preprocessed", {
      sessionId: id,
      chunks: preprocessed.chunks.length,
      totalChars: preprocessed.totalChars,
    });
    return {
      id,
      projectId,
      sourceOrigin,
      status: "chunked",
      totalFiles: preprocessed.totalFiles,
      totalChars: preprocessed.totalChars,
      cleaningWarnings: preprocessed.cleaningWarnings,
      chunks: preprocessed.chunks,
      proposedBundle: baselineBundle,
      committedReport: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export function listMaterialIngests(ctx: WorkspaceContext, input: Input): MaterialIngestSessionDto[] {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  return ctx.read(() => {
    const rows = stmt(ctx.db, `
      SELECT ${INGEST_COLS} FROM author_material_ingests
      WHERE project_id = ? ORDER BY updated_at DESC LIMIT 30;
    `).all(projectId) as IngestRow[];
    return rows.map(mapIngestRow);
  });
}

export function getMaterialIngest(ctx: WorkspaceContext, input: Input): MaterialIngestSessionDto {
  const sessionId = text(input, "sessionId");
  return ctx.read(() => {
    const row = requiredRow<IngestRow>(
      stmt(ctx.db, `SELECT ${INGEST_COLS} FROM author_material_ingests WHERE id = ?;`).get(sessionId),
      "material_ingest",
      sessionId,
    );
    return mapIngestRow(row);
  });
}

/** Lets author adjust chunk roles/titles/content after Stage 1 and recomputes local baseline bundle. */
export function updateMaterialChunks(ctx: WorkspaceContext, input: Input): MaterialIngestSessionDto {
  const sessionId = text(input, "sessionId");
  if (!Array.isArray(input.chunks)) invalid("chunks", "array-required");

  return ctx.atomic(() => {
    const row = requiredRow<IngestRow>(
      stmt(ctx.db, `SELECT ${INGEST_COLS} FROM author_material_ingests WHERE id = ?;`).get(sessionId),
      "material_ingest",
      sessionId,
    );
    if (row.status === "committed") invalid("sessionId", "session-already-committed");

    const rawInputChunks = input.chunks as readonly unknown[];
    const priorChunks = safeJsonParse<MaterialChunkDto[]>(row.chunksJson, []);
    const priorById = new Map(priorChunks.map((c) => [c.id, c]));

    const updatedChunks: MaterialChunkDto[] = [];
    for (const raw of rawInputChunks) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : `chunk-${updatedChunks.length + 1}`;
      const prior = priorById.get(id);
      const roleRaw = typeof rec.role === "string" ? rec.role.trim() : (prior?.role ?? "lore_note");
      const role: MaterialChunkRole = VALID_CHUNK_ROLES.has(roleRaw as MaterialChunkRole)
        ? (roleRaw as MaterialChunkRole)
        : "lore_note";
      const content = typeof rec.content === "string" ? rec.content : (prior?.content ?? "");
      updatedChunks.push({
        id,
        sourcePath: typeof rec.sourcePath === "string" ? rec.sourcePath : (prior?.sourcePath ?? "材料.txt"),
        lineStart: typeof rec.lineStart === "number" ? rec.lineStart : (prior?.lineStart ?? 1),
        lineEnd: typeof rec.lineEnd === "number" ? rec.lineEnd : (prior?.lineEnd ?? 1),
        title: typeof rec.title === "string" && rec.title.trim() ? rec.title.trim() : (prior?.title ?? `片段-${updatedChunks.length + 1}`),
        volumeTitle: typeof rec.volumeTitle === "string" && rec.volumeTitle.trim() ? rec.volumeTitle.trim() : prior?.volumeTitle,
        role,
        loreCategoryHint:
          typeof rec.loreCategoryHint === "string" && rec.loreCategoryHint.trim()
            ? (rec.loreCategoryHint.trim() as LoreCategory)
            : prior?.loreCategoryHint,
        charCount: [...content.replace(/\s/gu, "")].length,
        content,
        warnings: Array.isArray(rec.warnings) ? rec.warnings.map((w) => String(w)) : (prior?.warnings ?? []),
        duplicateOfExistingTitle:
          typeof rec.duplicateOfExistingTitle === "string"
            ? rec.duplicateOfExistingTitle
            : (prior?.duplicateOfExistingTitle ?? null),
      });
    }

    const existing = loadExistingRefs(ctx, row.projectId);
    const baselineBundle = buildLocalProposedBundle(updatedChunks, existing.chapters, existing.lore);
    const now = Date.now();
    stmt(ctx.db, `
      UPDATE author_material_ingests
      SET chunks_json = ?, proposed_bundle_json = ?, status = 'chunked', error = NULL, updated_at = ?
      WHERE id = ?;
    `).run(JSON.stringify(updatedChunks), JSON.stringify(baselineBundle), now, sessionId);

    return mapIngestRow({
      ...row,
      status: "chunked",
      chunksJson: JSON.stringify(updatedChunks),
      proposedBundleJson: JSON.stringify(baselineBundle),
      error: null,
      updatedAt: now,
    });
  });
}

/** Stage 2b (AI or DsH Agent): Submits a normalized bundle for explicit author preview & commit. */
export function proposeMaterialBundle(ctx: WorkspaceContext, input: Input): MaterialIngestSessionDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const rawBundle = input.bundle;
  if (!rawBundle || typeof rawBundle !== "object" || Array.isArray(rawBundle)) {
    invalid("bundle", "object-required");
  }
  const sessionId = optionalText(input, "sessionId");
  const sourceOrigin = input.sourceOrigin === "dsh_agent" ? "dsh_agent" : "workbench_upload";

  return ctx.atomic(() => {
    const existing = loadExistingRefs(ctx, projectId);
    const annotated = normalizeAndAnnotateBundle(
      rawBundle as Record<string, unknown>,
      existing.chapters,
      existing.lore,
    );
    const now = Date.now();

    if (sessionId) {
      const row = requiredRow<IngestRow>(
        stmt(ctx.db, `SELECT ${INGEST_COLS} FROM author_material_ingests WHERE id = ? AND project_id = ?;`).get(
          sessionId,
          projectId,
        ),
        "material_ingest",
        sessionId,
      );
      if (row.status === "committed") invalid("sessionId", "session-already-committed");
      stmt(ctx.db, `
        UPDATE author_material_ingests
        SET status = 'ready_for_review', proposed_bundle_json = ?, error = NULL, updated_at = ?
        WHERE id = ?;
      `).run(JSON.stringify(annotated), now, sessionId);
      ctx.event(projectId, "setting", "material.bundle.proposed", {
        sessionId,
        chapters: annotated.chapters.length,
        lore: annotated.lore.length,
        foreshadows: annotated.foreshadows.length,
      });
      return mapIngestRow({
        ...row,
        status: "ready_for_review",
        proposedBundleJson: JSON.stringify(annotated),
        error: null,
        updatedAt: now,
      });
    }

    const newId = randomUUID();
    stmt(ctx.db, `
      INSERT INTO author_material_ingests (
        id, project_id, source_origin, status, total_files, total_chars,
        cleaning_warnings_json, chunks_json, proposed_bundle_json,
        committed_report_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, 'ready_for_review', 0, 0, '[]', '[]', ?, NULL, NULL, ?, ?);
    `).run(newId, projectId, sourceOrigin, JSON.stringify(annotated), now, now);
    ctx.event(projectId, "setting", "material.bundle.proposed", {
      sessionId: newId,
      sourceOrigin,
      chapters: annotated.chapters.length,
      lore: annotated.lore.length,
      foreshadows: annotated.foreshadows.length,
    });
    return {
      id: newId,
      projectId,
      sourceOrigin,
      status: "ready_for_review",
      totalFiles: 0,
      totalChars: 0,
      cleaningWarnings: [],
      chunks: [],
      proposedBundle: annotated,
      committedReport: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  });
}

/**
 * Stage 3: Atomic commit of author-reviewed bundle into Fanqie standard tables
 * + FTS5 rebuild + L1 Book Bible Snapshot rebuild.
 * Strictly protects `state = 'final'` chapters and `locked = 1` lore.
 */
export function commitMaterialIngest(ctx: WorkspaceContext, input: Input): MaterialCommitSummaryDto {
  const sessionId = text(input, "sessionId");
  return ctx.atomic(() => {
    const row = requiredRow<IngestRow>(
      stmt(ctx.db, `SELECT ${INGEST_COLS} FROM author_material_ingests WHERE id = ?;`).get(sessionId),
      "material_ingest",
      sessionId,
    );
    if (row.status === "committed") invalid("sessionId", "session-already-committed");
    if (row.status === "discarded") invalid("sessionId", "session-discarded");

    const projectId = row.projectId;
    const existing = loadExistingRefs(ctx, projectId);
    const rawCandidate =
      input.editedBundle && typeof input.editedBundle === "object" && !Array.isArray(input.editedBundle)
        ? (input.editedBundle as Record<string, unknown>)
        : safeJsonParse<Record<string, unknown> | null>(row.proposedBundleJson, null);
    if (!rawCandidate) invalid("sessionId", "no-proposed-bundle");

    // Re-annotate against live DB inside transaction so locked/final guards can never be bypassed
    const bundle = normalizeAndAnnotateBundle(rawCandidate, existing.chapters, existing.lore);
    const now = Date.now();

    let volumesCreated = 0;
    let actsCreated = 0;
    let chaptersCreated = 0;
    let chaptersUpdated = 0;
    let chaptersSkippedLocked = 0;
    let loreCommitted = 0;
    let loreSkippedLocked = 0;
    let foreshadowsCommitted = 0;
    let controlsUpdated = false;

    // Volume & Act lookup caches
    const existingVolumes = stmt(ctx.db, "SELECT id, title, sort_order AS sortOrder FROM author_volumes WHERE project_id = ?;")
      .all(projectId) as readonly { id: string; title: string; sortOrder: number }[];
    const volumeByTitle = new Map(existingVolumes.map((v) => [v.title.trim(), v.id]));
    let nextVolOrder = existingVolumes.reduce((m, v) => Math.max(m, v.sortOrder), 0);

    const existingActs = stmt(ctx.db, "SELECT id, volume_id AS volumeId, title, sort_order AS sortOrder FROM author_acts WHERE project_id = ?;")
      .all(projectId) as readonly { id: string; volumeId: string; title: string; sortOrder: number }[];
    const actByKey = new Map(existingActs.map((a) => [`${a.volumeId}::${a.title.trim()}`, a.id]));
    let nextActOrder = existingActs.reduce((m, a) => Math.max(m, a.sortOrder), 0);

    function ensureVolume(title: string): string {
      const clean = title.trim() || "第一卷";
      const found = volumeByTitle.get(clean);
      if (found) return found;
      const id = randomUUID();
      nextVolOrder += 1;
      stmt(ctx.db, `
        INSERT INTO author_volumes (id, project_id, title, goal, summary, sort_order, created_at)
        VALUES (?, ?, ?, '', '', ?, ?);
      `).run(id, projectId, clean, nextVolOrder, now);
      volumeByTitle.set(clean, id);
      volumesCreated += 1;
      return id;
    }

    function ensureAct(volumeId: string, title: string): string {
      const clean = title.trim() || "第一幕";
      const key = `${volumeId}::${clean}`;
      const found = actByKey.get(key);
      if (found) return found;
      const id = randomUUID();
      nextActOrder += 1;
      stmt(ctx.db, `
        INSERT INTO author_acts (id, project_id, volume_id, title, goal, summary, sort_order, created_at)
        VALUES (?, ?, ?, ?, '', '', ?, ?);
      `).run(id, projectId, volumeId, clean, nextActOrder, now);
      actByKey.set(key, id);
      actsCreated += 1;
      return id;
    }

    // Track chapterId by normalized title for lore/foreshadow anchors
    const existingDocRows = stmt(ctx.db, `
      SELECT id, title, state, sort_key AS sortKey FROM author_documents WHERE project_id = ? ORDER BY sort_key ASC, rowid ASC;
    `).all(projectId) as readonly { id: string; title: string; state: string; sortKey: number }[];
    const docByTitle = new Map(existingDocRows.map((d) => [normalizeTitleKey(d.title), d]));
    let maxSortKey = existingDocRows.reduce((m, d) => Math.max(m, Number(d.sortKey ?? 0)), 0);

    // 1. Commit chapters
    for (const ch of bundle.chapters) {
      if (ch.conflictStatus === "skip_locked_final") {
        chaptersSkippedLocked += 1;
        continue;
      }
      if (!ch.selected) continue;

      const volId = ensureVolume(ch.volumeTitle);
      const actId = ensureAct(volId, ch.actTitle);
      const key = normalizeTitleKey(ch.title);
      const existingDoc = docByTitle.get(key);

      if (existingDoc) {
        if (existingDoc.state === "final") {
          chaptersSkippedLocked += 1;
          continue;
        }
        const docRow = ctx.document(existingDoc.id);
        const body = ch.body || docRow.body || "";
        const charCount = [...body.replace(/\s/gu, "")].length;
        appendRevision(ctx.db, {
          revisionId: randomUUID(),
          documentId: existingDoc.id,
          body,
          createdAt: now,
        });
        stmt(ctx.db, `
          UPDATE author_documents
          SET state = ?, summary = ?, volume_id = ?, act_id = ?, char_count = ?, updated_at = ?
          WHERE id = ?;
        `).run(ch.state, ch.summary || docRow.summary, volId, actId, charCount, now, existingDoc.id);
        if (ch.viewpoint) {
          const curPlan = ctx.planning(existingDoc.id) ?? {};
          ctx.savePlanning(ctx.document(existingDoc.id), { ...curPlan, viewpoint: ch.viewpoint });
        }
        syncChapterMemoryAndEntities(ctx, projectId, existingDoc.id, body);
        syncChapterFts(ctx.db, { documentId: existingDoc.id, projectId, title: ch.title, summary: ch.summary, body });
        chaptersUpdated += 1;
      } else {
        const docId = randomUUID();
        maxSortKey += 100;
        const body = ch.body || "";
        const charCount = [...body.replace(/\s/gu, "")].length;
        createDocument(ctx.db, docId);
        stmt(ctx.db, `
          INSERT INTO author_documents (
            id, project_id, title, state, mode, line, volume_id, act_id,
            char_count, summary, sort_key, updated_at
          ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?);
        `).run(docId, projectId, ch.title, ch.state, volId, actId, charCount, ch.summary, maxSortKey, now);
        if (body) {
          appendRevision(ctx.db, {
            revisionId: randomUUID(),
            documentId: docId,
            body,
            createdAt: now,
          });
        }
        if (ch.viewpoint) {
          ctx.savePlanning(ctx.document(docId), { viewpoint: ch.viewpoint });
        }
        ctx.event(projectId, "chapter", "document.created", {
          documentId: docId,
          title: ch.title,
          state: ch.state,
        });
        syncChapterMemoryAndEntities(ctx, projectId, docId, body);
        syncChapterFts(ctx.db, { documentId: docId, projectId, title: ch.title, summary: ch.summary, body });
        docByTitle.set(key, { id: docId, title: ch.title, state: ch.state, sortKey: maxSortKey });
        chaptersCreated += 1;
      }
    }

    const order = ctx.chapterOrder(projectId);
    const firstChapterId = order[0] ?? "ch-initial";
    function resolveChapterIdByTitle(title?: string): string | null {
      if (!title?.trim()) return null;
      const hit = docByTitle.get(normalizeTitleKey(title));
      return hit?.id ?? null;
    }

    // 2. Commit standardized lore
    for (const item of bundle.lore) {
      if (item.conflictStatus === "skip_locked") {
        loreSkippedLocked += 1;
        continue;
      }
      if (!item.selected) continue;

      const effChapterId = resolveChapterIdByTitle(item.effectiveChapterTitle) ?? firstChapterId;
      const knownFrom: Record<string, { readonly chapterId: string; readonly point: number }> = {};
      for (const kb of item.knownBy) {
        const kbChId = resolveChapterIdByTitle(kb.chapterTitle) ?? effChapterId;
        knownFrom[kb.character] = anchor(kbChId, 1);
      }
      const fact = {
        id: item.factId,
        note: item.note,
        source: `材料标准化入库(${sessionId.slice(0, 8)})`,
        kind: item.category === "agreement" ? ("agreement" as const) : ("fact" as const),
        locked: false, // Never auto-lock without explicit author lock click
        effectiveFrom: anchor(effChapterId, 1),
        knownFrom,
        aliases: item.aliases,
      };
      const settingId = randomUUID();
      const decidedSeq = currentSeq(ctx.db, projectId) + 1;
      stmt(ctx.db, `
        INSERT INTO author_settings (
          id, project_id, fact_id, category, entity_name, value,
          decision, decided_seq, origin, origin_ref
        ) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, 'author-ui', ?);
      `).run(
        settingId,
        projectId,
        item.factId,
        item.category,
        item.entityName,
        JSON.stringify(fact),
        decidedSeq,
        `material:${sessionId}`,
      );
      materializeApprovedLore(ctx, {
        projectId,
        settingId,
        factId: item.factId,
        category: item.category,
        entityName: item.entityName,
        fact,
        decidedSeq,
      });
      ctx.event(projectId, "setting", "setting.decided", {
        id: settingId,
        factId: item.factId,
        decision: "approved",
        fact,
      });
      loreCommitted += 1;
    }

    // 3. Commit foreshadows
    for (const fs of bundle.foreshadows) {
      if (!fs.selected) continue;
      const id = randomUUID();
      const plantedId = resolveChapterIdByTitle(fs.plantedChapterTitle) ?? (order[0] ?? null);
      const targetId = resolveChapterIdByTitle(fs.targetChapterTitle);
      stmt(ctx.db, `
        INSERT INTO author_foreshadows (
          id, project_id, fact_id, title, planted_chapter_id, planted_point,
          target_chapter_id, resolved_chapter_id, hinted_chapter_ids_json, status, note, updated_at
        ) VALUES (?, ?, NULL, ?, ?, 1, ?, NULL, '[]', ?, ?, ?);
      `).run(id, projectId, fs.title, plantedId, targetId, fs.status, fs.note, now);
      foreshadowsCommitted += 1;
    }

    // 4. Commit project controls compass / focus / pacing / genreTags
    if (bundle.authorIntent || bundle.currentFocus || bundle.pacingTier || (bundle.genreTags && bundle.genreTags.length > 0)) {
      const existingControls = stmt(ctx.db, `
        SELECT author_intent AS authorIntent, current_focus AS currentFocus,
          pacing_tier AS pacingTier, genre_tags_json AS genreTagsJson
        FROM author_project_controls WHERE project_id = ?;
      `).get(projectId) as
        | { authorIntent?: string; currentFocus?: string; pacingTier?: string; genreTagsJson?: string }
        | undefined;
      const nextIntent = bundle.authorIntent
        ? existingControls?.authorIntent?.trim()
          ? `${existingControls.authorIntent.trim()}\n\n${bundle.authorIntent}`
          : bundle.authorIntent
        : (existingControls?.authorIntent ?? "");
      const nextFocus = bundle.currentFocus ?? existingControls?.currentFocus ?? "";
      const nextPacing = bundle.pacingTier ?? existingControls?.pacingTier ?? "";
      const prevGenres = safeJsonParse<string[]>(existingControls?.genreTagsJson, []);
      const nextGenres = bundle.genreTags ? [...new Set([...prevGenres, ...bundle.genreTags])] : prevGenres;

      stmt(ctx.db, `
        INSERT INTO author_project_controls (
          project_id, author_intent, current_focus, pacing_tier, genre_tags_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (project_id) DO UPDATE SET
          author_intent = excluded.author_intent,
          current_focus = excluded.current_focus,
          pacing_tier = excluded.pacing_tier,
          genre_tags_json = excluded.genre_tags_json,
          updated_at = excluded.updated_at;
      `).run(projectId, nextIntent, nextFocus, nextPacing, JSON.stringify(nextGenres), now);
      controlsUpdated = true;
    }

    // 5. Rebuild FTS5 index & Force L1 Book Bible Snapshot rebuild
    rebuildProjectFts(ctx.db, projectId);
    const l1 = getOrRefreshBookPrefixSnapshot(ctx, projectId, { force: true, readOnly: false });

    const summary: MaterialCommitSummaryDto = {
      sessionId,
      projectId,
      volumesCreated,
      actsCreated,
      chaptersCreated,
      chaptersUpdated,
      chaptersSkippedLocked,
      loreCommitted,
      loreSkippedLocked,
      foreshadowsCommitted,
      controlsUpdated,
      l1SnapshotVersion: l1.snapshot.version,
    };

    stmt(ctx.db, `
      UPDATE author_material_ingests
      SET status = 'committed', proposed_bundle_json = ?, committed_report_json = ?, error = NULL, updated_at = ?
      WHERE id = ?;
    `).run(JSON.stringify(bundle), JSON.stringify(summary), now, sessionId);

    ctx.event(projectId, "setting", "material.committed", {
      sessionId,
      chaptersCreated,
      chaptersUpdated,
      loreCommitted,
      foreshadowsCommitted,
      l1SnapshotVersion: l1.snapshot.version,
    });

    return summary;
  });
}

export function discardMaterialIngest(ctx: WorkspaceContext, input: Input): { readonly discarded: string } {
  const sessionId = text(input, "sessionId");
  return ctx.atomic(() => {
    const row = requiredRow<IngestRow>(
      stmt(ctx.db, `SELECT ${INGEST_COLS} FROM author_material_ingests WHERE id = ?;`).get(sessionId),
      "material_ingest",
      sessionId,
    );
    if (row.status === "committed") invalid("sessionId", "session-already-committed");
    stmt(ctx.db, "UPDATE author_material_ingests SET status = 'discarded', updated_at = ? WHERE id = ?;")
      .run(Date.now(), sessionId);
    ctx.event(row.projectId, "setting", "material.discarded", { sessionId });
    return { discarded: sessionId };
  });
}

/**
 * Stage 2a: Async AI normalization runner executed through the Unified Job Engine.
 * Reuses the book's L0+L1 prompt cache prefix and extracts standardized chapters,
 * lore (with aliases & knownBy), foreshadows, and compass fields into the session inbox.
 */
export async function runMaterialExtraction(
  ctx: WorkspaceContext,
  params: {
    readonly sessionId: string;
    readonly instruction?: string;
    readonly caller: SingleShotLlmCaller;
    readonly signal: AbortSignal;
  },
): Promise<MaterialIngestSessionDto> {
  const session = getMaterialIngest(ctx, { sessionId: params.sessionId });
  if (session.status === "committed") invalid("sessionId", "session-already-committed");

  ctx.atomic(() => {
    stmt(ctx.db, "UPDATE author_material_ingests SET status = 'extracting', error = NULL, updated_at = ? WHERE id = ?;")
      .run(Date.now(), session.id);
  });

  try {
    if (params.signal.aborted) {
      throw new Error("material-extract-aborted");
    }
    const activeChunks = session.chunks.filter((c) => c.role !== "ignore");
    if (activeChunks.length === 0) {
      invalid("chunks", "no-active-chunks");
    }

    const shared = buildFanqieSharedLayeredPrefix(ctx, session.projectId, undefined, { readOnly: false });
    const existing = loadExistingRefs(ctx, session.projectId);
    const existingChapterHint = existing.chapters.length > 0
      ? existing.chapters.map((c) => `- 《${c.title}》（${c.state}）`).join("\n")
      : "（当前书尚无章节）";
    const existingLoreHint = existing.lore.length > 0
      ? existing.lore.slice(0, 50).map((l) => `- [${l.factId}] ${l.entityName}${l.locked ? "（已锁定·禁止覆盖）" : ""}`).join("\n")
      : "（当前书尚无设定）";

    const chunkDigest = activeChunks
      .map((c, idx) => {
        const excerpt = c.content.length > 2600 ? `${c.content.slice(0, 2600)}\n…（截断，原长 ${c.charCount} 字）` : c.content;
        return `### 切片 ${idx + 1} [${c.role}] ${c.title}${c.volumeTitle ? `（卷：${c.volumeTitle}）` : ""}（来源：${c.sourcePath}）\n${excerpt}`;
      })
      .join("\n\n");

    const dynamicSections = [
      `### 非标准材料标准化提炼任务\n共 ${activeChunks.length} 个有效切片，总字数约 ${session.totalChars} 字。`,
      params.instruction?.trim() ? `### 作者补充提炼要求\n${params.instruction.trim()}` : "",
      `### 目标书已有章节（切勿覆盖 final 定稿章）\n${existingChapterHint}`,
      `### 目标书已有设定（切勿篡改 locked 锁定设定）\n${existingLoreHint}`,
      `### 待标准化材料切片\n${chunkDigest}`,
    ];

    const layered = buildFanqieLayeredPayload(shared, "materialNormalize", dynamicSections);
    const rawText = await params.caller.complete({
      phase: "materialNormalize",
      system: SHARED_WORKBENCH_SYSTEM_KERNEL,
      prompt: layered.dynamicTail,
      layered,
    });
    const parsed = parseJsonPayload(rawText) as Record<string, unknown>;
    assertStageOutput(WRITING_STAGE_IDS.materialNormalize, parsed, "materialNormalize");

    // Preserve full chapter bodies from local chunks when AI returns shortened summaries for completed/rough chapters
    const localBodyByTitle = new Map(
      activeChunks
        .filter((c) => c.role === "completed_chapter" || c.role === "rough_draft")
        .map((c) => [normalizeTitleKey(c.title), c.content]),
    );
    if (Array.isArray(parsed.chapters)) {
      for (const ch of parsed.chapters) {
        if (!ch || typeof ch !== "object") continue;
        const rec = ch as Record<string, unknown>;
        const title = typeof rec.title === "string" ? rec.title : "";
        const localBody = localBodyByTitle.get(normalizeTitleKey(title));
        if (localBody && (typeof rec.body !== "string" || rec.body.trim().length < localBody.trim().length * 0.5)) {
          rec.body = localBody;
        }
      }
    }

    return proposeMaterialBundle(ctx, {
      projectId: session.projectId,
      sessionId: session.id,
      bundle: parsed,
      sourceOrigin: session.sourceOrigin,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.atomic(() => {
      stmt(ctx.db, "UPDATE author_material_ingests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?;")
        .run(message, Date.now(), session.id);
    });
    throw err;
  }
}
