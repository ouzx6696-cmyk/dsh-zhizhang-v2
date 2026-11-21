import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Guards the two documents that drive all V2.3 scheduling:
//   docs/zhizhang_v2_3_full_optimization_plan.md  (appendix A.1-A.4: the 123 findings)
//   docs/zhizhang_v2_3_status.md                  (the per-item tracker)
// A mismatch here silently re-points work at the wrong finding, so the ID set,
// per-module counts and the overview table are asserted rather than trusted.

const ROOT = new URL("../", import.meta.url);
const PLAN = readFileSync(new URL("docs/zhizhang_v2_3_full_optimization_plan.md", ROOT), "utf8");
const STATUS = readFileSync(new URL("docs/zhizhang_v2_3_status.md", ROOT), "utf8");

const MODULES = ["FE", "DSH", "DB", "FQ"];
const EXPECTED_TOTAL = { FE: 34, DSH: 28, DB: 27, FQ: 34 };
const STATUS_MARKS = new Set(["✅", "⚠️", "❌"]);

/** Splits a markdown table row into trimmed cells, keeping empties out. */
function cells(line) {
  // A literal pipe inside a cell is escaped as `\|`; protect it before splitting.
  const shielded = line.replace(/\\\|/g, "\u0000");
  const parts = shielded.split("|");
  if (parts.length < 2) return [];
  return parts
    .slice(1, -1)
    .map((cell) => cell.replace(/\u0000/g, "|").trim());
}

/** Extracts "| FE-01 | ... |" style ids from a markdown table. */
function idsFromTable(text) {
  const ids = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const first = cells(line)[0] ?? "";
    if (/^(?:FE|DSH|DB|FQ)-\d{2}$/.test(first)) ids.push(first);
  }
  return ids;
}

/**
 * Detail rows in the tracker carry exactly four cells (id, phase, mark, text).
 * The P0 summary table has three, so the arity check keeps it out of scope —
 * it gets its own dedicated guard below instead of being ignored entirely.
 */
function detailRows(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const row = cells(line);
    if (row.length !== 4) continue;
    if (!/^(?:FE|DSH|DB|FQ)-\d{2}$/.test(row[0])) continue;
    rows.push({ id: row[0], phase: row[1], mark: row[2], text: row[3] });
  }
  return rows;
}

function groupOf(id) {
  return id.slice(0, id.lastIndexOf("-"));
}

test("the tracker covers exactly the 123 findings in the plan appendix", () => {
  const planned = idsFromTable(PLAN);
  const tracked = detailRows(STATUS).map((row) => row.id);

  assert.equal(new Set(planned).size, planned.length, "appendix contains duplicate ids");
  assert.equal(new Set(tracked).size, tracked.length, "tracker contains duplicate rows");
  assert.equal(planned.length, 123, "appendix must list 123 findings");
  assert.deepEqual(
    [...tracked].sort(),
    [...planned].sort(),
    "tracker ids must equal appendix ids",
  );
});

test("each module keeps its planned item count", () => {
  const tracked = detailRows(STATUS);
  for (const module of MODULES) {
    const count = tracked.filter((row) => groupOf(row.id) === module).length;
    assert.equal(count, EXPECTED_TOTAL[module], `${module} row count drifted`);
  }
  assert.equal(tracked.length, 123);
});

test("every tracker row uses one of the three allowed status marks", () => {
  for (const row of detailRows(STATUS)) {
    assert.ok(STATUS_MARKS.has(row.mark), `${row.id} has an unknown status mark: ${row.mark}`);
    assert.ok(row.text.length > 0, `${row.id} has an empty description`);
    assert.match(row.phase, /^P\d$/, `${row.id} has an unexpected phase: ${row.phase}`);
  }
});

test("the overview table agrees with the detail rows it summarises", () => {
  const tracked = detailRows(STATUS);
  const expected = new Map(
    MODULES.map((module) => {
      const rows = tracked.filter((row) => groupOf(row.id) === module);
      return [module, {
        ok: rows.filter((row) => row.mark === "✅").length,
        warn: rows.filter((row) => row.mark === "⚠️").length,
        missing: rows.filter((row) => row.mark === "❌").length,
        total: rows.length,
      }];
    }),
  );

  const overview = new Map();
  for (const line of STATUS.split("\n")) {
    if (!line.startsWith("|")) continue;
    const row = cells(line);
    if (row.length !== 5) continue;
    const module = MODULES.find((name) => row[0].includes(`（${name}）`));
    if (!module) continue;
    const [ok, warn, missing, total] = row.slice(1).map((value) => Number(value));
    overview.set(module, { ok, warn, missing, total });
  }

  for (const module of MODULES) {
    assert.deepEqual(overview.get(module), expected.get(module), `${module} overview drifted`);
  }

  const totals = [...expected.values()].reduce(
    (acc, row) => ({
      ok: acc.ok + row.ok,
      warn: acc.warn + row.warn,
      missing: acc.missing + row.missing,
      total: acc.total + row.total,
    }),
    { ok: 0, warn: 0, missing: 0, total: 0 },
  );
  assert.equal(totals.total, 123);
  assert.equal(totals.ok + totals.warn + totals.missing, 123);
});

test("the P0 summary table is complete, all-green, and agrees with detail rows", () => {
  const section = (STATUS.split("## 2. P0 专项")[1] ?? "").split("\n---")[0];
  const rows = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const row = cells(line);
    if (row.length !== 3) continue;
    if (!/^(?:FE|DSH|DB|FQ)-\d{2}$/.test(row[0])) continue;
    rows.push({ id: row[0], mark: row[1], text: row[2] });
  }

  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, "P0 table has duplicate ids");
  assert.equal(rows.length, 24, "P0 must cover exactly 24 findings");
  for (const row of rows) {
    assert.equal(row.mark, "✅", `${row.id} is not closed in the P0 table`);
    assert.ok(row.text.length > 0, `${row.id} has an empty description`);
  }

  const headline = STATUS.match(/## 2\. P0 专项（24 条，(\d+) ✅ \/ (\d+) ⚠️ \/ (\d+) ❌）/);
  assert.ok(headline, "the P0 headline must state its counts");
  assert.deepEqual(
    [Number(headline[1]), Number(headline[2]), Number(headline[3])],
    [24, 0, 0],
    "the P0 headline counts must match the table",
  );

  const detail = new Map(detailRows(STATUS).map((row) => [row.id, row]));
  for (const row of rows) {
    assert.equal(detail.get(row.id)?.mark, "✅", `${row.id} disagrees between the P0 table and detail rows`);
    assert.equal(detail.get(row.id)?.phase, "P0", `${row.id} is not a P0 item`);
  }
});
