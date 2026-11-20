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
    const lore = queryLore(ctx, projectId).entries;
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
      return {
        ...ch,
        path,
        planning,
      };
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

    return {
      projectId: project.id,
      projectName: project.name,
      exportedAt,
      files,
    };
  });

  const writtenDirectory =
    input.writeToDisk === true && writeToDiskFn ? writeToDiskFn(projectId, built.files) : null;

  return {
    ...built,
    writtenDirectory,
  };
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
    fact?: { note?: string; source?: string; locked?: boolean; kind?: string };
  }[];
  readonly deconstructions?: readonly Record<string, unknown>[];
  readonly techniques?: readonly Record<string, unknown>[];
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
    return {
      path: assertSafeRelativePath(record.path),
      content: record.content,
    };
  });

  const manifestEntry = normalizedFiles.find((f) => f.path === "zhizhang-project.json" || f.path.endsWith("/zhizhang-project.json"));
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
      const existingDoc = candidateId
        ? (stmt(ctx.db, "SELECT id, project_id AS projectId, state FROM author_documents WHERE id = ?;")
            .get(candidateId) as { id: string; projectId: string; state: string } | undefined)
        : undefined;

      let targetDocId: string;
      if (existingDoc && existingDoc.projectId === projectId) {
        targetDocId = existingDoc.id;
        if (existingDoc.state === "final") {
          chaptersSkippedLocked.push(targetDocId);
          importedChapterOrder.push(targetDocId);
          continue;
        }
        const row = ctx.document(targetDocId);
        stmt(ctx.db, "UPDATE author_documents SET title = ?, volume_id = ?, act_id = ?, summary = ?, updated_at = ? WHERE id = ?;")
          .run(title, volumeId, actId, meta.summary ?? manifestCh?.summary ?? row.summary, now, targetDocId);
        if (body !== (row.body ?? "")) {
          ctx.appendDraftRevision(ctx.document(targetDocId), body, (saved) => {
            const nextState = saved.state === "planned" || saved.state === "drafting" ? "drafting" : "drafted";
            stmt(ctx.db, "UPDATE author_documents SET state = ? WHERE id = ?;").run(nextState, saved.id);
            ctx.event(projectId!, "chapter", "document.state", { documentId: saved.id, state: nextState });
          });
        }
        chaptersUpdated += 1;
      } else {
        targetDocId = randomUUID();
        createDocument(ctx.db, targetDocId);
        const initialState = body.trim() ? "drafting" : "planned";
        stmt(ctx.db, `
          INSERT INTO author_documents (id, project_id, title, state, mode, line, volume_id, act_id, summary, updated_at)
          VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?);
        `).run(targetDocId, projectId, title, initialState, volumeId, actId, meta.summary ?? manifestCh?.summary ?? "", now);
        ctx.event(projectId, "chapter", "document.created", {
          documentId: targetDocId,
          title,
          mode: null,
          line: null,
          state: initialState,
        });
        if (body.length > 0) {
          ctx.appendDraftRevision(ctx.document(targetDocId), body, () => {});
        }
        if (manifestCh?.planning) {
          ctx.savePlanning(ctx.document(targetDocId), manifestCh.planning);
        }
        chaptersCreated += 1;
      }
      importedChapterOrder.push(targetDocId);
    }

    if (importedChapterOrder.length > 0) {
      const merged = ctx.chapterOrder(projectId);
      const finalOrder = [...new Set([...merged, ...importedChapterOrder])];
      stmt(ctx.db, `
        INSERT INTO author_chapter_order (project_id, chapter_ids) VALUES (?, ?)
        ON CONFLICT (project_id) DO UPDATE SET chapter_ids = excluded.chapter_ids;
      `).run(projectId, JSON.stringify(finalOrder));
    }

    // Propose lore items from manifest as author-pending proposals (never overwriting locked settings).
    let loreProposed = 0;
    const defaultChapterId = importedChapterOrder[0] ?? ctx.chapterOrder(projectId)[0];
    for (const item of manifest?.lore ?? []) {
      if (!item.factId || !item.fact?.note) continue;
      const lockedExisting = stmt(ctx.db, `
        SELECT locked FROM author_lore_current WHERE project_id = ? AND fact_id = ?;
      `).get(projectId, item.factId) as { locked?: number } | undefined;
      if (lockedExisting?.locked === 1) continue;
      if (!defaultChapterId) continue;

      const proposalId = randomUUID();
      const factValue = {
        id: item.factId,
        note: item.fact.note,
        source: item.fact.source ?? "本地资产包导入提案",
        kind: item.fact.kind === "agreement" ? "agreement" : "fact",
        locked: item.fact.locked === true,
        effectiveFrom: { chapterId: defaultChapterId, point: 1 },
        knownFrom: {},
      };
      stmt(ctx.db, `
        INSERT INTO author_settings (id, project_id, fact_id, category, entity_name, value, decision)
        VALUES (?, ?, ?, ?, ?, ?, 'pending');
      `).run(
        proposalId,
        projectId,
        item.factId,
        item.category ?? "world_rule",
        item.entityName ?? "",
        JSON.stringify(factValue),
      );
      ctx.event(projectId, "setting", "setting.proposed", { id: proposalId, factId: item.factId });
      loreProposed += 1;
    }

    let libraryImported = 0;
    for (const dec of manifest?.deconstructions ?? []) {
      if (typeof dec.title !== "string" || typeof dec.excerpt !== "string") continue;
      const decId = randomUUID();
      stmt(ctx.db, `
        INSERT INTO library_deconstructions (
          id, scope, project_id, title, source_book, genre, pacing, tags_json, excerpt,
          hook_analysis, conflict_beats, payoff_rhythm, prose_notes, status, source_kind, created_at, updated_at
        ) VALUES (?, 'project', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'import', ?, ?);
      `).run(
        decId,
        projectId,
        dec.title,
        typeof dec.sourceBook === "string" ? dec.sourceBook : "",
        typeof dec.genre === "string" ? dec.genre : "",
        typeof dec.pacing === "string" ? dec.pacing : "",
        JSON.stringify(Array.isArray(dec.tags) ? dec.tags : []),
        dec.excerpt,
        typeof dec.hookAnalysis === "string" ? dec.hookAnalysis : "",
        typeof dec.conflictBeats === "string" ? dec.conflictBeats : "",
        typeof dec.payoffRhythm === "string" ? dec.payoffRhythm : "",
        typeof dec.proseNotes === "string" ? dec.proseNotes : "",
        now,
        now,
      );
      libraryImported += 1;
    }

    for (const card of manifest?.techniques ?? []) {
      if (typeof card.title !== "string" || typeof card.executionSteps !== "string") continue;
      const cardId = randomUUID();
      stmt(ctx.db, `
        INSERT INTO library_technique_cards (
          id, scope, project_id, title, category, pacing, scene_tags_json,
          trigger_when, execution_steps, constraints, anti_patterns, example_excerpt,
          priority, status, source_kind, created_at, updated_at
        ) VALUES (?, 'project', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'import', ?, ?);
      `).run(
        cardId,
        projectId,
        card.title,
        typeof card.category === "string" ? card.category : "narrative",
        typeof card.pacing === "string" ? card.pacing : "",
        JSON.stringify(Array.isArray(card.sceneTags) ? card.sceneTags : []),
        typeof card.triggerWhen === "string" ? card.triggerWhen : "",
        card.executionSteps,
        typeof card.constraints === "string" ? card.constraints : "",
        typeof card.antiPatterns === "string" ? card.antiPatterns : "",
        typeof card.exampleExcerpt === "string" ? card.exampleExcerpt : "",
        typeof card.priority === "number" ? card.priority : 50,
        now,
        now,
      );
      libraryImported += 1;
    }

    rebuildProjectFts(ctx.db, projectId);
    if (chaptersSkippedLocked.length > 0 && requestedProjectId && chaptersCreated === 0 && chaptersUpdated === 0 && loreProposed === 0 && libraryImported === 0) {
      // Allow returning summary cleanly even when only locked chapters matched.
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
    };
  });
}
