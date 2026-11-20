import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Atomically publishes an approved delivery Markdown file (`wx` temp file +
 * `linkSync` + `unlinkSync`) without overwriting an existing conflicting file.
 */
export function writeDeliveryFile(directory: string, id: string, contents: string): void {
  const path = join(directory, `${id}.md`);
  if (existsSync(path) && readFileSync(path, "utf8") === contents) return;
  const pending = join(directory, `.${id}.${randomUUID()}.tmp`);
  writeFileSync(pending, contents, { mode: 0o600, flag: "wx", flush: true });
  try {
    linkSync(pending, path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "EEXIST") throw error;
    if (readFileSync(path, "utf8") !== contents) {
      throw Object.assign(new Error("Delivery file already exists"), {
        code: "export.conflict",
        retryable: false,
      });
    }
  } finally {
    unlinkSync(pending);
  }
}
