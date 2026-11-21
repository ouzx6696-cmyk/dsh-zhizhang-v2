import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { ContractError } from "../contracts/index.ts";

const SAFE_DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function resolveContained(directory: string, filename: string): string {
  const root = resolve(directory);
  const target = resolve(join(root, filename));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new ContractError("input.invalid", { field: "deliveryId", reason: "path-escape-forbidden" });
  }
  return target;
}

/**
 * Atomically publishes an approved delivery Markdown file (`wx` temp file +
 * `linkSync` + `unlinkSync`) without overwriting an existing conflicting file.
 */
export function writeDeliveryFile(directory: string, id: string, contents: string): void {
  if (typeof id !== "string" || !SAFE_DELIVERY_ID.test(id) || id.includes("..")) {
    throw new ContractError("input.invalid", { field: "deliveryId", reason: "invalid-delivery-id" });
  }
  const path = resolveContained(directory, `${id}.md`);
  if (existsSync(path) && readFileSync(path, "utf8") === contents) return;
  const pending = resolveContained(directory, `.${id}.${randomUUID()}.tmp`);
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
