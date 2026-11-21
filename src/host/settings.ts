import { stmt, type SqliteDatabase } from "../storage/index.ts";

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
  readonly nodeVersion: string;
  readonly journalMode: string;
  readonly appliedMigrations: readonly string[];
  readonly ftsIntegrityOk: boolean;
  readonly counts: Readonly<Record<string, number>>;
  readonly activeGenerations: number;
  readonly activeProposals: number;
  /** In-flight `selection.rewrite` calls (DSH-10). */
  readonly activeMicroCalls: number;
  readonly agentToolsEnabled: boolean;
  /** True only after all 7+3 tools were accepted by the host registrar (DSH-01). */
  readonly agentToolsRegistered: boolean;
  /** Error class name when registration failed; never a message, so no paths leak. */
  readonly agentToolsError: string | null;
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
    title: "织章工作台（V2.2）",
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
        label: "启用 DsH 对话只读与提案工具（7+3）",
        type: "boolean",
        defaultValue: enableAgentTools,
        description: "允许 DsH 对话读取章节/知情事实并提交待确认提案，不允许静默写入正文。",
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
    readonly activeGenerations: number;
    readonly activeProposals: number;
    readonly activeMicroCalls?: number;
    readonly agentToolsEnabled: boolean;
    readonly agentToolsRegistered?: boolean;
    readonly agentToolsError?: string | null;
  },
): SanitizedDiagnosticsReport {
  const journalRow = stmt(db, "PRAGMA journal_mode;").get() as { journal_mode?: string } | undefined;
  const migrations = (
    stmt(db, "SELECT id FROM schema_migrations ORDER BY applied_at ASC, id ASC;").all() as readonly { id: string }[]
  ).map((m) => m.id);

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
    version: "2.2.0",
    nodeVersion: process.version,
    journalMode: journalRow?.journal_mode ?? "unknown",
    appliedMigrations: migrations,
    ftsIntegrityOk,
    counts: {
      projects: countTable("author_projects"),
      documents: countTable("author_documents"),
      revisions: countTable("revisions"),
      runs: countTable("author_runs"),
      loreCurrent: countTable("author_lore_current"),
      foreshadows: countTable("author_foreshadows"),
      techniques: countTable("library_technique_cards"),
      observations: countTable("author_chapter_observations"),
    },
    activeGenerations: runtimeInfo.activeGenerations,
    activeProposals: runtimeInfo.activeProposals,
    activeMicroCalls: runtimeInfo.activeMicroCalls ?? 0,
    agentToolsEnabled: runtimeInfo.agentToolsEnabled,
    agentToolsRegistered: runtimeInfo.agentToolsRegistered ?? false,
    agentToolsError: runtimeInfo.agentToolsError ?? null,
  };
}
