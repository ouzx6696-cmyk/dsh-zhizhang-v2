import { ContractError } from "../../contracts/errors.ts";

import { DELIVERY_ENDING, QA_PASS_SCORE, QA_REFINEMENT_LIMIT, TITLE_MAX } from "../../contracts/protected-rules.ts";

// Protected values live in contracts/protected-rules.ts (single source of truth); re-exported unchanged.
export { DELIVERY_ENDING, QA_PASS_SCORE, QA_REFINEMENT_LIMIT, TITLE_MAX };

export const ARTICLE_TRANSITIONS = {
  初稿待改: ["待验收"],
  待验收: ["已验收", "验收退回", "初稿待改"],
  已验收: ["已交稿"],
  验收退回: ["初稿待改", "待验收"],
  已交稿: [],
} as const;
export type ArticleStatus = keyof typeof ARTICLE_TRANSITIONS;

export const ARTICLE_MODES = {
  long: { label: "长图文", length: [2600, 3400], main: [1700, 2300], extension: [800, 1300] },
  short: { label: "短图文", length: [1100, 2200], main: null, extension: null },
  micro: { label: "微头条", length: [300, 1000], main: null, extension: null },
} as const;
export type ArticleMode = keyof typeof ARTICLE_MODES;

export const CONTENT_LINES = {
  资讯线: {
    drivers: ["账本型", "处境型", "冲突型", "信息型", "情感型"],
    openings: ["现场动作", "跑腿卡点", "原话顶门", "时间死线", "直球亮底牌", "账单暴击"],
    endings: ["经历共鸣", "两难选择", "潜台词追问", "帮亲友问计", "观点碰撞", "晒坐标"],
    extensions: ["下一步", "另一面", "往深一层"],
  },
  故事线: {
    drivers: ["故事型"],
    openings: ["定格画面", "原典一句", "反常结局", "配角开口", "直球亮底牌"],
    endings: ["画面留白", "两难选择", "经历共鸣", "观点碰撞", "古今对照"],
    extensions: ["别国同母题", "原典与流行说法", "今天的痕迹"],
  },
} as const;
export type ContentLine = keyof typeof CONTENT_LINES;

export function articleScenario(mode: string, line: string) {
  if (!Object.hasOwn(ARTICLE_MODES, mode)) {
    throw new ContractError("input.invalid", { field: "mode", reason: "unknown-article-mode" });
  }
  if (!Object.hasOwn(CONTENT_LINES, line)) {
    throw new ContractError("input.invalid", { field: "line", reason: "unknown-content-line" });
  }
  return { ...ARTICLE_MODES[mode as ArticleMode], ...CONTENT_LINES[line as ContentLine], hasTitle: mode !== "micro" };
}

export function assertArticleTransition(from: ArticleStatus, to: ArticleStatus): void {
  if (!(ARTICLE_TRANSITIONS[from] as readonly string[] | undefined)?.includes(to)) {
    throw new ContractError("gate.denied", { action: "article.transition", reason: `${from} → ${to}` });
  }
}

export function validateTitleMatrix(candidates: readonly { text: string; motif: string }[]) {
  const seen = new Set<string>();
  const valid = candidates.filter(({ text, motif }) => {
    const title = text.trim();
    if (!title || [...title].length > TITLE_MAX || !motif.trim() || seen.has(title)) return false;
    seen.add(title);
    return true;
  });
  const motifCount = new Set(valid.map(({ motif }) => motif.trim())).size;
  return { valid, motifCount, passed: valid.length >= 5 && motifCount >= 3 };
}

export interface ArticleQa {
  readonly overall: number;
  readonly passed: boolean;
  readonly fails: readonly string[];
  readonly hardGates: readonly string[];
}

export function qaPassed(qa: ArticleQa): boolean {
  return Number.isFinite(qa.overall) && qa.overall >= QA_PASS_SCORE && qa.overall <= 100 &&
    qa.passed === true && qa.fails.length === 0 && qa.hardGates.length === 0;
}

export function structuralGates(mode: ArticleMode, title: string, body: string): string[] {
  const gates: string[] = [];
  if (mode === "micro") {
    if (title.trim()) gates.push("微头条不设标题");
    if (/^\s*#{1,6}\s+\S/m.test(body)) gates.push("微头条不设小标题");
  } else if (!title.trim() || [...title.trim()].length > TITLE_MAX) {
    gates.push("标题须为 1–34 字符");
  }
  const [min, max] = ARTICLE_MODES[mode].length;
  const length = [...body.replace(/\s/gu, "")].length;
  if (length < min || length > max) gates.push(`正文须为 ${min}–${max} 个非空白字符`);
  return gates;
}

export function formatDelivery(title: string, body: string): string {
  let text = body.trimEnd();
  while (text.endsWith(DELIVERY_ENDING)) text = text.slice(0, -DELIVERY_ENDING.length).trimEnd();
  return [title.trim() && `# ${title.trim()}`, text.trim(), DELIVERY_ENDING].filter(Boolean).join("\n\n") + "\n";
}
