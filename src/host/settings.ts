import { readSchemaId, stmt, type SqliteDatabase } from "../storage/index.ts";
import type { ActiveJobCounts } from "./job-engine.ts";

export const DEFAULT_MODEL_ROUTE = { provider: "deepseek-account", model: "deepseek-flash" } as const;

export interface SanitizedDiagnosticsReport {
  readonly version: string;
  readonly schemaId: string;
  readonly nodeVersion: string;
  readonly journalMode: string;
  readonly ftsIntegrityOk: boolean;
  readonly usageConsistencyIssues: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly activeJobs: ActiveJobCounts;
  readonly agentToolsEnabled: boolean;
  readonly agentToolsRegistered: boolean;
  readonly agentToolCount: number;
  readonly agentToolsError: string | null;
  readonly systemPromptRegistered: boolean;
  readonly systemPromptError: string | null;
}

/**
 * Produces strictly non-sensitive operational diagnostics for `GET /api/zhizhang/diag`:
 * excludes manuscript text, prompt strings, secrets, and absolute host paths.
 */
export function buildSanitizedDiagnostics(
  db: SqliteDatabase,
  runtimeInfo: {
    readonly activeJobs: ActiveJobCounts;
    readonly usageConsistencyIssues?: number;
    readonly agentToolsEnabled: boolean;
    readonly agentToolsRegistered?: boolean;
    readonly agentToolCount?: number;
    readonly agentToolsError?: string | null;
    readonly systemPromptRegistered?: boolean;
    readonly systemPromptError?: string | null;
  },
): SanitizedDiagnosticsReport {
  const journalRow = stmt(db, "PRAGMA journal_mode;").get() as { journal_mode?: string } | undefined;
  let schemaId = "unknown";
  try {
    schemaId = readSchemaId(db);
  } catch {
    schemaId = "unknown";
  }

  let ftsIntegrityOk = true;
  try {
    for (const ftsTable of ["fts_chapters", "fts_lore", "fts_library"]) {
      db.exec(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES ('integrity-check');`);
    }
  } catch {
    ftsIntegrityOk = false;
  }

  const countTable = (table: string): number => {
    try {
      const row = stmt(db, `SELECT COUNT(*) AS count FROM ${table};`).get() as { count?: number } | undefined;
      return typeof row?.count === "number" ? row.count : 0;
    } catch {
      return 0;
    }
  };

  return {
    version: "3.2.0",
    schemaId,
    nodeVersion: process.version,
    journalMode: journalRow?.journal_mode ?? "unknown",
    ftsIntegrityOk,
    usageConsistencyIssues: runtimeInfo.usageConsistencyIssues ?? 0,
    counts: {
      projects: countTable("author_projects"),
      documents: countTable("author_documents"),
      revisions: countTable("revisions"),
      runs: countTable("author_runs"),
      jobs: countTable("author_jobs"),
      loreCurrent: countTable("author_lore_current"),
      foreshadows: countTable("author_foreshadows"),
      techniques: countTable("library_technique_cards"),
      observations: countTable("author_chapter_observations"),
    },
    activeJobs: runtimeInfo.activeJobs,
    agentToolsEnabled: runtimeInfo.agentToolsEnabled,
    agentToolsRegistered: runtimeInfo.agentToolsRegistered ?? false,
    agentToolCount: runtimeInfo.agentToolCount ?? 0,
    agentToolsError: runtimeInfo.agentToolsError ?? null,
    systemPromptRegistered: runtimeInfo.systemPromptRegistered ?? false,
    systemPromptError: runtimeInfo.systemPromptError ?? null,
  };
}
