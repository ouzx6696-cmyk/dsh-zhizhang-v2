import { readSchemaId, stmt, type SqliteDatabase } from "../storage/index.ts";
import type { ActiveJobCounts } from "./job-engine.ts";

export interface ZhizhangConfigFormField {
  readonly key: string;
  readonly label: string;
  readonly type: "text" | "boolean";
  readonly defaultValue: string | boolean;
  readonly description: string;
}

export interface ZhizhangConfigSchema {
  readonly id: string;
  readonly tab: "settings.plugins.tab";
  readonly title: string;
  readonly description: string;
  readonly fields: readonly ZhizhangConfigFormField[];
  readonly current: Readonly<Record<string, string | boolean>>;
}

export interface DsHConfigFormRegistrar {
  register(schema: ZhizhangConfigSchema): () => void | Promise<void>;
}

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

export function createZhizhangConfigSchema(initial?: {
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly enableAgentTools?: boolean;
}): ZhizhangConfigSchema {
  const defaultProvider = initial?.defaultProvider ?? "deepseek-account";
  const defaultModel = initial?.defaultModel ?? "deepseek-flash";
  const enableAgentTools = initial?.enableAgentTools ?? true;
  return {
    id: "zhizhang-workbench",
    tab: "settings.plugins.tab",
    title: "织章工作台（V3.0）",
    description: "配置默认模型提供方与 DsH 对话辅助工具边界（所有工具严禁直接改写权威稿件与设定）。",
    fields: [
      {
        key: "defaultProvider",
        label: "默认模型提供方",
        type: "text",
        defaultValue: defaultProvider,
        description: "工作台生成任务及定性审稿默认预填的提供方标识。",
      },
      {
        key: "defaultModel",
        label: "默认模型",
        type: "text",
        defaultValue: defaultModel,
        description: "工作台候选稿及滚动规划默认预填模型。",
      },
      {
        key: "enableAgentTools",
        label: "启用 DsH 对话只读与提案工具",
        type: "boolean",
        defaultValue: enableAgentTools,
        description: "允许 DsH 对话读取章节/文章/知情事实并提交待确认提案，不允许静默写入正文。",
      },
    ],
    current: {
      defaultProvider,
      defaultModel,
      enableAgentTools,
    },
  };
}

export function registerZhizhangSettings(
  registrar: DsHConfigFormRegistrar | undefined,
  initial?: {
    readonly defaultProvider?: string;
    readonly defaultModel?: string;
    readonly enableAgentTools?: boolean;
  },
): Array<() => void | Promise<void>> {
  if (!registrar) return [];
  return [registrar.register(createZhizhangConfigSchema(initial))];
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
    version: "3.0.0",
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
