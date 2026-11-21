import type {
  ContextBundleDto,
  ContextSlotReportDto,
  DeconstructionDto,
  RelatedChapterScoreDto,
  TechniqueCardDto,
  WritingStageBinding,
} from "../../../contracts/workspace-dto.ts";
import {
  normalizeStageBindings,
  rankRelatedChapters,
  settingsAt,
  type ChapterEntityMention,
  type RelatedChapterCandidate,
  type RelatedChapterMatch,
  type SettingFact,
} from "../../../domain/fanqie/index.ts";
import { anchor } from "../../../domain/shared/index.ts";
import { searchRelatedChaptersByFts, stmt } from "../../../storage/index.ts";
import {
  buildTaskProtocolSection,
  normalizeCacheText,
  sha256Prefix,
  SHARED_WORKBENCH_SYSTEM_KERNEL,
  type LayeredPromptPayload,
} from "../../../workflow/cache-layer.ts";
import { assembleContextBundle, type ContextSlotInput } from "../../../workflow/context-slots.ts";
import { estimateTokenCount, WRITER_SYSTEM } from "../../../workflow/writing-budget.ts";
import type { WritingPhase } from "../../../workflow/writing-stages.ts";
import { count, invalid, type DocumentRow, type Input, type WorkspaceContext } from "../../context.ts";
import type { ProductGenerationRunner } from "../../product-line.ts";
import {
  buildVolumeMilestoneL2,
  getOrRefreshBookPrefixSnapshot,
  type BookPrefixSnapshotResult,
  type VolumeMilestoneL2Result,
} from "./cache-snapshot.ts";
import { loadProjectControls } from "./controls.ts";
import { queryTechniqueRecommendations, resolveMountedLibraryForChapter } from "./library.ts";
import { approvedFacts } from "./shared.ts";

export interface FanqieSharedLayeredPrefix {
  readonly l1: BookPrefixSnapshotResult;
  readonly l2: VolumeMilestoneL2Result;
  readonly cachePartitionKey: string;
}

export function buildFanqieSharedLayeredPrefix(
  ctx: WorkspaceContext,
  projectId: string,
  row?: DocumentRow,
  options: { readonly readOnly?: boolean } = {},
): FanqieSharedLayeredPrefix {
  const l1 = getOrRefreshBookPrefixSnapshot(ctx, projectId, { readOnly: options.readOnly });
  const l2 = buildVolumeMilestoneL2(ctx, projectId, row);
  return {
    l1,
    l2,
    cachePartitionKey: `zhizhang:${projectId}`,
  };
}

/**
 * Composes a 4-Tier LayeredPromptPayload (`L0 + L1 + L2 + L3`) so every Fanqie
 * job kind (writing, micro-rewrite, review, fact-sync, summary, setting, arc-plan)
 * shares the exact same L0+L1+L2 prefix byte-for-byte.
 */
export function buildFanqieLayeredPayload(
  shared: FanqieSharedLayeredPrefix,
  phase: WritingPhase,
  dynamicSections: readonly string[],
  extraDirectives?: string,
): LayeredPromptPayload {
  const tailParts: string[] = [];
  if (shared.l1.pendingDeltaText) {
    tailParts.push(`### 【L1 增量设定补丁（待合入圣经快照）】\n${shared.l1.pendingDeltaText}`);
  }
  for (const section of dynamicSections) {
    const clean = section.trim();
    if (clean) tailParts.push(clean);
  }
  tailParts.push(buildTaskProtocolSection(phase, extraDirectives));

  return {
    systemKernel: SHARED_WORKBENCH_SYSTEM_KERNEL,
    bookPrefix: shared.l1.compiledText || undefined,
    bookPrefixSha256: shared.l1.snapshot.prefixSha256 || undefined,
    bookSnapshotVersion: shared.l1.snapshot.version,
    volumePrefix: shared.l2.volumePrefix || undefined,
    volumePrefixSha256: shared.l2.volumePrefixSha256 || undefined,
    dynamicTail: normalizeCacheText(tailParts.join("\n\n")),
    cachePartitionKey: shared.cachePartitionKey,
  };
}

export function formatTechniquesBlock(cards: readonly TechniqueCardDto[]): string {
  if (cards.length === 0) return "";
  return cards
    .map((card) => {
      const kindTag = card.assetKind === "skill" ? "Skill" : "技法";
      const parts = [`## ${kindTag}：${card.title}（${card.category}）`];
      if (card.triggerWhen) parts.push(`适用场景：${card.triggerWhen}`);
      if (card.executionSteps) parts.push(`执行步骤：${card.executionSteps}`);
      if (card.constraints) parts.push(`关键约束：${card.constraints}`);
      if (card.antiPatterns) parts.push(`禁忌反例：${card.antiPatterns}`);
      if (card.references && card.references.length > 0) {
        const sortedRefs = [...card.references].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        for (const ref of sortedRefs) {
          parts.push(`参考补充 [${ref.path}]：\n${ref.content.slice(0, 1500)}`);
        }
      }
      return parts.join("\n");
    })
    .join("\n\n");
}

function formatDeconstructionsBlock(samples: readonly DeconstructionDto[]): string {
  if (samples.length === 0) return "";
  return samples
    .map((sample) => {
      const parts = [`## 拆书范例：${sample.title}${sample.sourceBook ? `（出处：${sample.sourceBook}）` : ""}`];
      if (sample.hookAnalysis) parts.push(`开篇钩子：${sample.hookAnalysis}`);
      if (sample.conflictBeats) parts.push(`冲突节拍：${sample.conflictBeats}`);
      if (sample.payoffRhythm) parts.push(`爽点节奏：${sample.payoffRhythm}`);
      if (sample.proseNotes) parts.push(`文笔批注：${sample.proseNotes}`);
      if (sample.excerpt) parts.push(`片段节选：\n${sample.excerpt.slice(0, 600)}`);
      return parts.join("\n");
    })
    .join("\n\n");
}

function formatPovBoundaryBlock(
  viewpoint: string | undefined,
  knownFacts: readonly SettingFact[],
  allFacts: readonly SettingFact[],
): string {
  if (!viewpoint) return "";
  const knownIds = new Set(knownFacts.map((f) => f.id));
  const lines: string[] = [];
  if (knownFacts.length > 0) {
    lines.push(
      `当前视角人物「${viewpoint}」已获知设定（允许直接描写）：`,
      ...knownFacts.map((fact) => `- [${fact.id}] ${fact.note}（来源：${fact.source}）`),
    );
  } else {
    lines.push(`当前视角人物「${viewpoint}」暂无已获知专项设定。`);
  }
  const hiddenIds = allFacts
    .filter((f) => f.kind !== "agreement" && !knownIds.has(f.id))
    .map((f) => f.id)
    .sort();
  if (hiddenIds.length > 0) {
    lines.push(
      `【严禁泄露】以下 L1 客观设定在当前章节对「${viewpoint}」仍属未知，切勿通过内心独白或对话提前泄露：${hiddenIds.join("、")}`,
    );
  }
  return lines.join("\n");
}

function formatOutlineBlock(plan: Input | null, title: string): string {
  if (!plan) return `章节标题：${title}`;
  const lines = [`章节标题：${title}`];
  if (typeof plan.viewpoint === "string") lines.push(`视角人物：${plan.viewpoint}`);
  if (typeof plan.target === "number") lines.push(`目标字数：${plan.target}`);
  if (typeof plan.lockedFacts === "string") lines.push(`锁定事实：${plan.lockedFacts}`);
  if (typeof plan.knowledge === "string") lines.push(`人物知识边界：${plan.knowledge}`);
  if (plan.sections && typeof plan.sections === "object") {
    for (const [sec, val] of Object.entries(plan.sections as Record<string, unknown>)) {
      if (typeof val === "string" && val.trim()) lines.push(`${sec}：${val}`);
    }
  }
  return lines.join("\n");
}

function formatRelatedChaptersBlock(matches: readonly RelatedChapterMatch[]): string {
  if (matches.length === 0) return "";
  return matches
    .map((m) => `- 《${m.title}》（${m.reasons.join("；")}）：${m.summary || "（呼应前文线索与知情设定）"}`)
    .join("\n");
}

function collectSemanticQueryTerms(
  row: DocumentRow,
  plan: Input | null,
  instruction: string,
  entityNames: readonly string[],
): string[] {
  const candidates: string[] = [];
  for (const name of entityNames) {
    if ([...name.trim()].length >= 3) candidates.push(name.trim());
  }
  const sources = [
    row.title,
    typeof plan?.lockedFacts === "string" ? plan.lockedFacts : "",
    typeof plan?.knowledge === "string" ? plan.knowledge : "",
    instruction,
  ];
  if (plan?.sections && typeof plan.sections === "object") {
    for (const val of Object.values(plan.sections as Record<string, unknown>)) {
      if (typeof val === "string") sources.push(val);
    }
  }
  for (const src of sources) {
    for (const token of src.split(/[\s，。！？、；：“”‘’（）【】《》,.!?;:()\[\]{}"'/\\]+/)) {
      const clean = token.trim();
      const cps = [...clean];
      if (cps.length >= 3 && cps.length <= 12) {
        candidates.push(clean);
      } else if (cps.length > 12) {
        candidates.push(cps.slice(0, 6).join(""));
      }
    }
  }
  return [...new Set(candidates)].slice(0, 8);
}

export function buildFanqieFrozenContext(
  ctx: WorkspaceContext,
  row: DocumentRow,
  input: Input,
  options: { readonly readOnly?: boolean } = {},
): {
  readonly projectId: string;
  readonly knownAt: { readonly chapterId: string; readonly point: number };
  readonly knownFacts: readonly SettingFact[];
  readonly relatedChapters: readonly RelatedChapterScoreDto[];
  readonly scenario: null;
  readonly contextBundle: ContextBundleDto;
} {
  const plan = ctx.planning(row.id);
  const point = input.point === undefined ? 1 : count(input, "point");
  if (point === 0) invalid("point", "positive-integer-required");
  const at = anchor(row.id, point);
  const order = ctx.chapterOrder(row.projectId);
  const facts = approvedFacts(ctx, row.projectId);
  const viewpoint = typeof plan?.viewpoint === "string" ? plan.viewpoint : undefined;
  const knownFacts = viewpoint ? settingsAt(facts, order, at, viewpoint) : [];

  const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
  const tokenLimit = typeof input.tokenLimit === "number" && Number.isSafeInteger(input.tokenLimit) && input.tokenLimit > 0
    ? input.tokenLimit
    : 16_000;
  const maxInputTokens = Math.max(512, Math.floor(tokenLimit * 0.72));

  // L1 (Version-Pinned Book Bible) + L2 (Append-Only Volume/Act & 10-Chapter Milestones)
  // Completely decoupled from per-run `tokenLimit` and `stage`!
  const shared = buildFanqieSharedLayeredPrefix(ctx, row.projectId, row, { readOnly: options.readOnly });
  const l1TechSet = new Set(shared.l1.projectMountedTechniqueIds);
  const l1DeconstructSet = new Set(shared.l1.projectMountedDeconstructionIds);

  // Targeted author-selected qualitative observations (optional refine / deslop focus)
  const rawObsIds = Array.isArray(input.observationIds)
    ? input.observationIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const selectedObservations = rawObsIds.length > 0
    ? (stmt(ctx.db, `
        SELECT id, dimension, quote, suggestion
        FROM author_chapter_observations
        WHERE document_id = ? AND id IN (${rawObsIds.map(() => "?").join(", ")})
        ORDER BY created_at ASC, id ASC;
      `).all(row.id, ...rawObsIds) as readonly {
        id: string;
        dimension: string;
        quote: string;
        suggestion: string;
      }[])
    : [];
  const defaultStage: WritingStageBinding =
    selectedObservations.length > 0 && selectedObservations.every((obs) => obs.dimension === "ai_slop")
      ? "deslop"
      : selectedObservations.length > 0
        ? "refine"
        : "write";
  const stage: WritingStageBinding = input.stage !== undefined
    ? normalizeStageBindings([input.stage])[0]
    : defaultStage;
  const targetedObsText = selectedObservations
    .map((obs) => `- [${obs.dimension}] ${obs.quote ? `原文「${obs.quote}」 → ` : ""}${obs.suggestion}`)
    .join("\n");

  // Stage-specific / chapter-scoped techniques & deconstructions NOT already pinned in L1 go to L3
  const pacing = typeof input.pacing === "string" ? input.pacing : "";
  const mounted = resolveMountedLibraryForChapter(ctx, row, instruction, pacing, stage);
  const allTechniques = [...mounted.techniques].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const allDeconstructions = [...mounted.deconstructions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const l3Techniques = allTechniques.filter((card) => !l1TechSet.has(card.id) || stage !== "write");
  const l3Deconstructions = allDeconstructions.filter((item) => !l1DeconstructSet.has(item.id));

  // 4D Zero-token related historical chapter recall (outside recent 5 chapters)
  const currentIdx = order.indexOf(row.id);
  const foreshadowRows = stmt(ctx.db, `
    SELECT title, planted_chapter_id AS plantedChapterId, target_chapter_id AS targetChapterId, status, note
    FROM author_foreshadows
    WHERE project_id = ? AND status IN ('planted', 'hinted')
    ORDER BY id ASC;
  `).all(row.projectId) as readonly {
    title: string;
    plantedChapterId: string | null;
    targetChapterId: string | null;
    status: string;
    note: string;
  }[];
  const chapterRows = stmt(ctx.db, `
    SELECT id AS chapterId, title, summary FROM author_documents WHERE project_id = ?;
  `).all(row.projectId) as readonly RelatedChapterCandidate[];
  const entityMentions = stmt(ctx.db, `
    SELECT document_id AS documentId, entity_name AS entityName, mention_count AS mentionCount
    FROM author_chapter_entities
    WHERE project_id = ?;
  `).all(row.projectId) as readonly ChapterEntityMention[];
  const currentEntityNames = entityMentions
    .filter((entry) => entry.documentId === row.id && entry.mentionCount > 0)
    .map((entry) => entry.entityName);
  const queryTerms = collectSemanticQueryTerms(row, plan, instruction, currentEntityNames);
  const recentAndCurrentIds = currentIdx >= 0
    ? order.slice(Math.max(0, currentIdx - 5), currentIdx + 1)
    : [row.id];
  const ftsMatches = searchRelatedChaptersByFts(ctx.db, {
    projectId: row.projectId,
    queryTerms,
    excludeIds: recentAndCurrentIds,
    limit: 12,
  });
  const semanticScores = Object.fromEntries(ftsMatches.map((hit) => [hit.documentId, hit.score]));
  const relatedChapters = rankRelatedChapters({
    currentChapterId: row.id,
    chapterOrder: order,
    chapters: chapterRows,
    foreshadows: foreshadowRows,
    facts,
    entityMentions,
    viewpoint,
    currentEntityNames,
    currentOutlineText: formatOutlineBlock(plan, row.title) + "\n" + instruction,
    semanticScores,
    recentWindow: 5,
    topK: 4,
  });

  // Recent unarchived rolling summaries (chapters after L2 archivedLimit, up to 9 chapters) & prev tail
  let prevChapterTail = "";
  const summaryLines: string[] = [];
  if (currentIdx > 0) {
    const prevId = order[currentIdx - 1];
    const prevRow = stmt(ctx.db, `
      SELECT a.title, r.body
      FROM author_documents a
      JOIN documents d ON d.document_id = a.id
      LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
      WHERE a.id = ?;
    `).get(prevId) as { title: string; body: string | null } | undefined;
    if (prevRow?.body) {
      const tail = prevRow.body.trimEnd();
      prevChapterTail = tail.length > 1200
        ? `《${prevRow.title}》末尾衔接：\n…${tail.slice(-1200)}`
        : `《${prevRow.title}》末尾衔接：\n${tail}`;
    }

    const recentStart = Math.max(shared.l2.archivedLimit, currentIdx - 9);
    const prevSlice = order.slice(recentStart, currentIdx);
    const getSummary = stmt(ctx.db, "SELECT title, summary FROM author_documents WHERE id = ?;");
    for (const id of prevSlice) {
      const ch = getSummary.get(id) as { title: string; summary: string } | undefined;
      if (ch && ch.summary.trim()) {
        summaryLines.push(`- 《${ch.title}》：${ch.summary.trim()}`);
      }
    }
  }

  const controls = loadProjectControls(ctx, row.projectId);
  const activeAct = row.actId
    ? (stmt(ctx.db, `
        SELECT title, goal, arc_goal AS arcGoal, pacing_template AS pacingTemplate
        FROM author_acts WHERE id = ? AND project_id = ?;
      `).get(row.actId, row.projectId) as
        | { title: string; goal: string; arcGoal: string; pacingTemplate: string }
        | undefined)
    : undefined;
  const focusParts: string[] = [];
  if (controls.currentFocus) focusParts.push(controls.currentFocus);
  if (activeAct) {
    const actGoalText = activeAct.arcGoal || activeAct.goal;
    focusParts.push(
      `当前幕：${activeAct.title}${activeAct.pacingTemplate ? `（节奏：${activeAct.pacingTemplate}）` : ""}${actGoalText ? ` · 目标：${actGoalText}` : ""}`,
    );
  }
  const focusContent = focusParts.join("\n");

  // L3 Dynamic Slots only — L1 and L2 are immutable prefix layers never trimmed by `tokenLimit`.
  const l3Slots: readonly ContextSlotInput[] = [
    ...(shared.l1.pendingDeltaText
      ? [
          {
            id: "l1DeltaPatch",
            label: "L1 增量设定补丁（未合入圣经快照）",
            group: "dynamic" as const,
            tier: "l3" as const,
            priority: "high" as const,
            content: shared.l1.pendingDeltaText,
            maxShare: 0.14,
          },
        ]
      : []),
    {
      id: "povBoundary",
      label: viewpoint ? `L3 视角知情边界「${viewpoint}」` : "L3 视角知情边界",
      group: "dynamic",
      tier: "l3",
      priority: "high",
      content: formatPovBoundaryBlock(viewpoint, knownFacts, facts),
      maxShare: 0.2,
    },
    ...(l3Techniques.length > 0
      ? [
          {
            id: "chapterTechniques",
            label: `阶段与本章技法（${stage}）`,
            group: "dynamic" as const,
            tier: "l3" as const,
            priority: "medium" as const,
            content: formatTechniquesBlock(l3Techniques),
            maxShare: 0.18,
          },
        ]
      : []),
    ...(l3Deconstructions.length > 0
      ? [
          {
            id: "chapterDeconstructions",
            label: "本章挂载拆书范本",
            group: "dynamic" as const,
            tier: "l3" as const,
            priority: "optional" as const,
            content: formatDeconstructionsBlock(l3Deconstructions),
            maxShare: 0.14,
          },
        ]
      : []),
    {
      id: "currentFocus",
      label: "当前写作焦点与卷弧目标",
      group: "dynamic",
      tier: "l3",
      priority: "high",
      content: focusContent,
      maxShare: 0.1,
    },
    {
      id: "outline",
      label: "本章章纲与约束",
      group: "dynamic",
      tier: "l3",
      priority: "critical",
      content: formatOutlineBlock(plan, row.title),
    },
    {
      id: "relatedHistory",
      label: "相关远期历史章召回（Top 4）",
      group: "dynamic",
      tier: "l3",
      priority: "medium",
      content: formatRelatedChaptersBlock(relatedChapters),
      maxShare: 0.16,
    },
    {
      id: "rollingSummaries",
      label: "当前十章窗口内前文摘要",
      group: "dynamic",
      tier: "l3",
      priority: "optional",
      content: summaryLines.join("\n"),
      maxShare: 0.18,
      trimMode: "head",
    },
    {
      id: "prevTail",
      label: "上一章末尾衔接段",
      group: "dynamic",
      tier: "l3",
      priority: "medium",
      content: prevChapterTail,
      maxShare: 0.2,
      trimMode: "head",
    },
    {
      id: "activeDraft",
      label: "当前章工作稿正文",
      group: "dynamic",
      tier: "l3",
      priority: "critical",
      content: row.body ?? "",
    },
    ...(targetedObsText
      ? [
          {
            id: "targetedObservations",
            label: "作者勾选的定向修改意见",
            group: "dynamic" as const,
            tier: "l3" as const,
            priority: "high" as const,
            content: targetedObsText,
          },
        ]
      : []),
    {
      id: "instruction",
      label: "本轮写作指令",
      group: "dynamic",
      tier: "l3",
      priority: "critical",
      content: instruction,
    },
  ];

  const l1Tokens = shared.l1.snapshot.tokenCount;
  const l2Tokens = shared.l2.tokenCount;
  const l3Budget = Math.max(512, maxInputTokens - l1Tokens - l2Tokens);
  const assembledL3 = assembleContextBundle({
    slots: l3Slots,
    maxInputTokens: l3Budget,
    activeTechniqueIds: allTechniques.map((t) => t.id),
    activeDeconstructionIds: allDeconstructions.map((d) => d.id),
  });

  const protocolFooter = buildTaskProtocolSection(stage === "refine" ? "refine" : "write");
  const dynamicTail = normalizeCacheText(
    [assembledL3.dynamicTail, protocolFooter].filter(Boolean).join("\n\n"),
  );
  const l3Tokens = estimateTokenCount(dynamicTail);
  const l0Tokens = estimateTokenCount(SHARED_WORKBENCH_SYSTEM_KERNEL);
  const prefixTokens = l1Tokens + l2Tokens;
  const totalEstimatedTokens = prefixTokens + l3Tokens;
  const combinedPrefix = [SHARED_WORKBENCH_SYSTEM_KERNEL, shared.l1.compiledText, shared.l2.volumePrefix]
    .filter(Boolean)
    .join("\n\n===\n\n");
  const prefixSha256 = sha256Prefix(combinedPrefix);
  const estimatedCacheableRatio = Math.round(((l0Tokens + prefixTokens) / Math.max(1, l0Tokens + totalEstimatedTokens)) * 1000) / 1000;

  const prefixSlots: ContextSlotReportDto[] = [
    {
      id: "l1BookBible",
      label: `L1 全书圣经快照 v${shared.l1.snapshot.version}`,
      group: "prefix",
      tier: "l1",
      priority: "critical",
      rawTokens: l1Tokens,
      includedTokens: l1Tokens,
      status: l1Tokens > 0 ? "included" : "empty",
    },
    {
      id: "l2VolumeMilestones",
      label: shared.l2.archivedLimit > 0
        ? `L2 卷幕与前 ${shared.l2.archivedLimit} 章里程碑`
        : "L2 卷幕与活跃伏笔账本",
      group: "prefix",
      tier: "l2",
      priority: "high",
      rawTokens: l2Tokens,
      includedTokens: l2Tokens,
      status: l2Tokens > 0 ? "included" : "empty",
    },
  ];

  const stablePrefix = [shared.l1.compiledText, shared.l2.volumePrefix].filter(Boolean).join("\n\n===\n\n");

  return {
    projectId: row.projectId,
    knownAt: at,
    knownFacts,
    relatedChapters,
    scenario: null,
    contextBundle: {
      stablePrefix,
      bookPrefix: shared.l1.compiledText,
      bookPrefixSha256: shared.l1.snapshot.prefixSha256,
      bookSnapshotVersion: shared.l1.snapshot.version,
      volumePrefix: shared.l2.volumePrefix,
      volumePrefixSha256: shared.l2.volumePrefixSha256,
      dynamicTail,
      report: {
        maxInputTokens,
        totalEstimatedTokens,
        prefixTokens,
        dynamicTokens: l3Tokens,
        l1Tokens,
        l2Tokens,
        l3Tokens,
        l1Version: shared.l1.snapshot.version,
        l1DirtyCount: shared.l1.snapshot.dirtyMutations,
        l1Budget: shared.l1.snapshot.budgetTokens,
        prefixSha256,
        l2Sha256: shared.l2.volumePrefixSha256,
        estimatedCacheableRatio,
        overBudget: totalEstimatedTokens > maxInputTokens,
        slots: [...prefixSlots, ...assembledL3.report.slots],
        activeTechniqueIds: allTechniques.map((t) => t.id),
        activeDeconstructionIds: allDeconstructions.map((d) => d.id),
      },
    },
  };
}

export function previewContext(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
  if (row.product !== "fanqie") invalid("documentId", "chapter-required");
  const pacing = typeof input.pacing === "string" ? input.pacing : "";
  const instruction = typeof input.instruction === "string" ? input.instruction : "";
  const stage = input.stage !== undefined ? normalizeStageBindings([input.stage])[0] : undefined;
  return ctx.read(() => {
    const built = buildFanqieFrozenContext(ctx, row, input, { readOnly: true });
    const recommendations = queryTechniqueRecommendations(ctx, row, pacing, instruction, stage).slice(0, 8);
    return {
      knownAt: built.knownAt,
      knownFactsCount: built.knownFacts.length,
      report: built.contextBundle.report,
      relatedChapters: built.relatedChapters,
      recommendations,
    };
  });
}

/**
 * Fanqie single-shot generation runner using the 4-Tier Prompt Cache Ladder
 * (`L0 Shared Kernel` + `L1 Book Bible` + `L2 Volume Milestones` + `L3 Tail`).
 */
export function createFanqieGenerationRunner(): ProductGenerationRunner {
  return async ({ caller, run }) => {
    let prompt = run.frozenInput;
    let layered: LayeredPromptPayload | undefined;
    let system = WRITER_SYSTEM;
    try {
      const parsed = JSON.parse(run.frozenInput) as {
        projectId?: string;
        contextBundle?: ContextBundleDto;
      };
      if (parsed.contextBundle) {
        const bundle = parsed.contextBundle;
        const tail = bundle.dynamicTail || "";
        const joined = [bundle.stablePrefix, tail].filter(Boolean).join("\n\n---\n\n");
        if (joined.trim()) {
          prompt = joined;
          system = SHARED_WORKBENCH_SYSTEM_KERNEL;
          layered = {
            systemKernel: SHARED_WORKBENCH_SYSTEM_KERNEL,
            bookPrefix: bundle.bookPrefix ?? (bundle.stablePrefix || undefined),
            bookPrefixSha256: bundle.bookPrefixSha256,
            bookSnapshotVersion: bundle.bookSnapshotVersion,
            volumePrefix: bundle.volumePrefix || undefined,
            volumePrefixSha256: bundle.volumePrefixSha256,
            dynamicTail: tail,
            cachePartitionKey: parsed.projectId ? `zhizhang:${parsed.projectId}` : undefined,
          };
        }
      }
    } catch {
      // Fallback to raw frozenInput if non-JSON.
    }
    const body = await caller.complete({
      phase: "write",
      system,
      prompt,
      layered,
    });
    return { body, tokens: caller.usedTokens() };
  };
}
