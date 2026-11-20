import type {
  SkillImportPreviewDto,
  SkillReferenceDocDto,
  TechniqueCardDto,
  WritingStageBinding,
} from "../../../contracts/workspace-dto.ts";
import { normalizeStageBindings, normalizeTags, validatePacingLabel } from "../../../domain/fanqie/index.ts";
import { assertSafeRelativePath } from "../../../storage/index.ts";
import { invalid, optionalText, type Input, type WorkspaceContext } from "../../context.ts";
import { persistTechniqueCard } from "./library-crud.ts";

export const MAX_SKILL_FILE_BYTES = 128 * 1024;

const DANGEROUS_CAPABILITY_KEYS = new Set([
  "scripts", "script", "hooks", "hook", "tools", "tool", "allowed-tools", "allowed_tools",
  "mcp", "mcpservers", "mcp_servers", "subagents", "agents", "exec", "shell", "command",
  "commands", "permissions", "run",
]);

const EXECUTABLE_EXTENSIONS = [
  ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd", ".js", ".mjs", ".cjs", ".ts",
  ".mts", ".cts", ".py", ".rb", ".pl", ".php", ".exe", ".dll", ".so", ".dylib",
];

function stripInlineQuotes(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function parseYamlValue(raw: string): unknown {
  const t = raw.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    return t
      .slice(1, -1)
      .split(",")
      .map((s) => stripInlineQuotes(s))
      .filter(Boolean);
  }
  return stripInlineQuotes(t);
}

function sanitizeMarkdownContent(
  text: string,
  stripped: Set<string>,
  warnings: string[],
): string {
  let clean = text;
  if (/<script\b/iu.test(clean)) {
    clean = clean.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "");
    stripped.add("html-script-tag");
    warnings.push("已剥离潜在可执行 <script> 标签。");
  }
  if (/^#!/mu.test(clean)) {
    clean = clean.replace(/^#!.*$/gmu, "");
    stripped.add("shebang");
    warnings.push("已剥离脚本 Shebang 行。");
  }
  return clean.trim();
}

function parseSkillFrontmatter(raw: string): {
  readonly fields: Record<string, unknown>;
  readonly body: string;
  readonly strippedCapabilities: string[];
  readonly warnings: string[];
} {
  const normalized = raw.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n");
  const stripped = new Set<string>();
  const warnings: string[] = [];

  if (!normalized.startsWith("---\n")) {
    return {
      fields: {},
      body: sanitizeMarkdownContent(normalized, stripped, warnings),
      strippedCapabilities: [...stripped],
      warnings,
    };
  }

  const endIdx = normalized.indexOf("\n---", 3);
  if (endIdx < 0) {
    return {
      fields: {},
      body: sanitizeMarkdownContent(normalized, stripped, warnings),
      strippedCapabilities: [...stripped],
      warnings,
    };
  }

  const fmBlock = normalized.slice(4, endIdx);
  const afterClose = normalized.indexOf("\n", endIdx + 1);
  const rawBody = afterClose >= 0 ? normalized.slice(afterClose + 1) : "";
  const fields: Record<string, unknown> = {};

  let activeKey: string | null = null;
  let activeBlocked = false;
  let activeList: string[] | null = null;

  for (const line of fmBlock.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const isIndented = /^\s+/u.test(line);

    if (!isIndented) {
      if (activeKey && activeList && !activeBlocked) {
        fields[activeKey] = activeList;
      }
      activeList = null;
      const colon = line.indexOf(":");
      if (colon <= 0) {
        activeKey = null;
        activeBlocked = false;
        continue;
      }
      const key = line.slice(0, colon).trim().toLowerCase();
      const rest = line.slice(colon + 1).trim();
      if (DANGEROUS_CAPABILITY_KEYS.has(key)) {
        stripped.add(key);
        warnings.push(`已拒绝并剥离 frontmatter 高危能力声明：${key}`);
        activeKey = key;
        activeBlocked = true;
        continue;
      }
      activeKey = key;
      activeBlocked = false;
      if (rest) {
        fields[key] = parseYamlValue(rest);
      } else {
        activeList = [];
      }
      continue;
    }

    if (activeBlocked) continue;
    const itemMatch = line.match(/^\s*-\s+(.*)$/u);
    if (itemMatch && activeKey) {
      activeList ??= [];
      activeList.push(stripInlineQuotes(itemMatch[1]));
    }
  }
  if (activeKey && activeList && !activeBlocked) {
    fields[activeKey] = activeList;
  }

  const body = sanitizeMarkdownContent(rawBody, stripped, warnings);
  return { fields, body, strippedCapabilities: [...stripped], warnings };
}

function extractFirstHeading(body: string): string {
  for (const line of body.split("\n")) {
    const m = line.match(/^#\s+(.+)$/u);
    if (m) return m[1].trim();
  }
  return "";
}

function isDangerousFilePath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  if (
    lower.startsWith("scripts/") ||
    lower.includes("/scripts/") ||
    lower.startsWith("hooks/") ||
    lower.includes("/hooks/") ||
    lower.startsWith(".git/") ||
    lower.startsWith("node_modules/")
  ) {
    return true;
  }
  return EXECUTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isAllowedReferencePath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  if (!lower.startsWith("references/") && !lower.includes("/references/")) return false;
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt");
}

function assertByteLimit(path: string, content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_SKILL_FILE_BYTES) {
    invalid("files", `file-size-limit-exceeded:${path}`);
  }
}

/**
 * Parses and security-sandboxes standard `SKILL.md` skills (single-file or folder
 * bundles with `references/`), stripping scripts, hooks, tools, and subagents,
 * before either returning a dry-run preview or persisting into `library_technique_cards`.
 */
export function importSkillDocument(
  ctx: WorkspaceContext,
  input: Input,
): SkillImportPreviewDto | { readonly preview: SkillImportPreviewDto; readonly card: TechniqueCardDto } {
  const rejectedFiles: string[] = [];
  const allWarnings: string[] = [];
  const refs: SkillReferenceDocDto[] = [];
  let skillContent = "";

  if (Array.isArray(input.files)) {
    if (input.files.length === 0) invalid("files", "non-empty-skill-files-required");
    for (let i = 0; i < input.files.length; i++) {
      const entry = input.files[i];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        invalid("files", `invalid-file-entry-${i}`);
      }
      const rec = entry as { path?: unknown; content?: unknown };
      if (typeof rec.path !== "string" || typeof rec.content !== "string") {
        invalid("files", `invalid-file-fields-${i}`);
      }
      const safePath = assertSafeRelativePath(rec.path);
      assertByteLimit(safePath, rec.content);
      const lower = safePath.toLowerCase();

      if (isDangerousFilePath(safePath)) {
        rejectedFiles.push(safePath);
        allWarnings.push(`安全沙箱已拒绝脚本或可执行文件：${safePath}`);
        continue;
      }
      if (lower === "skill.md" || lower.endsWith("/skill.md")) {
        if (!skillContent) skillContent = rec.content;
        continue;
      }
      if (isAllowedReferencePath(safePath)) {
        refs.push({ path: safePath, content: rec.content });
      } else {
        rejectedFiles.push(safePath);
        allWarnings.push(`已忽略非参考文档文件：${safePath}`);
      }
    }
  } else {
    if (typeof input.skillMd !== "string" || !input.skillMd.trim()) {
      invalid("skillMd", "skill-markdown-required");
    }
    assertByteLimit("SKILL.md", input.skillMd);
    skillContent = input.skillMd;
    if (Array.isArray(input.references)) {
      for (const ref of input.references) {
        if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
        const r = ref as { path?: unknown; content?: unknown };
        if (typeof r.path !== "string" || typeof r.content !== "string") continue;
        const safePath = assertSafeRelativePath(r.path);
        assertByteLimit(safePath, r.content);
        if (isDangerousFilePath(safePath)) {
          rejectedFiles.push(safePath);
          allWarnings.push(`安全沙箱已拒绝脚本文件：${safePath}`);
        } else {
          refs.push({ path: safePath, content: r.content });
        }
      }
    }
  }

  if (!skillContent.trim()) {
    invalid("skillMd", "skill-md-missing");
  }

  const parsed = parseSkillFrontmatter(skillContent);
  const strippedSet = new Set(parsed.strippedCapabilities);
  allWarnings.push(...parsed.warnings);

  const sanitizedRefs = refs
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((ref) => ({
      path: ref.path,
      content: sanitizeMarkdownContent(ref.content, strippedSet, allWarnings),
    }))
    .filter((ref) => ref.content.length > 0);

  if (!parsed.body.trim()) {
    invalid("skillMd", "skill-body-required");
  }

  const fm = parsed.fields;
  const title =
    (typeof fm.title === "string" && fm.title.trim()) ||
    (typeof fm.name === "string" && fm.name.trim()) ||
    extractFirstHeading(parsed.body) ||
    optionalText(input, "title") ||
    "未命名写作 Skill";
  const triggerWhen =
    (typeof fm.triggerwhen === "string" && fm.triggerwhen.trim()) ||
    (typeof fm.description === "string" && fm.description.trim()) ||
    optionalText(input, "triggerWhen") ||
    "";
  const category =
    (typeof fm.category === "string" && fm.category.trim()) ||
    optionalText(input, "category") ||
    "narrative";
  const pacing = validatePacingLabel(fm.pacing ?? input.pacing);
  const sceneTags = normalizeTags(fm.scenetags ?? fm.tags ?? input.sceneTags);
  const stageBindings: WritingStageBinding[] = normalizeStageBindings(
    fm.stagebindings ?? fm.stage_bindings ?? fm.stages ?? input.stageBindings,
  );
  const constraints =
    (typeof fm.constraints === "string" && fm.constraints.trim()) ||
    (typeof input.constraints === "string" ? input.constraints.trim() : "");
  const antiPatterns =
    (typeof fm.antipatterns === "string" && fm.antipatterns.trim()) ||
    (typeof fm.anti_patterns === "string" && fm.anti_patterns.trim()) ||
    (typeof input.antiPatterns === "string" ? input.antiPatterns.trim() : "");
  const rawPriority = fm.priority !== undefined ? Number(fm.priority) : input.priority !== undefined ? Number(input.priority) : 65;
  const priority = Number.isSafeInteger(rawPriority) && rawPriority >= 0 ? Math.min(100, rawPriority) : 65;

  const preview: SkillImportPreviewDto = {
    title,
    triggerWhen,
    category,
    pacing,
    sceneTags,
    stageBindings,
    executionSteps: parsed.body,
    constraints,
    antiPatterns,
    references: sanitizedRefs,
    strippedCapabilities: [...strippedSet],
    rejectedFiles,
    warnings: [...new Set(allWarnings)],
    rawPreview: parsed.body.slice(0, 1500),
  };

  if (input.preview === true) {
    return preview;
  }

  const card = ctx.atomic(() =>
    persistTechniqueCard(
      ctx,
      {
        scope: input.scope ?? "global",
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.overrideOfId !== undefined ? { overrideOfId: input.overrideOfId } : {}),
        title,
        category,
        pacing,
        sceneTags,
        triggerWhen,
        executionSteps: parsed.body,
        constraints,
        antiPatterns,
        priority,
        assetKind: "skill",
        stageBindings,
        references: sanitizedRefs,
      },
      "skill-import",
    ),
  );

  return { preview, card };
}
