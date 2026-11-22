import type {
  BookCacheSnapshotDto,
  DeconstructionDto,
  TechniqueCardDto,
} from "../../../contracts/workspace-dto.ts";
import { stmt } from "../../../storage/index.ts";
import { normalizeCacheText, sha256Prefix } from "../../../workflow/cache-layer.ts";
import { estimateTokenCount } from "../../../workflow/writing-budget.ts";
import { count, text, type DocumentRow, type Input, type WorkspaceContext } from "../../context.ts";
import { normalizeContextTuning } from "../../../domain/fanqie/index.ts";
import { loadProjectControls } from "./controls.ts";
import { queryDeconstructions, queryTechniques } from "./library-crud.ts";
import { assertFanqieProject } from "./shared.ts";

export const DEFAULT_L1_BUDGET_TOKENS = 8_192;
export const L1_DIRTY_REBUILD_THRESHOLD = 10;
export const L1_COLD_WINDOW_MS = 25 * 60_000;

interface BookPrefixCacheRow {
  readonly projectId: string;
  readonly snapshotVersion: number;
  readonly compiledText: string;
  readonly prefixSha256: string;
  readonly tokenCount: number;
  readonly budgetTokens: number;
  readonly compiledLoreSeq: number;
  readonly dirtyMutations: number;
  readonly lastCacheHitAt: number;
  readonly updatedAt: number;
}

export interface BookPrefixSnapshotResult {
  readonly snapshot: BookCacheSnapshotDto;
  readonly compiledText: string;
  readonly pendingDeltaText: string;
  readonly pendingDeltaCount: number;
  readonly projectMountedTechniqueIds: readonly string[];
  readonly projectMountedDeconstructionIds: readonly string[];
}

export interface VolumeMilestoneL2Result {
  readonly volumePrefix: string;
  readonly volumePrefixSha256: string;
  readonly tokenCount: number;
  readonly archivedLimit: number;
  readonly activeForeshadowCount: number;
}

function readSnapshotRow(ctx: WorkspaceContext, projectId: string): BookPrefixCacheRow | undefined {
  return stmt(ctx.db, `
    SELECT project_id AS projectId,
      snapshot_version AS snapshotVersion,
      compiled_text AS compiledText,
      prefix_sha256 AS prefixSha256,
      token_count AS tokenCount,
      budget_tokens AS budgetTokens,
      compiled_lore_seq AS compiledLoreSeq,
      dirty_mutations AS dirtyMutations,
      last_cache_hit_at AS lastCacheHitAt,
      updated_at AS updatedAt
    FROM author_book_prefix_cache
    WHERE project_id = ?;
  `).get(projectId) as BookPrefixCacheRow | undefined;
}

function toSnapshotDto(row: BookPrefixCacheRow, dirtyThreshold = L1_DIRTY_REBUILD_THRESHOLD): BookCacheSnapshotDto {
  return {
    projectId: row.projectId,
    version: row.snapshotVersion,
    prefixSha256: row.prefixSha256,
    tokenCount: row.tokenCount,
    budgetTokens: row.budgetTokens,
    dirtyMutations: row.dirtyMutations,
    dirtyThreshold,
    compiledLoreSeq: row.compiledLoreSeq,
    lastCompiledAt: row.updatedAt,
    lastCacheHitAt: row.lastCacheHitAt,
  };
}

function trimToTokenBudget(content: string, maxTokens: number): string {
  if (estimateTokenCount(content) <= maxTokens) return content;
  if (maxTokens <= 16) return "";
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokenCount(content.slice(0, mid)) <= maxTokens - 8) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${content.slice(0, low).trimEnd()}\n…（已按 L1 固定配额截断）`;
}

function formatProjectTechniquesForL1(cards: readonly TechniqueCardDto[]): string {
  if (cards.length === 0) return "";
  return cards
    .map((card) => {
      const kindTag = card.assetKind === "skill" ? "Skill" : "技法";
      const parts = [`- [${card.id}] ${kindTag}《${card.title}》（${card.category}）`];
      if (card.triggerWhen) parts.push(`  适用场景：${card.triggerWhen}`);
      if (card.executionSteps) parts.push(`  执行步骤：${card.executionSteps}`);
      if (card.constraints) parts.push(`  关键约束：${card.constraints}`);
      if (card.antiPatterns) parts.push(`  禁忌反例：${card.antiPatterns}`);
      return parts.join("\n");
    })
    .join("\n");
}

function formatProjectDeconstructionsForL1(samples: readonly DeconstructionDto[]): string {
  if (samples.length === 0) return "";
  return samples
    .map((sample) => {
      const parts = [`- [${sample.id}] 拆书范例《${sample.title}》${sample.sourceBook ? `（${sample.sourceBook}）` : ""}`];
      if (sample.hookAnalysis) parts.push(`  开篇钩子：${sample.hookAnalysis}`);
      if (sample.conflictBeats) parts.push(`  冲突节拍：${sample.conflictBeats}`);
      if (sample.payoffRhythm) parts.push(`  爽点节奏：${sample.payoffRhythm}`);
      if (sample.proseNotes) parts.push(`  文笔批注：${sample.proseNotes}`);
      return parts.join("\n");
    })
    .join("\n");
}

function loadProjectScopedMounts(ctx: WorkspaceContext, projectId: string): {
  readonly techniques: readonly TechniqueCardDto[];
  readonly deconstructions: readonly DeconstructionDto[];
} {
  const mounts = stmt(ctx.db, `
    SELECT item_kind AS itemKind, item_id AS itemId, mode
    FROM author_library_mounts
    WHERE project_id = ? AND target_type = 'project' AND mode != 'exclude'
    ORDER BY item_id ASC;
  `).all(projectId) as readonly { itemKind: string; itemId: string; mode: string }[];

  const techIds = new Set(mounts.filter((m) => m.itemKind === "technique").map((m) => m.itemId));
  const deconstructIds = new Set(mounts.filter((m) => m.itemKind === "deconstruction").map((m) => m.itemId));

  const techniques = techIds.size > 0
    ? queryTechniques(ctx, { projectId })
        .filter((card) => techIds.has(card.id) || (card.overrideOfId !== null && techIds.has(card.overrideOfId)))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    : [];
  const deconstructions = deconstructIds.size > 0
    ? queryDeconstructions(ctx, { projectId })
        .filter((item) => deconstructIds.has(item.id) || (item.overrideOfId !== null && deconstructIds.has(item.overrideOfId)))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    : [];

  return { techniques, deconstructions };
}

/**
 * Compiles the deterministic L1 Book Bible Snapshot for a Fanqie project.
 *
 * Strictly decoupled from per-run `tokenLimit`, writing `stage`, and active
 * chapter selection so L1 remains byte-identical across chapter drafting,
 * micro-rewrites, reviews, fact sync, and arc planning.
 */
export function compileBookBibleL1(
  ctx: WorkspaceContext,
  projectId: string,
  budgetTokens = DEFAULT_L1_BUDGET_TOKENS,
): {
  readonly compiledText: string;
  readonly prefixSha256: string;
  readonly tokenCount: number;
  readonly compiledLoreSeq: number;
  readonly projectMountedTechniqueIds: readonly string[];
  readonly projectMountedDeconstructionIds: readonly string[];
} {
  const controls = loadProjectControls(ctx, projectId);
  const loreRows = stmt(ctx.db, `
    SELECT fact_id AS factId, category, entity_name AS entityName, locked, value, decided_seq AS decidedSeq
    FROM author_lore_current
    WHERE project_id = ?
    ORDER BY category ASC, locked DESC, fact_id ASC;
  `).all(projectId) as readonly {
    factId: string;
    category: string;
    entityName: string;
    locked: number;
    value: string;
    decidedSeq: number;
  }[];

  let maxLoreSeq = 0;
  const agreements: string[] = [];
  const worldLore: string[] = [];

  for (const row of loreRows) {
    if (row.decidedSeq > maxLoreSeq) maxLoreSeq = row.decidedSeq;
    let note = "";
    let source = "";
    try {
      const parsed = JSON.parse(row.value) as { note?: string; source?: string };
      note = typeof parsed.note === "string" ? parsed.note.trim() : "";
      source = typeof parsed.source === "string" ? parsed.source.trim() : "";
    } catch {
      continue;
    }
    if (!note) continue;
    if (row.category === "agreement") {
      agreements.push(`- [${row.factId}] ${note}`);
    } else {
      const tag = row.locked ? `${row.factId}|锁定` : row.factId;
      const prefix = row.entityName ? `${row.entityName}：` : "";
      const suffix = source ? `（来源：${source}）` : "";
      worldLore.push(`- [${tag}] (${row.category}) ${prefix}${note}${suffix}`);
    }
  }

  const { techniques, deconstructions } = loadProjectScopedMounts(ctx, projectId);
  const techText = formatProjectTechniquesForL1(techniques);
  const deconstructText = formatProjectDeconstructionsForL1(deconstructions);

  const sections: string[] = [
    "### 【L1 全书冻结设定圣经】\n注：以下为全书客观设定圣经；实际叙事时，任何视角人物仅可获知文末【L3 视角知情边界】中允许的信息。",
  ];
  if (controls.authorIntent.trim()) {
    sections.push(`#### 全书指南针（创作意图与禁区）\n${controls.authorIntent.trim()}`);
  }
  if (agreements.length > 0) {
    sections.push(`#### 全书创作约定\n${agreements.join("\n")}`);
  }
  if (worldLore.length > 0) {
    sections.push(`#### 全书世界观与实体圣经\n${worldLore.join("\n")}`);
  }
  if (techText) {
    sections.push(`#### 全书常驻技法卡片\n${techText}`);
  }
  if (deconstructText) {
    sections.push(`#### 全书常驻拆书范本\n${deconstructText}`);
  }

  const rawText = normalizeCacheText(sections.join("\n\n"));
  const compiledText = trimToTokenBudget(rawText, budgetTokens);
  const tokenCount = estimateTokenCount(compiledText);
  const prefixSha256 = sha256Prefix(compiledText);

  return {
    compiledText,
    prefixSha256,
    tokenCount,
    compiledLoreSeq: maxLoreSeq,
    projectMountedTechniqueIds: techniques.map((t) => t.id),
    projectMountedDeconstructionIds: deconstructions.map((d) => d.id),
  };
}

function buildPendingDelta(
  ctx: WorkspaceContext,
  projectId: string,
  compiledLoreSeq: number,
  compiledText: string,
): { readonly text: string; readonly count: number } {
  const deltaLines: string[] = [];
  const newerLore = stmt(ctx.db, `
    SELECT fact_id AS factId, category, entity_name AS entityName, locked, value
    FROM author_lore_current
    WHERE project_id = ? AND decided_seq > ?
    ORDER BY decided_seq ASC, fact_id ASC;
  `).all(projectId, compiledLoreSeq) as readonly {
    factId: string;
    category: string;
    entityName: string;
    locked: number;
    value: string;
  }[];

  for (const row of newerLore) {
    try {
      const parsed = JSON.parse(row.value) as { note?: string; source?: string };
      const note = typeof parsed.note === "string" ? parsed.note.trim() : "";
      if (!note) continue;
      const prefix = row.entityName ? `${row.entityName}：` : "";
      deltaLines.push(`- [新增设定 ${row.factId}] (${row.category}) ${prefix}${note}`);
    } catch {
      // Ignore malformed row.
    }
  }

  const controls = loadProjectControls(ctx, projectId);
  if (controls.authorIntent.trim() && !compiledText.includes(controls.authorIntent.trim())) {
    deltaLines.push(`- [更新指南针] ${controls.authorIntent.trim()}`);
  }

  return {
    text: deltaLines.join("\n"),
    count: deltaLines.length,
  };
}

/**
 * Returns the version-pinned L1 Book Bible Snapshot plus any incremental L3 delta
 * patch since the snapshot was compiled.
 *
 * Rebuilds automatically only when:
 * 1. No snapshot exists yet,
 * 2. `force === true` (author clicked "重建圣经快照"),
 * 3. `dirtyMutations >= L1_DIRTY_REBUILD_THRESHOLD` (10), or
 * 4. The book's cache has gone cold (`> 25 min` since last hit) and has pending dirty mutations.
 *
 * When `readOnly === true` (e.g. `context.preview` inside `ctx.read`), never writes to SQLite.
 */
export function getOrRefreshBookPrefixSnapshot(
  ctx: WorkspaceContext,
  projectId: string,
  options: {
    readonly force?: boolean;
    readonly budgetTokens?: number;
    readonly readOnly?: boolean;
    readonly now?: number;
  } = {},
): BookPrefixSnapshotResult {
  const now = options.now ?? Date.now();
  const existing = readSnapshotRow(ctx, projectId);
  const controls = loadProjectControls(ctx, projectId);
  const tuning = normalizeContextTuning(controls.contextTuning);
  const dirtyThreshold = tuning.l1DirtyThreshold;
  const targetBudget = options.budgetTokens ?? tuning.l1BudgetTokens ?? DEFAULT_L1_BUDGET_TOKENS;
  const budgetTokens = options.budgetTokens !== undefined
    ? options.budgetTokens
    : (tuning.l1BudgetTokens !== DEFAULT_L1_BUDGET_TOKENS
        ? tuning.l1BudgetTokens
        : (existing?.budgetTokens ?? targetBudget));
  const { techniques, deconstructions } = loadProjectScopedMounts(ctx, projectId);
  const projectMountedTechniqueIds = techniques.map((t) => t.id);
  const projectMountedDeconstructionIds = deconstructions.map((d) => d.id);

  const isColdWithDirty =
    existing !== undefined
    && existing.dirtyMutations > 0
    && existing.lastCacheHitAt > 0
    && now - existing.lastCacheHitAt > L1_COLD_WINDOW_MS;
  const needsRebuild =
    options.force === true
    || existing === undefined
    || existing.dirtyMutations >= dirtyThreshold
    || isColdWithDirty
    || (existing.budgetTokens !== budgetTokens);

  if (!needsRebuild && existing) {
    const delta = buildPendingDelta(ctx, projectId, existing.compiledLoreSeq, existing.compiledText);
    return {
      snapshot: toSnapshotDto(existing, dirtyThreshold),
      compiledText: existing.compiledText,
      pendingDeltaText: delta.text,
      pendingDeltaCount: delta.count,
      projectMountedTechniqueIds,
      projectMountedDeconstructionIds,
    };
  }

  if (options.readOnly && existing && !options.force) {
    const delta = buildPendingDelta(ctx, projectId, existing.compiledLoreSeq, existing.compiledText);
    return {
      snapshot: toSnapshotDto(existing, dirtyThreshold),
      compiledText: existing.compiledText,
      pendingDeltaText: delta.text,
      pendingDeltaCount: delta.count,
      projectMountedTechniqueIds,
      projectMountedDeconstructionIds,
    };
  }

  const compiled = compileBookBibleL1(ctx, projectId, budgetTokens);
  const nextVersion = existing ? existing.snapshotVersion + 1 : 1;
  const row: BookPrefixCacheRow = {
    projectId,
    snapshotVersion: nextVersion,
    compiledText: compiled.compiledText,
    prefixSha256: compiled.prefixSha256,
    tokenCount: compiled.tokenCount,
    budgetTokens,
    compiledLoreSeq: compiled.compiledLoreSeq,
    dirtyMutations: 0,
    lastCacheHitAt: existing?.lastCacheHitAt ?? 0,
    updatedAt: now,
  };

  if (!options.readOnly) {
    stmt(ctx.db, `
      INSERT INTO author_book_prefix_cache (
        project_id, snapshot_version, compiled_text, prefix_sha256, token_count,
        budget_tokens, compiled_lore_seq, dirty_mutations, last_cache_hit_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT (project_id) DO UPDATE SET
        snapshot_version = excluded.snapshot_version,
        compiled_text = excluded.compiled_text,
        prefix_sha256 = excluded.prefix_sha256,
        token_count = excluded.token_count,
        budget_tokens = excluded.budget_tokens,
        compiled_lore_seq = excluded.compiled_lore_seq,
        dirty_mutations = 0,
        updated_at = excluded.updated_at;
    `).run(
      row.projectId,
      row.snapshotVersion,
      row.compiledText,
      row.prefixSha256,
      row.tokenCount,
      row.budgetTokens,
      row.compiledLoreSeq,
      row.lastCacheHitAt,
      row.updatedAt,
    );
  }

  return {
    snapshot: toSnapshotDto(row, dirtyThreshold),
    compiledText: row.compiledText,
    pendingDeltaText: "",
    pendingDeltaCount: 0,
    projectMountedTechniqueIds: compiled.projectMountedTechniqueIds,
    projectMountedDeconstructionIds: compiled.projectMountedDeconstructionIds,
  };
}

/**
 * Marks a Fanqie project's L1 Book Bible snapshot dirty without immediately
 * rebuilding it, preserving KV-cache prefix stability until the dirty threshold
 * or cold window is reached.
 */
export function markBookPrefixDirty(ctx: WorkspaceContext, projectId: string): void {
  stmt(ctx.db, `
    UPDATE author_book_prefix_cache
    SET dirty_mutations = dirty_mutations + 1, updated_at = ?
    WHERE project_id = ?;
  `).run(Date.now(), projectId);
}

/**
 * Records the timestamp of the most recent cache hit (or prompt call) on a
 * project so cold-window auto-rebuilds never interrupt an active writing burst.
 */
export function touchBookCacheHit(ctx: WorkspaceContext, projectId: string, now = Date.now()): void {
  stmt(ctx.db, `
    UPDATE author_book_prefix_cache
    SET last_cache_hit_at = ?
    WHERE project_id = ?;
  `).run(now, projectId);
}

/**
 * Builds the Append-Only L2 Volume/Act & 10-Chapter Milestone Ledger.
 *
 * - Volumes & Acts with finalized summaries (sorted deterministically).
 * - Closed 10-chapter milestone blocks strictly preceding the current chapter's
 *   10-chapter bucket (`floor(currentIdx / 10) * 10`).
 * - Active foreshadows sorted strictly by `id ASC` (immune to `updated_at` churn).
 */
export function buildVolumeMilestoneL2(
  ctx: WorkspaceContext,
  projectId: string,
  row?: DocumentRow,
): VolumeMilestoneL2Result {
  const controls = loadProjectControls(ctx, projectId);
  const chunkSize = normalizeContextTuning(controls.contextTuning).l2MilestoneChunkSize;
  const order = ctx.chapterOrder(projectId);
  const currentIdx = row ? order.indexOf(row.id) : order.length;
  const effectiveIdx = currentIdx >= 0 ? currentIdx : order.length;
  const archivedLimit = Math.floor(effectiveIdx / chunkSize) * chunkSize;

  const volumes = stmt(ctx.db, `
    SELECT id, title, goal, summary
    FROM author_volumes
    WHERE project_id = ?
    ORDER BY sort_order ASC, id ASC;
  `).all(projectId) as readonly { id: string; title: string; goal: string; summary: string }[];

  const acts = stmt(ctx.db, `
    SELECT a.id, a.volume_id AS volumeId, a.title, a.summary, a.arc_summary AS arcSummary
    FROM author_acts a
    JOIN author_volumes v ON v.id = a.volume_id
    WHERE a.project_id = ?
    ORDER BY v.sort_order ASC, a.sort_order ASC, a.id ASC;
  `).all(projectId) as readonly {
    id: string;
    volumeId: string;
    title: string;
    summary: string;
    arcSummary: string;
  }[];

  const volumeLines: string[] = [];
  for (const vol of volumes) {
    const summary = vol.summary.trim();
    if (summary) volumeLines.push(`- [卷] 《${vol.title}》：${summary}`);
  }
  for (const act of acts) {
    const summary = (act.arcSummary || act.summary).trim();
    if (summary) volumeLines.push(`- [幕] 《${act.title}》：${summary}`);
  }

  const milestoneBlocks: string[] = [];
  if (archivedLimit > 0) {
    const chapterRows = stmt(ctx.db, `
      SELECT id, title, summary FROM author_documents WHERE project_id = ?;
    `).all(projectId) as readonly { id: string; title: string; summary: string }[];
    const byId = new Map(chapterRows.map((c) => [c.id, c]));

    for (let start = 0; start < archivedLimit; start += chunkSize) {
      const end = Math.min(start + chunkSize, archivedLimit);
      const lines: string[] = [];
      for (let i = start; i < end; i++) {
        const ch = byId.get(order[i]);
        if (ch && ch.summary.trim()) {
          lines.push(`- 第${i + 1}章《${ch.title}》：${ch.summary.trim()}`);
        }
      }
      if (lines.length > 0) {
        milestoneBlocks.push(`#### 第 ${start + 1}-${end} 章里程碑摘要\n${lines.join("\n")}`);
      }
    }
  }

  const foreshadowRows = stmt(ctx.db, `
    SELECT id, title, planted_chapter_id AS plantedChapterId, status, note
    FROM author_foreshadows
    WHERE project_id = ? AND status IN ('planted', 'hinted')
    ORDER BY id ASC;
  `).all(projectId) as readonly {
    id: string;
    title: string;
    plantedChapterId: string | null;
    status: string;
    note: string;
  }[];

  const activeForeshadows = foreshadowRows.filter((fs) => {
    if (!fs.plantedChapterId || currentIdx < 0) return true;
    const plantedIdx = order.indexOf(fs.plantedChapterId);
    return plantedIdx === -1 || plantedIdx <= currentIdx;
  });
  const foreshadowLines = activeForeshadows.map(
    (fs) => `- [${fs.id.slice(0, 8)}|${fs.status === "hinted" ? "推进中" : "已埋设"}] ${fs.title}${fs.note ? `：${fs.note}` : ""}`,
  );

  const sections: string[] = [];
  if (volumeLines.length > 0) {
    sections.push(`#### 已定稿卷幕摘要\n${volumeLines.join("\n")}`);
  }
  if (milestoneBlocks.length > 0) {
    sections.push(milestoneBlocks.join("\n\n"));
  }
  if (foreshadowLines.length > 0) {
    sections.push(`#### 活跃伏笔账本\n${foreshadowLines.join("\n")}`);
  }

  const volumePrefix = sections.length > 0
    ? normalizeCacheText(`### 【L2 卷幕里程碑】\n\n${sections.join("\n\n")}`)
    : "";

  return {
    volumePrefix,
    volumePrefixSha256: volumePrefix ? sha256Prefix(volumePrefix) : "",
    tokenCount: estimateTokenCount(volumePrefix),
    archivedLimit,
    activeForeshadowCount: activeForeshadows.length,
  };
}

export function getBookCacheSnapshotAction(ctx: WorkspaceContext, input: Input): BookCacheSnapshotDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  return ctx.read(() => getOrRefreshBookPrefixSnapshot(ctx, projectId, { readOnly: true }).snapshot);
}

export function rebuildBookCacheSnapshotAction(ctx: WorkspaceContext, input: Input): BookCacheSnapshotDto {
  const projectId = text(input, "projectId");
  assertFanqieProject(ctx, projectId);
  const budgetTokens = input.budgetTokens !== undefined ? Math.max(1024, count(input, "budgetTokens")) : undefined;
  return ctx.atomic(() => {
    const result = getOrRefreshBookPrefixSnapshot(ctx, projectId, {
      force: true,
      budgetTokens,
      readOnly: false,
    });
    ctx.event(projectId, "setting", "cache.rebuilt", {
      projectId,
      version: result.snapshot.version,
      prefixSha256: result.snapshot.prefixSha256,
      tokenCount: result.snapshot.tokenCount,
    });
    return result.snapshot;
  });
}
