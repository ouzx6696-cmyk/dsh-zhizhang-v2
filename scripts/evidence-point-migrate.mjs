import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pointAtOffset } from "../src/domain/shared/anchors.ts";
import { createHotBackup } from "../src/storage/backup.ts";
import { openDatabase } from "../src/storage/index.ts";

/**
 * Recomputes `author_evidence.point` with the shared paragraph splitter
 * (decision #12: one non-empty line is one paragraph).
 *
 * The backfill is deliberately NOT a startup migration: resolution #12 requires
 * a hot backup and a change report the author can review before any historical
 * row is rewritten. `--apply` is therefore an explicit, separate step.
 */

const SELECT_ROWS = `
  SELECT e.snapshot_id AS snapshotId,
         e.project_id AS projectId,
         e.document_id AS documentId,
         e.point AS point,
         e.quote_start AS quoteStart,
         r.body AS body
    FROM author_evidence e
    LEFT JOIN revisions r ON r.revision_id = e.revision_id
   ORDER BY e.document_id, e.quote_start, e.snapshot_id;
`;

const SAMPLE_LIMIT = 20;

function safeInt(value) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Builds the review report without writing anything. */
export function buildPointReport(db, options = {}) {
  const rows = db.prepare(SELECT_ROWS).all();
  const samples = [];
  let changed = 0;
  let missingRevision = 0;
  let recomputable = 0;

  for (const row of rows) {
    const quoteStart = safeInt(row.quoteStart);
    const stored = safeInt(row.point);
    if (typeof row.body !== "string" || quoteStart === null || stored === null) {
      missingRevision += 1;
      continue;
    }
    recomputable += 1;
    const next = pointAtOffset(row.body, quoteStart);
    if (next === stored) continue;
    changed += 1;
    if (samples.length < (options.sampleLimit ?? SAMPLE_LIMIT)) {
      samples.push({
        snapshotId: row.snapshotId,
        projectId: row.projectId,
        documentId: row.documentId,
        quoteStart,
        from: stored,
        to: next,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totalEvidence: rows.length,
    recomputable,
    missingRevision,
    changed,
    unchanged: recomputable - changed,
    samples,
  };
}

/** Applies the stored report rows in one transaction; returns rows updated. */
export function applyPointBackfill(db, samples) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const update = db.prepare("UPDATE author_evidence SET point = ? WHERE snapshot_id = ? AND point = ?;");
  let updated = 0;
  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const row of samples) {
      const result = update.run(row.to, row.snapshotId, row.from);
      updated += Number(result.changes ?? 0);
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  return updated;
}

/** Recomputes every drifted row in one pass, ignoring the sample cap. */
export function backfillAll(db) {
  const rows = db.prepare(SELECT_ROWS).all();
  const changes = [];
  for (const row of rows) {
    const quoteStart = safeInt(row.quoteStart);
    const stored = safeInt(row.point);
    if (typeof row.body !== "string" || quoteStart === null || stored === null) continue;
    const next = pointAtOffset(row.body, quoteStart);
    if (next !== stored) changes.push({ snapshotId: row.snapshotId, from: stored, to: next });
  }
  return { changes, updated: applyPointBackfill(db, changes) };
}

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--db") args.db = argv[++i];
    else if (arg === "--report") args.report = argv[++i];
    else if (arg === "--backup-dir") args.backupDir = argv[++i];
  }
  return args;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db) {
    console.error("usage: node scripts/evidence-point-migrate.mjs --db <workspace.sqlite> [--report <file>] [--apply] [--backup-dir <dir>]");
    process.exitCode = 1;
    return;
  }
  const dbPath = resolve(args.db);
  if (!existsSync(dbPath)) {
    console.error(`database not found: ${dbPath}`);
    process.exitCode = 1;
    return;
  }

  const reportPath = resolve(args.report ?? "point-report.json");
  const readOnly = !args.apply;
  const db = openDatabase(dbPath, { readOnly });
  try {
    const report = buildPointReport(db);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify({ database: dbPath, ...report }, null, 2)}\n`, "utf8");

    console.log(`evidence rows: ${report.totalEvidence} (recomputable ${report.recomputable}, missing revision ${report.missingRevision})`);
    console.log(`point changes: ${report.changed}`);
    console.log(`report written: ${reportPath}`);

    if (!args.apply) {
      if (report.changed > 0) console.log("dry run only; re-run with --apply after reviewing the report");
      return;
    }
    if (report.changed === 0) {
      console.log("nothing to apply");
      return;
    }

    const backupDir = resolve(args.backupDir ?? join(dirname(dbPath), "backups", `evidence-point-${timestampSlug()}`));
    await createHotBackup(db, backupDir);
    console.log(`hot backup: ${backupDir}`);

    const { updated } = backfillAll(db);
    const after = buildPointReport(db);
    console.log(`rows updated: ${updated}; remaining drift: ${after.changed}`);
    if (after.changed !== 0) {
      console.error("backfill did not converge; restore the backup before retrying");
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
