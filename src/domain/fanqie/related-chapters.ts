import type { SettingFact } from "./editorial.ts";

export interface RelatedChapterCandidate {
  readonly chapterId: string;
  readonly title: string;
  readonly summary: string;
}

export interface ChapterEntityMention {
  readonly documentId: string;
  readonly entityName: string;
  readonly mentionCount: number;
}

export interface RelatedChapterForeshadow {
  readonly title?: string;
  readonly plantedChapterId: string | null;
  readonly targetChapterId: string | null;
  readonly status: string;
}

export interface RelatedChaptersInput {
  readonly currentChapterId: string;
  readonly chapterOrder: readonly string[];
  readonly chapters: readonly RelatedChapterCandidate[];
  readonly foreshadows: readonly RelatedChapterForeshadow[];
  readonly facts: readonly SettingFact[];
  readonly entityMentions: readonly ChapterEntityMention[];
  readonly viewpoint?: string;
  readonly currentEntityNames?: readonly string[];
  readonly currentOutlineText?: string;
  readonly semanticScores?: Readonly<Record<string, number>>;
  readonly recentWindow?: number;
  readonly topK?: number;
}

export interface RelatedChapterMatch {
  readonly chapterId: string;
  readonly title: string;
  readonly summary: string;
  readonly score: number;
  readonly breakdown: {
    readonly foreshadow: number;
    readonly character: number;
    readonly knownFrom: number;
    readonly cooccurrenceAndSemantic: number;
  };
  readonly reasons: readonly string[];
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Ranks non-recent historical chapters across 4 zero-token dimensions
 * (unrecovered foreshadows 0.35, weighted entity overlap 0.25, `knownFrom`
 * narrative origin 0.25, multi-character co-occurrence + BM25 0.15).
 */
export function rankRelatedChapters(input: RelatedChaptersInput): RelatedChapterMatch[] {
  const currentIdx = input.chapterOrder.indexOf(input.currentChapterId);
  if (currentIdx <= 0) return [];

  const recentWindow = input.recentWindow ?? 5;
  const maxEligibleIdx = currentIdx - recentWindow - 1;
  if (maxEligibleIdx < 0) return [];

  const orderIndex = new Map<string, number>();
  for (let i = 0; i <= maxEligibleIdx; i++) {
    orderIndex.set(input.chapterOrder[i], i);
  }

  const viewpoint = input.viewpoint?.trim() ?? "";
  const activeCharacters = new Set<string>();
  if (viewpoint) activeCharacters.add(viewpoint);
  for (const name of input.currentEntityNames ?? []) {
    const trimmed = name.trim();
    if (trimmed) activeCharacters.add(trimmed);
  }

  const outlineText = input.currentOutlineText ?? "";
  const chapterEntities = new Map<string, Map<string, number>>();
  for (const mention of input.entityMentions) {
    const name = mention.entityName.trim();
    if (!name) continue;
    if (name.length >= 2 && outlineText && outlineText.includes(name)) {
      activeCharacters.add(name);
    }
    if (mention.mentionCount <= 0) continue;
    let perDoc = chapterEntities.get(mention.documentId);
    if (!perDoc) {
      perDoc = new Map();
      chapterEntities.set(mention.documentId, perDoc);
    }
    perDoc.set(name, (perDoc.get(name) ?? 0) + mention.mentionCount);
  }

  let totalWeight = 0;
  for (const name of activeCharacters) {
    totalWeight += name === viewpoint ? 2 : 1;
  }

  const foreshadowByPlanted = new Map<string, RelatedChapterForeshadow[]>();
  for (const fs of input.foreshadows) {
    if ((fs.status === "planted" || fs.status === "hinted") && fs.plantedChapterId) {
      const list = foreshadowByPlanted.get(fs.plantedChapterId) ?? [];
      list.push(fs);
      foreshadowByPlanted.set(fs.plantedChapterId, list);
    }
  }

  const nonAgreementFacts = input.facts.filter((fact) => fact.kind !== "agreement");
  const scored: Array<{ readonly match: RelatedChapterMatch; readonly candIdx: number }> = [];

  for (const candidate of input.chapters) {
    const candIdx = orderIndex.get(candidate.chapterId);
    if (candIdx === undefined) continue;

    const reasons = new Set<string>();

    // 1. Foreshadow dimension (0.35)
    let foreshadow = 0;
    const planted = foreshadowByPlanted.get(candidate.chapterId) ?? [];
    if (planted.length > 0) {
      if (planted.some((fs) => fs.targetChapterId === input.currentChapterId)) {
        foreshadow = 1.0;
        reasons.add("伏笔预定回收章");
      } else {
        foreshadow = Math.min(0.85, 0.45 + 0.2 * (planted.length - 1));
        reasons.add("未回收伏笔埋设章");
      }
    }

    // 2. Character entity overlap dimension (0.25)
    const candMentions = chapterEntities.get(candidate.chapterId);
    let matchedWeight = 0;
    let distinctActiveMatched = 0;
    const matchedNames: string[] = [];
    if (candMentions && activeCharacters.size > 0) {
      for (const name of activeCharacters) {
        if (candMentions.has(name)) {
          matchedWeight += name === viewpoint ? 2 : 1;
          distinctActiveMatched += 1;
          matchedNames.push(name);
        }
      }
    }
    const character = totalWeight > 0 ? Math.min(1, matchedWeight / totalWeight) : 0;
    if (character > 0) {
      reasons.add(`出场核心实体：${matchedNames.slice(0, 3).join("、")}`);
    }

    // 3. knownFrom narrative origin dimension (0.25)
    let rawKnown = 0;
    for (const fact of nonAgreementFacts) {
      if (viewpoint && fact.knownFrom[viewpoint]?.chapterId === candidate.chapterId) {
        rawKnown += 0.7;
        reasons.add("视角人物知情源头章");
      }
      if (fact.locked && fact.effectiveFrom.chapterId === candidate.chapterId) {
        rawKnown += 0.4;
        reasons.add("锁定设定生效转折章");
      }
      if (fact.effectiveTo?.chapterId === candidate.chapterId) {
        rawKnown += 0.3;
        reasons.add("设定失效节点章");
      }
    }
    const knownFrom = Math.min(1, rawKnown);

    // 4. Co-occurrence + semantic BM25 dimension (0.15)
    const cooc =
      activeCharacters.size >= 2 && distinctActiveMatched >= 2
        ? Math.min(1, (distinctActiveMatched - 1) / (activeCharacters.size - 1))
        : 0;
    const sem = Math.max(0, Math.min(1, input.semanticScores?.[candidate.chapterId] ?? 0));
    const cooccurrenceAndSemantic = activeCharacters.size >= 2 ? Math.min(1, 0.5 * cooc + 0.5 * sem) : sem;
    if (cooc > 0) reasons.add("多角共现");
    if (sem > 0) reasons.add("语义高相关");

    const total = round4(
      0.35 * foreshadow + 0.25 * character + 0.25 * knownFrom + 0.15 * cooccurrenceAndSemantic,
    );
    if (total <= 0) continue;

    scored.push({
      candIdx,
      match: {
        chapterId: candidate.chapterId,
        title: candidate.title,
        summary: candidate.summary,
        score: total,
        breakdown: {
          foreshadow: round4(foreshadow),
          character: round4(character),
          knownFrom: round4(knownFrom),
          cooccurrenceAndSemantic: round4(cooccurrenceAndSemantic),
        },
        reasons: [...reasons],
      },
    });
  }

  scored.sort((a, b) => {
    if (b.match.score !== a.match.score) return b.match.score - a.match.score;
    if (b.candIdx !== a.candIdx) return b.candIdx - a.candIdx;
    return a.match.chapterId < b.match.chapterId ? -1 : a.match.chapterId > b.match.chapterId ? 1 : 0;
  });

  const topK = Math.max(1, input.topK ?? 4);
  return scored.slice(0, topK).map((entry) => entry.match);
}
