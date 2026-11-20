import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./driver.ts";
import { runMigrations, type SchemaMigration } from "./migrations.ts";
import { SCHEMA_ID, SCHEMA_USER_VERSION } from "./schema.ts";

/** Default fractional-index gap between adjacent chapters (`author_documents.sort_key`). */
export const SORT_KEY_STEP = 1024;

/**
 * Computes a fractional `sort_key` strictly between `before` and `after` so
 * moving a chapter updates only 1 row in `author_documents` (DB-11).
 */
export function computeSortKeyBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return SORT_KEY_STEP;
  if (before === null) return (after as number) - SORT_KEY_STEP;
  if (after === null) return before + SORT_KEY_STEP;
  return (before + after) / 2;
}

const VALID_CONCERNS = new Set([
  "chapter",
  "revision",
  "candidate",
  "setting",
  "evidence",
  "run",
  "approval",
]);

/** Infers the frozen read-model concern from a committed event's `kind` (DB-19). */
export function inferEventConcern(kind: string): string | null {
  if (
    kind.startsWith("project.") ||
    kind.startsWith("document.") ||
    kind.startsWith("chapter.") ||
    kind.startsWith("volume.") ||
    kind.startsWith("act.") ||
    kind.startsWith("library.") ||
    kind.startsWith("foreshadow.") ||
    kind.startsWith("controls.")
  ) {
    return "chapter";
  }
  if (kind.startsWith("revision.")) return "revision";
  if (kind.startsWith("candidate.")) return "candidate";
  if (kind.startsWith("setting.") || kind.startsWith("proposal.") || kind.startsWith("lore.")) {
    return "setting";
  }
  if (kind.startsWith("evidence.") || kind.startsWith("article.") || kind.startsWith("observation.")) {
    return "evidence";
  }
  if (kind.startsWith("run.") || kind.startsWith("generation.")) return "run";
  if (kind.startsWith("approval.") || kind.startsWith("delivery.")) return "approval";
  return null;
}

export interface EventLogConcernAudit {
  readonly total: number;
  readonly valid: number;
  readonly missingConcern: number;
  readonly invalidConcern: number;
  readonly quarantined: number;
}

/** Read-only startup/diagnostics audit of `event_log` concern integrity (DB-19). */
export function auditEventLogConcerns(db: SqliteDatabase): EventLogConcernAudit {
  if (!hasObject(db, "table", "event_log")) {
    return { total: 0, valid: 0, missingConcern: 0, invalidConcern: 0, quarantined: 0 };
  }
  const rows = db.prepare("SELECT payload FROM event_log;").all() as readonly { payload?: unknown }[];
  let valid = 0;
  let missingConcern = 0;
  let invalidConcern = 0;
  for (const row of rows) {
    if (typeof row.payload !== "string") {
      invalidConcern += 1;
      continue;
    }
    try {
      const parsed = JSON.parse(row.payload) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        invalidConcern += 1;
        continue;
      }
      const concern = parsed.concern;
      if (concern === undefined || concern === null || concern === "") {
        missingConcern += 1;
      } else if (typeof concern === "string" && VALID_CONCERNS.has(concern)) {
        valid += 1;
      } else {
        invalidConcern += 1;
      }
    } catch {
      invalidConcern += 1;
    }
  }
  let quarantined = 0;
  if (hasObject(db, "table", "event_log_quarantine")) {
    const q = db.prepare("SELECT COUNT(*) AS count FROM event_log_quarantine;").get() as { count?: number } | undefined;
    quarantined = q?.count ?? 0;
  }
  return {
    total: rows.length,
    valid,
    missingConcern,
    invalidConcern,
    quarantined,
  };
}

function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table});`).all() as readonly { name?: unknown }[];
  const cols = new Set<string>();
  for (const row of rows) {
    if (typeof row.name === "string") cols.add(row.name);
  }
  return cols;
}

function hasObject(db: SqliteDatabase, type: "table" | "index", name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?;").get(type, name),
  );
}

const AUTHOR_MIGRATIONS: readonly SchemaMigration[] = [
  {
    id: "2.1.0-legacy-reports-table",
    up(db) {
      const droppedLegacyReportsIndex = hasObject(db, "index", "author_article_reports");
      if (!droppedLegacyReportsIndex) return;
      db.exec("DROP INDEX IF EXISTS author_article_reports;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS author_article_reports (
          id INTEGER PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          document_id TEXT NOT NULL REFERENCES author_documents(id),
          revision_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      if (hasObject(db, "table", "event_log")) {
        const existingCount = db.prepare("SELECT COUNT(*) AS count FROM author_article_reports;").get() as {
          count?: number;
        };
        if ((existingCount?.count ?? 0) === 0) {
          db.exec(`
            INSERT INTO author_article_reports (project_id, document_id, revision_id, kind, payload, created_at)
            SELECT project_id,
                   COALESCE(json_extract(payload, '$.documentId'), ''),
                   COALESCE(json_extract(payload, '$.revisionId'), ''),
                   kind,
                   payload,
                   seq
            FROM event_log
            WHERE kind IN ('article.qa', 'article.rejected')
            ORDER BY seq ASC;
          `);
        }
      }
    },
  },
  {
    id: "2.1.0-author-tables-and-backfill",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS author_projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          product TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS author_documents (
          id TEXT PRIMARY KEY REFERENCES documents(document_id),
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          title TEXT NOT NULL,
          state TEXT NOT NULL,
          mode TEXT,
          line TEXT,
          final_revision_id TEXT,
          editorial_rejections INTEGER NOT NULL DEFAULT 0,
          qa_rounds INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS author_runs (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES author_documents(id),
          state TEXT NOT NULL,
          base_revision_id TEXT NOT NULL,
          frozen_input TEXT NOT NULL,
          reserved INTEGER NOT NULL,
          settled INTEGER NOT NULL DEFAULT 0,
          candidate_id TEXT,
          late_usage_settled INTEGER NOT NULL DEFAULT 0,
          context_trace TEXT,
          recovery_hints TEXT
        );
        CREATE TABLE IF NOT EXISTS author_planning (
          document_id TEXT PRIMARY KEY REFERENCES author_documents(id),
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS author_run_refinement_claims (
          run_id TEXT PRIMARY KEY REFERENCES author_runs(id),
          rounds INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS author_candidate_qa (
          candidate_id TEXT PRIMARY KEY REFERENCES candidates(candidate_id),
          report TEXT NOT NULL,
          rounds INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS author_article_reports (
          id INTEGER PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          document_id TEXT NOT NULL REFERENCES author_documents(id),
          revision_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS author_evidence (
          snapshot_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          document_id TEXT NOT NULL REFERENCES author_documents(id),
          fact_id TEXT NOT NULL,
          revision_id TEXT NOT NULL,
          point INTEGER NOT NULL,
          quote_start INTEGER NOT NULL,
          quote_end INTEGER NOT NULL,
          verification_kind TEXT NOT NULL,
          verification_score INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS author_approvals (
          document_id TEXT NOT NULL REFERENCES author_documents(id),
          revision_id TEXT NOT NULL,
          at TEXT NOT NULL,
          PRIMARY KEY (document_id, revision_id)
        );
        CREATE TABLE IF NOT EXISTS author_chapter_order (
          project_id TEXT PRIMARY KEY REFERENCES author_projects(id),
          chapter_ids TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS author_settings (
          sequence INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          fact_id TEXT NOT NULL,
          value TEXT NOT NULL,
          decision TEXT NOT NULL DEFAULT 'pending',
          decided_seq INTEGER
        );
        CREATE TABLE IF NOT EXISTS author_read_checkpoints (
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          cache_key TEXT NOT NULL,
          version INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          state TEXT NOT NULL,
          PRIMARY KEY (project_id, cache_key)
        );
        CREATE TABLE IF NOT EXISTS author_volumes (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          title TEXT NOT NULL,
          goal TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS author_acts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          volume_id TEXT NOT NULL REFERENCES author_volumes(id),
          title TEXT NOT NULL,
          goal TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS author_lore_current (
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          fact_id TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'world_rule',
          entity_name TEXT NOT NULL DEFAULT '',
          latest_setting_id TEXT NOT NULL,
          locked INTEGER NOT NULL DEFAULT 0,
          value TEXT NOT NULL,
          decided_seq INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (project_id, fact_id)
        );
        CREATE TABLE IF NOT EXISTS author_foreshadows (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          fact_id TEXT,
          title TEXT NOT NULL,
          planted_chapter_id TEXT,
          planted_point INTEGER NOT NULL DEFAULT 1,
          target_chapter_id TEXT,
          resolved_chapter_id TEXT,
          status TEXT NOT NULL DEFAULT 'planted',
          note TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS library_deconstructions (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          project_id TEXT,
          override_of_id TEXT,
          title TEXT NOT NULL,
          source_book TEXT NOT NULL DEFAULT '',
          genre TEXT NOT NULL DEFAULT '',
          pacing TEXT NOT NULL DEFAULT '',
          tags_json TEXT NOT NULL DEFAULT '[]',
          excerpt TEXT NOT NULL,
          hook_analysis TEXT NOT NULL DEFAULT '',
          conflict_beats TEXT NOT NULL DEFAULT '',
          payoff_rhythm TEXT NOT NULL DEFAULT '',
          prose_notes TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'approved',
          source_kind TEXT NOT NULL DEFAULT 'manual',
          created_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS library_technique_cards (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          project_id TEXT,
          override_of_id TEXT,
          title TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'narrative',
          pacing TEXT NOT NULL DEFAULT '',
          scene_tags_json TEXT NOT NULL DEFAULT '[]',
          trigger_when TEXT NOT NULL DEFAULT '',
          execution_steps TEXT NOT NULL DEFAULT '',
          constraints TEXT NOT NULL DEFAULT '',
          anti_patterns TEXT NOT NULL DEFAULT '',
          example_excerpt TEXT NOT NULL DEFAULT '',
          priority INTEGER NOT NULL DEFAULT 50,
          status TEXT NOT NULL DEFAULT 'approved',
          source_kind TEXT NOT NULL DEFAULT 'manual',
          created_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS author_library_mounts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          item_kind TEXT NOT NULL,
          item_id TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'include',
          weight INTEGER NOT NULL DEFAULT 100,
          note TEXT NOT NULL DEFAULT '',
          UNIQUE(project_id, target_type, target_id, item_kind, item_id)
        );
        CREATE TABLE IF NOT EXISTS author_ai_proposals (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          document_id TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          source_ref TEXT NOT NULL DEFAULT '',
          payload TEXT NOT NULL DEFAULT '{}',
          provider TEXT,
          model TEXT,
          reserved INTEGER NOT NULL DEFAULT 0,
          settled INTEGER NOT NULL DEFAULT 0,
          usage TEXT NOT NULL DEFAULT '[]',
          error TEXT,
          created_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
      `);

      const hasEventLog = hasObject(db, "table", "event_log");
      const docCols = tableColumns(db, "author_documents");
      if (!docCols.has("volume_id")) db.exec("ALTER TABLE author_documents ADD COLUMN volume_id TEXT;");
      if (!docCols.has("act_id")) db.exec("ALTER TABLE author_documents ADD COLUMN act_id TEXT;");
      if (!docCols.has("char_count")) db.exec("ALTER TABLE author_documents ADD COLUMN char_count INTEGER NOT NULL DEFAULT 0;");
      if (!docCols.has("summary")) db.exec("ALTER TABLE author_documents ADD COLUMN summary TEXT NOT NULL DEFAULT '';");
      if (!docCols.has("updated_at")) db.exec("ALTER TABLE author_documents ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;");

      const settingCols = tableColumns(db, "author_settings");
      if (!settingCols.has("category")) db.exec("ALTER TABLE author_settings ADD COLUMN category TEXT NOT NULL DEFAULT 'world_rule';");
      if (!settingCols.has("entity_name")) db.exec("ALTER TABLE author_settings ADD COLUMN entity_name TEXT NOT NULL DEFAULT '';");

      if (!tableColumns(db, "author_projects").has("created_at")) {
        db.exec("ALTER TABLE author_projects ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;");
      }

      if (!tableColumns(db, "author_runs").has("late_usage_settled")) {
        db.exec("ALTER TABLE author_runs ADD COLUMN late_usage_settled INTEGER NOT NULL DEFAULT 0;");
        db.exec("UPDATE author_runs SET late_usage_settled = 1, candidate_id = NULL WHERE state = 'cancelled' AND candidate_id = '';");
        if (hasEventLog) {
          db.exec(`
            UPDATE author_runs
            SET late_usage_settled = 1
            WHERE state = 'cancelled'
              AND id IN (SELECT json_extract(payload, '$.runId') FROM event_log WHERE kind = 'run.usage.late');
          `);
        }
      }

      if (!tableColumns(db, "author_settings").has("decided_seq")) {
        db.exec("ALTER TABLE author_settings ADD COLUMN decided_seq INTEGER;");
        if (hasEventLog) {
          db.exec(`
            UPDATE author_settings
            SET decided_seq = (
              SELECT MAX(seq) FROM event_log
              WHERE event_log.project_id = author_settings.project_id
                AND event_log.kind = 'setting.decided'
                AND json_extract(event_log.payload, '$.id') = author_settings.id
            )
            WHERE decision != 'pending' AND decided_seq IS NULL;
          `);
        }
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS author_documents_by_project ON author_documents(project_id);
        CREATE INDEX IF NOT EXISTS author_documents_by_tree ON author_documents(project_id, volume_id, act_id);
        CREATE INDEX IF NOT EXISTS author_volumes_by_project ON author_volumes(project_id, sort_order);
        CREATE INDEX IF NOT EXISTS author_acts_by_volume ON author_acts(project_id, volume_id, sort_order);
        CREATE INDEX IF NOT EXISTS author_runs_by_document ON author_runs(document_id);
        CREATE INDEX IF NOT EXISTS author_settings_by_project ON author_settings(project_id);
        CREATE INDEX IF NOT EXISTS author_settings_approved_order
          ON author_settings(project_id, decided_seq) WHERE decision = 'approved';
        CREATE INDEX IF NOT EXISTS author_lore_current_by_cat ON author_lore_current(project_id, category, decided_seq);
        CREATE INDEX IF NOT EXISTS author_foreshadows_by_project ON author_foreshadows(project_id, status);
        CREATE INDEX IF NOT EXISTS library_deconstructions_scope ON library_deconstructions(scope, project_id, status);
        CREATE INDEX IF NOT EXISTS library_techniques_scope ON library_technique_cards(scope, project_id, status, priority DESC);
        CREATE INDEX IF NOT EXISTS author_library_mounts_lookup ON author_library_mounts(project_id, target_type, target_id);
        CREATE INDEX IF NOT EXISTS author_ai_proposals_status ON author_ai_proposals(project_id, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS author_reports_by_revision
          ON author_article_reports(project_id, revision_id, id DESC);
        CREATE INDEX IF NOT EXISTS author_evidence_by_fact
          ON author_evidence(project_id, fact_id);
      `);

      const loreCount = db.prepare("SELECT COUNT(*) AS count FROM author_lore_current;").get() as { count?: number };
      if ((loreCount?.count ?? 0) === 0) {
        const approvedRows = db.prepare(`
          SELECT project_id, fact_id, category, entity_name, id, value, COALESCE(decided_seq, 0) AS decided_seq
          FROM author_settings
          WHERE decision = 'approved'
          ORDER BY project_id ASC, COALESCE(decided_seq, 0) DESC, sequence DESC;
        `).all() as readonly {
          project_id: string;
          fact_id: string;
          category: string;
          entity_name: string;
          id: string;
          value: string;
          decided_seq: number;
        }[];
        const seen = new Set<string>();
        const upsertLore = db.prepare(`
          INSERT OR IGNORE INTO author_lore_current
            (project_id, fact_id, category, entity_name, latest_setting_id, locked, value, decided_seq)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `);
        for (const row of approvedRows) {
          const composite = `${row.project_id}\0${row.fact_id}`;
          if (seen.has(composite)) continue;
          seen.add(composite);
          let locked = 0;
          let category = row.category;
          try {
            const parsed = JSON.parse(row.value) as { locked?: boolean; kind?: string };
            locked = parsed.locked === true ? 1 : 0;
            if (parsed.kind === "agreement") category = "agreement";
          } catch {
            // Keep raw defaults on malformed legacy entries.
          }
          upsertLore.run(
            row.project_id,
            row.fact_id,
            category,
            row.entity_name,
            row.id,
            locked,
            row.value,
            row.decided_seq,
          );
        }
      }

      const uncountedDocs = db.prepare(`
        SELECT a.id, r.body, r.created_at AS createdAt
        FROM author_documents a
        JOIN documents d ON d.document_id = a.id
        JOIN revisions r ON r.revision_id = d.current_revision_id
        WHERE a.char_count = 0 AND length(r.body) > 0;
      `).all() as readonly { id: string; body: string; createdAt: number }[];
      if (uncountedDocs.length > 0) {
        const updateDoc = db.prepare(
          "UPDATE author_documents SET char_count = ?, updated_at = CASE WHEN updated_at = 0 THEN ? ELSE updated_at END WHERE id = ?;",
        );
        for (const doc of uncountedDocs) {
          const count = [...doc.body.replace(/\s/gu, "")].length;
          if (count > 0) updateDoc.run(count, doc.createdAt, doc.id);
        }
      }
    },
  },
  {
    id: "2.2.0-run-trace-and-recovery",
    up(db) {
      const runCols = tableColumns(db, "author_runs");
      if (!runCols.has("context_trace")) db.exec("ALTER TABLE author_runs ADD COLUMN context_trace TEXT;");
      if (!runCols.has("recovery_hints")) db.exec("ALTER TABLE author_runs ADD COLUMN recovery_hints TEXT;");
    },
  },
  {
    id: "2.2.0-command-journal-meta",
    up(db) {
      if (!hasObject(db, "table", "command_journal")) return;
      const journalCols = tableColumns(db, "command_journal");
      if (!journalCols.has("request_hash")) {
        db.exec("ALTER TABLE command_journal ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';");
      }
      if (!journalCols.has("created_at")) {
        db.exec("ALTER TABLE command_journal ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;");
      }
      db.exec("CREATE INDEX IF NOT EXISTS command_journal_created_at ON command_journal(created_at);");
    },
  },
  {
    id: "2.2.0-memory-sync-and-entities",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS author_chapter_memory_sync (
          document_id TEXT PRIMARY KEY REFERENCES author_documents(id),
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          current_body_sha256 TEXT NOT NULL DEFAULT '',
          synced_body_sha256 TEXT NOT NULL DEFAULT '',
          synced_body TEXT NOT NULL DEFAULT '',
          sync_status TEXT NOT NULL DEFAULT 'clean',
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS author_chapter_memory_sync_project
          ON author_chapter_memory_sync(project_id, sync_status);

        CREATE TABLE IF NOT EXISTS author_chapter_entities (
          document_id TEXT NOT NULL REFERENCES author_documents(id),
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          fact_id TEXT NOT NULL,
          entity_name TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'character',
          mention_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (document_id, fact_id)
        );
        CREATE INDEX IF NOT EXISTS author_chapter_entities_by_fact
          ON author_chapter_entities(project_id, fact_id);
        CREATE INDEX IF NOT EXISTS author_chapter_entities_by_doc
          ON author_chapter_entities(project_id, document_id);
      `);
    },
  },
  {
    id: "2.2.0-skills-diagnostics-observations",
    up(db) {
      const techCols = tableColumns(db, "library_technique_cards");
      if (!techCols.has("asset_kind")) {
        db.exec("ALTER TABLE library_technique_cards ADD COLUMN asset_kind TEXT NOT NULL DEFAULT 'technique';");
      }
      if (!techCols.has("stage_bindings_json")) {
        db.exec("ALTER TABLE library_technique_cards ADD COLUMN stage_bindings_json TEXT NOT NULL DEFAULT '[\"write\"]';");
      }
      if (!techCols.has("references_json")) {
        db.exec("ALTER TABLE library_technique_cards ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS author_project_slop_config (
          project_id TEXT PRIMARY KEY REFERENCES author_projects(id),
          custom_banned_json TEXT NOT NULL DEFAULT '[]',
          whitelist_json TEXT NOT NULL DEFAULT '[]',
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS author_chapter_observations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          document_id TEXT NOT NULL REFERENCES author_documents(id),
          revision_id TEXT,
          dimension TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'warning',
          quote TEXT NOT NULL DEFAULT '',
          suggestion TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open',
          source TEXT NOT NULL DEFAULT 'review',
          created_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS author_chapter_observations_doc
          ON author_chapter_observations(project_id, document_id, status);
      `);
    },
  },
  {
    id: "2.2.0-project-controls-and-arcs",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS author_project_controls (
          project_id TEXT PRIMARY KEY REFERENCES author_projects(id),
          author_intent TEXT NOT NULL DEFAULT '',
          current_focus TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL DEFAULT 0
        );
      `);
      const actCols = tableColumns(db, "author_acts");
      if (!actCols.has("arc_goal")) {
        db.exec("ALTER TABLE author_acts ADD COLUMN arc_goal TEXT NOT NULL DEFAULT '';");
      }
      if (!actCols.has("arc_summary")) {
        db.exec("ALTER TABLE author_acts ADD COLUMN arc_summary TEXT NOT NULL DEFAULT '';");
      }
      if (!actCols.has("pacing_template")) {
        db.exec("ALTER TABLE author_acts ADD COLUMN pacing_template TEXT NOT NULL DEFAULT '';");
      }
    },
  },
  {
    id: "2.3.0-proposals-micro-generation-origin",
    up(db) {
      const propCols = tableColumns(db, "author_ai_proposals");
      if (!propCols.has("base_revision_id")) {
        db.exec("ALTER TABLE author_ai_proposals ADD COLUMN base_revision_id TEXT;");
      }
      if (!propCols.has("source_sha256")) {
        db.exec("ALTER TABLE author_ai_proposals ADD COLUMN source_sha256 TEXT NOT NULL DEFAULT '';");
      }
      if (!propCols.has("origin")) {
        db.exec("ALTER TABLE author_ai_proposals ADD COLUMN origin TEXT NOT NULL DEFAULT 'ai-generate';");
      }
      if (!propCols.has("origin_ref")) {
        db.exec("ALTER TABLE author_ai_proposals ADD COLUMN origin_ref TEXT NOT NULL DEFAULT '';");
      }
      if (!propCols.has("error_detail")) {
        db.exec("ALTER TABLE author_ai_proposals ADD COLUMN error_detail TEXT;");
      }

      // Close any legacy duplicate inflight proposals before installing the DB-level mutex index.
      db.exec(`
        UPDATE author_ai_proposals
        SET status = 'failed', error = 'dedup-inflight-migration'
        WHERE status = 'inflight'
          AND rowid NOT IN (
            SELECT MAX(rowid)
            FROM author_ai_proposals
            WHERE status = 'inflight'
            GROUP BY kind, COALESCE(document_id, project_id, 'global')
          );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_proposal_inflight
          ON author_ai_proposals(kind, COALESCE(document_id, project_id, 'global'))
          WHERE status = 'inflight';
      `);

      const settingCols = tableColumns(db, "author_settings");
      if (!settingCols.has("origin")) {
        db.exec("ALTER TABLE author_settings ADD COLUMN origin TEXT NOT NULL DEFAULT 'author-ui';");
      }
      if (!settingCols.has("origin_ref")) {
        db.exec("ALTER TABLE author_settings ADD COLUMN origin_ref TEXT NOT NULL DEFAULT '';");
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS author_micro_calls (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES author_projects(id),
          document_id TEXT NOT NULL REFERENCES author_documents(id),
          mode TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          reserved INTEGER NOT NULL DEFAULT 0,
          settled INTEGER NOT NULL DEFAULT 0,
          usage TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(usage)),
          status TEXT NOT NULL DEFAULT 'inflight' CHECK (status IN ('inflight', 'completed', 'failed', 'uncertain')),
          created_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE INDEX IF NOT EXISTS author_micro_calls_by_project
          ON author_micro_calls(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS author_micro_calls_by_doc
          ON author_micro_calls(document_id, status);
        CREATE UNIQUE INDEX IF NOT EXISTS ux_micro_call_inflight
          ON author_micro_calls(document_id)
          WHERE status = 'inflight';
      `);

      // Bring generation ledger DDL into versioned migrations + DB-14 late_usage column.
      db.exec(`
        CREATE TABLE IF NOT EXISTS author_generation_attempts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES author_runs(id),
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          state TEXT NOT NULL,
          stage TEXT,
          usage TEXT NOT NULL,
          late_usage TEXT NOT NULL DEFAULT '[]',
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS author_generation_by_run ON author_generation_attempts(run_id);
        CREATE TABLE IF NOT EXISTS author_generation_calls (
          id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL REFERENCES author_generation_attempts(id),
          phase TEXT NOT NULL,
          input_reserve INTEGER NOT NULL,
          max_output INTEGER NOT NULL,
          usage TEXT
        );
        CREATE INDEX IF NOT EXISTS author_calls_by_attempt ON author_generation_calls(attempt_id);
      `);
      const attemptCols = tableColumns(db, "author_generation_attempts");
      if (!attemptCols.has("late_usage")) {
        db.exec("ALTER TABLE author_generation_attempts ADD COLUMN late_usage TEXT NOT NULL DEFAULT '[]';");
      }

      const cpCols = tableColumns(db, "author_read_checkpoints");
      if (!cpCols.has("last_used_at")) {
        db.exec("ALTER TABLE author_read_checkpoints ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0;");
      }
    },
  },
  {
    id: "2.3.0-document-sort-key-and-backfill",
    up(db) {
      const docCols = tableColumns(db, "author_documents");
      if (!docCols.has("sort_key")) {
        db.exec("ALTER TABLE author_documents ADD COLUMN sort_key REAL NOT NULL DEFAULT 0;");
      }

      const projectRows = db.prepare("SELECT DISTINCT project_id FROM author_documents;").all() as readonly {
        project_id: string;
      }[];
      const readOrderStmt = db.prepare("SELECT chapter_ids FROM author_chapter_order WHERE project_id = ?;");
      const readDocsStmt = db.prepare(
        "SELECT id, sort_key FROM author_documents WHERE project_id = ? ORDER BY rowid ASC;",
      );
      const updateSortStmt = db.prepare("UPDATE author_documents SET sort_key = ? WHERE id = ?;");

      for (const { project_id: projectId } of projectRows) {
        const docs = readDocsStmt.all(projectId) as readonly { id: string; sort_key: number }[];
        if (docs.length === 0) continue;
        // Skip if already backfilled with non-zero sort keys.
        if (docs.every((doc) => doc.sort_key > 0)) continue;

        const docIdSet = new Set(docs.map((doc) => doc.id));
        const orderRow = readOrderStmt.get(projectId) as { chapter_ids?: string } | undefined;
        let orderedIds: string[] = [];
        if (orderRow?.chapter_ids) {
          try {
            const parsed = JSON.parse(orderRow.chapter_ids) as unknown;
            if (Array.isArray(parsed)) {
              orderedIds = parsed.filter((id): id is string => typeof id === "string" && docIdSet.has(id));
            }
          } catch {
            orderedIds = [];
          }
        }
        const seen = new Set(orderedIds);
        for (const doc of docs) {
          if (!seen.has(doc.id)) {
            seen.add(doc.id);
            orderedIds.push(doc.id);
          }
        }
        for (let i = 0; i < orderedIds.length; i += 1) {
          updateSortStmt.run((i + 1) * SORT_KEY_STEP, orderedIds[i]);
        }
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS author_documents_by_tree_sort
          ON author_documents(project_id, volume_id, act_id, sort_key);
      `);
    },
  },
  {
    id: "2.3.0-controls-foreshadows-observations-memory",
    up(db) {
      const ctrlCols = tableColumns(db, "author_project_controls");
      if (!ctrlCols.has("pacing_tier")) {
        db.exec("ALTER TABLE author_project_controls ADD COLUMN pacing_tier TEXT NOT NULL DEFAULT '';");
      }
      if (!ctrlCols.has("genre_tags_json")) {
        db.exec("ALTER TABLE author_project_controls ADD COLUMN genre_tags_json TEXT NOT NULL DEFAULT '[]';");
      }
      if (!ctrlCols.has("agent_tools_enabled")) {
        db.exec("ALTER TABLE author_project_controls ADD COLUMN agent_tools_enabled INTEGER NOT NULL DEFAULT 0;");
      }
      if (!ctrlCols.has("daily_target")) {
        db.exec("ALTER TABLE author_project_controls ADD COLUMN daily_target INTEGER NOT NULL DEFAULT 0;");
      }
      if (!ctrlCols.has("stale_foreshadow_gap")) {
        db.exec("ALTER TABLE author_project_controls ADD COLUMN stale_foreshadow_gap INTEGER NOT NULL DEFAULT 20;");
      }
      if (!ctrlCols.has("token_calibration_json")) {
        db.exec("ALTER TABLE author_project_controls ADD COLUMN token_calibration_json TEXT NOT NULL DEFAULT '{}';");
      }

      const fsCols = tableColumns(db, "author_foreshadows");
      if (!fsCols.has("hinted_chapter_ids_json")) {
        db.exec("ALTER TABLE author_foreshadows ADD COLUMN hinted_chapter_ids_json TEXT NOT NULL DEFAULT '[]';");
      }

      const obsCols = tableColumns(db, "author_chapter_observations");
      if (!obsCols.has("verified")) {
        db.exec("ALTER TABLE author_chapter_observations ADD COLUMN verified INTEGER NOT NULL DEFAULT 1;");
      }

      const memCols = tableColumns(db, "author_chapter_memory_sync");
      if (!memCols.has("synced_revision_id")) {
        db.exec("ALTER TABLE author_chapter_memory_sync ADD COLUMN synced_revision_id TEXT;");
      }
    },
  },
  {
    id: "2.3.0-event-log-timestamps-and-quarantine",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS event_log_quarantine (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          event_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE INDEX IF NOT EXISTS event_log_quarantine_by_project
          ON event_log_quarantine(project_id, seq);
      `);

      if (!hasObject(db, "table", "event_log")) return;
      const evCols = tableColumns(db, "event_log");
      if (!evCols.has("created_at")) {
        db.exec("ALTER TABLE event_log ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;");
      }

      // Backfill missing/invalid concerns by event kind; quarantine uninferable rows without creating seq gaps.
      const rows = db.prepare("SELECT project_id, seq, event_id, kind, payload FROM event_log;").all() as readonly {
        project_id: string;
        seq: number;
        event_id: string;
        kind: string;
        payload: string;
      }[];
      const updatePayload = db.prepare("UPDATE event_log SET payload = ? WHERE project_id = ? AND seq = ?;");
      const insertQuarantine = db.prepare(`
        INSERT INTO event_log_quarantine (project_id, seq, event_id, kind, payload, reason, quarantined_at)
        VALUES (?, ?, ?, ?, ?, ?, ?);
      `);
      const now = Date.now();
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.payload);
        } catch {
          insertQuarantine.run(row.project_id, row.seq, row.event_id, row.kind, row.payload, "invalid-json", now);
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          insertQuarantine.run(row.project_id, row.seq, row.event_id, row.kind, row.payload, "non-object-payload", now);
          continue;
        }
        const record = parsed as Record<string, unknown>;
        const existingConcern = record.concern;
        if (typeof existingConcern === "string" && VALID_CONCERNS.has(existingConcern)) continue;
        const inferred = inferEventConcern(row.kind);
        if (inferred) {
          updatePayload.run(JSON.stringify({ ...record, concern: inferred }), row.project_id, row.seq);
        } else {
          insertQuarantine.run(
            row.project_id,
            row.seq,
            row.event_id,
            row.kind,
            row.payload,
            existingConcern ? `unknown-concern:${String(existingConcern)}` : "missing-concern",
            now,
          );
        }
      }
    },
  },
  {
    id: "2.3.0-hot-indexes",
    up(db) {
      if (hasObject(db, "table", "revisions")) {
        db.exec("CREATE INDEX IF NOT EXISTS revisions_by_document_created ON revisions(document_id, created_at);");
      }
      if (hasObject(db, "table", "candidates")) {
        db.exec("CREATE INDEX IF NOT EXISTS candidates_by_document ON candidates(document_id);");
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS author_generation_attempts_open
          ON author_generation_attempts(state)
          WHERE state IN ('prepared', 'inflight', 'received');
        CREATE INDEX IF NOT EXISTS author_ai_proposals_by_doc
          ON author_ai_proposals(document_id);
        CREATE INDEX IF NOT EXISTS author_runs_by_doc_state
          ON author_runs(document_id, state);
        CREATE INDEX IF NOT EXISTS author_settings_by_project_fact
          ON author_settings(project_id, fact_id);
        CREATE INDEX IF NOT EXISTS author_foreshadows_by_target
          ON author_foreshadows(project_id, target_chapter_id);
        CREATE INDEX IF NOT EXISTS author_chapter_entities_by_name
          ON author_chapter_entities(project_id, entity_name);
        CREATE INDEX IF NOT EXISTS author_read_checkpoints_lru
          ON author_read_checkpoints(last_used_at ASC);
      `);
    },
  },
  {
    id: "2.3.0-meta-version-and-uuid",
    up(db) {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
      db.prepare(`
        INSERT INTO meta (key, value) VALUES ('schema', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      `).run(SCHEMA_ID);
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('db_uuid', ?);").run(randomUUID());
      db.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION};`);
    },
  },
];

/**
 * V2 author-workspace schema with atomic, versioned migrations covering
 * `2.0.0` -> `2.1.0` -> `2.2.0` -> `2.3.0` idempotently.
 */
export function createAuthorSchema(db: SqliteDatabase): void {
  runMigrations(db, AUTHOR_MIGRATIONS);
}
