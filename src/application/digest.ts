import { createHash } from "node:crypto";

/**
 * Single definition of the SHA-256 hex digest.
 *
 * Used by Fanqie memory sync (body drift) and by proposal freshness checks
 * (`source_sha256`). Keeping one implementation avoids two files disagreeing
 * about encoding or hex casing when they compare hashes across layers.
 */
export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
