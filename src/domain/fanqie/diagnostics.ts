import type {
  AiSlopReportDto,
  ChapterDiagnosticsReportDto,
  GoldenThreeDimensionDto,
  GoldenThreeReportDto,
  SlopHitDto,
} from "../../contracts/workspace-dto.ts";

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

function nonWhitespaceLength(text: string): number {
  return [...text.replace(/\s/gu, "")].length;
}

/**
 * Zero-token offline AI-slop phrase & density scanner honoring project-level
 * custom banned words and author whitelist exceptions.
 */
export function scanAiSlop(
  body: string,
  config?: { readonly customBanned?: readonly string[]; readonly whitelist?: readonly string[] },
): AiSlopReportDto {
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

  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const hits: SlopHitDto[] = [];
  const countMap = new Map<string, { readonly phrase: string; readonly category: string; count: number }>();

  let lineOffset = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const paragraphIndex = idx + 1;
    if (line.trim()) {
      for (const pat of patterns) {
        let pos = 0;
        while (pos <= line.length - pat.phrase.length) {
          const found = line.indexOf(pat.phrase, pos);
          if (found < 0) break;
          const winStart = Math.max(0, found - 10);
          const winEnd = Math.min(line.length, found + pat.phrase.length + 10);
          hits.push({
            phrase: pat.phrase,
            category: pat.category,
            paragraphIndex,
            start: lineOffset + found,
            end: lineOffset + found + pat.phrase.length,
            excerpt: line.slice(winStart, winEnd),
          });
          const cur = countMap.get(pat.phrase);
          if (cur) cur.count += 1;
          else countMap.set(pat.phrase, { phrase: pat.phrase, category: pat.category, count: 1 });
          pos = found + pat.phrase.length;
        }
      }
    }
    lineOffset += line.length + 1;
  }

  hits.sort((a, b) => a.start - b.start);
  const densityPer1000Chars = charCount > 0 ? Math.round(((hits.length * 1000) / charCount) * 100) / 100 : 0;
  const severity = densityPer1000Chars >= 7 ? "high" : densityPer1000Chars >= 3 ? "warn" : "clean";
  const topPhrases = [...countMap.values()]
    .sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase))
    .slice(0, 10);

  return {
    charCount,
    totalHits: hits.length,
    densityPer1000Chars,
    severity,
    topPhrases,
    hits,
  };
}

const HOOK_KEYWORDS = ["退婚", "休书", "滚", "杀", "死", "跪", "系统", "绑架", "血", "惊", "猛地", "突然", "踹", "枪", "刀", "中毒"];
const CONFLICT_KEYWORDS = ["却", "但是", "竟", "敢", "休书", "滚", "冷笑", "质问", "反手", "一巴掌", "逼", "赌", "死", "跪", "退婚"];
const INFO_DUMP_MARKERS = ["世界", "境界", "分为", "历史", "传闻", "由来", "设定", "等级", "体系", "宗门", "法则", "规矩", "自古", "秩序"];

/**
 * 6-dimension offline structural health checker focusing on Golden 3 Chapters
 * (hook, 300-char conflict, info-dump detection, dialogue ratio, rhythm, word band).
 */
export function diagnoseGoldenThree(
  body: string,
  options?: { readonly chapterIndex?: number; readonly targetLength?: number },
): GoldenThreeReportDto {
  const isGoldenThreeChapter = (options?.chapterIndex ?? 0) < 3;
  const rawParas = body.replace(/\r\n?/g, "\n").split("\n");
  const paras: Array<{ readonly index: number; readonly text: string; readonly chars: number }> = [];
  rawParas.forEach((raw, idx) => {
    const trimmed = raw.trim();
    if (trimmed) paras.push({ index: idx + 1, text: trimmed, chars: nonWhitespaceLength(trimmed) });
  });
  const totalChars = paras.reduce((sum, p) => sum + p.chars, 0);

  // 1. Opening Hook (weight 0.20)
  const lead = paras.slice(0, 2).map((p) => p.text).join("\n");
  const hasLeadQuote = /[“「"]/u.test(lead);
  const hasLeadPunct = /[？！?!]/u.test(lead);
  const hasHookKw = HOOK_KEYWORDS.some((kw) => lead.includes(kw));
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
  const earlyConflictHits = CONFLICT_KEYWORDS.filter((kw) => first300.includes(kw)).length;
  const earlyHasDialogue = /[“「"]/u.test(first300);
  const earlyHasPunct = /[？！?!]/u.test(first300);
  let conflictScore = paras.length === 0 ? 0 : 45 + Math.min(30, earlyConflictHits * 12) + (earlyHasDialogue ? 15 : 0) + (earlyHasPunct ? 10 : 0);
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
      const hasQuote = /[“「"]/u.test(p.text);
      if (hasQuote) return false;
      const markers = INFO_DUMP_MARKERS.filter((m) => p.text.includes(m)).length;
      return (p.chars >= 120 && markers >= 2) || p.chars >= 260;
    })
    .map((p) => p.index);
  const infoScore = paras.length === 0 ? 0 : infoDumpParas.length === 0 ? 94 : Math.max(25, 72 - infoDumpParas.length * 18);
  const infoDim: GoldenThreeDimensionDto = {
    id: "infoDump",
    label: "设定灌输连续段",
    score: infoScore,
    status: infoScore >= 65 ? "pass" : "warn",
    summary: infoDumpParas.length === 0 ? "未发现连续大段干瘪设定灌输。" : `检测到 ${infoDumpParas.length} 处长段旁白/设定灌输，建议拆解进动作与对话交锋中。`,
    problemParagraphs: infoDumpParas,
  };

  // 4. Dialogue Ratio (weight 0.15)
  const dialogueMatches = body.match(/“[^”\n]*”|「[^」\n]*」|"[^"\n]*"/gu) ?? [];
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

  // 5. Paragraph Rhythm & Wall Paragraphs (weight 0.15)
  const wallParas = paras.filter((p) => p.chars > 160).map((p) => p.index);
  const avgChars = paras.length > 0 ? totalChars / paras.length : 0;
  let rhythmScore = paras.length === 0 ? 0 : 90 - wallParas.length * 16 - (avgChars > 110 ? 15 : 0);
  rhythmScore = Math.max(0, Math.min(100, rhythmScore));
  const rhythmDim: GoldenThreeDimensionDto = {
    id: "paragraphRhythm",
    label: "段落呼吸感",
    score: rhythmScore,
    status: rhythmScore >= 65 ? "pass" : "warn",
    summary: wallParas.length === 0 ? `均段 ${Math.round(avgChars)} 字，手机端阅读呼吸感良好。` : `发现 ${wallParas.length} 处超 160 字高密大段墙，建议按情绪节拍换行。`,
    problemParagraphs: wallParas,
  };

  // 6. Word Count Band (weight 0.10) — keeps Fanqie 1500..6000 caliber
  let wordScore = 90;
  let wordSummary = `当前 ${totalChars} 字，处于适读区间（1,500–6,000 字）。`;
  if (totalChars < 1500) {
    wordScore = totalChars === 0 ? 0 : Math.max(25, Math.round((totalChars / 1500) * 75));
    wordSummary = `当前 ${totalChars} 字，偏短（建议 ≥ 1,500 字，常见 2,000–2,500 字）。`;
  } else if (totalChars > 6000) {
    wordScore = 58;
    wordSummary = `当前 ${totalChars} 字，单章偏长（建议 ≤ 6,000 字，考虑拆章）。`;
  }
  const wordDim: GoldenThreeDimensionDto = {
    id: "wordCountBand",
    label: "字数达标带",
    score: wordScore,
    status: wordScore >= 65 ? "pass" : "warn",
    summary: wordSummary,
    problemParagraphs: [],
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

  return { isGoldenThreeChapter, overallScore, dimensions, warnings };
}

export function diagnoseChapterOffline(
  documentId: string,
  body: string,
  options?: {
    readonly chapterIndex?: number;
    readonly targetLength?: number;
    readonly customBanned?: readonly string[];
    readonly whitelist?: readonly string[];
  },
): ChapterDiagnosticsReportDto {
  return {
    documentId,
    goldenThree: diagnoseGoldenThree(body, options),
    aiSlop: scanAiSlop(body, options),
  };
}
