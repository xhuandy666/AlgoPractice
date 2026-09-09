-- Captured from the final P2 storage schema before P3.
CREATE TABLE problems (id TEXT PRIMARY KEY NOT NULL) STRICT;
CREATE TABLE problem_versions (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  version TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(problem_id, version)
) STRICT;
CREATE TABLE drafts (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  language TEXT NOT NULL CHECK(language IN ('python', 'java')),
  scope_id TEXT NOT NULL,
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  saved_at TEXT NOT NULL,
  PRIMARY KEY(problem_id, language, scope_id)
) STRICT;
CREATE TABLE attempts (
  id TEXT PRIMARY KEY NOT NULL,
  problem_id TEXT NOT NULL,
  language TEXT NOT NULL CHECK(language IN ('python', 'java')),
  problem_version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('practice', 'strict', 'coached')),
  started_at TEXT NOT NULL, draft_scope_id TEXT NOT NULL DEFAULT 'practice', ended_at TEXT, final_code TEXT, final_code_hash TEXT, final_draft_revision INTEGER, final_last_run_id TEXT REFERENCES runs(id), last_run_matches_final INTEGER NOT NULL DEFAULT 0 CHECK(last_run_matches_final IN (0, 1)), restored_from_run_id TEXT REFERENCES runs(id),
  FOREIGN KEY(problem_id, problem_version) REFERENCES problem_versions(problem_id, version)
) STRICT;
CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  test_suite_version TEXT NOT NULL,
  test_snapshot_json TEXT NOT NULL CHECK(json_valid(test_snapshot_json)),
  adapter_version TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'passed','completed','wrong_answer','compile_error','runtime_error','timeout','cancelled','output_limit','environment_error','invalid_request','internal_error','interrupted')),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK((status = 'queued' AND finished_at IS NULL AND result_json = 'null')
    OR (status <> 'queued' AND finished_at IS NOT NULL))
) STRICT;
CREATE INDEX runs_by_attempt ON runs(attempt_id, created_at);
CREATE TRIGGER immutable_problem_version BEFORE UPDATE ON problem_versions
BEGIN SELECT RAISE(ABORT, 'problem version is immutable'); END;
CREATE TRIGGER immutable_run_snapshot BEFORE UPDATE OF
  id, attempt_id, code, code_hash, test_suite_version, test_snapshot_json,
  adapter_version, created_at ON runs
BEGIN SELECT RAISE(ABORT, 'run snapshot is immutable'); END;
CREATE TRIGGER immutable_run_runtime BEFORE UPDATE OF runtime_version ON runs
WHEN OLD.status <> 'queued' OR NEW.status = 'queued' OR length(trim(NEW.runtime_version)) = 0
BEGIN SELECT RAISE(ABORT, 'run runtime may only be finalized with its terminal result'); END;
CREATE TRIGGER immutable_run_result BEFORE UPDATE ON runs WHEN OLD.status <> 'queued'
BEGIN SELECT RAISE(ABORT, 'run terminal result is immutable'); END;
CREATE TRIGGER immutable_attempt BEFORE UPDATE OF
  id, problem_id, language, problem_version, mode, started_at, draft_scope_id, restored_from_run_id ON attempts
BEGIN SELECT RAISE(ABORT, 'attempt identity is immutable'); END;
CREATE TRIGGER immutable_finished_attempt BEFORE UPDATE ON attempts WHEN OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'finished attempt is immutable'); END;
CREATE TRIGGER coherent_attempt_final BEFORE UPDATE ON attempts WHEN NEW.ended_at IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.final_code IS NULL OR NEW.final_code_hash IS NULL OR NEW.final_draft_revision IS NULL
    THEN RAISE(ABORT, 'finished attempt requires a final draft snapshot') END;
  SELECT CASE WHEN NEW.final_last_run_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM runs WHERE id = NEW.final_last_run_id AND attempt_id = NEW.id)
    THEN RAISE(ABORT, 'final run must belong to the attempt') END;
END;
CREATE UNIQUE INDEX attempt_scope_identity ON attempts(id, problem_id, language, mode, draft_scope_id);
CREATE TABLE active_attempts (
  problem_id TEXT NOT NULL,
  language TEXT NOT NULL,
  mode TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(problem_id, language, mode, scope_id),
  FOREIGN KEY(attempt_id, problem_id, language, mode, scope_id)
    REFERENCES attempts(id, problem_id, language, mode, draft_scope_id)
) STRICT;
CREATE TABLE library_problem_heads (
  problem_id TEXT PRIMARY KEY NOT NULL,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(problem_id, version) REFERENCES problem_versions(problem_id, version)
) STRICT;
CREATE TABLE study_lists (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('local', 'leetcode-cn', 'file')),
  source_url TEXT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE list_chapters (
  list_id TEXT NOT NULL REFERENCES study_lists(id),
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  parent_id TEXT,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(list_id, id),
  FOREIGN KEY(list_id, parent_id) REFERENCES list_chapters(list_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE list_items (
  list_id TEXT NOT NULL REFERENCES study_lists(id),
  item_key TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  chapter_id TEXT,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(list_id, item_key),
  FOREIGN KEY(list_id, chapter_id) REFERENCES list_chapters(list_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX list_items_by_problem ON list_items(problem_id);
CREATE TABLE list_refresh_previews (
  id TEXT PRIMARY KEY NOT NULL,
  list_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
  created_at TEXT NOT NULL,
  applied_at TEXT
) STRICT;
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','paused','cancelled','completed','completed_with_errors')),
  error_json TEXT NOT NULL CHECK(json_valid(error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE import_items (
  job_id TEXT NOT NULL REFERENCES import_jobs(id),
  item_key TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  seed_json TEXT NOT NULL CHECK(json_valid(seed_json)),
  version TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','running','imported','reused','link_only','restricted','failed','skipped')),
  error_json TEXT NOT NULL CHECK(json_valid(error_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(job_id, item_key),
  FOREIGN KEY(problem_id, version) REFERENCES problem_versions(problem_id, version)
) STRICT;
CREATE TABLE draft_restorations (
  request_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  scope_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
PRAGMA user_version = 2;
