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

const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  try {
    const view = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(view, 0, 0, ms);
  } catch {
    // Fallback if SharedArrayBuffer is unavailable in restricted environments.
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // brief wait
    }
  }
}

/**
 * Performs `renameSync` with bounded exponential backoff retries on Windows
 * `EPERM`/`EBUSY` directory-lock errors.
 */
export function renameWithRetry(
  oldPath: string,
  newPath: string,
  options?: {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly renameFn?: (from: string, to: string) => void;
  },
): void {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
  const baseDelayMs = Math.max(0, options?.baseDelayMs ?? 25);
  const doRename = options?.renameFn ?? renameSync;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      doRename(oldPath, newPath);
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const isRetryable = typeof code === "string" && RETRYABLE_RENAME_CODES.has(code);
      if (!isRetryable) throw error;
      if (attempt < maxAttempts) {
        sleepSyncMs(baseDelayMs * attempt);
        continue;
      }
      throw new StorageError("dependency.unavailable", {
        reason: "export-directory-locked",
        code,
        attempts: attempt,
      });
    }
  }
}

/**
 * Sanitizes a single directory or file segment for cross-platform OS safety,
 * preserving CJK characters while stripping reserved characters, trailing dots
 * and spaces, dot segments, and Windows reserved device names (`CON`, `NUL`,
 * `COM1`-`COM9`, `LPT1`-`LPT9`, etc.) with a collision-avoiding hash suffix.
 */
export function sanitizePathSegment(raw: string, fallback = "untitled"): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim()
    .replace(/^\.+|[.\s]+$/g, "")
    .slice(0, 80)
    .replace(/[.\s]+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  if (WINDOWS_RESERVED_NAME.test(cleaned)) {
    const hash = createHash("sha256").update(raw).digest("hex").slice(0, 6);
    const dotIdx = cleaned.indexOf(".");
    if (dotIdx > 0) {
      return `${cleaned.slice(0, dotIdx)}_${hash}${cleaned.slice(dotIdx)}`;
    }
    return `${cleaned}_${hash}`;
  }
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
 * ensuring all relative paths stay strictly confined inside `targetDir` and
 * retrying transient Windows EPERM/EBUSY directory swaps cleanly.
 */
export function writeLocalBundleToDir(
  targetDir: string,
  files: readonly BundleFileInput[],
  options?: {
    readonly renameFn?: (from: string, to: string) => void;
    readonly baseDelayMs?: number;
  },
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
      renameWithRetry(resolvedRoot, backupOldDir, {
        maxAttempts: 3,
        baseDelayMs: options?.baseDelayMs,
        renameFn: options?.renameFn,
      });
      movedOld = true;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== "ENOENT") {
        throw error;
      }
      // Target did not exist yet.
    }
    renameWithRetry(stagingDir, resolvedRoot, {
      maxAttempts: 3,
      baseDelayMs: options?.baseDelayMs,
      renameFn: options?.renameFn,
    });
    promoted = true;
    if (movedOld) {
      rmSync(backupOldDir, { recursive: true, force: true });
    }
    return { writtenDir: resolvedRoot, count: files.length };
  } catch (error) {
    if (movedOld && !promoted) {
      try {
        renameWithRetry(backupOldDir, resolvedRoot, {
          maxAttempts: 3,
          baseDelayMs: options?.baseDelayMs,
          renameFn: options?.renameFn,
        });
      } catch {
        // Best-effort rollback of previous export directory.
      }
    }
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}
