import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { openAuthorWorkspace } from "../src/application/author-workspace.ts";
import {
  appendRevision,
  createProjectionSchema,
  createStore,
  executeCommand,
  openDatabase,
  openStore,
  optimizeFts,
  searchWorkspaceFts,
  SORT_KEY_STEP,
  withReadTx,
  withWriteTx,
} from "../src/storage/index.ts";
import { createAuthorModelReader } from "../src/workflow/author-reads.ts";

/** Performance gates for 5,000-chapter scale verification. */
export const DB_BENCH_GATES = {
  navigationColdMs: 300,
  navigationHotMs: 5,
  fts3CharMs: 50,
  fts2CharMs: 80,
  draftSaveP95Ms: 80,
  journal100SavesBytes: 100 * 1024,
};

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Runs the 5,000-chapter / 50,000-event Zhizhang 3.0 database scale benchmark.
 */
export function runDbBench(options = {}) {
  const chapters = options.chapters ?? 5000;
  const totalEvents = Math.max(chapters + 10, options.events ?? 50_000);
  const bodyChars = options.bodyChars ?? 2500;
  const useFile = options.useFile ?? true;

  let tempDir = null;
  let db = null;
  const tSetup0 = performance.now();

  try {
    if (useFile) {
      tempDir = mkdtempSync(join(tmpdir(), "zhizhang-db-bench-"));
      const dbPath = join(tempDir, "bench.sqlite");
      createStore(dbPath);
      db = openStore(dbPath);
    } else {
      db = openDatabase(":memory:");
    }

    createProjectionSchema(db);
    openAuthorWorkspace(db);

    const projectId = "bench-project-1";
    const baseSentence = "夜风吹过长廊，灯火明灭之间，旧档案柜的铜锁泛出微弱寒光。";
    const repeatCount = Math.max(1, Math.ceil(bodyChars / baseSentence.length));
    const standardBody = baseSentence.repeat(repeatCount).slice(0, bodyChars);
    const hit3Body = `${standardBody.slice(0, bodyChars - 24)}青铜罗盘在掌心微微震颤。`;
    const hit2Body = `${standardBody.slice(0, bodyChars - 24)}沈青停步回望黑影深处。`;

    const now = Date.now();

    withWriteTx(db, () => {
      db.prepare("INSERT INTO author_projects (id, name, product, created_at) VALUES (?, ?, 'fanqie', ?);").run(
        projectId,
        "五千章规模基准书",
        now,
      );

      const insVol = db.prepare(
        "INSERT INTO author_volumes (id, project_id, title, sort_order, created_at) VALUES (?, ?, ?, ?, ?);",
      );
      const insAct = db.prepare(
        "INSERT INTO author_acts (id, project_id, volume_id, title, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?);",
      );
      const volumeCount = 5;
      const actsPerVol = 5;
      for (let v = 0; v < volumeCount; v += 1) {
        insVol.run(`vol-${v}`, projectId, `第${v + 1}卷`, v, now);
        for (let a = 0; a < actsPerVol; a += 1) {
          insAct.run(`act-${v}-${a}`, projectId, `vol-${v}`, `第${a + 1}幕`, a, now);
        }
      }

      const insDoc = db.prepare("INSERT INTO documents (document_id, current_revision_id) VALUES (?, ?);");
      const insRev = db.prepare("INSERT INTO revisions (revision_id, document_id, body, created_at) VALUES (?, ?, ?, ?);");
      const insAdoc = db.prepare(`
        INSERT INTO author_documents
          (id, project_id, title, state, volume_id, act_id, char_count, summary, sort_key, updated_at)
        VALUES (?, ?, ?, 'drafted', ?, ?, ?, ?, ?, ?);
      `);
      const insMap = db.prepare(`
        INSERT INTO fts_rowid_map (scope, project_id, entity_key, item_scope, indexed)
        VALUES ('chapter', ?, ?, 'project', 1);
      `);
      const insEntity = db.prepare(`
        INSERT INTO author_chapter_entities (document_id, project_id, fact_id, entity_name, category, mention_count)
        VALUES (?, ?, 'fact-shenqing', '沈青', 'character', ?);
      `);

      const hit3Count = Math.min(chapters, 1000);
      const hit2Count = Math.min(chapters, 50);

      for (let i = 0; i < chapters; i += 1) {
        const docId = `ch-${i}`;
        const revId = `rev-${i}-0`;
        const volIdx = i % volumeCount;
        const actIdx = Math.floor(i / volumeCount) % actsPerVol;
        const body = i < hit2Count ? hit2Body : i < hit3Count ? hit3Body : standardBody;
        insDoc.run(docId, revId);
        insRev.run(revId, docId, body, now - (chapters - i) * 1000);
        insAdoc.run(
          docId,
          projectId,
          `第${i + 1}章`,
          `vol-${volIdx}`,
          `act-${volIdx}-${actIdx}`,
          body.length,
          `第${i + 1}章剧情摘要`,
          (i + 1) * SORT_KEY_STEP,
          now,
        );
        insMap.run(projectId, docId);
        if (i < hit2Count) {
          insEntity.run(docId, projectId, hit2Count - i);
        }
      }

      // Build FTS5 index once and optimize b-tree segments.
      db.exec("INSERT INTO fts_chapters(fts_chapters) VALUES('rebuild');");
      optimizeFts(db);

      // Seed 50,000 contiguous events in event_log.
      const insEvent = db.prepare(`
        INSERT INTO event_log (project_id, seq, event_id, kind, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?);
      `);
      let seq = 0;
      insEvent.run(
        projectId,
        ++seq,
        `ev-${seq}`,
        "project.created",
        JSON.stringify({ concern: "chapter", name: "五千章规模基准书" }),
        now,
      );
      for (let v = 0; v < volumeCount; v += 1) {
        insEvent.run(
          projectId,
          ++seq,
          `ev-${seq}`,
          "volume.created",
          JSON.stringify({ concern: "chapter", volumeId: `vol-${v}`, title: `第${v + 1}卷` }),
          now,
        );
      }
      for (let i = 0; i < chapters; i += 1) {
        const volIdx = i % volumeCount;
        insEvent.run(
          projectId,
          ++seq,
          `ev-${seq}`,
          "document.created",
          JSON.stringify({
            concern: "chapter",
            documentId: `ch-${i}`,
            title: `第${i + 1}章`,
            state: "drafted",
            volumeId: `vol-${volIdx}`,
          }),
          now,
        );
      }
      while (seq < totalEvents) {
        const idx = seq % chapters;
        const kind = seq % 5 === 0 ? "document.state" : "revision.saved";
        const payload =
          kind === "document.state"
            ? JSON.stringify({ concern: "chapter", documentId: `ch-${idx}`, state: "drafted" })
            : JSON.stringify({ concern: "revision", documentId: `ch-${idx}`, revisionId: `rev-${idx}-${seq}` });
        insEvent.run(projectId, ++seq, `ev-${seq}`, kind, payload, now);
      }
    });

    db.exec("ANALYZE;");
    const setupMs = roundMs(performance.now() - tSetup0);

    // 1. Navigation cold read (5,000 chapters, 50,000 events)
    let writeTxCount = 0;
    const reader = createAuthorModelReader(db, {
      read: (fn) => withReadTx(db, fn),
      atomic: (fn) => {
        writeTxCount += 1;
        return withWriteTx(db, fn);
      },
    });

    const tCold0 = performance.now();
    const coldNav = reader(projectId, { model: "navigation" });
    const navigationColdMs = roundMs(performance.now() - tCold0);
    const coldChapterCount = coldNav.value.volumes.reduce((sum, vol) => sum + vol.chapters.length, 0);

    // 2. Navigation hot read (0 new events -> must open 0 write transactions & < 5ms)
    const writeTxBeforeHot = writeTxCount;
    const hotSamples = [];
    for (let i = 0; i < 11; i += 1) {
      const t0 = performance.now();
      const hotNav = reader(projectId, { model: "navigation" });
      hotSamples.push(performance.now() - t0);
      if (hotNav.folded !== 0) {
        throw new Error(`Expected 0 folded events on hot read, got ${hotNav.folded}`);
      }
    }
    hotSamples.sort((a, b) => a - b);
    const navigationHotMs = roundMs(percentile(hotSamples, 50));
    const hotWriteTxCount = writeTxCount - writeTxBeforeHot;

    // 3. FTS5 3-char search ("青铜罗盘", matching ~1,000 of 5,000 chapters)
    const fts3Samples = [];
    let fts3Hits = 0;
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      const hits = searchWorkspaceFts(db, { projectId, query: "青铜罗盘", scopes: ["chapter"], limit: 30 });
      fts3Samples.push(performance.now() - t0);
      fts3Hits = hits.length;
    }
    fts3Samples.sort((a, b) => a - b);
    const fts3CharMs = roundMs(percentile(fts3Samples, 50));

    // 4. FTS 2-char CJK search ("沈青", entity fast path)
    const fts2Samples = [];
    let fts2Hits = 0;
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      const hits = searchWorkspaceFts(db, { projectId, query: "沈青", scopes: ["chapter"], limit: 30 });
      fts2Samples.push(performance.now() - t0);
      fts2Hits = hits.length;
    }
    fts2Samples.sort((a, b) => a - b);
    const fts2CharMs = roundMs(percentile(fts2Samples, 50));

    // 5. 100 x draft.save via executeCommand -> p95 latency & command_journal size
    const saveSamples = [];
    let currentRev = "rev-0-0";
    for (let i = 0; i < 100; i += 1) {
      const nextBody = `${standardBody.slice(0, bodyChars - 16)}第${i}次修订。`;
      const nextRevId = `bench-save-${i}`;
      const t0 = performance.now();
      const outcome = executeCommand(
        db,
        {
          commandId: "draft.save",
          actor: "author",
          documentId: "ch-0",
          baseRevisionId: currentRev,
          payload: { documentId: "ch-0", baseRevisionId: currentRev, body: nextBody },
        },
        () => appendRevision(db, { revisionId: nextRevId, documentId: "ch-0", body: nextBody, createdAt: Date.now() }),
      );
      saveSamples.push(performance.now() - t0);
      if (!outcome.ok) {
        throw new Error(`draft.save failed at ${i}: ${outcome.code}`);
      }
      currentRev = nextRevId;
    }
    saveSamples.sort((a, b) => a - b);
    const draftSaveP50Ms = roundMs(percentile(saveSamples, 50));
    const draftSaveP95Ms = roundMs(percentile(saveSamples, 95));

    const journalRow = db
      .prepare(`
        SELECT
          COUNT(*) AS rows,
          COALESCE(SUM(
            length(CAST(actor_id AS BLOB)) +
            length(CAST(command_id AS BLOB)) +
            length(CAST(document_id AS BLOB)) +
            length(CAST(request_key AS BLOB)) +
            length(CAST(request_payload AS BLOB)) +
            length(CAST(request_hash AS BLOB)) +
            length(CAST(result_payload AS BLOB))
          ), 0) AS totalBytes
        FROM command_journal;
      `)
      .get();
    const journal100SavesBytes = Number(journalRow?.totalBytes ?? 0);

    const metrics = {
      setupMs,
      chapters: coldChapterCount,
      events: totalEvents,
      navigationColdMs,
      navigationHotMs,
      hotWriteTxCount,
      fts3CharMs,
      fts3Hits,
      fts2CharMs,
      fts2Hits,
      draftSaveP50Ms,
      draftSaveP95Ms,
      journal100SavesRows: Number(journalRow?.rows ?? 0),
      journal100SavesBytes,
    };

    const gateResults = {
      navigationColdMs: navigationColdMs < DB_BENCH_GATES.navigationColdMs,
      navigationHotMs: navigationHotMs < DB_BENCH_GATES.navigationHotMs,
      hotZeroWriteTx: hotWriteTxCount === 0,
      fts3CharMs: fts3CharMs < DB_BENCH_GATES.fts3CharMs,
      fts2CharMs: fts2CharMs < DB_BENCH_GATES.fts2CharMs,
      draftSaveP95Ms: draftSaveP95Ms < DB_BENCH_GATES.draftSaveP95Ms,
      journal100SavesBytes: journal100SavesBytes < DB_BENCH_GATES.journal100SavesBytes,
    };

    return {
      config: { chapters, events: totalEvents, bodyChars, useFile },
      metrics,
      gates: DB_BENCH_GATES,
      gateResults,
      passed: Object.values(gateResults).every(Boolean),
    };
  } finally {
    db?.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const parseNum = (prefix, fallback) => {
    const found = args.find((a) => a.startsWith(prefix));
    if (!found) return fallback;
    const n = Number(found.slice(prefix.length));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const result = runDbBench({
    chapters: parseNum("--chapters=", 5000),
    events: parseNum("--events=", 50_000),
    bodyChars: parseNum("--body-chars=", 2500),
    useFile: !args.includes("--memory"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (args.includes("--strict") && !result.passed) {
    process.exitCode = 1;
  }
}
