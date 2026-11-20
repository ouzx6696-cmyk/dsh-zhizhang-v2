import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGenerationLedger } from "../src/storage/author-generation.ts";
import { createAuthorSchema } from "../src/storage/author-schema.ts";
import {
  appliedMigrations,
  createCommandSchema,
  createDeliverySchema,
  createEventLogSchema,
  createFtsSchema,
  createProjectionSchema,
  openDatabase,
} from "../src/storage/index.ts";

const FTS_SHADOW_PATTERN = /^fts_(?:chapters|lore|library)_(?:data|idx|content|docsize|config)$/;

/**
 * Opens an in-memory SQLite database initialized with all Zhizhang V2.3
 * schemas and returns structured introspection metadata from `sqlite_master`.
 */
export function buildFreshSchemaSummary() {
  const db = openDatabase(":memory:");
  try {
    createCommandSchema(db);
    createEventLogSchema(db);
    createDeliverySchema(db);
    createProjectionSchema(db);
    createAuthorSchema(db);
    createFtsSchema(db);
    createGenerationLedger(db);
    return inspectDatabaseSchema(db);
  } finally {
    db.close();
  }
}

/** Introspects an initialized SQLite handle via `sqlite_master` and PRAGMAs. */
export function inspectDatabaseSchema(db) {
  const schemaRow = db.prepare("SELECT value FROM meta WHERE key = 'schema';").get();
  const userVersionRow = db.prepare("PRAGMA user_version;").get();
  const migrations = appliedMigrations(db);

  const allObjects = db
    .prepare(
      `SELECT type, name, tbl_name AS tblName, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type ASC, name ASC;`,
    )
    .all();

  const tables = [];
  const ftsTables = [];
  const ftsShadowTables = [];
  const views = [];
  const indexes = [];
  const triggers = [];

  for (const obj of allObjects) {
    if (obj.type === "table") {
      if (FTS_SHADOW_PATTERN.test(obj.name)) {
        ftsShadowTables.push(obj.name);
        continue;
      }
      if (typeof obj.sql === "string" && /CREATE\s+VIRTUAL\s+TABLE/i.test(obj.sql)) {
        ftsTables.push({ name: obj.name, sql: obj.sql.trim() });
        continue;
      }
      const columns = db
        .prepare(`PRAGMA table_info("${obj.name}");`)
        .all()
        .map((col) => ({
          name: col.name,
          type: col.type,
          notNull: col.notnull === 1,
          defaultValue: col.dflt_value,
          pk: col.pk,
        }));
      const foreignKeys = db
        .prepare(`PRAGMA foreign_key_list("${obj.name}");`)
        .all()
        .map((fk) => ({
          from: fk.from,
          table: fk.table,
          to: fk.to,
        }));
      tables.push({
        name: obj.name,
        strict: typeof obj.sql === "string" && /\)\s*STRICT\b/i.test(obj.sql),
        columns,
        foreignKeys,
      });
    } else if (obj.type === "view") {
      views.push({ name: obj.name, sql: (obj.sql ?? "").trim() });
    } else if (obj.type === "index" && obj.sql) {
      indexes.push({
        name: obj.name,
        table: obj.tblName,
        unique: /CREATE\s+UNIQUE\s+INDEX/i.test(obj.sql),
        partial: /\bWHERE\b/i.test(obj.sql),
      });
    } else if (obj.type === "trigger") {
      triggers.push({
        name: obj.name,
        table: obj.tblName,
      });
    }
  }

  return {
    schemaId: schemaRow?.value ?? "unknown",
    userVersion: userVersionRow?.user_version ?? 0,
    migrations,
    counts: {
      tables: tables.length,
      ftsTables: ftsTables.length,
      ftsShadowTables: ftsShadowTables.length,
      views: views.length,
      indexes: indexes.length,
      triggers: triggers.length,
    },
    tables,
    ftsTables,
    views,
    indexes,
    triggers,
  };
}

/** Renders deterministic Markdown documentation from a schema summary (DB-21). */
export function renderSchemaMarkdown(summary) {
  const lines = [
    "# Zhizhang SQLite Schema Reference (Auto-Generated)",
    "",
    `> Generated from \`sqlite_master\` by \`scripts/schema-doc.mjs\`. Do not hand-edit.`,
    "",
    `- **Schema ID**: \`${summary.schemaId}\``,
    `- **SQLite \`user_version\`**: \`${summary.userVersion}\``,
    `- **Migrations applied**: ${summary.migrations.length}`,
    "",
    "## Summary Counts",
    "",
    "| Object Type | Count |",
    "| --- | ---: |",
    `| Tables (non-shadow) | ${summary.counts.tables} |`,
    `| FTS5 Virtual Tables | ${summary.counts.ftsTables} |`,
    `| FTS5 Shadow Tables | ${summary.counts.ftsShadowTables} |`,
    `| Views | ${summary.counts.views} |`,
    `| Explicit Indexes | ${summary.counts.indexes} |`,
    `| Triggers | ${summary.counts.triggers} |`,
    "",
    "## Migrations",
    "",
    ...summary.migrations.map((id, i) => `${i + 1}. \`${id}\``),
    "",
    "## Tables",
    "",
  ];

  for (const table of summary.tables) {
    lines.push(`### \`${table.name}\`${table.strict ? " (STRICT)" : ""}`);
    lines.push("");
    lines.push("| Column | Type | Not Null | Default | PK |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const col of table.columns) {
      lines.push(
        `| \`${col.name}\` | \`${col.type || "ANY"}\` | ${col.notNull ? "YES" : "NO"} | ${col.defaultValue ?? ""} | ${col.pk || ""} |`,
      );
    }
    if (table.foreignKeys.length > 0) {
      lines.push("");
      lines.push(
        `Foreign keys: ${table.foreignKeys.map((fk) => `\`${fk.from}\` -> \`${fk.table}(${fk.to})\``).join(", ")}`,
      );
    }
    lines.push("");
  }

  lines.push("## FTS5 Virtual Tables", "");
  for (const fts of summary.ftsTables) {
    lines.push(`- \`${fts.name}\``);
  }
  lines.push("");

  lines.push("## Views", "");
  for (const view of summary.views) {
    lines.push(`- \`${view.name}\``);
  }
  lines.push("");

  lines.push("## Explicit Indexes", "");
  lines.push("| Index | Table | Unique | Partial |");
  lines.push("| --- | --- | --- | --- |");
  for (const idx of summary.indexes) {
    lines.push(`| \`${idx.name}\` | \`${idx.table}\` | ${idx.unique ? "YES" : "NO"} | ${idx.partial ? "YES" : "NO"} |`);
  }
  lines.push("");

  lines.push("## Triggers", "");
  lines.push("| Trigger | Table |");
  lines.push("| --- | --- |");
  for (const tr of summary.triggers) {
    lines.push(`| \`${tr.name}\` | \`${tr.table}\` |`);
  }
  lines.push("");

  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const summary = buildFreshSchemaSummary();
  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const markdown = renderSchemaMarkdown(summary);
    const writeIdx = args.indexOf("--write");
    if (writeIdx >= 0 && args[writeIdx + 1]) {
      writeFileSync(args[writeIdx + 1], markdown, "utf8");
    } else {
      console.log(markdown);
    }
  }
}
