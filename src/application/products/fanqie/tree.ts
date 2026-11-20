import { randomUUID } from "node:crypto";
import type { ActDto, ChapterTreeItemDto, NovelTreeDto, VolumeDto } from "../../../contracts/workspace-dto.ts";
import { ContractError } from "../../../contracts/index.ts";
import {
  flattenNovelOrder,
  planReorder,
  planTreeChapterMove,
  type HierarchyAct,
  type HierarchyChapter,
  type HierarchyVolume,
} from "../../../domain/fanqie/index.ts";
import { currentSeq, stmt, syncChapterFts } from "../../../storage/index.ts";
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
import { approvedFacts, assertFanqieProject, optionalNullableId, reorderRelations } from "./shared.ts";

function loadVolumes(ctx: WorkspaceContext, projectId: string): VolumeDto[] {
  return stmt(ctx.db, `
    SELECT id, project_id AS projectId, title, goal, summary, sort_order AS sortOrder, created_at AS createdAt
    FROM author_volumes
    WHERE project_id = ?
    ORDER BY sort_order ASC, rowid ASC;
  `).all(projectId) as VolumeDto[];
}

function loadActs(ctx: WorkspaceContext, projectId: string): ActDto[] {
  return stmt(ctx.db, `
    SELECT id, project_id AS projectId, volume_id AS volumeId, title, goal, summary,
      sort_order AS sortOrder, created_at AS createdAt
    FROM author_acts
    WHERE project_id = ?
    ORDER BY sort_order ASC, rowid ASC;
  `).all(projectId) as ActDto[];
}

function loadTreeChapters(ctx: WorkspaceContext, projectId: string) {
  return stmt(ctx.db, `
    SELECT a.id, a.title, a.state, a.volume_id AS volumeId, a.act_id AS actId,
      a.char_count AS charCount, a.summary, a.updated_at AS updatedAt, p.value AS planningJson
    FROM author_documents a
    LEFT JOIN author_planning p ON p.document_id = a.id
    WHERE a.project_id = ?
    ORDER BY a.rowid ASC;
  `).all(projectId) as readonly {
    id: string;
    title: string;
    state: string;
    volumeId: string | null;
    actId: string | null;
    charCount: number;
    summary: string;
    updatedAt: number;
    planningJson: string | null;
  }[];
}

function saveFlatOrder(ctx: WorkspaceContext, projectId: string, chapterIds: readonly string[]): void {
  stmt(ctx.db, `
    INSERT INTO author_chapter_order (project_id, chapter_ids) VALUES (?, ?)
    ON CONFLICT (project_id) DO UPDATE SET chapter_ids = excluded.chapter_ids;
  `).run(projectId, JSON.stringify(chapterIds));
}

function applyHierarchyOrderChecked(
  ctx: WorkspaceContext,
  projectId: string,
  action: string,
  volumes: readonly HierarchyVolume[],
  acts: readonly HierarchyAct[],
  chapters: readonly HierarchyChapter[],
  input: Input,
): string[] {
  const before = ctx.chapterOrder(projectId);
  const after = flattenNovelOrder(volumes, acts, chapters, before);
  const seq = currentSeq(ctx.db, projectId);
  if (input.asOfSeq !== undefined && input.asOfSeq !== seq) {
    throw new ContractError("version.conflict", {
      documentId: projectId,
      baseRevisionId: String(input.asOfSeq),
      currentRevisionId: String(seq),
    });
  }
  const plan = planReorder(reorderRelations(approvedFacts(ctx, projectId)), before, after);
  if (plan.requiresAuthorConfirmation && input.confirmed !== true) {
    refuse(action, "author-confirmation-required");
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    saveFlatOrder(ctx, projectId, after);
    ctx.event(projectId, "chapter", "chapter.reordered", { chapterIds: after });
  }
  return after;
}

export function attachChapterToTree(
  ctx: WorkspaceContext,
  projectId: string,
  documentId: string,
  input: Input,
): void {
  const volumeId = optionalNullableId(input, "volumeId") ?? null;
  const actId = optionalNullableId(input, "actId") ?? null;
  if (!volumeId && !actId) return;

  let resolvedVolumeId = volumeId;
  if (actId) {
    const act = requiredRow<{ projectId: string; volumeId: string }>(
      stmt(ctx.db, "SELECT project_id AS projectId, volume_id AS volumeId FROM author_acts WHERE id = ?;").get(actId),
      "act",
      actId,
    );
    if (act.projectId !== projectId) invalid("actId", "project-mismatch");
    if (resolvedVolumeId && act.volumeId !== resolvedVolumeId) invalid("actId", "act-volume-mismatch");
    resolvedVolumeId = act.volumeId;
  } else if (resolvedVolumeId) {
    const vol = requiredRow<{ projectId: string }>(
      stmt(ctx.db, "SELECT project_id AS projectId FROM author_volumes WHERE id = ?;").get(resolvedVolumeId),
      "volume",
      resolvedVolumeId,
    );
    if (vol.projectId !== projectId) invalid("volumeId", "project-mismatch");
  }

  stmt(ctx.db, "UPDATE author_documents SET volume_id = ?, act_id = ?, updated_at = ? WHERE id = ?;")
    .run(resolvedVolumeId, actId, Date.now(), documentId);

  const volumes = loadVolumes(ctx, projectId);
  const acts = loadActs(ctx, projectId);
  const chapters = loadTreeChapters(ctx, projectId);
  const flat = flattenNovelOrder(volumes, acts, chapters, ctx.chapterOrder(projectId));
  saveFlatOrder(ctx, projectId, flat);
  ctx.event(projectId, "chapter", "chapter.moved", {
    documentId,
    volumeId: resolvedVolumeId,
    actId,
  });
}

export function queryTree(ctx: WorkspaceContext, projectId: string): NovelTreeDto {
  const volumes = loadVolumes(ctx, projectId);
  const acts = loadActs(ctx, projectId);
  const rawChapters = loadTreeChapters(ctx, projectId);
  const order = ctx.chapterOrder(projectId, rawChapters);
  const byId = new Map(rawChapters.map((ch) => [ch.id, ch]));

  let totalChars = 0;
  const chapters: ChapterTreeItemDto[] = [];
  order.forEach((id, index) => {
    const row = byId.get(id);
    if (!row) return;
    totalChars += row.charCount;
    let targetLength: number | null = null;
    let viewpoint: string | null = null;
    if (row.planningJson) {
      try {
        const parsed = JSON.parse(row.planningJson) as { target?: unknown; viewpoint?: unknown };
        if (typeof parsed.target === "number") targetLength = parsed.target;
        if (typeof parsed.viewpoint === "string") viewpoint = parsed.viewpoint;
      } catch {
        // Ignore malformed legacy planning JSON.
      }
    }
    chapters.push({
      id: row.id,
      title: row.title,
      state: row.state,
      volumeId: row.volumeId,
      actId: row.actId,
      charCount: row.charCount,
      summary: row.summary,
      targetLength,
      viewpoint,
      order: index + 1,
      updatedAt: row.updatedAt,
    });
  });

  return {
    projectId,
    volumes,
    acts,
    chapters,
    totalChars,
    asOfSeq: currentSeq(ctx.db, projectId),
  };
}

export function getTree(ctx: WorkspaceContext, input: Input): NovelTreeDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  return ctx.read(() => queryTree(ctx, projectId));
}

export function createVolume(ctx: WorkspaceContext, input: Input): VolumeDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const title = text(input, "title").trim();
  const goal = optionalText(input, "goal") ?? "";
  const summary = optionalText(input, "summary") ?? "";
  return ctx.atomic(() => {
    const maxRow = stmt(ctx.db, "SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM author_volumes WHERE project_id = ?;")
      .get(projectId) as { maxOrder: number };
    const sortOrder = input.sortOrder !== undefined ? count(input, "sortOrder") : maxRow.maxOrder + 1;
    const id = randomUUID();
    const createdAt = Date.now();
    stmt(ctx.db, `
      INSERT INTO author_volumes (id, project_id, title, goal, summary, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `).run(id, projectId, title, goal, summary, sortOrder, createdAt);
    ctx.event(projectId, "chapter", "volume.created", { volumeId: id, title, sortOrder });
    return { id, projectId, title, goal, summary, sortOrder, createdAt };
  });
}

export function updateVolume(ctx: WorkspaceContext, input: Input): VolumeDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const volumeId = text(input, "volumeId");
  return ctx.atomic(() => {
    const existing = requiredRow<VolumeDto>(
      stmt(ctx.db, `
        SELECT id, project_id AS projectId, title, goal, summary, sort_order AS sortOrder, created_at AS createdAt
        FROM author_volumes WHERE id = ? AND project_id = ?;
      `).get(volumeId, projectId),
      "volume",
      volumeId,
    );
    const title = input.title !== undefined ? text(input, "title").trim() : existing.title;
    const goal = input.goal !== undefined ? (optionalText(input, "goal") ?? "") : existing.goal;
    const summary = input.summary !== undefined ? (optionalText(input, "summary") ?? "") : existing.summary;
    const sortOrder = input.sortOrder !== undefined ? count(input, "sortOrder") : existing.sortOrder;

    stmt(ctx.db, "UPDATE author_volumes SET title = ?, goal = ?, summary = ?, sort_order = ? WHERE id = ?;")
      .run(title, goal, summary, sortOrder, volumeId);

    if (title !== existing.title) {
      ctx.event(projectId, "chapter", "volume.renamed", { volumeId, title });
    }
    if (sortOrder !== existing.sortOrder) {
      applyHierarchyOrderChecked(
        ctx,
        projectId,
        "volume.update",
        loadVolumes(ctx, projectId),
        loadActs(ctx, projectId),
        loadTreeChapters(ctx, projectId),
        input,
      );
    }
    return { ...existing, title, goal, summary, sortOrder };
  });
}

export function deleteVolume(ctx: WorkspaceContext, input: Input) {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const volumeId = text(input, "volumeId");
  return ctx.atomic(() => {
    requiredRow(
      stmt(ctx.db, "SELECT id FROM author_volumes WHERE id = ? AND project_id = ?;").get(volumeId, projectId),
      "volume",
      volumeId,
    );
    const hasActs = stmt(ctx.db, "SELECT 1 FROM author_acts WHERE volume_id = ? LIMIT 1;").get(volumeId);
    const hasDocs = stmt(ctx.db, "SELECT 1 FROM author_documents WHERE volume_id = ? LIMIT 1;").get(volumeId);
    if (hasActs || hasDocs) refuse("volume.delete", "volume-not-empty");
    stmt(ctx.db, "DELETE FROM author_volumes WHERE id = ?;").run(volumeId);
    return { deleted: volumeId };
  });
}

export function createAct(ctx: WorkspaceContext, input: Input): ActDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const volumeId = text(input, "volumeId");
  const title = text(input, "title").trim();
  const goal = optionalText(input, "goal") ?? "";
  const summary = optionalText(input, "summary") ?? "";
  return ctx.atomic(() => {
    requiredRow(
      stmt(ctx.db, "SELECT id FROM author_volumes WHERE id = ? AND project_id = ?;").get(volumeId, projectId),
      "volume",
      volumeId,
    );
    const maxRow = stmt(ctx.db, "SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM author_acts WHERE volume_id = ?;")
      .get(volumeId) as { maxOrder: number };
    const sortOrder = input.sortOrder !== undefined ? count(input, "sortOrder") : maxRow.maxOrder + 1;
    const id = randomUUID();
    const createdAt = Date.now();
    stmt(ctx.db, `
      INSERT INTO author_acts (id, project_id, volume_id, title, goal, summary, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `).run(id, projectId, volumeId, title, goal, summary, sortOrder, createdAt);
    return { id, projectId, volumeId, title, goal, summary, sortOrder, createdAt };
  });
}

export function updateAct(ctx: WorkspaceContext, input: Input): ActDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const actId = text(input, "actId");
  return ctx.atomic(() => {
    const existing = requiredRow<ActDto>(
      stmt(ctx.db, `
        SELECT id, project_id AS projectId, volume_id AS volumeId, title, goal, summary,
          sort_order AS sortOrder, created_at AS createdAt
        FROM author_acts WHERE id = ? AND project_id = ?;
      `).get(actId, projectId),
      "act",
      actId,
    );
    const title = input.title !== undefined ? text(input, "title").trim() : existing.title;
    const goal = input.goal !== undefined ? (optionalText(input, "goal") ?? "") : existing.goal;
    const summary = input.summary !== undefined ? (optionalText(input, "summary") ?? "") : existing.summary;
    const sortOrder = input.sortOrder !== undefined ? count(input, "sortOrder") : existing.sortOrder;

    stmt(ctx.db, "UPDATE author_acts SET title = ?, goal = ?, summary = ?, sort_order = ? WHERE id = ?;")
      .run(title, goal, summary, sortOrder, actId);
    if (sortOrder !== existing.sortOrder) {
      applyHierarchyOrderChecked(
        ctx,
        projectId,
        "act.update",
        loadVolumes(ctx, projectId),
        loadActs(ctx, projectId),
        loadTreeChapters(ctx, projectId),
        input,
      );
    }
    return { ...existing, title, goal, summary, sortOrder };
  });
}

export function deleteAct(ctx: WorkspaceContext, input: Input) {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const actId = text(input, "actId");
  return ctx.atomic(() => {
    requiredRow(
      stmt(ctx.db, "SELECT id FROM author_acts WHERE id = ? AND project_id = ?;").get(actId, projectId),
      "act",
      actId,
    );
    const hasDocs = stmt(ctx.db, "SELECT 1 FROM author_documents WHERE act_id = ? LIMIT 1;").get(actId);
    if (hasDocs) refuse("act.delete", "act-not-empty");
    stmt(ctx.db, "DELETE FROM author_acts WHERE id = ?;").run(actId);
    return { deleted: actId };
  });
}

export function moveChapter(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
  if (row.product !== "fanqie") invalid("documentId", "chapter-required");
  const projectId = row.projectId;
  const targetVolumeId = optionalNullableId(input, "targetVolumeId") ?? null;
  const targetActId = optionalNullableId(input, "targetActId") ?? null;
  const beforeChapterId = optionalNullableId(input, "beforeChapterId");
  const targetIndex = input.targetIndex !== undefined ? count(input, "targetIndex") : undefined;

  const computePlan = () => {
    const volumes = loadVolumes(ctx, projectId);
    const acts = loadActs(ctx, projectId);
    const chapters = loadTreeChapters(ctx, projectId);
    const resolvedVolumeId =
      targetActId !== null && targetVolumeId === null
        ? (acts.find((a) => a.id === targetActId)?.volumeId ?? null)
        : targetVolumeId;
    const { beforeOrder, afterOrder } = planTreeChapterMove(
      volumes,
      acts,
      chapters,
      ctx.chapterOrder(projectId, chapters),
      {
        chapterId: row.id,
        targetVolumeId: resolvedVolumeId,
        targetActId,
        beforeChapterId,
        targetIndex,
      },
    );
    const plan = planReorder(reorderRelations(approvedFacts(ctx, projectId)), beforeOrder, afterOrder);
    return {
      ...plan,
      resolvedVolumeId,
      resolvedActId: targetActId,
      beforeOrder,
      chapterIds: afterOrder,
      asOfSeq: currentSeq(ctx.db, projectId),
    };
  };

  if (input.preview === true) {
    return ctx.read(() => {
      const computed = computePlan();
      return {
        impact: computed.impact,
        requiresAuthorConfirmation: computed.requiresAuthorConfirmation,
        chapterIds: computed.chapterIds,
        asOfSeq: computed.asOfSeq,
        volumeId: computed.resolvedVolumeId,
        actId: computed.resolvedActId,
      };
    });
  }

  return ctx.atomic(() => {
    const computed = computePlan();
    if (input.asOfSeq !== undefined && input.asOfSeq !== computed.asOfSeq) {
      throw new ContractError("version.conflict", {
        documentId: projectId,
        baseRevisionId: String(input.asOfSeq),
        currentRevisionId: String(computed.asOfSeq),
      });
    }
    if (computed.requiresAuthorConfirmation && input.confirmed !== true) {
      refuse("chapter.move", "author-confirmation-required");
    }
    stmt(ctx.db, "UPDATE author_documents SET volume_id = ?, act_id = ?, updated_at = ? WHERE id = ?;")
      .run(computed.resolvedVolumeId, computed.resolvedActId, Date.now(), row.id);
    if (JSON.stringify(computed.beforeOrder) !== JSON.stringify(computed.chapterIds)) {
      saveFlatOrder(ctx, projectId, computed.chapterIds);
      ctx.event(projectId, "chapter", "chapter.reordered", { chapterIds: computed.chapterIds });
    }
    ctx.event(projectId, "chapter", "chapter.moved", {
      documentId: row.id,
      volumeId: computed.resolvedVolumeId,
      actId: computed.resolvedActId,
    });
    return {
      documentId: row.id,
      volumeId: computed.resolvedVolumeId,
      actId: computed.resolvedActId,
      chapterIds: computed.chapterIds,
    };
  });
}

export function saveChapterSummary(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
  if (row.product !== "fanqie") invalid("documentId", "chapter-required");
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  return ctx.atomic(() => {
    stmt(ctx.db, "UPDATE author_documents SET summary = ?, updated_at = ? WHERE id = ?;")
      .run(summary, Date.now(), row.id);
    syncChapterFts(ctx.db, {
      projectId: row.projectId,
      documentId: row.id,
      title: row.title,
      summary,
      body: row.body ?? "",
    });
    ctx.event(row.projectId, "chapter", "chapter.summary", { documentId: row.id });
    return { documentId: row.id, summary };
  });
}
