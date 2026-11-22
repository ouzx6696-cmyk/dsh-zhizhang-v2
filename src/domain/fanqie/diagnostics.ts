import type {
  AiSlopReportDto,
  ChapterDiagnosticsReportDto,
  ChapterQualityV2Dto,
  GoldenThreeDimensionDto,
  GoldenThreeReportDto,
  PovLeakWarningDto,
  SlopHitDto,
} from "../../contracts/workspace-dto.ts";
import { splitChapterParagraphs } from "../shared/anchors.ts";
import { CHAPTER_LENGTH_WARNING_BAND, DEFAULT_CHAPTER_LENGTH } from "./editorial.ts";

export const OBSERVATION_DIMENSIONS = [
  "continuity",
  "ooc",
  "pacing",
  "foreshadow",
  "style",
  "ai_slop",
] as const;

export interface AiSlopPattern {
  readonly phrase: string;
  readonly category: "cliche_action" | "cliche_emotion" | "summary_connector" | "filler_hedge";
}

export const AI_SLOP_CATEGORY_WEIGHTS: Readonly<Record<string, number>> = {
  summary_connector: 0.5,
  cliche_emotion: 1.0,
  cliche_action: 1.0,
  filler_hedge: 0.75,
  custom: 1.0,
};

export const DEFAULT_AI_SLOP_PATTERNS: readonly AiSlopPattern[] = [
  // summary_connector
  { phrase: "值得注意的是", category: "summary_connector" },
  { phrase: "总而言之", category: "summary_connector" },
  { phrase: "综上所述", category: "summary_connector" },
  { phrase: "不难看出", category: "summary_connector" },
  { phrase: "由此可见", category: "summary_connector" },
  { phrase: "毋庸置疑", category: "summary_connector" },
  { phrase: "毫不夸张地说", category: "summary_connector" },
  { phrase: "换句话说", category: "summary_connector" },
  { phrase: "归根结底", category: "summary_connector" },
  { phrase: "显而易见", category: "summary_connector" },
  { phrase: "事实上", category: "summary_connector" },
  { phrase: "不仅如此", category: "summary_connector" },
  { phrase: "与此同时", category: "summary_connector" },
  { phrase: "然而就在这时", category: "summary_connector" },
  { phrase: "说白了", category: "summary_connector" },
  { phrase: "归根到底", category: "summary_connector" },
  { phrase: "客观来看", category: "summary_connector" },
  { phrase: "平心而论", category: "summary_connector" },
  { phrase: "不可否认", category: "summary_connector" },
  { phrase: "令人深思的是", category: "summary_connector" },
  // cliche_emotion
  { phrase: "五味杂陈", category: "cliche_emotion" },
  { phrase: "百感交集", category: "cliche_emotion" },
  { phrase: "嘴角微微上扬", category: "cliche_emotion" },
  { phrase: "勾起一抹冷笑", category: "cliche_emotion" },
  { phrase: "眼中闪过一丝", category: "cliche_emotion" },
  { phrase: "瞳孔骤然一缩", category: "cliche_emotion" },
  { phrase: "倒吸一口凉气", category: "cliche_emotion" },
  { phrase: "心中一凛", category: "cliche_emotion" },
  { phrase: "心头猛地一震", category: "cliche_emotion" },
  { phrase: "如坠冰窟", category: "cliche_emotion" },
  { phrase: "翻江倒海", category: "cliche_emotion" },
  { phrase: "难以名状", category: "cliche_emotion" },
  { phrase: "说不出的复杂", category: "cliche_emotion" },
  { phrase: "脊背发凉", category: "cliche_emotion" },
  { phrase: "莫名的颤栗", category: "cliche_emotion" },
  { phrase: "心脏漏跳了一拍", category: "cliche_emotion" },
  { phrase: "仿佛被抽干了力气", category: "cliche_emotion" },
  { phrase: "空气仿佛凝固了", category: "cliche_emotion" },
  { phrase: "死一般的寂静", category: "cliche_emotion" },
  { phrase: "时间仿佛静止了", category: "cliche_emotion" },
  { phrase: "一股寒意从脚底直窜天灵盖", category: "cliche_emotion" },
  { phrase: "眉宇间闪过一丝", category: "cliche_emotion" },
  { phrase: "眼底深处泛起", category: "cliche_emotion" },
  // cliche_action
  { phrase: "深吸了一口气", category: "cliche_action" },
  { phrase: "缓缓吐出一口浊气", category: "cliche_action" },
  { phrase: "下意识地", category: "cliche_action" },
  { phrase: "不由自主地", category: "cliche_action" },
  { phrase: "鬼使神差地", category: "cliche_action" },
  { phrase: "迈着沉重的步伐", category: "cliche_action" },
  { phrase: "迈着坚定的步伐", category: "cliche_action" },
  { phrase: "指节发白", category: "cliche_action" },
  { phrase: "骨节泛白", category: "cliche_action" },
  { phrase: "攥紧了拳头", category: "cliche_action" },
  { phrase: "嘴唇动了动", category: "cliche_action" },
  { phrase: "欲言又止", category: "cliche_action" },
  { phrase: "僵在原地", category: "cliche_action" },
  { phrase: "愣在原地", category: "cliche_action" },
  { phrase: "缓缓闭上了眼睛", category: "cliche_action" },
  { phrase: "苦笑一声", category: "cliche_action" },
  { phrase: "自嘲地笑了笑", category: "cliche_action" },
  { phrase: "沉声说道", category: "cliche_action" },
  { phrase: "淡淡地开口", category: "cliche_action" },
  { phrase: "声音沙哑地", category: "cliche_action" },
  { phrase: "沙哑着嗓子", category: "cliche_action" },
  { phrase: "微微颔首", category: "cliche_action" },
  { phrase: "不动声色地", category: "cliche_action" },
  // filler_hedge
  { phrase: "某种意义上", category: "filler_hedge" },
  { phrase: "在某种程度上", category: "filler_hedge" },
  { phrase: "隐隐约约", category: "filler_hedge" },
  { phrase: "若有所思", category: "filler_hedge" },
  { phrase: "似笑非笑", category: "filler_hedge" },
  { phrase: "若无其事", category: "filler_hedge" },
  { phrase: "波澜不惊", category: "filler_hedge" },
  { phrase: "耐人寻味", category: "filler_hedge" },
  { phrase: "意味深长", category: "filler_hedge" },
  { phrase: "细思极恐", category: "filler_hedge" },
  { phrase: "宿命般", category: "filler_hedge" },
  { phrase: "冥冥之中", category: "filler_hedge" },
  { phrase: "仿佛在诉说着", category: "filler_hedge" },
  { phrase: "如同一道闪电划破夜空", category: "filler_hedge" },
  { phrase: "仿佛命运的齿轮开始转动", category: "filler_hedge" },
  { phrase: "命运的齿轮", category: "filler_hedge" },
  { phrase: "一丝不易察觉的", category: "filler_hedge" },
  { phrase: "莫可名状", category: "filler_hedge" },
  { phrase: "无声无息间", category: "filler_hedge" },
  { phrase: "悄然无声地", category: "filler_hedge" },
  { phrase: "静静地矗立在那里", category: "filler_hedge" },
  { phrase: "像是在回应着什么", category: "filler_hedge" },
];

export interface AiSlopScanConfig {
  readonly customBanned?: readonly string[];
  readonly whitelist?: readonly string[];
  readonly excludeDialogue?: boolean;
}

export interface AiSlopReport extends AiSlopReportDto {
  readonly weightedHits: number;
  readonly weightedDensityPer1000Chars: number;
  readonly sentenceLengthCV: number;
  readonly monotoneRuns: number;
  readonly rhythmMonotone: boolean;
}

export interface GoldenThreeOptions {
  readonly chapterIndex?: number;
  readonly targetLength?: number;
  readonly pacingTier?: string;
  readonly genreTags?: readonly string[];
  readonly customHookKeywords?: readonly string[];
  readonly customConflictKeywords?: readonly string[];
}

export interface ChapterDiagnosticsReport extends ChapterDiagnosticsReportDto {
  readonly goldenThree: GoldenThreeReportDto;
  readonly aiSlop: AiSlopReport;
}

const DIALOGUE_SPAN_RE = /“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|‘[^’\n]*’/gu;
const HAS_QUOTE_RE = /[“”「」『』"‘’]/u;
const SENTENCE_SPLIT_RE = /[。！？!?…；;]+/u;
const QUOTE_EDGE_RE = /^[“”「」『』"‘’\s]+|[“”「」『』"‘’\s]+$/gu;
const ASCII_WORD_RE = /^[A-Za-z0-9_-]+$/u;

function nonWhitespaceLength(text: string): number {
  return [...text.replace(/\s/gu, "")].length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function analyzeSentenceRhythm(paragraphs: readonly { readonly text: string }[]): {
  readonly sentenceLengthCV: number;
  readonly monotoneRuns: number;
  readonly rhythmMonotone: boolean;
} {
  const lengths: number[] = [];
  for (const para of paragraphs) {
    for (const part of para.text.split(SENTENCE_SPLIT_RE)) {
      const cleaned = part.replace(QUOTE_EDGE_RE, "");
      const len = nonWhitespaceLength(cleaned);
      if (len >= 2) lengths.push(len);
    }
  }
  if (lengths.length < 3) {
    return { sentenceLengthCV: 0, monotoneRuns: 0, rhythmMonotone: false };
  }

  let sum = 0;
  for (const len of lengths) sum += len;
  const mean = sum / lengths.length;
  let sqDiff = 0;
  for (const len of lengths) {
    const delta = len - mean;
    sqDiff += delta * delta;
  }
  const std = Math.sqrt(sqDiff / lengths.length);
  const sentenceLengthCV = mean > 0 ? round3(std / mean) : 0;

  let monotoneRuns = 0;
  let runStart = 0;
  while (runStart < lengths.length) {
    let runMin = lengths[runStart];
    let runMax = lengths[runStart];
    let runEnd = runStart + 1;
    while (runEnd < lengths.length) {
      const nextLen = lengths[runEnd];
      const candMin = Math.min(runMin, nextLen);
      const candMax = Math.max(runMax, nextLen);
      const tolerance = Math.max(6, Math.round(candMin * 0.25));
      if (candMax - candMin <= tolerance) {
        runMin = candMin;
        runMax = candMax;
        runEnd += 1;
      } else {
        break;
      }
    }
    if (runEnd - runStart >= 4) {
      monotoneRuns += 1;
      runStart = runEnd;
    } else {
      runStart += 1;
    }
  }

  const rhythmMonotone =
    lengths.length >= 6
      ? sentenceLengthCV < 0.25 || monotoneRuns >= 2
      : lengths.length >= 4 && monotoneRuns >= 1 && sentenceLengthCV < 0.28;

  return { sentenceLengthCV, monotoneRuns, rhythmMonotone };
}

/**
 * Zero-token offline AI-slop phrase, weighted density, and sentence-rhythm scanner (FQ-16).
 * Uses non-overlapping longest-match scanning over `splitChapterParagraphs(body)` so
 * overlapping sub-phrases never double-count and offsets match original UTF-16 indices.
 */
export function scanAiSlop(body: string, config?: AiSlopScanConfig): AiSlopReport {
  const charCount = nonWhitespaceLength(body);
  const whitelist = new Set((config?.whitelist ?? []).map((w) => w.trim()).filter(Boolean));
  const patterns: Array<{ readonly phrase: string; readonly category: string }> = [];
  const seen = new Set<string>();

  for (const entry of DEFAULT_AI_SLOP_PATTERNS) {
    if (whitelist.has(entry.phrase) || seen.has(entry.phrase)) continue;
    seen.add(entry.phrase);
    patterns.push(entry);
  }
  for (const custom of config?.customBanned ?? []) {
    const phrase = custom.trim();
    if (!phrase || whitelist.has(phrase) || seen.has(phrase)) continue;
    seen.add(phrase);
    patterns.push({ phrase, category: "custom" });
  }

  // Sort by descending length so longer phrases claim their span before substrings.
  patterns.sort(
    (a, b) =>
      b.phrase.length - a.phrase.length ||
      (AI_SLOP_CATEGORY_WEIGHTS[b.category] ?? 1) - (AI_SLOP_CATEGORY_WEIGHTS[a.category] ?? 1) ||
      a.phrase.localeCompare(b.phrase),
  );

  const paragraphs = splitChapterParagraphs(body);
  const hits: SlopHitDto[] = [];
  const countMap = new Map<string, { readonly phrase: string; readonly category: string; count: number }>();
  let rawWeightedHits = 0;

  for (const span of paragraphs) {
    const line = span.text;
    const occupied = new Uint8Array(line.length);

    if (config?.excludeDialogue === true) {
      for (const match of line.matchAll(DIALOGUE_SPAN_RE)) {
        const mStart = match.index ?? 0;
        const mEnd = Math.min(line.length, mStart + match[0].length);
        occupied.fill(1, mStart, mEnd);
      }
    }

    for (const pat of patterns) {
      const plen = pat.phrase.length;
      if (plen === 0 || plen > line.length) continue;
      let pos = 0;
      while (pos <= line.length - plen) {
        const found = line.indexOf(pat.phrase, pos);
        if (found < 0) break;

        let overlaps = false;
        for (let k = found; k < found + plen; k += 1) {
          if (occupied[k] !== 0) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) {
          pos = found + 1;
          continue;
        }

        occupied.fill(1, found, found + plen);
        const winStart = Math.max(0, found - 10);
        const winEnd = Math.min(line.length, found + plen + 10);
        hits.push({
          phrase: pat.phrase,
          category: pat.category,
          paragraphIndex: span.index,
          start: span.start + found,
          end: span.start + found + plen,
          excerpt: line.slice(winStart, winEnd),
        });
        rawWeightedHits += AI_SLOP_CATEGORY_WEIGHTS[pat.category] ?? 1.0;

        const cur = countMap.get(pat.phrase);
        if (cur) cur.count += 1;
        else countMap.set(pat.phrase, { phrase: pat.phrase, category: pat.category, count: 1 });
        pos = found + plen;
      }
    }
  }

  hits.sort((a, b) => a.start - b.start);
  const weightedHits = round2(rawWeightedHits);
  const weightedDensityPer1000Chars = charCount > 0 ? round2((rawWeightedHits * 1000) / charCount) : 0;
  const { sentenceLengthCV, monotoneRuns, rhythmMonotone } = analyzeSentenceRhythm(paragraphs);

  const severity =
    weightedDensityPer1000Chars >= 6
      ? "high"
      : weightedDensityPer1000Chars >= 2.5 || (rhythmMonotone && weightedDensityPer1000Chars >= 1.5)
        ? "warn"
        : "clean";
  const topPhrases = [...countMap.values()]
    .sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase))
    .slice(0, 10);

  return {
    charCount,
    totalHits: hits.length,
    weightedHits,
    densityPer1000Chars: weightedDensityPer1000Chars,
    weightedDensityPer1000Chars,
    severity,
    topPhrases,
    hits,
    sentenceLengthCV,
    monotoneRuns,
    rhythmMonotone,
  };
}

// Multi-char (>=2) keyword tables parameterized by pacing tier and genre tags (FQ-14 / FQ-15).
const BASE_HOOK_KEYWORDS: readonly string[] = [
  "猛地",
  "突然",
  "骤然",
  "轰然",
  "一脚",
  "踹开",
  "撞开",
  "推开",
  "血迹",
  "尖叫",
  "警报",
  "失踪",
  "死讯",
  "坠落",
  "倒计时",
  "火光",
  "刀锋",
  "枪声",
  "中毒",
  "绑架",
];

const BASE_CONFLICT_KEYWORDS: readonly string[] = [
  "冷笑",
  "质问",
  "反手",
  "一巴掌",
  "威胁",
  "拒绝",
  "背叛",
  "对峙",
  "逼近",
  "阻拦",
  "挑衅",
  "陷害",
  "争吵",
  "撕毁",
  "反击",
  "逼迫",
  "违约",
  "曝光",
  "揭穿",
  "压迫",
];

const PACING_HOOK_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  快爽: ["退婚", "休书", "系统", "觉醒", "重生", "签到", "属性面板", "一巴掌", "跪下", "滚出去", "打脸", "废柴", "开除", "净身出户"],
  稳推: ["欠条", "催债", "通知书", "裁员", "分手", "离婚", "协议", "账本", "盘点", "查封", "调令", "重逢", "遗嘱", "契约"],
  慢燃: ["异常", "尸体", "尸检", "失踪", "门锁", "血手印", "监控", "匿名信", "黑影", "脚步声", "停电", "封锁", "失联", "旧档案", "密码", "暗号"],
};

const PACING_CONFLICT_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  快爽: ["退婚", "休书", "滚出去", "跪下", "赔礼", "嘲讽", "羞辱", "看不起", "赌约", "生死状", "断绝关系", "逐出家门", "冒领"],
  稳推: ["算计", "克扣", "刁难", "退股", "压价", "截胡", "造谣", "排挤", "翻脸", "拆台", "误会", "隐瞒", "夺权", "施压", "分家"],
  慢燃: ["撒谎", "不在场", "疑点", "伪造", "灭口", "跟踪", "窃听", "隐瞒", "否认", "反常", "破绽", "栽赃", "试探", "套话", "封口"],
};

const GENRE_KEYWORD_PACKS: readonly {
  readonly tags: readonly string[];
  readonly hooks: readonly string[];
  readonly conflicts: readonly string[];
}[] = [
  {
    tags: ["悬疑", "灵异", "刑侦", "推理"],
    hooks: ["异常", "尸体", "尸检", "失踪", "门锁", "血手印", "监控", "匿名信", "凶案", "封锁", "遗书"],
    conflicts: ["撒谎", "不在场", "疑点", "伪造", "灭口", "跟踪", "破绽", "栽赃", "隐瞒", "反常"],
  },
  {
    tags: ["言情", "古言", "甜宠", "虐恋"],
    hooks: ["婚约", "离婚", "退亲", "误会", "重逢", "订婚", "白月光", "替身", "和离", "休书"],
    conflicts: ["冷战", "偏心", "吃醋", "心寒", "误会", "背叛", "隐瞒", "质问", "退婚", "逼婚"],
  },
  {
    tags: ["玄幻", "修仙", "高武", "仙侠", "战神"],
    hooks: ["灵根", "丹田", "突破", "宗门", "退婚", "秘境", "妖兽", "雷劫", "功法", "禁地", "剑气", "灵脉"],
    conflicts: ["废柴", "退婚", "挑衅", "夺宝", "生死战", "围攻", "背叛", "碾压", "镇压", "试炼"],
  },
  {
    tags: ["都市", "都市日常", "商战", "职场", "经营"],
    hooks: ["裁员", "欠款", "合同", "热搜", "竞标", "查账", "跳槽", "解约", "违约金", "爆料"],
    conflicts: ["克扣", "刁难", "压价", "截胡", "造谣", "排挤", "翻脸", "违约", "算计", "施压"],
  },
  {
    tags: ["种田", "年代", "日常"],
    hooks: ["分家", "荒年", "税粮", "账本", "地契", "退亲", "集市", "收成", "欠账", "盘店"],
    conflicts: ["分家", "算计", "克扣", "占便宜", "刁难", "欠债", "退亲", "抢地", "排挤", "翻脸"],
  },
  {
    tags: ["权谋", "朝堂", "历史"],
    hooks: ["密旨", "弹劾", "抄家", "刺杀", "政变", "罪证", "密信", "兵符", "谋反", "诏书"],
    conflicts: ["党争", "弹劾", "构陷", "夺权", "灭口", "背叛", "试探", "施压", "反间", "逼宫"],
  },
  {
    tags: ["科幻", "末世", "系统", "重生", "逆袭"],
    hooks: ["丧尸", "末日", "警报", "辐射", "氧气", "感染", "信号", "跃迁", "失控", "庇护所", "系统", "重生", "觉醒"],
    conflicts: ["断粮", "背叛", "失控", "封锁", "抢夺", "变异", "危机", "倒计时", "围攻", "反击"],
  },
];

const INFO_DUMP_MARKERS = [
  "世界",
  "境界",
  "分为",
  "历史",
  "传闻",
  "由来",
  "设定",
  "等级",
  "体系",
  "宗门",
  "法则",
  "规矩",
  "自古",
  "秩序",
];

function buildKeywordSet(
  base: readonly string[],
  pacingMap: Readonly<Record<string, readonly string[]>>,
  genreKind: "hooks" | "conflicts",
  options?: GoldenThreeOptions,
): string[] {
  const words = new Set<string>(base);
  const tier = options?.pacingTier?.trim() ?? "";
  const genreTags = (options?.genreTags ?? []).map((t) => t.trim()).filter(Boolean);

  if (tier && Object.hasOwn(pacingMap, tier)) {
    for (const w of pacingMap[tier]) words.add(w);
  } else if (genreTags.length === 0) {
    // Default balanced multi-char coverage when project has not configured pacingTier/genreTags yet.
    for (const list of Object.values(pacingMap)) {
      for (const w of list) words.add(w);
    }
  }

  for (const pack of GENRE_KEYWORD_PACKS) {
    if (genreTags.some((tag) => pack.tags.some((pt) => tag.includes(pt) || pt.includes(tag)))) {
      for (const w of pack[genreKind]) words.add(w);
    }
  }

  const customs = genreKind === "hooks" ? options?.customHookKeywords : options?.customConflictKeywords;
  for (const raw of customs ?? []) {
    const trimmed = raw.trim();
    if (trimmed.length >= 2) words.add(trimmed);
  }
  return [...words];
}

function containsKeyword(text: string, kw: string): boolean {
  if (!kw) return false;
  if (ASCII_WORD_RE.test(kw)) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "iu").test(text);
  }
  return text.includes(kw);
}

/**
 * Offline structural health checker for Fanqie chapters (FQ-15 / FQ-02 / FQ-14):
 * - Golden 3 Chapters (`chapterIndex < 3`): scores 6 dimensions (opening hook, early 300-char
 *   conflict, info-dump detection, dialogue ratio, deduplicated paragraph rhythm, target word band).
 * - Non-Golden Chapters (`chapterIndex >= 3`): outputs pacing (paragraph rhythm) and word-count
 *   band diagnostics cleanly without Golden-3 false warnings.
 */
export function diagnoseGoldenThree(body: string, options?: GoldenThreeOptions): GoldenThreeReportDto {
  const isGoldenThreeChapter = (options?.chapterIndex ?? 0) < 3;
  const spans = splitChapterParagraphs(body);
  const paras = spans.map((span) => {
    const trimmed = span.text.trim();
    return { index: span.index, text: trimmed, chars: nonWhitespaceLength(trimmed) };
  });
  const totalChars = paras.reduce((sum, p) => sum + p.chars, 0);

  // Word Count Band dimension (FQ-15: target ± 25%, fallback 2000-2500 recommended & 1500-6000 reminder)
  const [defaultMin, defaultMax] = DEFAULT_CHAPTER_LENGTH;
  const [warnMin, warnMax] = CHAPTER_LENGTH_WARNING_BAND;
  const hasExplicitTarget =
    typeof options?.targetLength === "number" &&
    Number.isFinite(options.targetLength) &&
    options.targetLength > 0;
  const bandMin = hasExplicitTarget ? Math.round(options!.targetLength! * 0.75) : defaultMin;
  const bandMax = hasExplicitTarget ? Math.round(options!.targetLength! * 1.25) : defaultMax;

  let wordScore = 95;
  let wordSummary: string;
  if (totalChars === 0) {
    wordScore = 0;
    wordSummary = "正文为空。";
  } else if (totalChars >= bandMin && totalChars <= bandMax) {
    wordScore = 95;
    wordSummary = hasExplicitTarget
      ? `当前 ${totalChars} 字，落在目标篇幅（${options!.targetLength} ±25%，即 ${bandMin}–${bandMax} 字）内。`
      : `当前 ${totalChars} 字，落在推荐章幅带（${defaultMin}–${defaultMax} 字）内。`;
  } else if (hasExplicitTarget) {
    if (totalChars < bandMin) {
      wordScore = Math.max(20, Math.round((totalChars / Math.max(1, bandMin)) * 60));
      wordSummary = `当前 ${totalChars} 字，低于目标篇幅下限（目标 ${options!.targetLength} ±25%，建议 ≥ ${bandMin} 字）。`;
    } else {
      const overshoot = (totalChars - bandMax) / Math.max(1, bandMax);
      wordScore = Math.max(30, Math.round(62 - overshoot * 35));
      wordSummary = `当前 ${totalChars} 字，超出目标篇幅上限（目标 ${options!.targetLength} ±25%，建议 ≤ ${bandMax} 字）。`;
    }
  } else if (totalChars < warnMin) {
    wordScore = Math.max(25, Math.round((totalChars / warnMin) * 62));
    wordSummary = `当前 ${totalChars} 字，偏短（提醒下限 ${warnMin} 字，推荐 ${defaultMin}–${defaultMax} 字）。`;
  } else if (totalChars < defaultMin) {
    wordScore = 75;
    wordSummary = `当前 ${totalChars} 字，位于提醒区间（${warnMin}–${warnMax} 字），略低于推荐带（${defaultMin}–${defaultMax} 字）。`;
  } else if (totalChars <= warnMax) {
    wordScore = 78;
    wordSummary = `当前 ${totalChars} 字，位于提醒区间（${warnMin}–${warnMax} 字），高于常见推荐带（${defaultMin}–${defaultMax} 字）。`;
  } else {
    wordScore = 55;
    wordSummary = `当前 ${totalChars} 字，单章偏长（超出提醒上限 ${warnMax} 字，考虑拆章）。`;
  }
  const wordDim: GoldenThreeDimensionDto = {
    id: "wordCountBand",
    label: "字数达标带",
    score: wordScore,
    status: wordScore >= 65 ? "pass" : "warn",
    summary: wordSummary,
    problemParagraphs: [],
  };

  if (!isGoldenThreeChapter) {
    // Non-golden chapters: pacing (paragraph rhythm) + word-count diagnostics only.
    const wallParas = paras.filter((p) => p.chars > 160).map((p) => p.index);
    const avgChars = paras.length > 0 ? totalChars / paras.length : 0;
    let rhythmScore = paras.length === 0 ? 0 : 90 - wallParas.length * 16 - (avgChars > 110 ? 15 : 0);
    rhythmScore = Math.max(0, Math.min(100, rhythmScore));
    const rhythmDim: GoldenThreeDimensionDto = {
      id: "paragraphRhythm",
      label: "段落呼吸感",
      score: rhythmScore,
      status: rhythmScore >= 65 ? "pass" : "warn",
      summary:
        wallParas.length === 0
          ? `均段 ${Math.round(avgChars)} 字，手机端阅读呼吸感良好。`
          : `发现 ${wallParas.length} 处超 160 字高密大段墙，建议按情绪节拍换行。`,
      problemParagraphs: wallParas,
    };
    const dimensions = [rhythmDim, wordDim];
    const overallScore = Math.round(rhythmDim.score * 0.6 + wordDim.score * 0.4);
    const warnings = dimensions
      .filter((d) => d.status === "warn")
      .map((d) => `${d.label}：${d.summary}`);
    return { isGoldenThreeChapter: false, overallScore, dimensions, warnings };
  }

  const hookKeywords = buildKeywordSet(BASE_HOOK_KEYWORDS, PACING_HOOK_KEYWORDS, "hooks", options);
  const conflictKeywords = buildKeywordSet(BASE_CONFLICT_KEYWORDS, PACING_CONFLICT_KEYWORDS, "conflicts", options);

  // 1. Opening Hook (weight 0.20)
  const lead = paras.slice(0, 2).map((p) => p.text).join("\n");
  const hasLeadQuote = HAS_QUOTE_RE.test(lead);
  const hasLeadPunct = /[？！?!]/u.test(lead);
  const hasHookKw = hookKeywords.some((kw) => containsKeyword(lead, kw));
  let hookScore = paras.length === 0 ? 0 : 48;
  if (hasLeadQuote) hookScore += 20;
  if (hasLeadPunct) hookScore += 15;
  if (hasHookKw) hookScore += 15;
  if (paras[0] && paras[0].chars > 180 && !hasLeadQuote && !hasLeadPunct) hookScore -= 15;
  hookScore = Math.max(0, Math.min(100, hookScore));
  const hookDim: GoldenThreeDimensionDto = {
    id: "openingHook",
    label: "开场钩子",
    score: hookScore,
    status: hookScore >= 65 ? "pass" : "warn",
    summary: hookScore >= 65 ? "开篇具备强动作/对话或悬念切入。" : "开篇偏平缓或大段铺陈，建议用对话、冲突动作或反常事件破题。",
    problemParagraphs: hookScore < 65 && paras[0] ? [paras[0].index] : [],
  };

  // 2. Early 300-char Conflict Trigger (weight 0.20)
  const first300 = body.replace(/\s+/gu, "").slice(0, 320);
  const earlyConflictHits = conflictKeywords.filter((kw) => containsKeyword(first300, kw)).length;
  const earlyHasDialogue = HAS_QUOTE_RE.test(first300);
  const earlyHasPunct = /[？！?!]/u.test(first300);
  let conflictScore =
    paras.length === 0
      ? 0
      : 45 + Math.min(30, earlyConflictHits * 12) + (earlyHasDialogue ? 15 : 0) + (earlyHasPunct ? 10 : 0);
  conflictScore = Math.max(0, Math.min(100, conflictScore));
  const conflictDim: GoldenThreeDimensionDto = {
    id: "earlyConflict",
    label: "前300字冲突触发",
    score: conflictScore,
    status: conflictScore >= 65 ? "pass" : "warn",
    summary: conflictScore >= 65 ? "前300字已触发明确对峙或危机悬念。" : "前300字缺少明确矛盾或压迫感，建议提前抛出阻碍或利益冲突。",
    problemParagraphs: conflictScore < 65 ? paras.slice(0, 2).map((p) => p.index) : [],
  };

  // 3. Info-dump / Exposition Wall Detection (weight 0.20)
  const infoDumpParas = paras
    .filter((p) => {
      if (HAS_QUOTE_RE.test(p.text)) return false;
      const markers = INFO_DUMP_MARKERS.filter((m) => p.text.includes(m)).length;
      return (p.chars >= 120 && markers >= 2) || p.chars >= 260;
    })
    .map((p) => p.index);
  const infoDumpSet = new Set(infoDumpParas);
  const infoScore =
    paras.length === 0 ? 0 : infoDumpParas.length === 0 ? 94 : Math.max(25, 72 - infoDumpParas.length * 18);
  const infoDim: GoldenThreeDimensionDto = {
    id: "infoDump",
    label: "设定灌输连续段",
    score: infoScore,
    status: infoScore >= 65 ? "pass" : "warn",
    summary:
      infoDumpParas.length === 0
        ? "未发现连续大段干瘪设定灌输。"
        : `检测到 ${infoDumpParas.length} 处长段旁白/设定灌输，建议拆解进动作与对话交锋中。`,
    problemParagraphs: infoDumpParas,
  };

  // 4. Dialogue Ratio (weight 0.15) — full CJK/ASCII quote matching
  const dialogueMatches = body.match(DIALOGUE_SPAN_RE) ?? [];
  const dialogueChars = dialogueMatches.reduce((sum, seg) => sum + nonWhitespaceLength(seg), 0);
  const ratio = totalChars > 0 ? dialogueChars / totalChars : 0;
  let dialogueScore = 88;
  let dialogueSummary = `对话占比约 ${Math.round(ratio * 100)}%，互动节奏均衡。`;
  if (totalChars === 0) {
    dialogueScore = 0;
    dialogueSummary = "正文为空。";
  } else if (ratio < 0.08) {
    dialogueScore = 46;
    dialogueSummary = `对话占比偏低（${Math.round(ratio * 100)}%），易显沉闷说书腔。`;
  } else if (ratio > 0.8) {
    dialogueScore = 58;
    dialogueSummary = `对话占比偏高（${Math.round(ratio * 100)}%），建议补足动作与神态描写锚定场景。`;
  }
  const dialogueDim: GoldenThreeDimensionDto = {
    id: "dialogueRatio",
    label: "对话占比",
    score: dialogueScore,
    status: dialogueScore >= 65 ? "pass" : "warn",
    summary: dialogueSummary,
    problemParagraphs: dialogueScore < 65 ? paras.filter((p) => p.chars > 140).slice(0, 3).map((p) => p.index) : [],
  };

  // 5. Paragraph Rhythm & Wall Paragraphs (weight 0.15) — deduplicated against infoDumpParas (FQ-15)
  const wallParas = paras
    .filter((p) => p.chars > 160 && !infoDumpSet.has(p.index))
    .map((p) => p.index);
  const avgChars = paras.length > 0 ? totalChars / paras.length : 0;
  let rhythmScore = paras.length === 0 ? 0 : 90 - wallParas.length * 16 - (avgChars > 110 ? 15 : 0);
  rhythmScore = Math.max(0, Math.min(100, rhythmScore));
  const rhythmDim: GoldenThreeDimensionDto = {
    id: "paragraphRhythm",
    label: "段落呼吸感",
    score: rhythmScore,
    status: rhythmScore >= 65 ? "pass" : "warn",
    summary:
      wallParas.length === 0
        ? `均段 ${Math.round(avgChars)} 字，手机端阅读呼吸感良好。`
        : `发现 ${wallParas.length} 处超 160 字高密大段墙，建议按情绪节拍换行。`,
    problemParagraphs: wallParas,
  };

  const dimensions = [hookDim, conflictDim, infoDim, dialogueDim, rhythmDim, wordDim];
  const overallScore = Math.round(
    hookDim.score * 0.2 +
      conflictDim.score * 0.2 +
      infoDim.score * 0.2 +
      dialogueDim.score * 0.15 +
      rhythmDim.score * 0.15 +
      wordDim.score * 0.1,
  );
  const warnings = dimensions
    .filter((d) => d.status === "warn")
    .map((d) => `${d.label}：${d.summary}`);

  return { isGoldenThreeChapter: true, overallScore, dimensions, warnings };
}

export interface HiddenFactHint {
  readonly factId: string;
  readonly entityName: string;
  readonly note: string;
  readonly aliases?: readonly string[];
}

export interface QualityV2Options {
  readonly pacingTier?: string;
  readonly recentChapterBodies?: readonly string[];
  readonly hiddenFacts?: readonly HiddenFactHint[];
  readonly viewpoint?: string | null;
  readonly goldenThree?: GoldenThreeReportDto;
  readonly aiSlop?: AiSlopReport;
}

export interface ParagraphPatchInput {
  readonly paragraphIndex: number;
  readonly replacement: string;
}

const ENDING_HOOK_MARKERS: readonly string[] = [
  "突然",
  "骤然",
  "就在",
  "门外",
  "脚步声",
  "手机",
  "铃声",
  "震动",
  "黑影",
  "血迹",
  "倒计时",
  "推开",
  "踹开",
  "响起",
  "不对",
  "不可能",
  "是谁",
  "等等",
  "来了",
  "露馅",
  "曝光",
  "死讯",
  "失踪",
  "抬头",
  "转身",
  "冷笑",
  "碎了",
  "警报",
  "系统",
  "提示",
  "真相",
  "却",
];

const FLAT_CLOSURE_MARKERS: readonly string[] = [
  "一切终于结束了",
  "这一天就这样过去了",
  "从此以后",
  "安心地睡去",
  "总而言之",
  "明天又是新的一天",
  "一切归于平静",
];

const ECHO_STOP_PHRASES = new Set<string>([
  "没有什么",
  "不知道为",
  "这个时候",
  "就在这个",
  "没有任何",
  "怎么回事",
  "怎么可能",
  "不是因为",
  "自己也不",
  "看起来像",
  "这样一来",
  "与此同时",
]);

const COGNITIVE_LEAK_VERBS: readonly string[] = [
  "知道",
  "明白",
  "清楚",
  "原来",
  "早就",
  "其实",
  "果然",
  "想起",
  "记得",
  "认出",
  "知晓",
  "察觉",
  "识破",
  "真相",
  "秘密",
  "隐瞒",
  "背后",
];

/** Evaluates chapter-ending cliffhanger / pull strength (zero-token). */
export function analyzeEndingHook(
  body: string,
  pacingTier?: string,
): {
  readonly endingHookScore: number;
  readonly endingHookStatus: "pass" | "warn";
  readonly endingHookSummary: string;
} {
  const spans = splitChapterParagraphs(body);
  if (spans.length === 0) {
    return { endingHookScore: 0, endingHookStatus: "warn", endingHookSummary: "正文为空，缺少章末钩子。" };
  }
  const tailParas = spans.slice(-2).map((s) => s.text.trim());
  const tailText = tailParas.join("\n");
  const lastPara = tailParas[tailParas.length - 1] ?? "";

  let score = 46;
  const hasStrongPunct = /[？！?!…]$/u.test(lastPara) || /[？！?!…][”」』"']$/u.test(lastPara);
  const hasDialogueCut = HAS_QUOTE_RE.test(lastPara);
  const hookHits = ENDING_HOOK_MARKERS.filter((m) => tailText.includes(m)).length;
  const flatHits = FLAT_CLOSURE_MARKERS.filter((m) => tailText.includes(m)).length;

  if (hasStrongPunct) score += 20;
  if (hasDialogueCut) score += 14;
  if (hookHits > 0) score += Math.min(22, hookHits * 10);
  if (nonWhitespaceLength(lastPara) <= 45 && nonWhitespaceLength(lastPara) >= 6) score += 8;
  if (flatHits > 0) score -= flatHits * 25;
  if (pacingTier === "快爽" && !hasStrongPunct && hookHits === 0) score -= 8;

  const clamped = Math.max(0, Math.min(100, score));
  const status: "pass" | "warn" = clamped >= 65 ? "pass" : "warn";
  const summary =
    flatHits > 0
      ? "章末存在平淡总结式收尾，建议截断在冲突升级或悬念抛出瞬间。"
      : status === "pass"
        ? "章末具备明确的对话截断、动作转折或悬念牵引力。"
        : "章末牵引力偏弱，建议在尾段抛出新威胁、反转信息或悬念问句。";
  return { endingHookScore: clamped, endingHookStatus: status, endingHookSummary: summary };
}

/** Detects repetitive paragraph openings (consecutive or >=3 repeated 2-char CJK leads). */
export function analyzeParagraphLeadRepetition(
  body: string,
): readonly { readonly lead: string; readonly paragraphs: readonly number[] }[] {
  const spans = splitChapterParagraphs(body);
  const leadMap = new Map<string, number[]>();
  const consecutivePairs = new Set<string>();
  let prevLead = "";

  for (const span of spans) {
    const trimmed = span.text.trim();
    if (!trimmed || HAS_QUOTE_RE.test(trimmed[0])) {
      prevLead = "";
      continue;
    }
    const cjkPrefix = trimmed.replace(/^[^\u4e00-\u9fff]+/u, "").slice(0, 2);
    if (cjkPrefix.length < 2) {
      prevLead = "";
      continue;
    }
    const list = leadMap.get(cjkPrefix);
    if (list) list.push(span.index);
    else leadMap.set(cjkPrefix, [span.index]);

    if (prevLead === cjkPrefix) {
      consecutivePairs.add(cjkPrefix);
    }
    prevLead = cjkPrefix;
  }

  const results: Array<{ readonly lead: string; readonly paragraphs: readonly number[] }> = [];
  for (const [lead, paragraphs] of leadMap.entries()) {
    if (paragraphs.length >= 3 || (paragraphs.length >= 2 && consecutivePairs.has(lead))) {
      results.push({ lead, paragraphs });
    }
  }
  return results
    .sort((a, b) => b.paragraphs.length - a.paragraphs.length || a.lead.localeCompare(b.lead))
    .slice(0, 8);
}

function extractFourCharNgrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  // Strip dialogue quotes so character catchphrases don't dominate narration echo counts
  const narration = text.replace(DIALOGUE_SPAN_RE, " ");
  const segments = narration.match(/[\u4e00-\u9fff]{4,}/gu) ?? [];
  for (const seg of segments) {
    for (let i = 0; i <= seg.length - 4; i += 1) {
      const gram = seg.slice(i, i + 4);
      if (ECHO_STOP_PHRASES.has(gram)) continue;
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
  }
  return counts;
}

/** Detects overused 4-char narration phrases echoed across recent chapters (zero-token). */
export function detectCrossChapterEchoes(
  body: string,
  recentChapterBodies: readonly string[] = [],
): readonly { readonly phrase: string; readonly currentCount: number; readonly recentCount: number }[] {
  if (!body.trim() || recentChapterBodies.length === 0) return [];
  const currentCounts = extractFourCharNgrams(body);
  if (currentCounts.size === 0) return [];

  const recentCounts = new Map<string, number>();
  for (const recentBody of recentChapterBodies) {
    if (!recentBody?.trim()) continue;
    const map = extractFourCharNgrams(recentBody);
    for (const [gram, count] of map.entries()) {
      recentCounts.set(gram, (recentCounts.get(gram) ?? 0) + count);
    }
  }

  const hits: Array<{ readonly phrase: string; readonly currentCount: number; readonly recentCount: number }> = [];
  for (const [phrase, currentCount] of currentCounts.entries()) {
    const recentCount = recentCounts.get(phrase) ?? 0;
    if ((currentCount >= 2 && recentCount >= 2) || (currentCount >= 1 && recentCount >= 4)) {
      hits.push({ phrase, currentCount, recentCount });
    }
  }

  // Deduplicate overlapping substrings by keeping the higher-scoring gram first
  hits.sort((a, b) => b.currentCount + b.recentCount - (a.currentCount + a.recentCount) || a.phrase.localeCompare(b.phrase));
  const deduped: typeof hits = [];
  for (const hit of hits) {
    if (deduped.some((kept) => kept.phrase.includes(hit.phrase.slice(1, 3)) && kept.phrase !== hit.phrase && kept.recentCount >= hit.recentCount)) {
      continue;
    }
    deduped.push(hit);
    if (deduped.length >= 8) break;
  }
  return deduped;
}

/** Heuristic zero-token detector for potential POV information leaks against hidden facts. */
export function detectPovLeakHeuristics(
  body: string,
  hiddenFacts: readonly HiddenFactHint[] = [],
  viewpoint?: string | null,
): readonly PovLeakWarningDto[] {
  const pov = viewpoint?.trim() ?? "";
  if (!pov || !body.trim() || hiddenFacts.length === 0) return [];

  const spans = splitChapterParagraphs(body);
  const warnings: PovLeakWarningDto[] = [];
  const seenKeys = new Set<string>();

  for (const fact of hiddenFacts) {
    const terms = new Set<string>();
    const entity = fact.entityName.trim();
    if (entity.length >= 2 && entity !== pov) terms.add(entity);
    for (const alias of fact.aliases ?? []) {
      const a = alias.trim();
      if (a.length >= 2 && a !== pov) terms.add(a);
    }
    // Extract quoted secret terms inside fact.note (e.g. 「暗门」 / 《秘录》 / “内鬼”)
    for (const match of fact.note.matchAll(/[「『《“"]([^」』》”"\n]{2,12})[」』》”"]/gu)) {
      const inner = match[1].trim();
      if (inner.length >= 2 && inner !== pov) terms.add(inner);
    }
    if (terms.size === 0) continue;

    for (const span of spans) {
      const narration = span.text.replace(DIALOGUE_SPAN_RE, " ");
      const hasCognitive = COGNITIVE_LEAK_VERBS.some((v) => narration.includes(v));
      for (const term of terms) {
        const idx = narration.indexOf(term);
        if (idx < 0) continue;
        // Flag if narration combines the hidden entity/secret with cognitive awareness,
        // or mentions a quoted secret term directly in POV narration.
        const isDirectSecret = term !== entity && fact.note.includes(term);
        if (!hasCognitive && !isDirectSecret) continue;

        const key = `${fact.factId}:${span.index}:${term}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        const winStart = Math.max(0, idx - 14);
        const winEnd = Math.min(narration.length, idx + term.length + 14);
        warnings.push({
          factId: fact.factId,
          entityName: fact.entityName,
          matchedTerm: term,
          paragraphIndex: span.index,
          excerpt: narration.slice(winStart, winEnd).trim(),
        });
        if (warnings.length >= 10) return warnings;
      }
    }
  }

  return warnings;
}

/** Computes comprehensive Quality v2 report combining ending hook, repetition, echoes, POV leak, and composite score. */
export function diagnoseQualityV2(body: string, options?: QualityV2Options): ChapterQualityV2Dto {
  const ending = analyzeEndingHook(body, options?.pacingTier);
  const paragraphLeadRepetitions = analyzeParagraphLeadRepetition(body);
  const crossChapterEchoes = detectCrossChapterEchoes(body, options?.recentChapterBodies);
  const povLeakWarnings = detectPovLeakHeuristics(body, options?.hiddenFacts, options?.viewpoint);

  const goldenScore = options?.goldenThree ? options.goldenThree.overallScore : 75;
  const slopDensity = options?.aiSlop ? options.aiSlop.weightedDensityPer1000Chars : 0;
  const slopScore = Math.max(0, Math.min(100, Math.round(100 - slopDensity * 10 - (options?.aiSlop?.rhythmMonotone ? 10 : 0))));

  let composite = Math.round(goldenScore * 0.4 + slopScore * 0.3 + ending.endingHookScore * 0.3);
  composite -= Math.min(18, paragraphLeadRepetitions.length * 6);
  composite -= Math.min(15, crossChapterEchoes.length * 4);
  composite -= Math.min(30, povLeakWarnings.length * 15);
  const compositeScore = Math.max(0, Math.min(100, composite));

  return {
    endingHookScore: ending.endingHookScore,
    endingHookStatus: ending.endingHookStatus,
    endingHookSummary: ending.endingHookSummary,
    paragraphLeadRepetitions,
    crossChapterEchoes,
    povLeakWarnings,
    compositeScore,
  };
}

/**
 * Applies paragraph-level surgical patches while preserving all untouched paragraphs
 * and original line breaks verbatim.
 */
export function applyParagraphPatches(
  body: string,
  patches: readonly ParagraphPatchInput[],
): {
  readonly body: string;
  readonly appliedCount: number;
  readonly preservedRatio: number;
  readonly skippedIndices: readonly number[];
} {
  const spans = splitChapterParagraphs(body);
  if (spans.length === 0 || patches.length === 0) {
    return {
      body,
      appliedCount: 0,
      preservedRatio: 1,
      skippedIndices: patches.map((p) => p.paragraphIndex),
    };
  }

  const spanByIndex = new Map<number, (typeof spans)[number]>();
  for (const span of spans) {
    spanByIndex.set(span.index, span);
  }

  const byIndex = new Map<number, string>();
  const skippedIndices: number[] = [];
  for (const patch of patches) {
    const clean = patch.replacement.replace(/^\[P\d+\]\s*/u, "").trim();
    if (!clean || !spanByIndex.has(patch.paragraphIndex)) {
      skippedIndices.push(patch.paragraphIndex);
      continue;
    }
    byIndex.set(patch.paragraphIndex, clean);
  }
  if (byIndex.size === 0) {
    return { body, appliedCount: 0, preservedRatio: 1, skippedIndices };
  }

  // Apply replacements from end to start so earlier UTF-16 offsets stay valid
  const sortedIndices = [...byIndex.keys()].sort((a, b) => {
    const sa = spanByIndex.get(a)!;
    const sb = spanByIndex.get(b)!;
    return sb.start - sa.start;
  });
  let nextBody = body;
  for (const idx of sortedIndices) {
    const span = spanByIndex.get(idx)!;
    const replacement = byIndex.get(idx)!;
    nextBody = `${nextBody.slice(0, span.start)}${replacement}${nextBody.slice(span.end)}`;
  }

  const preservedRatio = round3(Math.max(0, (spans.length - byIndex.size) / spans.length));
  return { body: nextBody, appliedCount: byIndex.size, preservedRatio, skippedIndices };
}

export function diagnoseChapterOffline(
  documentId: string,
  body: string,
  options?: GoldenThreeOptions & AiSlopScanConfig & Omit<QualityV2Options, "goldenThree" | "aiSlop">,
): ChapterDiagnosticsReport {
  const goldenThree = diagnoseGoldenThree(body, options);
  const aiSlop = scanAiSlop(body, options);
  const qualityV2 = diagnoseQualityV2(body, {
    pacingTier: options?.pacingTier,
    recentChapterBodies: options?.recentChapterBodies,
    hiddenFacts: options?.hiddenFacts,
    viewpoint: options?.viewpoint,
    goldenThree,
    aiSlop,
  });
  return {
    documentId,
    goldenThree,
    aiSlop,
    qualityV2,
  };
}
