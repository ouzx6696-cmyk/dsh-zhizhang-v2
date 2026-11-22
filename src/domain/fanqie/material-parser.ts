import type {
  ForeshadowStatus,
  LoreCategory,
  MaterialChunkDto,
  MaterialChunkRole,
  MaterialProposedBundleDto,
  MaterialProposedChapterDto,
  MaterialProposedForeshadowDto,
  MaterialProposedLoreDto,
} from "../../contracts/workspace-dto.ts";

export interface RawMaterialFileInput {
  readonly path: string;
  readonly content: string;
}

export interface MaterialPreprocessResult {
  readonly totalFiles: number;
  readonly totalChars: number;
  readonly cleaningWarnings: readonly string[];
  readonly chunks: readonly MaterialChunkDto[];
}

export interface ExistingChapterRef {
  readonly title: string;
  readonly state: string;
}

export interface ExistingLoreRef {
  readonly factId: string;
  readonly entityName: string;
  readonly locked: boolean;
}

const VOLUME_HEADING_RE =
  /^(?:#{1,2}\s*)?(?:第[零一二三四五六七八九十百千万0-9]+[卷部]|卷[零一二三四五六七八九十百千万0-9]+|Volume\s+\d+)(?:[\s:：—\-·]+.*)?$/iu;

const CHAPTER_HEADING_RE =
  /^(?:#{1,3}\s*)?(?:第[零一二三四五六七八九十百千万0-9]+[章节回]|Chapter\s+\d+|序章|楔子|番外[零一二三四五六七八九十0-9]*)(?:[\s:：—\-·]+.*)?$/iu;

const MARKDOWN_HEADING_RE = /^(#{1,3})\s+(.+)$/u;
const BRACKET_HEADING_RE = /^【([^】]{1,40})】\s*$/u;
const SECTION_DIVIDER_RE = /^(?:[-=_*]{3,}|—{3,})$/u;

const ROUGH_DRAFT_MARKERS = ["TODO", "待补", "待写", "待扩写", "草稿", "细纲", "梗概", "（略）", "[略]"];

function normalizeTitleForCompare(title: string): string {
  return title
    .replace(/^#+\s*/u, "")
    .replace(/[\s:：·\-—_]+/gu, "")
    .trim()
    .toLowerCase();
}

function nonWsCount(text: string): number {
  return [...text.replace(/\s/gu, "")].length;
}

/**
 * Stage 1a: Pure zero-token raw text sanitizer for non-standard user files.
 * Strips BOM, HTML script/style blocks, zero-width invisible characters, and
 * normalizes CRLF + excessive blank lines while logging non-destructive warnings.
 */
export function cleanRawMaterialText(raw: string): { readonly text: string; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  let text = String(raw ?? "");
  if (text.startsWith("\uFEFF")) {
    text = text.slice(1);
    warnings.push("已移除 UTF-8 BOM 头");
  }
  const hadScripts = /<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/iu.test(text);
  if (hadScripts) {
    text = text.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, "");
    warnings.push("已清理嵌入的 HTML script/style 标签");
  }
  const hadZeroWidth = /[\u200B-\u200D\u2060\uFEFF]/u.test(text);
  if (hadZeroWidth) {
    text = text.replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "");
    warnings.push("已清理不可见零宽字符");
  }
  text = text.replace(/\r\n?/gu, "\n");
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n");
  text = text.replace(/\n{4,}/gu, "\n\n\n").trim();
  return { text, warnings };
}

function inferLoreCategory(title: string, content: string): LoreCategory {
  const sample = `${title}\n${content.slice(0, 400)}`;
  if (/人物|角色|主角|配角|反派|女主|男主|人设|性格|外貌|金手指宿主|出身/u.test(sample)) return "character";
  if (/势力|宗门|组织|阵营|家族|公会|门派|皇室|教派|公司/u.test(sample)) return "faction";
  if (/地点|地图|城市|秘境|大陆|疆域|学院|星球|区域|场景/u.test(sample)) return "location";
  if (/物品|道具|法宝|武器|丹药|神器|功法|遗物|秘籍|装备/u.test(sample)) return "item";
  if (/伏笔|悬念|暗线|谜团|伏线/u.test(sample)) return "foreshadow";
  if (/约定|铁律|禁令|红线|协议|禁忌/u.test(sample)) return "agreement";
  return "world_rule";
}

function classifyNonChapterChunk(
  title: string,
  content: string,
  sourcePath: string,
): { readonly role: MaterialChunkRole; readonly loreCategoryHint?: LoreCategory } {
  const header = `${sourcePath} ${title}`;
  const sample = `${header}\n${content.slice(0, 500)}`;

  if (/大纲|卷纲|全书指南|简介|卖点|核心梗|故事线|主线规划|节奏表|写作计划/u.test(header)) {
    return { role: "outline_note" };
  }
  if (/伏笔|暗线|悬念表|回收计划/u.test(header)) {
    return { role: "foreshadow_note", loreCategoryHint: "foreshadow" };
  }
  if (/设定|人物|角色|世界观|势力|地图|地点|道具|境界|体系|资料/u.test(header)) {
    return { role: "lore_note", loreCategoryHint: inferLoreCategory(title, content) };
  }
  if (/大纲|主线|卖点|全书核心/u.test(sample) && !/[“”「」]/u.test(content)) {
    return { role: "outline_note" };
  }
  if (/伏笔|埋线|回收章/u.test(sample) && nonWsCount(content) < 900) {
    return { role: "foreshadow_note", loreCategoryHint: "foreshadow" };
  }
  // If long narrative text with dialogue quotes, treat as rough_draft rather than lore.
  const chars = nonWsCount(content);
  const dialogueCount = (content.match(/[“「"]/gu) ?? []).length;
  if (chars >= 500 && dialogueCount >= 4) {
    const hasDraftMarker = ROUGH_DRAFT_MARKERS.some((m) => content.includes(m));
    return { role: chars >= 1100 && !hasDraftMarker ? "completed_chapter" : "rough_draft" };
  }
  return { role: "lore_note", loreCategoryHint: inferLoreCategory(title, content) };
}

function splitLongTextByParagraphs(text: string, maxChars: number): string[] {
  if (nonWsCount(text) <= maxChars) return [text];
  const paras = text.split(/\n{2,}/u);
  const parts: string[] = [];
  let buf: string[] = [];
  let count = 0;
  for (const para of paras) {
    const pLen = nonWsCount(para);
    if (buf.length > 0 && count + pLen > maxChars) {
      parts.push(buf.join("\n\n"));
      buf = [para];
      count = pLen;
    } else {
      buf.push(para);
      count += pLen;
    }
  }
  if (buf.length > 0) parts.push(buf.join("\n\n"));
  return parts;
}

/**
 * Stage 1b: Deterministic zero-token structural splitter & classifier for
 * unstructured lore docs, outlines, rough drafts, and completed chapters.
 */
export function preprocessNonStandardMaterials(
  files: readonly RawMaterialFileInput[],
  existingChapterTitles: readonly string[] = [],
): MaterialPreprocessResult {
  const cleaningWarnings: string[] = [];
  const chunks: MaterialChunkDto[] = [];
  let totalChars = 0;
  let chunkSeq = 0;

  const existingTitleMap = new Map<string, string>();
  for (const title of existingChapterTitles) {
    const norm = normalizeTitleForCompare(title);
    if (norm) existingTitleMap.set(norm, title);
  }

  for (const file of files) {
    const sourcePath = (file.path || "未命名材料.txt").trim();
    const cleaned = cleanRawMaterialText(file.content);
    for (const w of cleaned.warnings) {
      cleaningWarnings.push(`${sourcePath}：${w}`);
    }
    if (!cleaned.text) {
      cleaningWarnings.push(`${sourcePath}：内容为空，已跳过`);
      continue;
    }
    totalChars += nonWsCount(cleaned.text);

    const lines = cleaned.text.split("\n");
    const chapterLineIndices: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (CHAPTER_HEADING_RE.test(trimmed)) {
        chapterLineIndices.push(i);
      }
    }

    if (chapterLineIndices.length > 0) {
      // Chapter-structured document (may also have leading preface/lore + volume headers)
      let currentVolume = "第一卷";
      // Check lines before first chapter for volume header or preface lore
      const firstChapIdx = chapterLineIndices[0];
      const prefaceLines: string[] = [];
      for (let i = 0; i < firstChapIdx; i += 1) {
        const trimmed = lines[i].trim();
        if (VOLUME_HEADING_RE.test(trimmed)) {
          currentVolume = trimmed.replace(/^#+\s*/u, "").trim();
        } else if (trimmed) {
          prefaceLines.push(lines[i]);
        }
      }
      if (prefaceLines.length > 0 && nonWsCount(prefaceLines.join("\n")) >= 30) {
        const prefaceText = prefaceLines.join("\n").trim();
        const inferred = classifyNonChapterChunk(`${sourcePath} 卷首说明`, prefaceText, sourcePath);
        chunkSeq += 1;
        chunks.push({
          id: `chunk-${chunkSeq}`,
          sourcePath,
          lineStart: 1,
          lineEnd: firstChapIdx,
          title: `${sourcePath.replace(/\.[^.]+$/u, "")}·前置说明`,
          volumeTitle: currentVolume,
          role: inferred.role,
          loreCategoryHint: inferred.loreCategoryHint,
          charCount: nonWsCount(prefaceText),
          content: prefaceText,
          warnings: [],
          duplicateOfExistingTitle: null,
        });
      }

      for (let c = 0; c < chapterLineIndices.length; c += 1) {
        const startIdx = chapterLineIndices[c];
        const nextStart = c + 1 < chapterLineIndices.length ? chapterLineIndices[c + 1] : lines.length;
        // Scan trailing volume heading that belongs to the NEXT chapter
        let endIdx = nextStart;
        let nextVolume = currentVolume;
        for (let k = startIdx + 1; k < nextStart; k += 1) {
          const t = lines[k].trim();
          if (VOLUME_HEADING_RE.test(t)) {
            endIdx = k;
            nextVolume = t.replace(/^#+\s*/u, "").trim();
            break;
          }
        }
        const rawTitle = lines[startIdx].trim().replace(/^#+\s*/u, "").trim();
        const bodyText = lines.slice(startIdx + 1, endIdx).join("\n").trim();
        const charCount = nonWsCount(bodyText);
        const hasDraftMarker = ROUGH_DRAFT_MARKERS.some((m) => bodyText.includes(m) || rawTitle.includes(m));
        const role: MaterialChunkRole =
          charCount >= 800 && !hasDraftMarker ? "completed_chapter" : "rough_draft";
        const warnings: string[] = [];
        if (charCount < 200) warnings.push("正文不足 200 字，归类为草稿/细纲");
        if (hasDraftMarker) warnings.push("检测到草稿/待补标记");
        const dup = existingTitleMap.get(normalizeTitleForCompare(rawTitle)) ?? null;
        if (dup) warnings.push(`与现有章节「${dup}」重名`);

        chunkSeq += 1;
        chunks.push({
          id: `chunk-${chunkSeq}`,
          sourcePath,
          lineStart: startIdx + 1,
          lineEnd: endIdx,
          title: rawTitle,
          volumeTitle: currentVolume,
          role,
          charCount,
          content: bodyText,
          warnings,
          duplicateOfExistingTitle: dup,
        });
        currentVolume = nextVolume;
      }
      continue;
    }

    // Non-chapter document (setting bible, character sheets, outline, messy notes)
    interface RawSection {
      title: string;
      lineStart: number;
      lineEnd: number;
      lines: string[];
    }
    const sections: RawSection[] = [];
    const baseTitle = sourcePath.replace(/^.*[/\\]/u, "").replace(/\.[^.]+$/u, "") || "未命名资料";
    let current: RawSection = { title: baseTitle, lineStart: 1, lineEnd: 1, lines: [] };

    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      const mdMatch = trimmed.match(MARKDOWN_HEADING_RE);
      const bracketMatch = trimmed.match(BRACKET_HEADING_RE);
      if (mdMatch || bracketMatch) {
        if (current.lines.some((l) => l.trim().length > 0)) {
          current.lineEnd = i;
          sections.push(current);
        }
        const headingTitle = (mdMatch ? mdMatch[2] : bracketMatch![1]).trim();
        current = { title: headingTitle, lineStart: i + 1, lineEnd: i + 1, lines: [] };
      } else if (SECTION_DIVIDER_RE.test(trimmed)) {
        if (current.lines.some((l) => l.trim().length > 0)) {
          current.lineEnd = i;
          sections.push(current);
          current = { title: `${baseTitle}·片段${sections.length + 1}`, lineStart: i + 2, lineEnd: i + 2, lines: [] };
        }
      } else {
        current.lines.push(lines[i]);
      }
    }
    if (current.lines.some((l) => l.trim().length > 0)) {
      current.lineEnd = lines.length;
      sections.push(current);
    }

    if (sections.length === 0) {
      sections.push({ title: baseTitle, lineStart: 1, lineEnd: lines.length, lines });
    }

    for (const sec of sections) {
      const text = sec.lines.join("\n").trim();
      if (!text) continue;
      const inferred = classifyNonChapterChunk(sec.title, text, sourcePath);
      const splitParts =
        inferred.role === "completed_chapter" || inferred.role === "rough_draft"
          ? [text]
          : splitLongTextByParagraphs(text, 3200);
      for (let p = 0; p < splitParts.length; p += 1) {
        const partText = splitParts[p];
        const partTitle = splitParts.length > 1 ? `${sec.title}（${p + 1}/${splitParts.length}）` : sec.title;
        const dup =
          inferred.role === "completed_chapter" || inferred.role === "rough_draft"
            ? (existingTitleMap.get(normalizeTitleForCompare(partTitle)) ?? null)
            : null;
        chunkSeq += 1;
        chunks.push({
          id: `chunk-${chunkSeq}`,
          sourcePath,
          lineStart: sec.lineStart,
          lineEnd: sec.lineEnd,
          title: partTitle,
          role: inferred.role,
          loreCategoryHint: inferred.loreCategoryHint,
          charCount: nonWsCount(partText),
          content: partText,
          warnings: dup ? [`与现有章节「${dup}」重名`] : [],
          duplicateOfExistingTitle: dup,
        });
      }
    }
  }

  return {
    totalFiles: files.length,
    totalChars,
    cleaningWarnings,
    chunks,
  };
}

function slugFactId(entityName: string, index: number): string {
  const clean = entityName
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 18);
  return `mat-${clean || "entry"}-${index}`;
}

function extractAliasesFromText(content: string): string[] {
  const match = content.match(/(?:别名|又称|外号|绰号|简称)[：:]\s*([^\n]+)/u);
  if (!match) return [];
  return [...new Set(match[1].split(/[、,，/；;\s]+/u).map((s) => s.trim()).filter((s) => s.length >= 1 && s.length <= 20))];
}

function buildBriefSummary(body: string): string {
  const compact = body.replace(/\s+/gu, " ").trim();
  if (compact.length <= 130) return compact;
  return `${compact.slice(0, 128)}…`;
}

/**
 * Stage 1c: Zero-token deterministic baseline proposal bundle builder.
 * Allows immediate offline preview & commit when the author skips AI refinement,
 * or serves as the structured conflict-checked foundation alongside AI/DsH proposals.
 */
export function buildLocalProposedBundle(
  chunks: readonly MaterialChunkDto[],
  existingChapters: readonly ExistingChapterRef[] = [],
  existingLore: readonly ExistingLoreRef[] = [],
): MaterialProposedBundleDto {
  const chapters: MaterialProposedChapterDto[] = [];
  const lore: MaterialProposedLoreDto[] = [];
  const foreshadows: MaterialProposedForeshadowDto[] = [];
  const warnings: string[] = [];
  const outlineSnippets: string[] = [];

  const chapterMap = new Map<string, ExistingChapterRef>();
  for (const ch of existingChapters) {
    chapterMap.set(normalizeTitleForCompare(ch.title), ch);
  }
  const loreByName = new Map<string, ExistingLoreRef>();
  for (const item of existingLore) {
    loreByName.set(item.entityName.trim().toLowerCase(), item);
  }

  let chapSeq = 0;
  let loreSeq = 0;
  let fsSeq = 0;

  for (const chunk of chunks) {
    if (chunk.role === "ignore") continue;

    if (chunk.role === "completed_chapter" || chunk.role === "rough_draft") {
      chapSeq += 1;
      const existing = chapterMap.get(normalizeTitleForCompare(chunk.title));
      const conflictStatus: MaterialProposedChapterDto["conflictStatus"] = existing
        ? existing.state === "final"
          ? "skip_locked_final"
          : "update_draft"
        : "new";
      if (conflictStatus === "skip_locked_final") {
        warnings.push(`章节「${chunk.title}」在目标书中已定稿（final），默认跳过覆盖以保护定稿。`);
      }
      chapters.push({
        id: `mch-${chapSeq}`,
        volumeTitle: chunk.volumeTitle?.trim() || "第一卷",
        actTitle: "第一幕",
        title: chunk.title,
        state: chunk.role === "completed_chapter" ? "drafted" : "drafting",
        summary: buildBriefSummary(chunk.content),
        body: chunk.content,
        conflictStatus,
        selected: conflictStatus !== "skip_locked_final",
      });
      continue;
    }

    if (chunk.role === "outline_note") {
      outlineSnippets.push(`【${chunk.title}】\n${chunk.content.slice(0, 600)}`);
      continue;
    }

    if (chunk.role === "foreshadow_note") {
      const lines = chunk.content
        .split("\n")
        .map((l) => l.replace(/^[-*•\d.、\s]+/u, "").trim())
        .filter((l) => l.length >= 4);
      if (lines.length >= 2 && lines.length <= 20) {
        for (const line of lines) {
          fsSeq += 1;
          const [head, ...rest] = line.split(/[：:]/u);
          const title = (head || line).slice(0, 40).trim();
          const note = rest.length > 0 ? rest.join("：").trim() : line;
          const status: ForeshadowStatus = /已回收|揭晓|已解/u.test(line) ? "resolved" : "planted";
          foreshadows.push({
            id: `mfs-${fsSeq}`,
            title,
            status,
            note,
            selected: true,
          });
        }
      } else {
        fsSeq += 1;
        foreshadows.push({
          id: `mfs-${fsSeq}`,
          title: chunk.title.slice(0, 40),
          status: "planted",
          note: chunk.content.slice(0, 500),
          selected: true,
        });
      }
      continue;
    }

    // lore_note
    loreSeq += 1;
    const entityName = chunk.title.replace(/（\d+\/\d+）$/u, "").trim().slice(0, 40) || `设定条目${loreSeq}`;
    const existing = loreByName.get(entityName.toLowerCase());
    const conflictStatus: MaterialProposedLoreDto["conflictStatus"] = existing
      ? existing.locked
        ? "skip_locked"
        : "update_unlocked"
      : "new";
    if (conflictStatus === "skip_locked") {
      warnings.push(`设定「${entityName}」在目标书中已锁定（locked），默认跳过覆盖以保护主设定。`);
    }
    lore.push({
      id: `mlore-${loreSeq}`,
      factId: existing?.factId ?? slugFactId(entityName, loreSeq),
      category: chunk.loreCategoryHint ?? inferLoreCategory(entityName, chunk.content),
      entityName,
      note: chunk.content.slice(0, 1200),
      aliases: extractAliasesFromText(chunk.content),
      lockedSuggested: false,
      knownBy: [],
      conflictStatus,
      conflictNote:
        conflictStatus === "skip_locked"
          ? "目标设定已锁定，不可自动覆盖"
          : conflictStatus === "update_unlocked"
            ? "将更新已有未锁定设定条目"
            : undefined,
      selected: conflictStatus !== "skip_locked",
    });
  }

  return {
    authorIntent: outlineSnippets.length > 0 ? outlineSnippets.join("\n\n").slice(0, 1800) : undefined,
    chapters,
    lore,
    foreshadows,
    warnings,
  };
}
