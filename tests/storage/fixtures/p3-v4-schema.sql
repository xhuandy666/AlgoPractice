-- Frozen actual P3 v4 schema, exported before P4 implementation.
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
CREATE TABLE learning_settings (id INTEGER PRIMARY KEY CHECK(id = 1), value_json TEXT NOT NULL CHECK(json_valid(value_json))) STRICT;
CREATE TABLE attachments (
  hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash) = 64), name TEXT NOT NULL,
  mime_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0), created_at TEXT NOT NULL
) STRICT;
CREATE TABLE ai_requests (
  id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL REFERENCES attempts(id), request_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  status TEXT NOT NULL CHECK(status IN ('pending','streaming','repairing','completed','failed','cancelled','interrupted')),
  response_json TEXT NOT NULL CHECK(json_valid(response_json)), error_json TEXT NOT NULL CHECK(json_valid(error_json)),
  usage_json TEXT NOT NULL CHECK(json_valid(usage_json)), cached_from_request_id TEXT REFERENCES ai_requests(id),
  created_at TEXT NOT NULL, finished_at TEXT,
  CHECK((status IN ('pending','streaming','repairing') AND finished_at IS NULL) OR
    (status IN ('completed','failed','cancelled','interrupted') AND finished_at IS NOT NULL))
) STRICT;
CREATE TABLE ai_help_state (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES attempts(id), automatic_shown_at TEXT, dismissed_at TEXT
) STRICT;
CREATE TABLE ai_help_used (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES ai_requests(id), attempt_id TEXT NOT NULL REFERENCES attempts(id),
  level TEXT NOT NULL CHECK(level IN ('L0','L1','L2','L3','L4')), created_at TEXT NOT NULL
) STRICT;
CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('problem','topic')), subject_id TEXT NOT NULL,
  latest_version INTEGER NOT NULL CHECK(latest_version > 0), confirmed_version INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(id,latest_version) REFERENCES note_versions(note_id,version) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(id,confirmed_version) REFERENCES note_versions(note_id,version) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE note_versions (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, version INTEGER NOT NULL CHECK(version > 0),
  title TEXT NOT NULL, markdown TEXT NOT NULL, tags_json TEXT NOT NULL CHECK(json_valid(tags_json)),
  origin TEXT NOT NULL CHECK(origin IN ('user','ai')), state TEXT NOT NULL CHECK(state IN ('draft','confirmed')),
  ai_request_id TEXT REFERENCES ai_requests(id), created_at TEXT NOT NULL, PRIMARY KEY(note_id, version)
) STRICT;
CREATE TABLE note_attachment_refs (
  note_id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL REFERENCES attachments(hash),
  PRIMARY KEY(note_id,version,hash), FOREIGN KEY(note_id,version) REFERENCES note_versions(note_id,version) ON DELETE CASCADE
) STRICT;
CREATE TABLE note_requests (
  request_id TEXT PRIMARY KEY NOT NULL, input_hash TEXT NOT NULL, note_id TEXT NOT NULL, version INTEGER NOT NULL,
  FOREIGN KEY(note_id,version) REFERENCES note_versions(note_id,version) ON DELETE CASCADE
) STRICT;
CREATE TABLE attempt_note_versions (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE, note_id TEXT NOT NULL, version INTEGER NOT NULL,
  PRIMARY KEY(attempt_id,note_id), FOREIGN KEY(note_id,version) REFERENCES note_versions(note_id,version) ON DELETE CASCADE
) STRICT;
CREATE TABLE review_items (
  id TEXT PRIMARY KEY NOT NULL, problem_id TEXT NOT NULL REFERENCES problems(id),
  target TEXT NOT NULL CHECK(target IN ('understanding','rewrite')), language TEXT NOT NULL CHECK(language IN ('none','python','java')),
  initial_card_json TEXT NOT NULL CHECK(json_valid(initial_card_json)), card_json TEXT NOT NULL CHECK(json_valid(card_json)),
  algorithm_version TEXT NOT NULL, parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),
  due_at TEXT NOT NULL, scheduled_at TEXT, suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(problem_id,target,language),
  CHECK((target = 'understanding' AND language = 'none') OR (target = 'rewrite' AND language IN ('python','java')))
) STRICT;
CREATE TABLE review_events (
  id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE, item_id TEXT NOT NULL REFERENCES review_items(id),
  kind TEXT NOT NULL CHECK(kind IN ('review','correction')), rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 4),
  reviewed_at TEXT NOT NULL, created_at TEXT NOT NULL, corrects_event_id TEXT REFERENCES review_events(id),
  algorithm_version TEXT NOT NULL, attempt_id TEXT REFERENCES attempts(id),
  CHECK((kind = 'review' AND corrects_event_id IS NULL) OR (kind = 'correction' AND corrects_event_id IS NOT NULL))
) STRICT;
CREATE TABLE review_requests (
  request_id TEXT PRIMARY KEY NOT NULL, input_hash TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES review_events(id)
) STRICT;
CREATE TABLE activity_samples (
  id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL REFERENCES attempts(id),
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0 AND duration_ms <= 30000), occurred_at TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE attachment_deletion_candidates (
  hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash) = 64), name TEXT NOT NULL,
  mime_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0), created_at TEXT NOT NULL
) STRICT;
CREATE INDEX runs_by_attempt ON runs(attempt_id, created_at);
CREATE UNIQUE INDEX attempt_scope_identity ON attempts(id, problem_id, language, mode, draft_scope_id);
CREATE INDEX list_items_by_problem ON list_items(problem_id);
CREATE INDEX ai_requests_by_attempt ON ai_requests(attempt_id, created_at);
CREATE INDEX ai_completed_cache ON ai_requests(request_hash) WHERE status = 'completed';
CREATE INDEX notes_by_subject ON notes(kind, subject_id);
CREATE INDEX review_due ON review_items(due_at);
CREATE UNIQUE INDEX one_feedback_per_attempt ON review_events(item_id,attempt_id) WHERE kind = 'review' AND attempt_id IS NOT NULL;
CREATE INDEX review_history ON review_events(item_id,reviewed_at);
CREATE INDEX activity_by_attempt ON activity_samples(attempt_id,occurred_at);
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
CREATE TRIGGER coherent_attempt_final BEFORE UPDATE ON attempts WHEN NEW.ended_at IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.final_code IS NULL OR NEW.final_code_hash IS NULL OR NEW.final_draft_revision IS NULL
    THEN RAISE(ABORT, 'finished attempt requires a final draft snapshot') END;
  SELECT CASE WHEN NEW.final_last_run_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM runs WHERE id = NEW.final_last_run_id AND attempt_id = NEW.id)
    THEN RAISE(ABORT, 'final run must belong to the attempt') END;
END;
CREATE TRIGGER immutable_attachment BEFORE UPDATE ON attachments BEGIN SELECT RAISE(ABORT, 'attachment metadata is immutable'); END;
CREATE TRIGGER immutable_ai_request BEFORE UPDATE OF id,attempt_id,request_hash,snapshot_json,created_at ON ai_requests
BEGIN SELECT RAISE(ABORT, 'AI request snapshot is immutable'); END;
CREATE TRIGGER immutable_note_identity BEFORE UPDATE OF id,kind,subject_id,created_at ON notes
BEGIN SELECT RAISE(ABORT, 'note identity is immutable'); END;
CREATE TRIGGER immutable_note_attachment_ref BEFORE UPDATE ON note_attachment_refs
BEGIN SELECT RAISE(ABORT, 'note attachment references are immutable'); END;
CREATE TRIGGER immutable_attempt_note_ref BEFORE UPDATE ON attempt_note_versions
BEGIN SELECT RAISE(ABORT, 'archived note references are immutable'); END;
CREATE TRIGGER immutable_review_identity BEFORE UPDATE OF id,problem_id,target,language,initial_card_json,algorithm_version,parameters_json,created_at ON review_items
BEGIN SELECT RAISE(ABORT, 'review identity and algorithm are immutable'); END;
CREATE TRIGGER immutable_activity BEFORE UPDATE ON activity_samples BEGIN SELECT RAISE(ABORT, 'activity samples are immutable'); END;
CREATE TRIGGER immutable_attempt BEFORE UPDATE OF
  id, problem_id, language, problem_version, mode, started_at, draft_scope_id ON attempts
BEGIN SELECT RAISE(ABORT, 'attempt identity is immutable'); END;
CREATE TRIGGER immutable_attempt_source BEFORE UPDATE OF restored_from_run_id ON attempts
WHEN NOT (OLD.restored_from_run_id IS NOT NULL AND NEW.restored_from_run_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'attempt source may only be detached'); END;
CREATE TRIGGER immutable_finished_attempt BEFORE UPDATE OF
  ended_at, final_code, final_code_hash, final_draft_revision, final_last_run_id, last_run_matches_final ON attempts
WHEN OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'finished attempt is immutable'); END;
CREATE TRIGGER immutable_review_event BEFORE UPDATE OF
  id, request_id, item_id, kind, rating, reviewed_at, created_at, corrects_event_id, algorithm_version ON review_events
BEGIN SELECT RAISE(ABORT, 'review events are immutable'); END;
CREATE TRIGGER immutable_review_attempt BEFORE UPDATE OF attempt_id ON review_events
WHEN NOT (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'review attempt may only be detached'); END;
CREATE TRIGGER immutable_note_version BEFORE UPDATE OF
  note_id, version, title, markdown, tags_json, origin, state, created_at ON note_versions
BEGIN SELECT RAISE(ABORT, 'note version is immutable'); END;
CREATE TRIGGER immutable_note_ai_source BEFORE UPDATE OF ai_request_id ON note_versions
WHEN NOT (OLD.ai_request_id IS NOT NULL AND NEW.ai_request_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'note AI source may only be detached'); END;
CREATE TRIGGER immutable_ai_terminal BEFORE UPDATE OF
  status, response_json, error_json, usage_json, finished_at ON ai_requests WHEN OLD.finished_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'AI terminal result is immutable'); END;
CREATE TRIGGER immutable_ai_cache_source BEFORE UPDATE OF cached_from_request_id ON ai_requests
WHEN OLD.finished_at IS NOT NULL AND NOT (OLD.cached_from_request_id IS NOT NULL AND NEW.cached_from_request_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'AI cache source may only be detached'); END;
PRAGMA user_version = 4;
