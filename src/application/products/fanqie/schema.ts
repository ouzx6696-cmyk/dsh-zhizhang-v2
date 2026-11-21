import type { SqliteDatabase } from "../../../storage/index.ts";

/**
 * Clean Next-Gen (`zhizhang/3.0`) DDL for Fanqie (serialized novel) tables.
 * Owned exclusively by the Fanqie product-line module and initialized via
 * `fanqieModule.initSchema(db)`.
 */
export function initFanqieSchema(db: SqliteDatabase): void {
  db.exec(`
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
      arc_goal TEXT NOT NULL DEFAULT '',
      arc_summary TEXT NOT NULL DEFAULT '',
      pacing_template TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS author_settings (
      sequence INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      fact_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'world_rule',
      entity_name TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'pending',
      decided_seq INTEGER,
      origin TEXT NOT NULL DEFAULT 'author-ui',
      origin_ref TEXT NOT NULL DEFAULT ''
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

    CREATE TABLE IF NOT EXISTS author_foreshadows (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      fact_id TEXT,
      title TEXT NOT NULL,
      planted_chapter_id TEXT,
      planted_point INTEGER NOT NULL DEFAULT 1,
      target_chapter_id TEXT,
      resolved_chapter_id TEXT,
      hinted_chapter_ids_json TEXT NOT NULL DEFAULT '[]',
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
      asset_kind TEXT NOT NULL DEFAULT 'technique',
      stage_bindings_json TEXT NOT NULL DEFAULT '["write"]',
      references_json TEXT NOT NULL DEFAULT '[]',
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
      error_detail TEXT,
      base_revision_id TEXT,
      source_sha256 TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL DEFAULT 'ai-generate',
      origin_ref TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS author_chapter_memory_sync (
      document_id TEXT PRIMARY KEY REFERENCES author_documents(id),
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      current_body_sha256 TEXT NOT NULL DEFAULT '',
      synced_body_sha256 TEXT NOT NULL DEFAULT '',
      synced_body TEXT NOT NULL DEFAULT '',
      synced_revision_id TEXT,
      sync_status TEXT NOT NULL DEFAULT 'clean',
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS author_chapter_entities (
      document_id TEXT NOT NULL REFERENCES author_documents(id),
      project_id TEXT NOT NULL REFERENCES author_projects(id),
      fact_id TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'character',
      mention_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (document_id, fact_id)
    );

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
      verified INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'review',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS author_project_controls (
      project_id TEXT PRIMARY KEY REFERENCES author_projects(id),
      author_intent TEXT NOT NULL DEFAULT '',
      current_focus TEXT NOT NULL DEFAULT '',
      pacing_tier TEXT NOT NULL DEFAULT '',
      genre_tags_json TEXT NOT NULL DEFAULT '[]',
      agent_tools_enabled INTEGER NOT NULL DEFAULT 0,
      daily_target INTEGER NOT NULL DEFAULT 0,
      stale_foreshadow_gap INTEGER NOT NULL DEFAULT 20,
      token_calibration_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS author_book_prefix_cache (
      project_id TEXT PRIMARY KEY REFERENCES author_projects(id),
      snapshot_version INTEGER NOT NULL DEFAULT 1,
      compiled_text TEXT NOT NULL DEFAULT '',
      prefix_sha256 TEXT NOT NULL DEFAULT '',
      token_count INTEGER NOT NULL DEFAULT 0,
      budget_tokens INTEGER NOT NULL DEFAULT 8192,
      compiled_lore_seq INTEGER NOT NULL DEFAULT 0,
      dirty_mutations INTEGER NOT NULL DEFAULT 0,
      last_cache_hit_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS author_volumes_by_project ON author_volumes(project_id, sort_order);
    CREATE INDEX IF NOT EXISTS author_acts_by_volume ON author_acts(project_id, volume_id, sort_order);
    CREATE INDEX IF NOT EXISTS author_settings_by_project ON author_settings(project_id);
    CREATE INDEX IF NOT EXISTS author_settings_by_project_fact ON author_settings(project_id, fact_id);
    CREATE INDEX IF NOT EXISTS author_settings_approved_order
      ON author_settings(project_id, decided_seq) WHERE decision = 'approved';
    CREATE INDEX IF NOT EXISTS author_lore_current_by_cat ON author_lore_current(project_id, category, decided_seq);
    CREATE INDEX IF NOT EXISTS author_evidence_by_fact ON author_evidence(project_id, fact_id);
    CREATE INDEX IF NOT EXISTS author_foreshadows_by_project ON author_foreshadows(project_id, status);
    CREATE INDEX IF NOT EXISTS author_foreshadows_by_target ON author_foreshadows(project_id, target_chapter_id);
    CREATE INDEX IF NOT EXISTS library_deconstructions_scope ON library_deconstructions(scope, project_id, status);
    CREATE INDEX IF NOT EXISTS library_techniques_scope ON library_technique_cards(scope, project_id, status, priority DESC);
    CREATE INDEX IF NOT EXISTS author_library_mounts_lookup ON author_library_mounts(project_id, target_type, target_id);
    CREATE INDEX IF NOT EXISTS author_ai_proposals_status ON author_ai_proposals(project_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS author_ai_proposals_by_doc ON author_ai_proposals(document_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_proposal_inflight
      ON author_ai_proposals(kind, COALESCE(document_id, project_id, 'global'))
      WHERE status = 'inflight';
    CREATE INDEX IF NOT EXISTS author_chapter_memory_sync_project ON author_chapter_memory_sync(project_id, sync_status);
    CREATE INDEX IF NOT EXISTS author_chapter_entities_by_fact ON author_chapter_entities(project_id, fact_id);
    CREATE INDEX IF NOT EXISTS author_chapter_entities_by_doc ON author_chapter_entities(project_id, document_id);
    CREATE INDEX IF NOT EXISTS author_chapter_entities_by_name ON author_chapter_entities(project_id, entity_name);
    CREATE INDEX IF NOT EXISTS author_chapter_observations_doc ON author_chapter_observations(project_id, document_id, status);
  `);
}
