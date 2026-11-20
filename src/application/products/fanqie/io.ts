import { createHash, randomUUID } from "node:crypto";
import type {
  LocalBundleFileDto,
  ProjectExportBundleDto,
  ProjectImportSummaryDto,
} from "../../../contracts/workspace-dto.ts";
import {
  assertSafeRelativePath,
  createDocument,
  parseChapterMarkdown,
  rebuildProjectFts,
  sanitizePathSegment,
  serializeChapterMarkdown,
  stmt,
} from "../../../storage/index.ts";
import { invalid, optionalText, refuse, text, type Input, type WorkspaceContext } from "../../context.ts";
import { queryDeconstructions, queryLibraryMounts, queryTechniques } from "./library.ts";
import { queryForeshadows, queryLore } from "./lore.ts";
import { assertFanqieProject } from "./shared.ts";
import { queryTree } from "./tree.ts";

export type ProjectBundleDiskWriter = (projectId: string, files: readonly LocalBundleFileDto[]) => string;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function padIndex(n: number, width = 2): string {
  return String(Math.max(1, n)).padStart(width, "0");
}

export function exportProjectBundle(
  ctx: WorkspaceContext,
  input: Input,
  writeToDiskFn?: ProjectBundleDiskWriter,
): ProjectExportBundleDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);

  const built = ctx.read(() => {
    const project = stmt(ctx.db, "SELECT id, name, product FROM author_projects WHERE id = ?;")
      .get(projectId) as { id: string; name: string; product: string };
    const tree = queryTree(ctx, projectId);
    const lore = queryLore(ctx, projectId, { all: true }).entries;
    const foreshadows = queryForeshadows(ctx, projectId);
    const mounts = queryLibraryMounts(ctx, projectId);

    const mountedIds = new Set(mounts.map((m) => `${m.itemKind}:${m.itemId}`));
    const deconstructions = queryDeconstructions(ctx, { projectId }).filter(
      (item) => item.scope === "project" || mountedIds.has(`deconstruction:${item.id}`),
    );
    const techniques = queryTechniques(ctx, { projectId }).filter(
      (item) => item.scope === "project" || mountedIds.has(`technique:${item.id}`),
    );

    const volumeById = new Map(tree.volumes.map((v, idx) => [v.id, { ...v, idx: idx + 1 }]));
    const actById = new Map(tree.acts.map((a, idx) => [a.id, { ...a, idx: idx + 1 }]));

    const files: LocalBundleFileDto[] = [];
    const getBodyStmt = stmt(ctx.db, `
      SELECT r.body, p.value AS planningJson
      FROM documents d
      LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
      LEFT JOIN author_planning p ON p.document_id = d.document_id
      WHERE d.document_id = ?;
    `);

    const exportedChapters = tree.chapters.map((ch, idx) => {
      const raw = getBodyStmt.get(ch.id) as { body?: string | null; planningJson?: string | null } | undefined;
      const body = raw?.body ?? "";
      let planning: Record<string, unknown> | null = null;
      if (raw?.planningJson) {
        try {
          planning = JSON.parse(raw.planningJson) as Record<string, unknown>;
        } catch {
          planning = null;
        }
      }
      const vol = ch.volumeId ? volumeById.get(ch.volumeId) : undefined;
      const act = ch.actId ? actById.get(ch.actId) : undefined;
      const volFolder = vol ? `${padIndex(vol.idx)}_${sanitizePathSegment(vol.title)}` : "00_未分卷";
      const actFolder = act ? `${padIndex(act.idx)}_${sanitizePathSegment(act.title)}` : null;
      const chName = `${padIndex(idx + 1, 3)}_${sanitizePathSegment(ch.title)}.md`;
      const path = actFolder ? `${volFolder}/${actFolder}/${chName}` : `${volFolder}/${chName}`;
      const content = serializeChapterMarkdown(
        {
          chapterId: ch.id,
          title: ch.title,
          state: ch.state,
          volume: vol?.title,
          act: act?.title,
          viewpoint: ch.viewpoint ?? undefined,
          target: ch.targetLength ?? undefined,
          summary: ch.summary || undefined,
        },
        body,
      );
      files.push({ path, content, sha256: sha256(content) });
      return { ...ch, path, planning };
    });

    const settingsMd = [
      `# ${project.name} · 动态设定库`,
      "",
      ...lore.map(
        (entry) =>
          `## [${entry.category}] ${entry.entityName ? `${entry.entityName} · ` : ""}${entry.factId}${entry.locked ? "（已锁定）" : ""}\n- 内容：${entry.fact.note}\n- 来源：${entry.fact.source}\n- 生效：${entry.fact.effectiveFrom.chapterId} #${entry.fact.effectiveFrom.point}`,
      ),
    ].join("\n\n");
    files.push({ path: "_worldbook/settings.md", content: settingsMd, sha256: sha256(settingsMd) });

    const foreshadowsMd = [
      `# ${project.name} · 伏笔追踪`,
      "",
      ...foreshadows.map(
        (fs) => `## ${fs.title} [${fs.status}]\n- 关联设定：${fs.factId ?? "无"}\n- 备注：${fs.note || "无"}`,
      ),
    ].join("\n\n");
    files.push({ path: "_worldbook/foreshadows.md", content: foreshadowsMd, sha256: sha256(foreshadowsMd) });

    const deconstructMd = [
      `# 拆书库快照`,
      "",
      ...deconstructions.map(
        (item) =>
          `## ${item.title} (${item.scope})\n- 出处：${item.sourceBook}\n- 钩子：${item.hookAnalysis}\n- 冲突：${item.conflictBeats}\n- 节奏：${item.payoffRhythm}\n\n> ${item.excerpt}`,
      ),
    ].join("\n\n");
    files.push({ path: "_library/deconstructions.md", content: deconstructMd, sha256: sha256(deconstructMd) });

    const techniqueMd = [
      `# 技法卡片快照`,
      "",
      ...techniques.map(
        (card) =>
          `## ${card.title} [${card.category}]\n- 触发：${card.triggerWhen}\n- 步骤：${card.executionSteps}\n- 约束：${card.constraints}\n- 禁忌：${card.antiPatterns}`,
      ),
    ].join("\n\n");
    files.push({ path: "_library/techniques.md", content: techniqueMd, sha256: sha256(techniqueMd) });

    const exportedAt = new Date().toISOString();
    const manifestJson = JSON.stringify(
      {
        format: "zhizhang-novel-bundle/v1",
        exportedAt,
        project,
        volumes: tree.volumes,
        acts: tree.acts,
        chapters: exportedChapters,
        lore,
        foreshadows,
        deconstructions,
        techniques,
        mounts,
      },
      null,
      2,
    );
    files.unshift({ path: "zhizhang-project.json", content: manifestJson, sha256: sha256(manifestJson) });

    return { projectId: project.id, projectName: project.name, exportedAt, files };
  });

  const writtenDirectory =
    input.writeToDisk === true && writeToDiskFn ? writeToDiskFn(projectId, built.files) : null;

  return { ...built, writtenDirectory };
}

interface ManifestAnchor {
  readonly chapterId?: string;
  readonly point?: number;
}

interface ParsedManifest {
  readonly project?: { readonly name?: string };
  readonly volumes?: readonly { id: string; title: string; goal?: string; summary?: string; sortOrder?: number }[];
  readonly acts?: readonly { id: string; volumeId: string; title: string; goal?: string; summary?: string; sortOrder?: number }[];
  readonly chapters?: readonly {
    id: string;
    title: string;
    volumeId?: string | null;
    actId?: string | null;
    summary?: string;
    path?: string;
    planning?: Record<string, unknown> | null;
  }[];
  readonly lore?: readonly {
    factId: string;
    category?: string;
    entityName?: string;
    fact?: {
      note?: string;
      source?: string;
      locked?: boolean;
      kind?: string;
      effectiveFrom?: ManifestAnchor;
      effectiveTo?: ManifestAnchor;
      knownFrom?: Readonly<Record<string, ManifestAnchor>>;
    };
  }[];
  readonly foreshadows?: readonly {
    id?: string;
    factId?: string | null;
    title?: string;
    plantedChapterId?: string | null;
    plantedPoint?: number;
    targetChapterId?: string | null;
    resolvedChapterId?: string | null;
    status?: string;
    note?: string;
  }[];
  readonly deconstructions?: readonly Record<string, unknown>[];
  readonly techniques?: readonly Record<string, unknown>[];
  readonly mounts?: readonly {
    targetType?: string;
    targetId?: string;
    itemKind?: string;
    itemId?: string;
    mode?: string;
    weight?: number;
    note?: string;
  }[];
}

const VALID_FS_STATUSES = new Set(["proposed", "planted", "hinted", "resolved", "abandoned"]);

function remapAnchor(
  raw: ManifestAnchor | undefined,
  chapterIdMap: Map<string, string>,
  validChapterIds: Set<string>,
  fallbackChapterId: string,
): { readonly chapterId: string; readonly point: number } {
  const srcId = raw?.chapterId;
  const mappedId = srcId
    ? (chapterIdMap.get(srcId) ?? (validChapterIds.has(srcId) ? srcId : fallbackChapterId))
    : fallbackChapterId;
  const pt = typeof raw?.point === "number" && Number.isSafeInteger(raw.point) && raw.point >= 1 ? raw.point : 1;
  return { chapterId: mappedId, point: pt };
}

export function importProjectBundle(ctx: WorkspaceContext, input: Input): ProjectImportSummaryDto {
  const rawFiles = input.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    invalid("files", "non-empty-bundle-files-required");
  }

  const normalizedFiles = rawFiles.map((item, idx) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      invalid("files", `invalid-file-entry-${idx}`);
    }
    const record = item as { path?: unknown; content?: unknown };
    if (typeof record.path !== "string" || typeof record.content !== "string") {
      invalid("files", `invalid-file-fields-${idx}`);
    }
    return { path: assertSafeRelativePath(record.path), content: record.content };
  });

  const manifestEntry = normalizedFiles.find(
    (f) => f.path === "zhizhang-project.json" || f.path.endsWith("/zhizhang-project.json"),
  );
  let manifest: ParsedManifest | null = null;
  if (manifestEntry) {
    try {
      manifest = JSON.parse(manifestEntry.content) as ParsedManifest;
    } catch {
      invalid("files", "invalid-manifest-json");
    }
  }

  const requestedProjectId = optionalText(input, "projectId");
  const projectName = optionalText(input, "projectName") ?? manifest?.project?.name?.trim() ?? "导入长篇项目";

  return ctx.atomic(() => {
    const now = Date.now();
    let projectId = requestedProjectId;
    if (projectId) {
      assertFanqieProject(ctx, projectId);
    } else {
      projectId = randomUUID();
      stmt(ctx.db, "INSERT INTO author_projects (id, name, product, created_at) VALUES (?, ?, 'fanqie', ?);")
        .run(projectId, projectName, now);
      ctx.event(projectId, "chapter", "project.created", { name: projectName, product: "fanqie" });
    }

    const volumeIdMap = new Map<string, string>();
    const volumeTitleMap = new Map<string, string>();
    const existingVols = stmt(ctx.db, "SELECT id, title FROM author_volumes WHERE project_id = ?;")
      .all(projectId) as readonly { id: string; title: string }[];
    for (const v of existingVols) {
      volumeIdMap.set(v.id, v.id);
      volumeTitleMap.set(v.title, v.id);
    }

    let volumesCreated = 0;
    const ensureVolume = (title: string, sourceId?: string, goal = "", summary = "", sortOrder?: number): string => {
      if (sourceId && volumeIdMap.has(sourceId)) return volumeIdMap.get(sourceId)!;
      const byTitle = volumeTitleMap.get(title);
      if (byTitle) {
        if (sourceId) volumeIdMap.set(sourceId, byTitle);
        return byTitle;
      }
      const id = randomUUID();
      const order = sortOrder ?? volumeTitleMap.size + 1;
      stmt(ctx.db, `
        INSERT INTO author_volumes (id, project_id, title, goal, summary, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?);
      `).run(id, projectId, title, goal, summary, order, now);
      ctx.event(projectId!, "chapter", "volume.created", { volumeId: id, title, sortOrder: order });
      volumeIdMap.set(id, id);
      if (sourceId) volumeIdMap.set(sourceId, id);
      volumeTitleMap.set(title, id);
      volumesCreated += 1;
      return id;
    };

    for (const vol of manifest?.volumes ?? []) {
      ensureVolume(vol.title, vol.id, vol.goal ?? "", vol.summary ?? "", vol.sortOrder);
    }

    const actIdMap = new Map<string, string>();
    const actKeyMap = new Map<string, string>();
    const existingActs = stmt(ctx.db, "SELECT id, volume_id AS volumeId, title FROM author_acts WHERE project_id = ?;")
      .all(projectId) as readonly { id: string; volumeId: string; title: string }[];
    for (const a of existingActs) {
      actIdMap.set(a.id, a.id);
      actKeyMap.set(`${a.volumeId}\0${a.title}`, a.id);
    }

    let actsCreated = 0;
    const ensureAct = (
      volumeId: string,
      title: string,
      sourceId?: string,
      goal = "",
      summary = "",
      sortOrder?: number,
    ): string => {
      if (sourceId && actIdMap.has(sourceId)) return actIdMap.get(sourceId)!;
      const key = `${volumeId}\0${title}`;
      const existingId = actKeyMap.get(key);
      if (existingId) {
        if (sourceId) actIdMap.set(sourceId, existingId);
        return existingId;
      }
      const id = randomUUID();
      const order = sortOrder ?? actKeyMap.size + 1;
      stmt(ctx.db, `
        INSERT INTO author_acts (id, project_id, volume_id, title, goal, summary, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `).run(id, projectId, volumeId, title, goal, summary, order, now);
      ctx.event(projectId!, "chapter", "act.created", { actId: id, volumeId, title, sortOrder: order });
      actIdMap.set(id, id);
      if (sourceId) actIdMap.set(sourceId, id);
      actKeyMap.set(key, id);
      actsCreated += 1;
      return id;
    };

    for (const act of manifest?.acts ?? []) {
      const mappedVol = volumeIdMap.get(act.volumeId);
      if (mappedVol) ensureAct(mappedVol, act.title, act.id, act.goal ?? "", act.summary ?? "", act.sortOrder);
    }

    const existingDocs = stmt(ctx.db, `
      SELECT id, title, state, volume_id AS volumeId, act_id AS actId
      FROM author_documents WHERE project_id = ? ORDER BY rowid ASC;
    `).all(projectId) as readonly {
      id: string;
      title: string;
      state: string;
      volumeId: string | null;
      actId: string | null;
    }[];
    const existingDocById = new Map(existingDocs.map((d) => [d.id, d]));
    const existingDocsByKey = new Map<string, typeof existingDocs[number]>();
    for (const d of existingDocs) {
      const key = `${d.volumeId ?? ""}\0${d.actId ?? ""}\0${d.title}`;
      if (!existingDocsByKey.has(key)) existingDocsByKey.set(key, d);
    }
    const validDocIdsInProject = new Set(existingDocs.map((d) => d.id));
    const claimedDocIds = new Set<string>();
    const chapterIdMap = new Map<string, string>();

    const manifestChapterByPath = new Map(
      (manifest?.chapters ?? []).filter((c) => c.path).map((c) => [c.path!, c]),
    );
    const mdFiles = normalizedFiles
      .filter(
        (file) =>
          file.path.endsWith(".md") &&
          !file.path.startsWith("_worldbook/") &&
          !file.path.startsWith("_library/"),
      )
      .sort((a, b) => a.path.localeCompare(b.path));

    let chaptersCreated = 0;
    let chaptersUpdated = 0;
    const chaptersSkippedLocked: string[] = [];
    const importedChapterOrder: string[] = [];

    for (const file of mdFiles) {
      const { meta, body } = parseChapterMarkdown(file.content);
      const manifestCh = manifestChapterByPath.get(file.path);
      const segments = file.path.split("/");
      const rawFileTitle = segments[segments.length - 1]
        .replace(/\.md$/iu, "")
        .replace(/^\d+_/u, "");
      const title = (meta.title ?? manifestCh?.title ?? rawFileTitle).trim() || "未命名章节";

      let volumeId: string | null = null;
      let actId: string | null = null;
      if (manifestCh?.volumeId && volumeIdMap.has(manifestCh.volumeId)) {
        volumeId = volumeIdMap.get(manifestCh.volumeId)!;
      } else if (meta.volume) {
        volumeId = ensureVolume(meta.volume);
      } else if (segments.length >= 2 && !segments[0].startsWith("00_")) {
        volumeId = ensureVolume(segments[0].replace(/^\d+_/u, "") || segments[0]);
      }

      if (manifestCh?.actId && actIdMap.has(manifestCh.actId)) {
        actId = actIdMap.get(manifestCh.actId)!;
      } else if (volumeId && meta.act) {
        actId = ensureAct(volumeId, meta.act);
      } else if (volumeId && segments.length >= 3) {
        actId = ensureAct(volumeId, segments[1].replace(/^\d+_/u, "") || segments[1]);
      }

      const candidateId = meta.chapterId ?? manifestCh?.id;
      const matchedById = candidateId ? existingDocById.get(candidateId) : undefined;
      const fallbackByKey = existingDocsByKey.get(`${volumeId ?? ""}\0${actId ?? ""}\0${title}`);
      const existingDoc = matchedById ?? (fallbackByKey && !claimedDocIds.has(fallbackByKey.id) ? fallbackByKey : undefined);

      let targetDocId: string;
      if (existingDoc) {
        targetDocId = existingDoc.id;
        claimedDocIds.add(targetDocId);
        if (meta.chapterId) chapterIdMap.set(meta.chapterId, targetDocId);
        if (manifestCh?.id) chapterIdMap.set(manifestCh.id, targetDocId);

        if (existingDoc.state === "final") {
          chaptersSkippedLocked.push(targetDocId);
          importedChapterOrder.push(targetDocId);
          continue;
        }
        const row = ctx.document(targetDocId);
        const nextSummary = meta.summary ?? manifestCh?.summary ?? row.summary;
        const metaChanged =
          title !== row.title || volumeId !== row.volumeId || actId !== row.actId || nextSummary !== row.summary;
        const bodyChanged = body !== (row.body ?? "");

        if (metaChanged) {
          stmt(ctx.db, "UPDATE author_documents SET title = ?, volume_id = ?, act_id = ?, summary = ?, updated_at = ? WHERE id = ?;")
            .run(title, volumeId, actId, nextSummary, now, targetDocId);
          ctx.event(projectId, "chapter", "chapter.updated", { documentId: targetDocId });
        }
        if (bodyChanged) {
          ctx.appendDraftRevision(ctx.document(targetDocId), body, (saved) => {
            const nextState = saved.state === "planned" || saved.state === "drafting" ? "drafting" : "drafted";
            stmt(ctx.db, "UPDATE author_documents SET state = ? WHERE id = ?;").run(nextState, saved.id);
            ctx.event(projectId!, "chapter", "document.state", { documentId: saved.id, state: nextState });
          });
        }
        if (metaChanged || bodyChanged) {
          chaptersUpdated += 1;
        }
      } else {
        targetDocId = randomUUID();
        createDocument(ctx.db, targetDocId);
        const initialState = body.trim() ? "drafting" : "planned";
        stmt(ctx.db, `
          INSERT INTO author_documents (id, project_id, title, state, mode, line, volume_id, act_id, summary, updated_at)
          VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?);
        `).run(targetDocId, projectId, title, initialState, volumeId, actId, meta.summary ?? manifestCh?.summary ?? "", now);
        ctx.event(projectId, "chapter", "document.created", {
          documentId: targetDocId, title, mode: null, line: null, state: initialState,
        });
        if (body.length > 0) {
          ctx.appendDraftRevision(ctx.document(targetDocId), body, () => {});
        }
        if (manifestCh?.planning) {
          ctx.savePlanning(ctx.document(targetDocId), manifestCh.planning);
        }
        if (meta.chapterId) chapterIdMap.set(meta.chapterId, targetDocId);
        if (manifestCh?.id) chapterIdMap.set(manifestCh.id, targetDocId);
        validDocIdsInProject.add(targetDocId);
        chaptersCreated += 1;
      }
      importedChapterOrder.push(targetDocId);
    }

    if (importedChapterOrder.length > 0) {
      const merged = ctx.chapterOrder(projectId);
      const finalOrder = [...new Set([...merged, ...importedChapterOrder])];
      if (JSON.stringify(merged) !== JSON.stringify(finalOrder)) {
        stmt(ctx.db, `
          INSERT INTO author_chapter_order (project_id, chapter_ids) VALUES (?, ?)
          ON CONFLICT (project_id) DO UPDATE SET chapter_ids = excluded.chapter_ids;
        `).run(projectId, JSON.stringify(finalOrder));
      }
    }

    // Idempotent lore proposal import (skips locked settings & identical existing approved/pending entries)
    let loreProposed = 0;
    const defaultChapterId = importedChapterOrder[0] ?? ctx.chapterOrder(projectId)[0];
    for (const item of manifest?.lore ?? []) {
      if (!item.factId || !item.fact?.note) continue;
      if (!defaultChapterId) continue;

      const effectiveFrom = remapAnchor(item.fact.effectiveFrom, chapterIdMap, validDocIdsInProject, defaultChapterId);
      const effectiveTo = item.fact.effectiveTo
        ? remapAnchor(item.fact.effectiveTo, chapterIdMap, validDocIdsInProject, defaultChapterId)
        : undefined;
      const knownFrom: Record<string, { chapterId: string; point: number }> = {};
      if (item.fact.knownFrom && typeof item.fact.knownFrom === "object") {
        for (const [charName, anc] of Object.entries(item.fact.knownFrom)) {
          knownFrom[charName] = remapAnchor(anc, chapterIdMap, validDocIdsInProject, defaultChapterId);
        }
      }
      const category = item.category ?? "world_rule";
      const entityName = item.entityName ?? "";
      const factValue = {
        id: item.factId,
        note: item.fact.note,
        source: item.fact.source ?? "本地资产包导入提案",
        kind: item.fact.kind === "agreement" ? "agreement" : "fact",
        locked: item.fact.locked === true,
        effectiveFrom,
        ...(effectiveTo ? { effectiveTo } : {}),
        knownFrom,
      };
      const factJson = JSON.stringify(factValue);

      const approvedRow = stmt(ctx.db, `
        SELECT locked, value FROM author_lore_current WHERE project_id = ? AND fact_id = ?;
      `).get(projectId, item.factId) as { locked?: number; value?: string } | undefined;
      if (approvedRow?.locked === 1 || approvedRow?.value === factJson) continue;

      const existingPending = stmt(ctx.db, `
        SELECT 1 FROM author_settings
        WHERE project_id = ? AND fact_id = ? AND decision = 'pending' AND value = ?
        LIMIT 1;
      `).get(projectId, item.factId, factJson);
      if (existingPending) continue;

      const proposalId = randomUUID();
      stmt(ctx.db, `
        INSERT INTO author_settings (id, project_id, fact_id, category, entity_name, value, decision)
        VALUES (?, ?, ?, ?, ?, ?, 'pending');
      `).run(proposalId, projectId, item.factId, category, entityName, factJson);
      ctx.event(projectId, "setting", "setting.proposed", { id: proposalId, factId: item.factId });
      loreProposed += 1;
    }

    // Restore foreshadows idempotently
    let foreshadowsImported = 0;
    const remapOptionalCh = (src: string | null | undefined): string | null => {
      if (!src) return null;
      return chapterIdMap.get(src) ?? (validDocIdsInProject.has(src) ? src : null);
    };
    const existingFsRows = stmt(ctx.db, `
      SELECT id, fact_id AS factId, title, planted_chapter_id AS plantedChapterId, planted_point AS plantedPoint,
        target_chapter_id AS targetChapterId, resolved_chapter_id AS resolvedChapterId, status, note
      FROM author_foreshadows WHERE project_id = ?;
    `).all(projectId) as readonly {
      id: string;
      factId: string | null;
      title: string;
      plantedChapterId: string | null;
      plantedPoint: number;
      targetChapterId: string | null;
      resolvedChapterId: string | null;
      status: string;
      note: string;
    }[];
    const fsById = new Map(existingFsRows.map((f) => [f.id, f]));
    const fsByKey = new Map(existingFsRows.map((f) => [`${f.title}\0${f.factId ?? ""}`, f]));

    for (const fs of manifest?.foreshadows ?? []) {
      const title = typeof fs.title === "string" ? fs.title.trim() : "";
      if (!title) continue;
      const factId = typeof fs.factId === "string" && fs.factId.trim() ? fs.factId.trim() : null;
      const status = typeof fs.status === "string" && VALID_FS_STATUSES.has(fs.status) ? fs.status : "planted";
      const plantedChapterId = remapOptionalCh(fs.plantedChapterId);
      const targetChapterId = remapOptionalCh(fs.targetChapterId);
      const resolvedChapterId = remapOptionalCh(fs.resolvedChapterId);
      const plantedPoint = typeof fs.plantedPoint === "number" && Number.isSafeInteger(fs.plantedPoint) && fs.plantedPoint >= 1
        ? fs.plantedPoint
        : 1;
      const note = typeof fs.note === "string" ? fs.note.trim() : "";

      const match = (fs.id ? fsById.get(fs.id) : undefined) ?? fsByKey.get(`${title}\0${factId ?? ""}`);
      if (match) {
        const same =
          match.factId === factId &&
          match.plantedChapterId === plantedChapterId &&
          match.plantedPoint === plantedPoint &&
          match.targetChapterId === targetChapterId &&
          match.resolvedChapterId === resolvedChapterId &&
          match.status === status &&
          match.note === note;
        if (same) continue;
        stmt(ctx.db, `
          UPDATE author_foreshadows
          SET fact_id = ?, planted_chapter_id = ?, planted_point = ?,
              target_chapter_id = ?, resolved_chapter_id = ?, status = ?, note = ?, updated_at = ?
          WHERE id = ?;
        `).run(factId, plantedChapterId, plantedPoint, targetChapterId, resolvedChapterId, status, note, now, match.id);
        ctx.event(projectId, "setting", "foreshadow.updated", { id: match.id, status });
        foreshadowsImported += 1;
      } else {
        const newFsId = randomUUID();
        stmt(ctx.db, `
          INSERT INTO author_foreshadows (
            id, project_id, fact_id, title, planted_chapter_id, planted_point,
            target_chapter_id, resolved_chapter_id, status, note, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        `).run(newFsId, projectId, factId, title, plantedChapterId, plantedPoint, targetChapterId, resolvedChapterId, status, note, now);
        ctx.event(projectId, "setting", "foreshadow.updated", { id: newFsId, status });
        const inserted = {
          id: newFsId, factId, title, plantedChapterId, plantedPoint, targetChapterId, resolvedChapterId, status, note,
        };
        fsById.set(newFsId, inserted);
        fsByKey.set(`${title}\0${factId ?? ""}`, inserted);
        foreshadowsImported += 1;
      }
    }

    // Idempotent library deconstruction & technique import
    let libraryImported = 0;
    const deconstructIdMap = new Map<string, string>();
    const existingDecs = stmt(ctx.db, `
      SELECT id, scope, project_id AS projectId, title, source_book AS sourceBook, genre, pacing,
        tags_json AS tagsJson, excerpt, hook_analysis AS hookAnalysis, conflict_beats AS conflictBeats,
        payoff_rhythm AS payoffRhythm, prose_notes AS proseNotes
      FROM library_deconstructions WHERE scope = 'global' OR project_id = ?;
    `).all(projectId) as readonly {
      id: string; scope: string; projectId: string | null; title: string; sourceBook: string;
      genre: string; pacing: string; tagsJson: string; excerpt: string; hookAnalysis: string;
      conflictBeats: string; payoffRhythm: string; proseNotes: string;
    }[];
    const decById = new Map(existingDecs.map((d) => [d.id, d]));
    const decByProjectKey = new Map(
      existingDecs.filter((d) => d.projectId === projectId).map((d) => [`${d.title}\0${d.sourceBook}`, d]),
    );

    for (const dec of manifest?.deconstructions ?? []) {
      if (typeof dec.title !== "string" || typeof dec.excerpt !== "string") continue;
      const srcId = typeof dec.id === "string" ? dec.id : undefined;
      const sourceBook = typeof dec.sourceBook === "string" ? dec.sourceBook : "";
      const genre = typeof dec.genre === "string" ? dec.genre : "";
      const pacing = typeof dec.pacing === "string" ? dec.pacing : "";
      const tagsJson = JSON.stringify(Array.isArray(dec.tags) ? dec.tags : []);
      const hookAnalysis = typeof dec.hookAnalysis === "string" ? dec.hookAnalysis : "";
      const conflictBeats = typeof dec.conflictBeats === "string" ? dec.conflictBeats : "";
      const payoffRhythm = typeof dec.payoffRhythm === "string" ? dec.payoffRhythm : "";
      const proseNotes = typeof dec.proseNotes === "string" ? dec.proseNotes : "";
      const incomingHash = sha256(JSON.stringify([
        dec.title, sourceBook, genre, pacing, tagsJson, dec.excerpt, hookAnalysis, conflictBeats, payoffRhythm, proseNotes,
      ]));

      const idMatch = srcId ? decById.get(srcId) : undefined;
      if (idMatch && idMatch.scope === "global") {
        deconstructIdMap.set(srcId!, idMatch.id);
        continue;
      }
      const existing = (idMatch && idMatch.projectId === projectId ? idMatch : undefined) ??
        decByProjectKey.get(`${dec.title}\0${sourceBook}`);
      if (existing) {
        if (srcId) deconstructIdMap.set(srcId, existing.id);
        const existingHash = sha256(JSON.stringify([
          existing.title, existing.sourceBook, existing.genre, existing.pacing, existing.tagsJson,
          existing.excerpt, existing.hookAnalysis, existing.conflictBeats, existing.payoffRhythm, existing.proseNotes,
        ]));
        if (existingHash === incomingHash) continue;
        stmt(ctx.db, `
          UPDATE library_deconstructions
          SET genre = ?, pacing = ?, tags_json = ?, excerpt = ?, hook_analysis = ?,
              conflict_beats = ?, payoff_rhythm = ?, prose_notes = ?, updated_at = ?
          WHERE id = ?;
        `).run(genre, pacing, tagsJson, dec.excerpt, hookAnalysis, conflictBeats, payoffRhythm, proseNotes, now, existing.id);
        libraryImported += 1;
      } else {
        const decId = randomUUID();
        stmt(ctx.db, `
          INSERT INTO library_deconstructions (
            id, scope, project_id, title, source_book, genre, pacing, tags_json, excerpt,
            hook_analysis, conflict_beats, payoff_rhythm, prose_notes, status, source_kind, created_at, updated_at
          ) VALUES (?, 'project', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'import', ?, ?);
        `).run(
          decId, projectId, dec.title, sourceBook, genre, pacing, tagsJson,
          dec.excerpt, hookAnalysis, conflictBeats, payoffRhythm, proseNotes, now, now,
        );
        if (srcId) deconstructIdMap.set(srcId, decId);
        libraryImported += 1;
      }
    }

    const techniqueIdMap = new Map<string, string>();
    const existingTechs = stmt(ctx.db, `
      SELECT id, scope, project_id AS projectId, title, category, pacing, scene_tags_json AS sceneTagsJson,
        trigger_when AS triggerWhen, execution_steps AS executionSteps, constraints, anti_patterns AS antiPatterns,
        example_excerpt AS exampleExcerpt, priority
      FROM library_technique_cards WHERE scope = 'global' OR project_id = ?;
    `).all(projectId) as readonly {
      id: string; scope: string; projectId: string | null; title: string; category: string; pacing: string;
      sceneTagsJson: string; triggerWhen: string; executionSteps: string; constraints: string;
      antiPatterns: string; exampleExcerpt: string; priority: number;
    }[];
    const techById = new Map(existingTechs.map((t) => [t.id, t]));
    const techByProjectKey = new Map(
      existingTechs.filter((t) => t.projectId === projectId).map((t) => [`${t.title}\0${t.category}`, t]),
    );

    for (const card of manifest?.techniques ?? []) {
      if (typeof card.title !== "string" || typeof card.executionSteps !== "string") continue;
      const srcId = typeof card.id === "string" ? card.id : undefined;
      const category = typeof card.category === "string" ? card.category : "narrative";
      const pacing = typeof card.pacing === "string" ? card.pacing : "";
      const sceneTagsJson = JSON.stringify(Array.isArray(card.sceneTags) ? card.sceneTags : []);
      const triggerWhen = typeof card.triggerWhen === "string" ? card.triggerWhen : "";
      const constraints = typeof card.constraints === "string" ? card.constraints : "";
      const antiPatterns = typeof card.antiPatterns === "string" ? card.antiPatterns : "";
      const exampleExcerpt = typeof card.exampleExcerpt === "string" ? card.exampleExcerpt : "";
      const priority = typeof card.priority === "number" ? card.priority : 50;
      const incomingHash = sha256(JSON.stringify([
        card.title, category, pacing, sceneTagsJson, triggerWhen, card.executionSteps, constraints, antiPatterns, exampleExcerpt, priority,
      ]));

      const idMatch = srcId ? techById.get(srcId) : undefined;
      if (idMatch && idMatch.scope === "global") {
        techniqueIdMap.set(srcId!, idMatch.id);
        continue;
      }
      const existing = (idMatch && idMatch.projectId === projectId ? idMatch : undefined) ??
        techByProjectKey.get(`${card.title}\0${category}`);
      if (existing) {
        if (srcId) techniqueIdMap.set(srcId, existing.id);
        const existingHash = sha256(JSON.stringify([
          existing.title, existing.category, existing.pacing, existing.sceneTagsJson, existing.triggerWhen,
          existing.executionSteps, existing.constraints, existing.antiPatterns, existing.exampleExcerpt, existing.priority,
        ]));
        if (existingHash === incomingHash) continue;
        stmt(ctx.db, `
          UPDATE library_technique_cards
          SET pacing = ?, scene_tags_json = ?, trigger_when = ?, execution_steps = ?,
              constraints = ?, anti_patterns = ?, example_excerpt = ?, priority = ?, updated_at = ?
          WHERE id = ?;
        `).run(pacing, sceneTagsJson, triggerWhen, card.executionSteps, constraints, antiPatterns, exampleExcerpt, priority, now, existing.id);
        libraryImported += 1;
      } else {
        const cardId = randomUUID();
        stmt(ctx.db, `
          INSERT INTO library_technique_cards (
            id, scope, project_id, title, category, pacing, scene_tags_json,
            trigger_when, execution_steps, constraints, anti_patterns, example_excerpt,
            priority, status, source_kind, created_at, updated_at
          ) VALUES (?, 'project', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'import', ?, ?);
        `).run(
          cardId, projectId, card.title, category, pacing, sceneTagsJson, triggerWhen,
          card.executionSteps, constraints, antiPatterns, exampleExcerpt, priority, now, now,
        );
        if (srcId) techniqueIdMap.set(srcId, cardId);
        libraryImported += 1;
      }
    }

    // Restore author_library_mounts with ID remapping & deduplication
    let mountsRestored = 0;
    const existingMounts = stmt(ctx.db, `
      SELECT target_type AS targetType, target_id AS targetId, item_kind AS itemKind, item_id AS itemId, mode, weight, note
      FROM author_library_mounts WHERE project_id = ?;
    `).all(projectId) as readonly {
      targetType: string; targetId: string; itemKind: string; itemId: string; mode: string; weight: number; note: string;
    }[];
    const mountMap = new Map(
      existingMounts.map((m) => [`${m.targetType}\0${m.targetId}\0${m.itemKind}\0${m.itemId}`, m]),
    );

    for (const m of manifest?.mounts ?? []) {
      const targetType = m.targetType;
      const itemKind = m.itemKind;
      if (
        (targetType !== "project" && targetType !== "volume" && targetType !== "act" && targetType !== "chapter") ||
        (itemKind !== "deconstruction" && itemKind !== "technique") ||
        typeof m.targetId !== "string" ||
        typeof m.itemId !== "string"
      ) {
        continue;
      }
      const targetId = targetType === "project"
        ? projectId
        : targetType === "volume"
          ? volumeIdMap.get(m.targetId)
          : targetType === "act"
            ? actIdMap.get(m.targetId)
            : (chapterIdMap.get(m.targetId) ?? (validDocIdsInProject.has(m.targetId) ? m.targetId : undefined));
      if (!targetId) continue;

      const itemId = itemKind === "deconstruction"
        ? (deconstructIdMap.get(m.itemId) ?? m.itemId)
        : (techniqueIdMap.get(m.itemId) ?? m.itemId);
      const libTable = itemKind === "deconstruction" ? "library_deconstructions" : "library_technique_cards";
      const itemExists = stmt(ctx.db, `SELECT 1 FROM ${libTable} WHERE id = ? AND (scope = 'global' OR project_id = ?);`)
        .get(itemId, projectId);
      if (!itemExists) continue;

      const mode = m.mode === "exclude" || m.mode === "pin" ? m.mode : "include";
      const weight = typeof m.weight === "number" && Number.isSafeInteger(m.weight) && m.weight >= 0 ? m.weight : 100;
      const note = typeof m.note === "string" ? m.note.trim() : "";

      const mountKey = `${targetType}\0${targetId}\0${itemKind}\0${itemId}`;
      const existing = mountMap.get(mountKey);
      if (existing && existing.mode === mode && existing.weight === weight && existing.note === note) {
        continue;
      }
      stmt(ctx.db, `
        INSERT INTO author_library_mounts (id, project_id, target_type, target_id, item_kind, item_id, mode, weight, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (project_id, target_type, target_id, item_kind, item_id) DO UPDATE SET
          mode = excluded.mode, weight = excluded.weight, note = excluded.note;
      `).run(randomUUID(), projectId, targetType, targetId, itemKind, itemId, mode, weight, note);
      mountMap.set(mountKey, { targetType, targetId, itemKind, itemId, mode, weight, note });
      ctx.event(projectId, "setting", "library.mounted", { targetType, targetId, itemKind, itemId, mode });
      mountsRestored += 1;
    }

    rebuildProjectFts(ctx.db, projectId);
    if (chaptersSkippedLocked.length > 0 && requestedProjectId && chaptersCreated === 0 && chaptersUpdated === 0 && loreProposed === 0 && libraryImported === 0 && foreshadowsImported === 0 && mountsRestored === 0) {
      void refuse;
    }

    return {
      projectId,
      volumesCreated,
      actsCreated,
      chaptersCreated,
      chaptersUpdated,
      chaptersSkippedLocked,
      loreProposed,
      libraryImported,
      foreshadowsImported,
      mountsRestored,
    };
  });
}
