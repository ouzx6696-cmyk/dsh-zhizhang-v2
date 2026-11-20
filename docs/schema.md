# Zhizhang SQLite Schema Reference (Auto-Generated)

> Generated from `sqlite_master` by `scripts/schema-doc.mjs`. Do not hand-edit.

- **Schema ID**: `zhizhang/2.3`
- **SQLite `user_version`**: `23`
- **Migrations applied**: 13

## Summary Counts

| Object Type | Count |
| --- | ---: |
| Tables (non-shadow) | 40 |
| FTS5 Virtual Tables | 3 |
| FTS5 Shadow Tables | 12 |
| Views | 3 |
| Explicit Indexes | 40 |
| Triggers | 14 |

## Migrations

1. `2.1.0-legacy-reports-table`
2. `2.1.0-author-tables-and-backfill`
3. `2.2.0-run-trace-and-recovery`
4. `2.2.0-command-journal-meta`
5. `2.2.0-memory-sync-and-entities`
6. `2.2.0-skills-diagnostics-observations`
7. `2.2.0-project-controls-and-arcs`
8. `2.3.0-proposals-micro-generation-origin`
9. `2.3.0-document-sort-key-and-backfill`
10. `2.3.0-controls-foreshadows-observations-memory`
11. `2.3.0-event-log-timestamps-and-quarantine`
12. `2.3.0-hot-indexes`
13. `2.3.0-meta-version-and-uuid`

## Tables

### `author_acts`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `project_id` | `TEXT` | YES |  |  |
| `volume_id` | `TEXT` | YES |  |  |
| `title` | `TEXT` | YES |  |  |
| `goal` | `TEXT` | YES | '' |  |
| `summary` | `TEXT` | YES | '' |  |
| `sort_order` | `INTEGER` | YES |  |  |
| `created_at` | `INTEGER` | YES | 0 |  |
| `arc_goal` | `TEXT` | YES | '' |  |
| `arc_summary` | `TEXT` | YES | '' |  |
| `pacing_template` | `TEXT` | YES | '' |  |

Foreign keys: `volume_id` -> `author_volumes(id)`, `project_id` -> `author_projects(id)`

### `author_ai_proposals`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `project_id` | `TEXT` | NO |  |  |
| `document_id` | `TEXT` | NO |  |  |
| `kind` | `TEXT` | YES |  |  |
| `status` | `TEXT` | YES |  |  |
| `source_ref` | `TEXT` | YES | '' |  |
| `payload` | `TEXT` | YES | '{}' |  |
| `provider` | `TEXT` | NO |  |  |
| `model` | `TEXT` | NO |  |  |
| `reserved` | `INTEGER` | YES | 0 |  |
| `settled` | `INTEGER` | YES | 0 |  |
| `usage` | `TEXT` | YES | '[]' |  |
| `error` | `TEXT` | NO |  |  |
| `created_at` | `INTEGER` | YES | 0 |  |
| `updated_at` | `INTEGER` | YES | 0 |  |
| `base_revision_id` | `TEXT` | NO |  |  |
| `source_sha256` | `TEXT` | YES | '' |  |
| `origin` | `TEXT` | YES | 'ai-generate' |  |
| `origin_ref` | `TEXT` | YES | '' |  |
| `error_detail` | `TEXT` | NO |  |  |

### `author_approvals`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `document_id` | `TEXT` | YES |  | 1 |
| `revision_id` | `TEXT` | YES |  | 2 |
| `at` | `TEXT` | YES |  |  |

Foreign keys: `document_id` -> `author_documents(id)`

### `author_article_reports`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `INTEGER` | NO |  | 1 |
| `project_id` | `TEXT` | YES |  |  |
| `document_id` | `TEXT` | YES |  |  |
| `revision_id` | `TEXT` | YES |  |  |
| `kind` | `TEXT` | YES |  |  |
| `payload` | `TEXT` | YES |  |  |
| `created_at` | `INTEGER` | YES |  |  |

Foreign keys: `document_id` -> `author_documents(id)`, `project_id` -> `author_projects(id)`

### `author_candidate_qa`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `candidate_id` | `TEXT` | NO |  | 1 |
| `report` | `TEXT` | YES |  |  |
| `rounds` | `INTEGER` | YES |  |  |

Foreign keys: `candidate_id` -> `candidates(candidate_id)`

### `author_chapter_entities`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `document_id` | `TEXT` | YES |  | 1 |
| `project_id` | `TEXT` | YES |  |  |
| `fact_id` | `TEXT` | YES |  | 2 |
| `entity_name` | `TEXT` | YES |  |  |
| `category` | `TEXT` | YES | 'character' |  |
| `mention_count` | `INTEGER` | YES | 0 |  |

Foreign keys: `project_id` -> `author_projects(id)`, `document_id` -> `author_documents(id)`

### `author_chapter_memory_sync`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `document_id` | `TEXT` | NO |  | 1 |
| `project_id` | `TEXT` | YES |  |  |
| `current_body_sha256` | `TEXT` | YES | '' |  |
| `synced_body_sha256` | `TEXT` | YES | '' |  |
| `synced_body` | `TEXT` | YES | '' |  |
| `sync_status` | `TEXT` | YES | 'clean' |  |
| `updated_at` | `INTEGER` | YES | 0 |  |
| `synced_revision_id` | `TEXT` | NO |  |  |

Foreign keys: `project_id` -> `author_projects(id)`, `document_id` -> `author_documents(id)`

### `author_chapter_observations`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `project_id` | `TEXT` | YES |  |  |
| `document_id` | `TEXT` | YES |  |  |
| `revision_id` | `TEXT` | NO |  |  |
| `dimension` | `TEXT` | YES |  |  |
| `severity` | `TEXT` | YES | 'warning' |  |
| `quote` | `TEXT` | YES | '' |  |
| `suggestion` | `TEXT` | YES | '' |  |
| `status` | `TEXT` | YES | 'open' |  |
| `source` | `TEXT` | YES | 'review' |  |
| `created_at` | `INTEGER` | YES | 0 |  |
| `updated_at` | `INTEGER` | YES | 0 |  |
| `verified` | `INTEGER` | YES | 1 |  |

Foreign keys: `document_id` -> `author_documents(id)`, `project_id` -> `author_projects(id)`

### `author_chapter_order`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `project_id` | `TEXT` | NO |  | 1 |
| `chapter_ids` | `TEXT` | YES |  |  |

Foreign keys: `project_id` -> `author_projects(id)`

### `author_decisions`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `decision_id` | `INTEGER` | NO |  | 1 |
| `actor_id` | `TEXT` | YES |  |  |
| `document_id` | `TEXT` | YES |  |  |
| `candidate_id` | `TEXT` | YES |  |  |
| `revision_id` | `TEXT` | YES |  |  |

Foreign keys: `revision_id` -> `revisions(revision_id)`, `candidate_id` -> `candidates(candidate_id)`, `document_id` -> `documents(document_id)`

### `author_documents`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `project_id` | `TEXT` | YES |  |  |
| `title` | `TEXT` | YES |  |  |
| `state` | `TEXT` | YES |  |  |
| `mode` | `TEXT` | NO |  |  |
| `line` | `TEXT` | NO |  |  |
| `final_revision_id` | `TEXT` | NO |  |  |
| `editorial_rejections` | `INTEGER` | YES | 0 |  |
| `qa_rounds` | `INTEGER` | YES | 0 |  |
| `volume_id` | `TEXT` | NO |  |  |
| `act_id` | `TEXT` | NO |  |  |
| `char_count` | `INTEGER` | YES | 0 |  |
| `summary` | `TEXT` | YES | '' |  |
| `updated_at` | `INTEGER` | YES | 0 |  |
| `sort_key` | `REAL` | YES | 0 |  |

Foreign keys: `project_id` -> `author_projects(id)`, `id` -> `documents(document_id)`

### `author_evidence`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `snapshot_id` | `TEXT` | NO |  | 1 |
| `project_id` | `TEXT` | YES |  |  |
| `document_id` | `TEXT` | YES |  |  |
| `fact_id` | `TEXT` | YES |  |  |
| `revision_id` | `TEXT` | YES |  |  |
| `point` | `INTEGER` | YES |  |  |
| `quote_start` | `INTEGER` | YES |  |  |
| `quote_end` | `INTEGER` | YES |  |  |
| `verification_kind` | `TEXT` | YES |  |  |
| `verification_score` | `INTEGER` | YES |  |  |

Foreign keys: `document_id` -> `author_documents(id)`, `project_id` -> `author_projects(id)`

### `author_foreshadows`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `project_id` | `TEXT` | YES |  |  |
| `fact_id` | `TEXT` | NO |  |  |
| `title` | `TEXT` | YES |  |  |
| `planted_chapter_id` | `TEXT` | NO |  |  |
| `planted_point` | `INTEGER` | YES | 1 |  |
| `target_chapter_id` | `TEXT` | NO |  |  |
| `resolved_chapter_id` | `TEXT` | NO |  |  |
| `status` | `TEXT` | YES | 'planted' |  |
| `note` | `TEXT` | YES | '' |  |
| `updated_at` | `INTEGER` | YES | 0 |  |
| `hinted_chapter_ids_json` | `TEXT` | YES | '[]' |  |

Foreign keys: `project_id` -> `author_projects(id)`

### `author_generation_attempts`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `run_id` | `TEXT` | YES |  |  |
| `provider` | `TEXT` | YES |  |  |
| `model` | `TEXT` | YES |  |  |
| `state` | `TEXT` | YES |  |  |
| `stage` | `TEXT` | NO |  |  |
| `usage` | `TEXT` | YES |  |  |
| `late_usage` | `TEXT` | YES | '[]' |  |
| `error` | `TEXT` | NO |  |  |

Foreign keys: `run_id` -> `author_runs(id)`

### `author_generation_calls`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `attempt_id` | `TEXT` | YES |  |  |
| `phase` | `TEXT` | YES |  |  |
| `input_reserve` | `INTEGER` | YES |  |  |
| `max_output` | `INTEGER` | YES |  |  |
| `usage` | `TEXT` | NO |  |  |

Foreign keys: `attempt_id` -> `author_generation_attempts(id)`

### `author_library_mounts`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `project_id` | `TEXT` | YES |  |  |
| `target_type` | `TEXT` | YES |  |  |
| `target_id` | `TEXT` | YES |  |  |
| `item_kind` | `TEXT` | YES |  |  |
| `item_id` | `TEXT` | YES |  |  |
| `mode` | `TEXT` | YES | 'include' |  |
| `weight` | `INTEGER` | YES | 100 |  |
| `note` | `TEXT` | YES | '' |  |

Foreign keys: `project_id` -> `author_projects(id)`

### `author_lore_current`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `project_id` | `TEXT` | YES |  | 1 |
| `fact_id` | `TEXT` | YES |  | 2 |
| `category` | `TEXT` | YES | 'world_rule' |  |
| `entity_name` | `TEXT` | YES | '' |  |
| `latest_setting_id` | `TEXT` | YES |  |  |
| `locked` | `INTEGER` | YES | 0 |  |
| `value` | `TEXT` | YES |  |  |
| `decided_seq` | `INTEGER` | YES | 0 |  |

Foreign keys: `project_id` -> `author_projects(id)`

### `author_micro_calls` (STRICT)

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | YES |  | 1 |
| `project_id` | `TEXT` | YES |  |  |
| `document_id` | `TEXT` | YES |  |  |
| `mode` | `TEXT` | YES |  |  |
| `provider` | `TEXT` | YES |  |  |
| `model` | `TEXT` | YES |  |  |
| `reserved` | `INTEGER` | YES | 0 |  |
| `settled` | `INTEGER` | YES | 0 |  |
| `usage` | `TEXT` | YES | '[]' |  |
| `status` | `TEXT` | YES | 'inflight' |  |
| `created_at` | `INTEGER` | YES | 0 |  |
| `updated_at` | `INTEGER` | YES | 0 |  |

Foreign keys: `document_id` -> `author_documents(id)`, `project_id` -> `author_projects(id)`

### `author_planning`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `document_id` | `TEXT` | NO |  | 1 |
| `value` | `TEXT` | YES |  |  |

Foreign keys: `document_id` -> `author_documents(id)`

### `author_project_controls`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `project_id` | `TEXT` | NO |  | 1 |
| `author_intent` | `TEXT` | YES | '' |  |
| `current_focus` | `TEXT` | YES | '' |  |
| `updated_at` | `INTEGER` | YES | 0 |  |
| `pacing_tier` | `TEXT` | YES | '' |  |
| `genre_tags_json` | `TEXT` | YES | '[]' |  |
| `agent_tools_enabled` | `INTEGER` | YES | 0 |  |
| `daily_target` | `INTEGER` | YES | 0 |  |
| `stale_foreshadow_gap` | `INTEGER` | YES | 20 |  |
| `token_calibration_json` | `TEXT` | YES | '{}' |  |

Foreign keys: `project_id` -> `author_projects(id)`

### `author_project_slop_config`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `project_id` | `TEXT` | NO |  | 1 |
| `custom_banned_json` | `TEXT` | YES | '[]' |  |
| `whitelist_json` | `TEXT` | YES | '[]' |  |
| `updated_at` | `INTEGER` | YES | 0 |  |

Foreign keys: `project_id` -> `author_projects(id)`

### `author_projects`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `name` | `TEXT` | YES |  |  |
| `product` | `TEXT` | YES |  |  |
| `created_at` | `INTEGER` | YES | 0 |  |

### `author_read_checkpoints`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `project_id` | `TEXT` | YES |  | 1 |
| `cache_key` | `TEXT` | YES |  | 2 |
| `version` | `INTEGER` | YES |  |  |
| `seq` | `INTEGER` | YES |  |  |
| `state` | `TEXT` | YES |  |  |
| `last_used_at` | `INTEGER` | YES | 0 |  |

Foreign keys: `project_id` -> `author_projects(id)`

### `author_run_refinement_claims`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `run_id` | `TEXT` | NO |  | 1 |
| `rounds` | `INTEGER` | YES | 0 |  |

Foreign keys: `run_id` -> `author_runs(id)`

### `author_runs`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `document_id` | `TEXT` | YES |  |  |
| `state` | `TEXT` | YES |  |  |
| `base_revision_id` | `TEXT` | YES |  |  |
| `frozen_input` | `TEXT` | YES |  |  |
| `reserved` | `INTEGER` | YES |  |  |
| `settled` | `INTEGER` | YES | 0 |  |
| `candidate_id` | `TEXT` | NO |  |  |
| `late_usage_settled` | `INTEGER` | YES | 0 |  |
| `context_trace` | `TEXT` | NO |  |  |
| `recovery_hints` | `TEXT` | NO |  |  |

Foreign keys: `document_id` -> `author_documents(id)`

### `author_settings`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `sequence` | `INTEGER` | NO |  | 1 |
| `id` | `TEXT` | YES |  |  |
| `project_id` | `TEXT` | YES |  |  |
| `fact_id` | `TEXT` | YES |  |  |
| `value` | `TEXT` | YES |  |  |
| `decision` | `TEXT` | YES | 'pending' |  |
| `decided_seq` | `INTEGER` | NO |  |  |
| `category` | `TEXT` | YES | 'world_rule' |  |
| `entity_name` | `TEXT` | YES | '' |  |
| `origin` | `TEXT` | YES | 'author-ui' |  |
| `origin_ref` | `TEXT` | YES | '' |  |

Foreign keys: `project_id` -> `author_projects(id)`

### `author_volumes`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `project_id` | `TEXT` | YES |  |  |
| `title` | `TEXT` | YES |  |  |
| `goal` | `TEXT` | YES | '' |  |
| `summary` | `TEXT` | YES | '' |  |
| `sort_order` | `INTEGER` | YES |  |  |
| `created_at` | `INTEGER` | YES | 0 |  |

Foreign keys: `project_id` -> `author_projects(id)`

### `candidates`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `candidate_id` | `TEXT` | NO |  | 1 |
| `document_id` | `TEXT` | YES |  |  |
| `base_revision_id` | `TEXT` | YES |  |  |
| `body` | `TEXT` | YES |  |  |

Foreign keys: `base_revision_id` -> `revisions(revision_id)`, `document_id` -> `documents(document_id)`

### `command_journal`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `actor_id` | `TEXT` | YES |  | 1 |
| `command_id` | `TEXT` | YES |  | 2 |
| `document_id` | `TEXT` | YES |  | 3 |
| `request_key` | `TEXT` | YES |  | 4 |
| `request_payload` | `TEXT` | YES |  |  |
| `request_hash` | `TEXT` | YES | '' |  |
| `result_payload` | `TEXT` | YES |  |  |
| `created_at` | `INTEGER` | YES | 0 |  |

### `deliveries`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `article_id` | `TEXT` | NO |  | 1 |
| `final_revision_id` | `TEXT` | YES |  |  |
| `approval_id` | `TEXT` | YES |  |  |
| `export_state` | `TEXT` | YES |  |  |
| `export_hash` | `TEXT` | NO |  |  |
| `export_error` | `TEXT` | NO |  |  |
| `export_attempts` | `INTEGER` | YES | 0 |  |

### `documents`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `document_id` | `TEXT` | NO |  | 1 |
| `current_revision_id` | `TEXT` | NO |  |  |

### `event_log`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `project_id` | `TEXT` | YES |  | 1 |
| `seq` | `INTEGER` | YES |  | 2 |
| `event_id` | `TEXT` | YES |  |  |
| `kind` | `TEXT` | YES |  |  |
| `payload` | `TEXT` | YES |  |  |
| `created_at` | `INTEGER` | YES | 0 |  |

### `event_log_quarantine` (STRICT)

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `INTEGER` | NO |  | 1 |
| `project_id` | `TEXT` | YES |  |  |
| `seq` | `INTEGER` | YES |  |  |
| `event_id` | `TEXT` | YES |  |  |
| `kind` | `TEXT` | YES |  |  |
| `payload` | `TEXT` | YES |  |  |
| `reason` | `TEXT` | YES |  |  |
| `quarantined_at` | `INTEGER` | YES | 0 |  |

### `fts_rowid_map`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `fts_rowid` | `INTEGER` | NO |  | 1 |
| `scope` | `TEXT` | YES |  |  |
| `project_id` | `TEXT` | YES |  |  |
| `entity_key` | `TEXT` | YES |  |  |
| `item_scope` | `TEXT` | YES | 'project' |  |
| `indexed` | `INTEGER` | YES | 1 |  |

### `library_deconstructions`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `scope` | `TEXT` | YES |  |  |
| `project_id` | `TEXT` | NO |  |  |
| `override_of_id` | `TEXT` | NO |  |  |
| `title` | `TEXT` | YES |  |  |
| `source_book` | `TEXT` | YES | '' |  |
| `genre` | `TEXT` | YES | '' |  |
| `pacing` | `TEXT` | YES | '' |  |
| `tags_json` | `TEXT` | YES | '[]' |  |
| `excerpt` | `TEXT` | YES |  |  |
| `hook_analysis` | `TEXT` | YES | '' |  |
| `conflict_beats` | `TEXT` | YES | '' |  |
| `payoff_rhythm` | `TEXT` | YES | '' |  |
| `prose_notes` | `TEXT` | YES | '' |  |
| `status` | `TEXT` | YES | 'approved' |  |
| `source_kind` | `TEXT` | YES | 'manual' |  |
| `created_at` | `INTEGER` | YES | 0 |  |
| `updated_at` | `INTEGER` | YES | 0 |  |

### `library_technique_cards`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `scope` | `TEXT` | YES |  |  |
| `project_id` | `TEXT` | NO |  |  |
| `override_of_id` | `TEXT` | NO |  |  |
| `title` | `TEXT` | YES |  |  |
| `category` | `TEXT` | YES | 'narrative' |  |
| `pacing` | `TEXT` | YES | '' |  |
| `scene_tags_json` | `TEXT` | YES | '[]' |  |
| `trigger_when` | `TEXT` | YES | '' |  |
| `execution_steps` | `TEXT` | YES | '' |  |
| `constraints` | `TEXT` | YES | '' |  |
| `anti_patterns` | `TEXT` | YES | '' |  |
| `example_excerpt` | `TEXT` | YES | '' |  |
| `priority` | `INTEGER` | YES | 50 |  |
| `status` | `TEXT` | YES | 'approved' |  |
| `source_kind` | `TEXT` | YES | 'manual' |  |
| `created_at` | `INTEGER` | YES | 0 |  |
| `updated_at` | `INTEGER` | YES | 0 |  |
| `asset_kind` | `TEXT` | YES | 'technique' |  |
| `stage_bindings_json` | `TEXT` | YES | '["write"]' |  |
| `references_json` | `TEXT` | YES | '[]' |  |

### `meta`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `key` | `TEXT` | NO |  | 1 |
| `value` | `TEXT` | YES |  |  |

### `projection_rows`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `project_id` | `TEXT` | YES |  | 1 |
| `key` | `TEXT` | YES |  | 2 |
| `version` | `INTEGER` | YES |  |  |
| `seq` | `INTEGER` | YES |  |  |
| `state` | `TEXT` | YES |  |  |

### `revisions`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `revision_id` | `TEXT` | NO |  | 1 |
| `document_id` | `TEXT` | YES |  |  |
| `body` | `TEXT` | YES |  |  |
| `created_at` | `INTEGER` | YES |  |  |

Foreign keys: `document_id` -> `documents(document_id)`

### `schema_migrations`

| Column | Type | Not Null | Default | PK |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | NO |  | 1 |
| `applied_at` | `INTEGER` | YES |  |  |

## FTS5 Virtual Tables

- `fts_chapters`
- `fts_library`
- `fts_lore`

## Views

- `v_fts_chapters`
- `v_fts_library`
- `v_fts_lore`

## Explicit Indexes

| Index | Table | Unique | Partial |
| --- | --- | --- | --- |
| `author_acts_by_volume` | `author_acts` | NO | NO |
| `author_ai_proposals_by_doc` | `author_ai_proposals` | NO | NO |
| `author_ai_proposals_status` | `author_ai_proposals` | NO | NO |
| `author_calls_by_attempt` | `author_generation_calls` | NO | NO |
| `author_chapter_entities_by_doc` | `author_chapter_entities` | NO | NO |
| `author_chapter_entities_by_fact` | `author_chapter_entities` | NO | NO |
| `author_chapter_entities_by_name` | `author_chapter_entities` | NO | NO |
| `author_chapter_memory_sync_project` | `author_chapter_memory_sync` | NO | NO |
| `author_chapter_observations_doc` | `author_chapter_observations` | NO | NO |
| `author_documents_by_project` | `author_documents` | NO | NO |
| `author_documents_by_tree` | `author_documents` | NO | NO |
| `author_documents_by_tree_sort` | `author_documents` | NO | NO |
| `author_evidence_by_fact` | `author_evidence` | NO | NO |
| `author_foreshadows_by_project` | `author_foreshadows` | NO | NO |
| `author_foreshadows_by_target` | `author_foreshadows` | NO | NO |
| `author_generation_attempts_open` | `author_generation_attempts` | NO | YES |
| `author_generation_by_run` | `author_generation_attempts` | NO | NO |
| `author_library_mounts_lookup` | `author_library_mounts` | NO | NO |
| `author_lore_current_by_cat` | `author_lore_current` | NO | NO |
| `author_micro_calls_by_doc` | `author_micro_calls` | NO | NO |
| `author_micro_calls_by_project` | `author_micro_calls` | NO | NO |
| `author_read_checkpoints_lru` | `author_read_checkpoints` | NO | NO |
| `author_reports_by_revision` | `author_article_reports` | NO | NO |
| `author_runs_by_doc_state` | `author_runs` | NO | NO |
| `author_runs_by_document` | `author_runs` | NO | NO |
| `author_settings_approved_order` | `author_settings` | NO | YES |
| `author_settings_by_project` | `author_settings` | NO | NO |
| `author_settings_by_project_fact` | `author_settings` | NO | NO |
| `author_volumes_by_project` | `author_volumes` | NO | NO |
| `candidates_by_document` | `candidates` | NO | NO |
| `command_journal_created_at` | `command_journal` | NO | NO |
| `event_log_identity` | `event_log` | YES | NO |
| `event_log_quarantine_by_project` | `event_log_quarantine` | NO | NO |
| `fts_rowid_map_lookup` | `fts_rowid_map` | NO | NO |
| `fts_rowid_map_project` | `fts_rowid_map` | NO | NO |
| `library_deconstructions_scope` | `library_deconstructions` | NO | NO |
| `library_techniques_scope` | `library_technique_cards` | NO | NO |
| `revisions_by_document_created` | `revisions` | NO | NO |
| `ux_micro_call_inflight` | `author_micro_calls` | YES | YES |
| `ux_proposal_inflight` | `author_ai_proposals` | YES | YES |

## Triggers

| Trigger | Table |
| --- | --- |
| `tr_fts_adoc_au` | `author_documents` |
| `tr_fts_adoc_bd` | `author_documents` |
| `tr_fts_adoc_bu` | `author_documents` |
| `tr_fts_dec_au` | `library_deconstructions` |
| `tr_fts_dec_bd` | `library_deconstructions` |
| `tr_fts_dec_bu` | `library_deconstructions` |
| `tr_fts_doc_rev_au` | `documents` |
| `tr_fts_doc_rev_bu` | `documents` |
| `tr_fts_lore_au` | `author_lore_current` |
| `tr_fts_lore_bd` | `author_lore_current` |
| `tr_fts_lore_bu` | `author_lore_current` |
| `tr_fts_tech_au` | `library_technique_cards` |
| `tr_fts_tech_bd` | `library_technique_cards` |
| `tr_fts_tech_bu` | `library_technique_cards` |
