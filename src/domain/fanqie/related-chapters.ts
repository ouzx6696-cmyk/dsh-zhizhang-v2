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
  readonly entityAliases?: Readonly<Record<string, readonly string[]>>;
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

export interface EntityAliasTarget {
  readonly factId: string;
  readonly entityName: string;
  readonly aliases?: readonly string[];
  readonly category?: string;
}

export interface EntityMentionCountResult {
  readonly factId: string;
  readonly entityName: string;
  readonly category?: string;
  readonly count: number;
  readonly matchedTerms: Readonly<Record<string, number>>;
}

interface ChapterFactSignal {
  rawKnown: number;
  hasViewpointOrigin: boolean;
  hasLockedEffectiveFrom: boolean;
  hasEffectiveTo: boolean;
}

const ASCII_TERM_RE = /^[A-Za-z0-9_-]+$/u;
const ASCII_WORD_CHAR_RE = /[A-Za-z0-9_-]/u;

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function isAsciiWordBoundary(text: string, start: number, end: number): boolean {
  if (start > 0 && ASCII_WORD_CHAR_RE.test(text[start - 1])) return false;
  if (end < text.length && ASCII_WORD_CHAR_RE.test(text[end])) return false;
  return true;
}

/**
 * Counts mentions of entities and their aliases in `body` using non-overlapping
 * longest-match scanning (FQ-19). Longer names/aliases (e.g. `李四海`, `林远山`)
 * claim their spans before shorter substrings (`李四`, `林远`) can double-match.
 */
export function countEntityMentionsWithAliases(
  body: string,
  entities: readonly EntityAliasTarget[],
  options?: { readonly minTermLength?: number },
): EntityMentionCountResult[] {
  if (!body || entities.length === 0) return [];
  const minLen =
    options?.minTermLength !== undefined && Number.isFinite(options.minTermLength) && options.minTermLength >= 1
      ? Math.floor(options.minTermLength)
      : 2;

  const termOwners = new Map<string, EntityAliasTarget[]>();
  const seenPerEntity = new Map<string, Set<string>>();

  for (const entity of entities) {
    let entityTerms = seenPerEntity.get(entity.factId);
    if (!entityTerms) {
      entityTerms = new Set<string>();
      seenPerEntity.set(entity.factId, entityTerms);
    }
    const candidates = [entity.entityName, ...(entity.aliases ?? [])];
    for (const raw of candidates) {
      const term = raw.trim();
      if (term.length < minLen || entityTerms.has(term)) continue;
      entityTerms.add(term);
      const owners = termOwners.get(term);
      if (owners) owners.push(entity);
      else termOwners.set(term, [entity]);
    }
  }

  if (termOwners.size === 0) return [];

  const sortedTerms = [...termOwners.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const occupied = new Uint8Array(body.length);
  const tallies = new Map<
    string,
    {
      readonly target: EntityAliasTarget;
      count: number;
      readonly matchedTerms: Record<string, number>;
    }
  >();

  for (const term of sortedTerms) {
    const tlen = term.length;
    if (tlen > body.length) continue;
    const isAscii = ASCII_TERM_RE.test(term);
    const owners = termOwners.get(term)!;
    let pos = 0;
    while (pos <= body.length - tlen) {
      const found = body.indexOf(term, pos);
      if (found < 0) break;
      const end = found + tlen;

      if (isAscii && !isAsciiWordBoundary(body, found, end)) {
        pos = found + 1;
        continue;
      }

      let overlaps = false;
      for (let k = found; k < end; k += 1) {
        if (occupied[k] !== 0) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) {
        pos = found + 1;
        continue;
      }

      occupied.fill(1, found, end);
      for (const owner of owners) {
        let entry = tallies.get(owner.factId);
        if (!entry) {
          entry = { target: owner, count: 0, matchedTerms: {} };
          tallies.set(owner.factId, entry);
        }
        entry.count += 1;
        entry.matchedTerms[term] = (entry.matchedTerms[term] ?? 0) + 1;
      }
      pos = end;
    }
  }

  const results: EntityMentionCountResult[] = [];
  for (const entry of tallies.values()) {
    if (entry.count <= 0) continue;
    results.push({
      factId: entry.target.factId,
      entityName: entry.target.entityName.trim(),
      ...(entry.target.category !== undefined ? { category: entry.target.category } : {}),
      count: entry.count,
      matchedTerms: entry.matchedTerms,
    });
  }
  results.sort((a, b) => b.count - a.count || a.factId.localeCompare(b.factId));
  return results;
}

/**
 * Ranks non-recent historical chapters across 4 zero-token dimensions
 * (unrecovered foreshadows 0.35, weighted entity overlap 0.25, `knownFrom`
 * narrative origin 0.25, multi-character co-occurrence + BM25 0.15).
 *
 * Pre-indexes chapter positions and chapter->fact signals in O(N + F + E) (FQ-18).
 */
export function rankRelatedChapters(input: RelatedChaptersInput): RelatedChapterMatch[] {
  const positionMap = new Map<string, number>();
  for (let i = 0; i < input.chapterOrder.length; i += 1) {
    const id = input.chapterOrder[i];
    if (!positionMap.has(id)) positionMap.set(id, i);
  }

  const currentIdx = positionMap.get(input.currentChapterId) ?? -1;
  if (currentIdx <= 0) return [];

  const recentWindow = input.recentWindow ?? 5;
  const maxEligibleIdx = currentIdx - recentWindow - 1;
  if (maxEligibleIdx < 0) return [];

  const viewpoint = input.viewpoint?.trim() ?? "";
  const activeCharacters = new Set<string>();
  if (viewpoint) activeCharacters.add(viewpoint);
  for (const name of input.currentEntityNames ?? []) {
    const trimmed = name.trim();
    if (trimmed) activeCharacters.add(trimmed);
  }

  const outlineText = input.currentOutlineText ?? "";
  const entityAliases = input.entityAliases;
  if (outlineText && entityAliases) {
    for (const [canonical, aliases] of Object.entries(entityAliases)) {
      const name = canonical.trim();
      if (!name || activeCharacters.has(name)) continue;
      if (
        (name.length >= 2 && outlineText.includes(name)) ||
        aliases.some((alias) => {
          const t = alias.trim();
          return t.length >= 2 && outlineText.includes(t);
        })
      ) {
        activeCharacters.add(name);
      }
    }
  }

  const checkedOutlineNames = new Set<string>();
  const chapterEntities = new Map<string, Map<string, number>>();
  for (const mention of input.entityMentions) {
    const name = mention.entityName.trim();
    if (!name) continue;
    if (outlineText && name.length >= 2 && !checkedOutlineNames.has(name)) {
      checkedOutlineNames.add(name);
      if (outlineText.includes(name)) {
        activeCharacters.add(name);
      }
    }
    if (mention.mentionCount <= 0) continue;
    const docIdx = positionMap.get(mention.documentId);
    if (docIdx === undefined || docIdx > maxEligibleIdx) continue;
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
      const plantedIdx = positionMap.get(fs.plantedChapterId);
      if (plantedIdx === undefined || plantedIdx > maxEligibleIdx) continue;
      const list = foreshadowByPlanted.get(fs.plantedChapterId);
      if (list) list.push(fs);
      else foreshadowByPlanted.set(fs.plantedChapterId, [fs]);
    }
  }

  // Pre-index chapterId -> fact narrative signals once in O(F) instead of O(C * F).
  const factSignalsByChapter = new Map<string, ChapterFactSignal>();
  const touchSignal = (chapterId: string): ChapterFactSignal | null => {
    const idx = positionMap.get(chapterId);
    if (idx === undefined || idx > maxEligibleIdx) return null;
    let sig = factSignalsByChapter.get(chapterId);
    if (!sig) {
      sig = {
        rawKnown: 0,
        hasViewpointOrigin: false,
        hasLockedEffectiveFrom: false,
        hasEffectiveTo: false,
      };
      factSignalsByChapter.set(chapterId, sig);
    }
    return sig;
  };

  for (const fact of input.facts) {
    if (fact.kind === "agreement") continue;
    if (viewpoint && Object.hasOwn(fact.knownFrom, viewpoint)) {
      const knownAt = fact.knownFrom[viewpoint];
      if (knownAt) {
        const sig = touchSignal(knownAt.chapterId);
        if (sig) {
          sig.rawKnown += 0.7;
          sig.hasViewpointOrigin = true;
        }
      }
    }
    if (fact.locked) {
      const sig = touchSignal(fact.effectiveFrom.chapterId);
      if (sig) {
        sig.rawKnown += 0.4;
        sig.hasLockedEffectiveFrom = true;
      }
    }
    if (fact.effectiveTo) {
      const sig = touchSignal(fact.effectiveTo.chapterId);
      if (sig) {
        sig.rawKnown += 0.3;
        sig.hasEffectiveTo = true;
      }
    }
  }

  const scored: Array<{ readonly match: RelatedChapterMatch; readonly candIdx: number }> = [];

  for (const candidate of input.chapters) {
    const candIdx = positionMap.get(candidate.chapterId);
    if (candIdx === undefined || candIdx > maxEligibleIdx) continue;

    const reasons = new Set<string>();

    // 1. Foreshadow dimension (0.35)
    let foreshadow = 0;
    const planted = foreshadowByPlanted.get(candidate.chapterId);
    if (planted && planted.length > 0) {
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

    // 3. knownFrom narrative origin dimension (0.25) — O(1) lookup
    const factSignal = factSignalsByChapter.get(candidate.chapterId);
    let knownFrom = 0;
    if (factSignal) {
      knownFrom = Math.min(1, factSignal.rawKnown);
      if (factSignal.hasViewpointOrigin) reasons.add("视角人物知情源头章");
      if (factSignal.hasLockedEffectiveFrom) reasons.add("锁定设定生效转折章");
      if (factSignal.hasEffectiveTo) reasons.add("设定失效节点章");
    }

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
