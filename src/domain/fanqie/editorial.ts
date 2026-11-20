import { ContractError } from "../../contracts/errors.ts";
import { type Anchor, type ValidityInterval } from "../shared/anchors.ts";

import { CHAPTER_STATES, EDITORIAL_REJECTION_LIMIT } from "../../contracts/protected-rules.ts";

// Protected values live in contracts/protected-rules.ts (single source of truth); re-exported unchanged.
export { CHAPTER_STATES, EDITORIAL_REJECTION_LIMIT };
export type ChapterState = (typeof CHAPTER_STATES)[number];
export const DEFAULT_CHAPTER_LENGTH = [2000, 2500] as const;
export const CHAPTER_LENGTH_WARNING_BAND = [1500, 6000] as const;

/**
 * Author-authorized explicit Fanqie chapter transition table (Res#1 / FQ-25),
 * encoded verbatim from `docs/02-domain-rules.md` without adding or removing
 * any transition edge.
 */
export const CHAPTER_TRANSITIONS = {
  planned: ["drafting"],
  drafting: ["drafting", "drafted", "reviewed"],
  drafted: ["drafted", "reviewed"],
  reviewed: ["drafted", "final"],
  final: [],
} as const satisfies Readonly<Record<ChapterState, readonly ChapterState[]>>;

export function assertChapterTransition(from: ChapterState, to: ChapterState): void {
  if (!Object.hasOwn(CHAPTER_TRANSITIONS, from)) {
    throw new ContractError("input.invalid", { field: "state", reason: "unknown-chapter-state" });
  }
  if (!Object.hasOwn(CHAPTER_TRANSITIONS, to)) {
    throw new ContractError("input.invalid", { field: "state", reason: "unknown-chapter-state" });
  }
  if (!(CHAPTER_TRANSITIONS[from] as readonly string[]).includes(to)) {
    throw new ContractError("gate.denied", {
      action: "chapter.transition",
      from,
      to,
      reason: `${from} → ${to}`,
    });
  }
}

export const PACING = {
  快爽: { opening: "约前 300 字见到具体处境", payoff: "小回报约 1–2 章，阶段回报约 4–6 章", genres: ["逆袭", "打脸", "系统", "鉴宝", "高武", "战神", "重生"] },
  稳推: { opening: "首章立住处境与所求", payoff: "单元内有可见进展", genres: ["权谋", "经营", "种田", "年代", "都市", "都市日常", "言情"] },
  慢燃: { opening: "立住氛围与可理解的问题", payoff: "以信息揭示和关系移动为主", genres: ["悬疑", "灵异", "刑侦", "温情", "群像"] },
} as const;

export function assertChapterFinalizable(state: ChapterState, editorialRejections: number): void {
  if (state !== "reviewed" || editorialRejections > EDITORIAL_REJECTION_LIMIT) {
    throw new ContractError("gate.denied", {
      action: "draft.finalize",
      reason: state !== "reviewed" ? "editorial-review-required" : "editorial-rejection-limit",
    });
  }
}

export interface SettingFact extends ValidityInterval {
  readonly id: string;
  readonly note: string;
  readonly knownFrom: Readonly<Record<string, Anchor>>;
  readonly kind: "fact" | "agreement";
  readonly locked: boolean;
  readonly source: string;
  readonly aliases?: readonly string[];
}

export function settingsAt(
  entries: readonly SettingFact[],
  order: readonly string[],
  at: Anchor,
  characterId: string,
): SettingFact[] {
  const positions = new Map<string, number>();
  order.forEach((id, index) => { if (!positions.has(id)) positions.set(id, index); });
  const before = (left: Anchor, right: Anchor) => {
    const a = positions.get(left.chapterId) ?? order.length;
    const b = positions.get(right.chapterId) ?? order.length;
    return a === b ? left.point < right.point : a < b;
  };
  const effective = new Map<string, SettingFact>();
  for (const entry of entries) {
    if (before(at, entry.effectiveFrom) || (entry.effectiveTo && !before(at, entry.effectiveTo))) continue;
    const prior = effective.get(entry.id);
    if (!prior || !before(entry.effectiveFrom, prior.effectiveFrom)) effective.set(entry.id, entry);
  }
  return [...effective.values()].filter((entry) => {
    if (entry.kind === "agreement") return false;
    const known = Object.hasOwn(entry.knownFrom, characterId) ? entry.knownFrom[characterId] : undefined;
    return known !== undefined && !before(at, known);
  });
}

export const OUTLINE_SECTIONS = ["剧情梗概", "核心冲突与看点", "情节推进节点", "章末落点"] as const;

export function chapterLengthWarnings(target: number): string[] {
  const [min, max] = CHAPTER_LENGTH_WARNING_BAND;
  return target < min || target > max ? [`目标篇幅可参考 ${min}–${max} 个非空白字符`] : [];
}
