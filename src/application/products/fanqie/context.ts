import type {
  ContextBundleDto,
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
import { assembleContextBundle, type ContextSlotInput } from "../../../workflow/context-slots.ts";
import { WRITER_SYSTEM } from "../../../workflow/writing-budget.ts";
import { count, invalid, type DocumentRow, type Input, type WorkspaceContext } from "../../context.ts";
import type { ProductGenerationRunner } from "../../product-line.ts";
import { loadProjectControls } from "./controls.ts";
import { queryTechniqueRecommendations, resolveMountedLibraryForChapter } from "./library.ts";
import { approvedFacts } from "./shared.ts";

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

function formatFactsBlock(facts: readonly SettingFact[]): string {
  if (facts.length === 0) return "";
  return facts.map((fact) => `- [${fact.id}] ${fact.note}（来源：${fact.source}）`).join("\n");
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
): {
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

  // 1. Agreements (stable project-wide rules, sorted deterministically for Prefix Cache)
  const agreementRows = stmt(ctx.db, `
    SELECT fact_id AS factId, value FROM author_lore_current
    WHERE project_id = ? AND category = 'agreement'
    ORDER BY fact_id ASC;
  `).all(row.projectId) as readonly { factId: string; value: string }[];
  const agreementText = agreementRows
    .map((entry) => {
      try {
        const parsed = JSON.parse(entry.value) as { note?: string };
        return `- [${entry.factId}] ${parsed.note ?? ""}`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n");

  // 2. Targeted author-selected qualitative observations (optional refine / deslop focus)
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

  // 3. Stage-bound mounted & recommended technique/skill cards + deconstruction samples (sorted by stable ID)
  const pacing = typeof input.pacing === "string" ? input.pacing : "";
  const mounted = resolveMountedLibraryForChapter(ctx, row, instruction, pacing, stage);
  const techniques = [...mounted.techniques].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const deconstructions = [...mounted.deconstructions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 3. Active foreshadows planted on or before current chapter
  const currentIdx = order.indexOf(row.id);
  const foreshadowRows = stmt(ctx.db, `
    SELECT title, planted_chapter_id AS plantedChapterId, target_chapter_id AS targetChapterId, status, note
    FROM author_foreshadows
    WHERE project_id = ? AND status IN ('planted', 'hinted')
    ORDER BY updated_at DESC;
  `).all(row.projectId) as readonly {
    title: string;
    plantedChapterId: string | null;
    targetChapterId: string | null;
    status: string;
    note: string;
  }[];
  const activeForeshadows = foreshadowRows
    .filter((fs) => {
      if (!fs.plantedChapterId || currentIdx < 0) return true;
      const plantedIdx = order.indexOf(fs.plantedChapterId);
      return plantedIdx === -1 || plantedIdx <= currentIdx;
    })
    .map((fs) => `- [${fs.status === "hinted" ? "推进中" : "已埋设"}] ${fs.title}${fs.note ? `：${fs.note}` : ""}`)
    .join("\n");

  // 4. 4D Zero-token related historical chapter recall (outside recent 5 chapters)
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

  // 5. Rolling summaries (up to 5 previous chapters) & previous chapter tail
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
      prevChapterTail = tail.length > 1200 ? `《${prevRow.title}》末尾衔接：\n…${tail.slice(-1200)}` : `《${prevRow.title}》末尾衔接：\n${tail}`;
    }

    const prevSlice = order.slice(Math.max(0, currentIdx - 5), currentIdx);
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

  const slots: readonly ContextSlotInput[] = [
    {
      id: "agreements",
      label: "全书创作约定（Prefix 稳定区）",
      group: "prefix",
      priority: "high",
      content: agreementText,
      maxShare: 0.15,
    },
    {
      id: "authorIntent",
      label: "全书指南针（创作意图与禁区）",
      group: "prefix",
      priority: "high",
      content: controls.authorIntent,
      maxShare: 0.12,
    },
    {
      id: "techniques",
      label: "挂载技法卡片",
      group: "prefix",
      priority: "medium",
      content: formatTechniquesBlock(techniques),
      maxShare: 0.18,
    },
    {
      id: "deconstructions",
      label: "挂载拆书范本",
      group: "prefix",
      priority: "optional",
      content: formatDeconstructionsBlock(deconstructions),
      maxShare: 0.16,
    },
    {
      id: "currentFocus",
      label: "当前写作焦点与卷弧目标",
      group: "dynamic",
      priority: "high",
      content: focusContent,
      maxShare: 0.1,
    },
    {
      id: "outline",
      label: "本章章纲与约束",
      group: "dynamic",
      priority: "critical",
      content: formatOutlineBlock(plan, row.title),
    },
    {
      id: "knownFacts",
      label: viewpoint ? `视角人物「${viewpoint}」知情设定` : "知情设定",
      group: "dynamic",
      priority: "high",
      content: formatFactsBlock(knownFacts),
      maxShare: 0.2,
    },
    {
      id: "foreshadows",
      label: "活跃伏笔提示",
      group: "dynamic",
      priority: "medium",
      content: activeForeshadows,
      maxShare: 0.1,
    },
    {
      id: "relatedHistory",
      label: "相关远期历史章召回（Top 4）",
      group: "dynamic",
      priority: "medium",
      content: formatRelatedChaptersBlock(relatedChapters),
      maxShare: 0.14,
    },
    {
      id: "rollingSummaries",
      label: "前文滚动摘要（近5章）",
      group: "dynamic",
      priority: "optional",
      content: summaryLines.join("\n"),
      maxShare: 0.18,
      trimMode: "head",
    },
    {
      id: "prevTail",
      label: "上一章末尾衔接段",
      group: "dynamic",
      priority: "medium",
      content: prevChapterTail,
      maxShare: 0.2,
      trimMode: "head",
    },
    {
      id: "activeDraft",
      label: "当前章工作稿正文",
      group: "dynamic",
      priority: "critical",
      content: row.body ?? "",
    },
    ...(targetedObsText
      ? [
          {
            id: "targetedObservations",
            label: "作者勾选的定向修改意见",
            group: "dynamic" as const,
            priority: "high" as const,
            content: targetedObsText,
          },
        ]
      : []),
    {
      id: "instruction",
      label: "本轮写作指令",
      group: "dynamic",
      priority: "critical",
      content: instruction,
    },
  ];

  const assembled = assembleContextBundle({
    slots,
    maxInputTokens,
    activeTechniqueIds: techniques.map((t) => t.id),
    activeDeconstructionIds: deconstructions.map((d) => d.id),
  });

  return {
    knownAt: at,
    knownFacts,
    relatedChapters,
    scenario: null,
    contextBundle: {
      stablePrefix: assembled.stablePrefix,
      dynamicTail: assembled.dynamicTail,
      report: assembled.report,
    },
  };
}

export function previewContext(ctx: WorkspaceContext, row: DocumentRow, input: Input) {
  if (row.product !== "fanqie") invalid("documentId", "chapter-required");
  const pacing = typeof input.pacing === "string" ? input.pacing : "";
  const instruction = typeof input.instruction === "string" ? input.instruction : "";
  const stage = input.stage !== undefined ? normalizeStageBindings([input.stage])[0] : undefined;
  return ctx.read(() => {
    const built = buildFanqieFrozenContext(ctx, row, input);
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
 * Fanqie single-shot generation runner that preserves Prefix-Caching stable
 * headers when `contextBundle` is present in `frozenInput`.
 */
export function createFanqieGenerationRunner(): ProductGenerationRunner {
  return async ({ caller, run }) => {
    let prompt = run.frozenInput;
    let cachePrefix: string | undefined;
    try {
      const parsed = JSON.parse(run.frozenInput) as {
        contextBundle?: { readonly stablePrefix?: string; readonly dynamicTail?: string };
      };
      if (parsed.contextBundle) {
        const joined = [parsed.contextBundle.stablePrefix, parsed.contextBundle.dynamicTail]
          .filter(Boolean)
          .join("\n\n---\n\n");
        if (joined.trim()) {
          prompt = joined;
          cachePrefix = parsed.contextBundle.stablePrefix || undefined;
        }
      }
    } catch {
      // Fallback to raw frozenInput if non-JSON.
    }
    const body = await caller.complete({
      phase: "write",
      system: WRITER_SYSTEM,
      prompt,
      cachePrefix,
    });
    return { body, tokens: caller.usedTokens() };
  };
}
