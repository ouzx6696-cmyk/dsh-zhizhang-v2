import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { StorageError } from "./errors.ts";

export interface BundleFileInput {
  readonly path: string;
  readonly content: string;
}

export interface ChapterMarkdownFrontmatter {
  readonly chapterId?: string;
  readonly title?: string;
  readonly state?: string;
  readonly volume?: string;
  readonly act?: string;
  readonly viewpoint?: string;
  readonly target?: number;
  readonly summary?: string;
}

/**
 * Sanitizes a single directory or file segment for cross-platform OS safety,
 * preserving CJK characters while stripping reserved characters and dot segments.
 */
export function sanitizePathSegment(raw: string, fallback = "untitled"): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 80);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

/**
 * Normalizes and validates a relative POSIX bundle path, refusing absolute
 * paths, Windows drive letters, null bytes, or `..` traversal attempts.
 */
export function assertSafeRelativePath(rawPath: string): string {
  if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) {
    throw new StorageError("input.invalid", { field: "path", reason: "invalid-relative-path" });
  }
  const slashNormalized = rawPath.replace(/\\/g, "/").trim();
  if (
    slashNormalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(slashNormalized) ||
    isAbsolute(slashNormalized)
  ) {
    throw new StorageError("input.invalid", { field: "path", reason: "absolute-path-forbidden" });
  }
  if (slashNormalized.split("/").some((segment) => segment === "..")) {
    throw new StorageError("input.invalid", { field: "path", reason: "path-traversal-forbidden" });
  }
  const normalized = posix.normalize(slashNormalized);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new StorageError("input.invalid", { field: "path", reason: "path-traversal-forbidden" });
  }
  return normalized;
}

/** Serializes a novel chapter with clean YAML-subset frontmatter and body. */
export function serializeChapterMarkdown(
  meta: ChapterMarkdownFrontmatter,
  body: string,
): string {
  const lines = ["---"];
  if (meta.chapterId) lines.push(`chapterId: ${meta.chapterId}`);
  if (meta.title !== undefined) lines.push(`title: ${JSON.stringify(meta.title)}`);
  if (meta.state) lines.push(`state: ${meta.state}`);
  if (meta.volume) lines.push(`volume: ${JSON.stringify(meta.volume)}`);
  if (meta.act) lines.push(`act: ${JSON.stringify(meta.act)}`);
  if (meta.viewpoint) lines.push(`viewpoint: ${JSON.stringify(meta.viewpoint)}`);
  if (typeof meta.target === "number" && meta.target > 0) lines.push(`target: ${meta.target}`);
  if (meta.summary) lines.push(`summary: ${JSON.stringify(meta.summary)}`);
  lines.push("---", "");
  return lines.join("\n") + body;
}

function unquoteScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : trimmed.slice(1, -1);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Parses optional YAML-subset frontmatter and returns `{ meta, body }`. */
export function parseChapterMarkdown(content: string): {
  readonly meta: ChapterMarkdownFrontmatter;
  readonly body: string;
} {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { meta: {}, body: normalized };
  }
  const closingIdx = normalized.indexOf("\n---\n", 4);
  if (closingIdx < 0) {
    return { meta: {}, body: normalized };
  }
  const headerBlock = normalized.slice(4, closingIdx);
  const body = normalized.slice(closingIdx + 5);
  const parsed: Record<string, string | number> = {};
  for (const line of headerBlock.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const rawVal = line.slice(colon + 1).trim();
    if (!rawVal) continue;
    if (key === "target") {
      const n = Number(rawVal);
      if (Number.isSafeInteger(n) && n > 0) parsed[key] = n;
    } else {
      parsed[key] = unquoteScalar(rawVal);
    }
  }
  return { meta: parsed as ChapterMarkdownFrontmatter, body };
}

/**
 * Writes an entire local project export bundle atomically under `targetDir`,
 * ensuring all relative paths stay strictly confined inside `targetDir`.
 */
export function writeLocalBundleToDir(
  targetDir: string,
  files: readonly BundleFileInput[],
): { readonly writtenDir: string; readonly count: number } {
  const resolvedRoot = resolve(targetDir);
  mkdirSync(dirname(resolvedRoot), { recursive: true, mode: 0o700 });
  const stagingDir = `${resolvedRoot}.staging-${randomUUID()}`;
  const backupOldDir = `${resolvedRoot}.prev-${randomUUID()}`;
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  let movedOld = false;
  let promoted = false;
  try {
    const manifestEntries: Array<{ path: string; sha256: string }> = [];
    for (const file of files) {
      const safeRel = assertSafeRelativePath(file.path);
      const dest = resolve(stagingDir, safeRel);
      const relCheck = relative(stagingDir, dest);
      if (!relCheck || relCheck.startsWith("..") || isAbsolute(relCheck)) {
        throw new StorageError("input.invalid", { field: "path", reason: "path-escape-forbidden" });
      }
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, file.content, { mode: 0o600, flush: true });
      manifestEntries.push({
        path: safeRel,
        sha256: createHash("sha256").update(file.content).digest("hex"),
      });
    }
    writeFileSync(
      join(stagingDir, "export-manifest.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), files: manifestEntries }, null, 2),
      { mode: 0o600, flush: true },
    );

    try {
      renameSync(resolvedRoot, backupOldDir);
      movedOld = true;
    } catch {
      // Target did not exist yet.
    }
    renameSync(stagingDir, resolvedRoot);
    promoted = true;
    if (movedOld) {
      rmSync(backupOldDir, { recursive: true, force: true });
    }
    return { writtenDir: resolvedRoot, count: files.length };
  } catch (error) {
    if (movedOld && !promoted) {
      try {
        renameSync(backupOldDir, resolvedRoot);
      } catch {
        // Best-effort rollback of previous export directory.
      }
    }
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}
