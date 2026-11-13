// The complete database schema of this lineage. A new database is created from this one script in a single transaction.
// There are no migrations: this version does not read databases of earlier versions (0.x), which keep their own folder.
// Derived from the composed v1–v10 migrations without the columns, values and tables only 0.x data needed; every
// later change edits this script and, once released, adds a migration of this lineage.

/** Header marker of this lineage ("TLN1"). Databases of earlier versions carry 0 and are refused, whatever their version. */
export const APPLICATION_ID = 0x544c4e31;
export const SCHEMA_VERSION = 11;

export const SCHEMA = `
-- problems
CREATE TABLE problems (id TEXT PRIMARY KEY NOT NULL) STRICT;

-- problem_versions
CREATE TABLE problem_versions (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  version TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(problem_id, version)
) STRICT;

-- runs
CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  test_suite_version TEXT NOT NULL,
  test_snapshot_json TEXT NOT NULL CHECK(json_valid(test_snapshot_json)),
  expected_output_source TEXT NOT NULL CHECK(expected_output_source IN ('native-samples','user','none')),
  adapter_version TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'passed','completed','wrong_answer','compile_error','runtime_error','timeout','cancelled','output_limit','environment_error','invalid_request','internal_error','interrupted')),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK((status = 'queued' AND finished_at IS NULL AND result_json = 'null')
    OR (status <> 'queued' AND finished_at IS NOT NULL))
) STRICT;

-- library_problem_heads
CREATE TABLE library_problem_heads (
  problem_id TEXT PRIMARY KEY NOT NULL,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(problem_id, version) REFERENCES problem_versions(problem_id, version)
) STRICT;

-- study_lists
CREATE TABLE study_lists (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('local', 'leetcode-cn', 'file')),
  source_url TEXT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- list_chapters
CREATE TABLE list_chapters (
  list_id TEXT NOT NULL REFERENCES study_lists(id),
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  parent_id TEXT,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(list_id, id),
  FOREIGN KEY(list_id, parent_id) REFERENCES list_chapters(list_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

-- list_items
CREATE TABLE list_items (
  list_id TEXT NOT NULL REFERENCES study_lists(id),
  item_key TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  chapter_id TEXT,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(list_id, item_key),
  FOREIGN KEY(list_id, chapter_id) REFERENCES list_chapters(list_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

-- list_refresh_previews
CREATE TABLE list_refresh_previews (
  id TEXT PRIMARY KEY NOT NULL,
  list_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
  created_at TEXT NOT NULL,
  applied_at TEXT
) STRICT;

-- import_jobs
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

-- import_items
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

-- draft_restorations
CREATE TABLE draft_restorations (
  request_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  scope_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- learning_settings
CREATE TABLE learning_settings (id INTEGER PRIMARY KEY CHECK(id = 1), value_json TEXT NOT NULL CHECK(json_valid(value_json))) STRICT;

-- attachments
CREATE TABLE attachments (
  hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash) = 64), name TEXT NOT NULL,
  mime_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0), created_at TEXT NOT NULL
) STRICT;

-- ai_requests
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

-- ai_help_state
CREATE TABLE ai_help_state (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES attempts(id), automatic_shown_at TEXT, dismissed_at TEXT
) STRICT;

-- notes
CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('problem','topic')), subject_id TEXT NOT NULL,
  latest_version INTEGER NOT NULL CHECK(latest_version > 0), confirmed_version INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(id,latest_version) REFERENCES note_versions(note_id,version) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(id,confirmed_version) REFERENCES note_versions(note_id,version) DEFERRABLE INITIALLY DEFERRED
) STRICT;

-- note_versions
CREATE TABLE note_versions (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, version INTEGER NOT NULL CHECK(version > 0),
  title TEXT NOT NULL, markdown TEXT NOT NULL, tags_json TEXT NOT NULL CHECK(json_valid(tags_json)),
  origin TEXT NOT NULL CHECK(origin IN ('user','ai')), state TEXT NOT NULL CHECK(state IN ('draft','confirmed')),
  ai_request_id TEXT REFERENCES ai_requests(id), created_at TEXT NOT NULL, PRIMARY KEY(note_id, version)
) STRICT;

-- note_attachment_refs
CREATE TABLE note_attachment_refs (
  note_id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL REFERENCES attachments(hash),
  PRIMARY KEY(note_id,version,hash), FOREIGN KEY(note_id,version) REFERENCES note_versions(note_id,version) ON DELETE CASCADE
) STRICT;

-- note_requests
CREATE TABLE note_requests (
  request_id TEXT PRIMARY KEY NOT NULL, input_hash TEXT NOT NULL, note_id TEXT NOT NULL, version INTEGER NOT NULL,
  FOREIGN KEY(note_id,version) REFERENCES note_versions(note_id,version) ON DELETE CASCADE
) STRICT;

-- attempt_note_versions
CREATE TABLE attempt_note_versions (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE, note_id TEXT NOT NULL, version INTEGER NOT NULL,
  PRIMARY KEY(attempt_id,note_id), FOREIGN KEY(note_id,version) REFERENCES note_versions(note_id,version) ON DELETE CASCADE
) STRICT;

-- activity_samples
CREATE TABLE activity_samples (
  id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL REFERENCES attempts(id),
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0 AND duration_ms <= 30000), occurred_at TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;

-- attachment_deletion_candidates
CREATE TABLE attachment_deletion_candidates (
  hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash) = 64), name TEXT NOT NULL,
  mime_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0), created_at TEXT NOT NULL
) STRICT;

-- company_datasets
CREATE TABLE company_datasets (
 id TEXT PRIMARY KEY NOT NULL, file_hash TEXT UNIQUE NOT NULL,
 data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;

-- interview_sessions
CREATE TABLE interview_sessions (
 id TEXT PRIMARY KEY NOT NULL, request_id TEXT UNIQUE NOT NULL,
 ended_at TEXT, data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;

-- interview_attempts
CREATE TABLE interview_attempts (
 attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES attempts(id),
 session_id TEXT NOT NULL REFERENCES interview_sessions(id)
) STRICT;

-- official_submissions
CREATE TABLE official_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  draft_revision INTEGER NOT NULL CHECK(draft_revision > 0),
  slug TEXT NOT NULL,
  source_id TEXT NOT NULL,
  submission_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('submitting','judging','paused','completed','unknown','error')),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  error_json TEXT NOT NULL CHECK(json_valid(error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK((status IN ('submitting','judging','paused') AND finished_at IS NULL)
    OR (status IN ('completed','unknown','error') AND finished_at IS NOT NULL)),
  CHECK((status = 'completed' AND result_json <> 'null') OR (status <> 'completed' AND result_json = 'null')),
  CHECK(status NOT IN ('judging','paused','completed') OR submission_id IS NOT NULL)
) STRICT;

-- submission_remarks
CREATE TABLE submission_remarks (
  local_run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  official_submission_id TEXT UNIQUE REFERENCES official_submissions(id) ON DELETE CASCADE,
  remark TEXT NOT NULL CHECK(length(remark) <= 240),
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_at TEXT NOT NULL,
  CHECK((local_run_id IS NOT NULL AND official_submission_id IS NULL)
    OR (local_run_id IS NULL AND official_submission_id IS NOT NULL))
) STRICT;

-- active_attempts
CREATE TABLE active_attempts (
  problem_id TEXT NOT NULL, language TEXT NOT NULL, mode TEXT NOT NULL, scope_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE, answer_format TEXT NOT NULL CHECK(answer_format IN ('function','acm')),
  PRIMARY KEY(problem_id, language, mode, scope_id, answer_format),
  FOREIGN KEY(attempt_id, problem_id, language, mode, scope_id, answer_format)
    REFERENCES attempts(id, problem_id, language, mode, draft_scope_id, answer_format)
) STRICT;

-- problem_review_meta
CREATE TABLE problem_review_meta (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL) STRICT;

-- problem_review_plans
CREATE TABLE problem_review_plans (
  id TEXT PRIMARY KEY NOT NULL, problem_id TEXT NOT NULL UNIQUE REFERENCES problems(id),
  initial_anchor TEXT, card_json TEXT CHECK(card_json IS NULL OR json_valid(card_json)),
  algorithm_version TEXT NOT NULL, parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),
  due_at TEXT, scheduled_at TEXT, suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(id,problem_id), CHECK((card_json IS NULL AND due_at IS NULL) OR (card_json IS NOT NULL AND due_at IS NOT NULL))
) STRICT;

-- problem_review_events
CREATE TABLE problem_review_events (
  id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE, sequence INTEGER NOT NULL UNIQUE,
  plan_id TEXT NOT NULL, problem_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('review','correction')), source TEXT NOT NULL CHECK(source IN ('manual','official')),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 4), observed_at TEXT NOT NULL,
  learning_date TEXT NOT NULL, time_zone TEXT NOT NULL, created_at TEXT NOT NULL,
  corrects_event_id TEXT REFERENCES problem_review_events(id), algorithm_version TEXT NOT NULL,
  attempt_id TEXT REFERENCES attempts(id), opportunity_id TEXT REFERENCES review_daily_ac_opportunities(id),
  stable_key TEXT NOT NULL, source_deleted INTEGER NOT NULL DEFAULT 0 CHECK(source_deleted IN (0,1)),
  FOREIGN KEY(plan_id,problem_id) REFERENCES problem_review_plans(id,problem_id),
  CHECK((kind = 'review' AND corrects_event_id IS NULL) OR (kind = 'correction' AND corrects_event_id IS NOT NULL))
) STRICT;

-- problem_review_day_assessments
CREATE TABLE problem_review_day_assessments (
  problem_id TEXT NOT NULL REFERENCES problems(id), learning_date TEXT NOT NULL,
  time_zone TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES problem_review_events(id),
  PRIMARY KEY(problem_id,learning_date)
) STRICT;

-- problem_review_requests
CREATE TABLE problem_review_requests (
  request_id TEXT PRIMARY KEY NOT NULL, input_hash TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES problem_review_events(id)
) STRICT;

-- review_daily_ac_opportunities
CREATE TABLE review_daily_ac_opportunities (
  id TEXT PRIMARY KEY NOT NULL, plan_id TEXT, problem_id TEXT NOT NULL REFERENCES problems(id),
  learning_date TEXT NOT NULL, time_zone TEXT NOT NULL, accepted_at TEXT NOT NULL,
  official_submission_id TEXT NOT NULL, submission_record_id TEXT REFERENCES official_submissions(id),
  attempt_id TEXT REFERENCES attempts(id), problem_version TEXT NOT NULL, code_hash TEXT NOT NULL CHECK(length(code_hash) = 64),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','skipped','assessed')),
  claimed_at TEXT, skipped_at TEXT, assessment_event_id TEXT REFERENCES problem_review_events(id),
  source_deleted INTEGER NOT NULL DEFAULT 0 CHECK(source_deleted IN (0,1)), created_at TEXT NOT NULL,
  UNIQUE(problem_id,learning_date), UNIQUE(submission_record_id),
  FOREIGN KEY(plan_id,problem_id) REFERENCES problem_review_plans(id,problem_id),
  CHECK((state = 'assessed' AND assessment_event_id IS NOT NULL) OR (state <> 'assessed' AND assessment_event_id IS NULL))
) STRICT;

-- review_assessment_drafts
CREATE TABLE review_assessment_drafts (
  key TEXT PRIMARY KEY NOT NULL, problem_id TEXT NOT NULL REFERENCES problems(id),
  source TEXT NOT NULL CHECK(source IN ('manual','official','correction')),
  opportunity_id TEXT REFERENCES review_daily_ac_opportunities(id), event_id TEXT REFERENCES problem_review_events(id),
  rating INTEGER CHECK(rating IS NULL OR rating BETWEEN 1 AND 4), request_id TEXT NOT NULL UNIQUE,
  learning_date TEXT NOT NULL, time_zone TEXT NOT NULL, observed_at TEXT NOT NULL, submitted_at TEXT,
  revision INTEGER NOT NULL CHECK(revision > 0), resolved_event_id TEXT REFERENCES problem_review_events(id), updated_at TEXT NOT NULL
) STRICT;

-- review_sessions
CREATE TABLE review_sessions (
  id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL,
  problem_ids_json TEXT NOT NULL CHECK(json_valid(problem_ids_json)), position INTEGER NOT NULL CHECK(position >= 0),
  status TEXT NOT NULL CHECK(status IN ('active','ended')), skipped_json TEXT NOT NULL CHECK(json_valid(skipped_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT,
  queue_policy TEXT NOT NULL CHECK(queue_policy IN ('recommended','selected')),
  scheduled_dates_json TEXT NOT NULL CHECK(json_valid(scheduled_dates_json)),
  CHECK((status = 'active' AND ended_at IS NULL) OR (status = 'ended' AND ended_at IS NOT NULL))
) STRICT;

-- drafts
CREATE TABLE drafts (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  language TEXT NOT NULL CHECK(language IN ('python','java','go','cpp')),
  scope_id TEXT NOT NULL, code TEXT NOT NULL, code_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0), saved_at TEXT NOT NULL,
  answer_format TEXT NOT NULL CHECK(answer_format IN ('function','acm')),
  spec_version TEXT NOT NULL, test_config_json TEXT NOT NULL CHECK(json_valid(test_config_json)),
  PRIMARY KEY(problem_id, language, scope_id, answer_format)
) STRICT;

-- attempts
CREATE TABLE attempts (
  id TEXT PRIMARY KEY NOT NULL, problem_id TEXT NOT NULL,
  language TEXT NOT NULL CHECK(language IN ('python','java','go','cpp')),
  problem_version TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('practice','strict','coached')),
  started_at TEXT NOT NULL, draft_scope_id TEXT NOT NULL DEFAULT 'practice', ended_at TEXT,
  final_code TEXT, final_code_hash TEXT, final_draft_revision INTEGER,
  final_last_run_id TEXT REFERENCES runs(id),
  last_run_matches_final INTEGER NOT NULL DEFAULT 0 CHECK(last_run_matches_final IN (0,1)),
  restored_from_run_id TEXT REFERENCES runs(id),
  answer_format TEXT NOT NULL DEFAULT 'function' CHECK(answer_format IN ('function','acm')),
  spec_version TEXT NOT NULL DEFAULT 'native-v1',
  final_test_config_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(final_test_config_json)),
  FOREIGN KEY(problem_id, problem_version) REFERENCES problem_versions(problem_id, version)
) STRICT;

-- index runs_by_attempt on runs
CREATE INDEX runs_by_attempt ON runs(attempt_id, created_at);

-- index runs_trusted_pass on runs: an attempt's first solve is one seek (learning/verdicts.ts)
CREATE INDEX runs_trusted_pass ON runs(attempt_id, created_at) WHERE status = 'passed' AND expected_output_source = 'native-samples';

-- index list_items_by_problem on list_items
CREATE INDEX list_items_by_problem ON list_items(problem_id);

-- index ai_requests_by_attempt on ai_requests
CREATE INDEX ai_requests_by_attempt ON ai_requests(attempt_id, created_at);

-- index ai_completed_cache on ai_requests
CREATE INDEX ai_completed_cache ON ai_requests(request_hash) WHERE status = 'completed';

-- index notes_by_subject on notes
CREATE INDEX notes_by_subject ON notes(kind, subject_id);

-- index activity_by_attempt on activity_samples
CREATE INDEX activity_by_attempt ON activity_samples(attempt_id,occurred_at);

-- index one_active_interview on interview_sessions
CREATE UNIQUE INDEX one_active_interview ON interview_sessions((1)) WHERE ended_at IS NULL;

-- index official_by_attempt on official_submissions
CREATE INDEX official_by_attempt ON official_submissions(attempt_id, created_at);

-- index official_active_attempt on official_submissions
CREATE UNIQUE INDEX official_active_attempt ON official_submissions(attempt_id) WHERE status IN ('submitting','judging');

-- index problem_review_due on problem_review_plans
CREATE INDEX problem_review_due ON problem_review_plans(due_at,problem_id);

-- index problem_review_history on problem_review_events
CREATE INDEX problem_review_history ON problem_review_events(plan_id,observed_at,stable_key);

-- index problem_review_corrections on problem_review_events
CREATE INDEX problem_review_corrections ON problem_review_events(corrects_event_id,sequence DESC);

-- index problem_review_by_day on problem_review_events
CREATE INDEX problem_review_by_day ON problem_review_events(learning_date,problem_id) WHERE kind = 'review';

-- index review_ac_pending on review_daily_ac_opportunities
CREATE INDEX review_ac_pending ON review_daily_ac_opportunities(state,accepted_at);

-- index one_active_review_session on review_sessions
CREATE UNIQUE INDEX one_active_review_session ON review_sessions(status) WHERE status = 'active';

-- index attempt_scope_identity on attempts
CREATE UNIQUE INDEX attempt_scope_identity ON attempts(id, problem_id, language, mode, draft_scope_id);

-- index attempt_format_identity on attempts
CREATE UNIQUE INDEX attempt_format_identity ON attempts(id, problem_id, language, mode, draft_scope_id, answer_format);

-- index attempts_by_problem_language on attempts
CREATE INDEX attempts_by_problem_language ON attempts(problem_id, language);

-- view problem_review_effective_events (problem_review_effective_events)
CREATE VIEW problem_review_effective_events AS
SELECT e.*, COALESCE((SELECT c.rating FROM problem_review_events c WHERE c.corrects_event_id = e.id
  AND c.kind = 'correction' ORDER BY c.sequence DESC LIMIT 1),e.rating) AS effective_rating,
  CASE WHEN NOT EXISTS(SELECT 1 FROM problem_review_events p
    WHERE p.plan_id = e.plan_id AND p.kind = 'review' AND p.id <> e.id AND
      (p.observed_at < e.observed_at OR (p.observed_at = e.observed_at AND p.stable_key < e.stable_key)))
    THEN 1 ELSE 0 END AS is_initial
FROM problem_review_events e WHERE e.kind = 'review';

-- trigger immutable_problem_version on problem_versions
CREATE TRIGGER immutable_problem_version BEFORE UPDATE ON problem_versions
BEGIN SELECT RAISE(ABORT, 'problem version is immutable'); END;

-- trigger immutable_run_snapshot on runs
CREATE TRIGGER immutable_run_snapshot BEFORE UPDATE OF
  id, attempt_id, code, code_hash, test_suite_version, test_snapshot_json,
  adapter_version, created_at ON runs
BEGIN SELECT RAISE(ABORT, 'run snapshot is immutable'); END;

-- trigger immutable_run_runtime on runs
CREATE TRIGGER immutable_run_runtime BEFORE UPDATE OF runtime_version ON runs
WHEN OLD.status <> 'queued' OR NEW.status = 'queued' OR length(trim(NEW.runtime_version)) = 0
BEGIN SELECT RAISE(ABORT, 'run runtime may only be finalized with its terminal result'); END;

-- trigger immutable_run_result on runs
CREATE TRIGGER immutable_run_result BEFORE UPDATE ON runs WHEN OLD.status <> 'queued'
BEGIN SELECT RAISE(ABORT, 'run terminal result is immutable'); END;

-- trigger immutable_attachment on attachments
CREATE TRIGGER immutable_attachment BEFORE UPDATE ON attachments BEGIN SELECT RAISE(ABORT, 'attachment metadata is immutable'); END;

-- trigger immutable_ai_request on ai_requests
CREATE TRIGGER immutable_ai_request BEFORE UPDATE OF id,attempt_id,request_hash,snapshot_json,created_at ON ai_requests
BEGIN SELECT RAISE(ABORT, 'AI request snapshot is immutable'); END;

-- trigger immutable_note_identity on notes
CREATE TRIGGER immutable_note_identity BEFORE UPDATE OF id,kind,subject_id,created_at ON notes
BEGIN SELECT RAISE(ABORT, 'note identity is immutable'); END;

-- trigger immutable_note_attachment_ref on note_attachment_refs
CREATE TRIGGER immutable_note_attachment_ref BEFORE UPDATE ON note_attachment_refs
BEGIN SELECT RAISE(ABORT, 'note attachment references are immutable'); END;

-- trigger immutable_attempt_note_ref on attempt_note_versions
CREATE TRIGGER immutable_attempt_note_ref BEFORE UPDATE ON attempt_note_versions
BEGIN SELECT RAISE(ABORT, 'archived note references are immutable'); END;

-- trigger immutable_activity on activity_samples
CREATE TRIGGER immutable_activity BEFORE UPDATE ON activity_samples BEGIN SELECT RAISE(ABORT, 'activity samples are immutable'); END;

-- trigger immutable_note_version on note_versions
CREATE TRIGGER immutable_note_version BEFORE UPDATE OF
  note_id, version, title, markdown, tags_json, origin, state, created_at ON note_versions
BEGIN SELECT RAISE(ABORT, 'note version is immutable'); END;

-- trigger immutable_note_ai_source on note_versions
CREATE TRIGGER immutable_note_ai_source BEFORE UPDATE OF ai_request_id ON note_versions
WHEN NOT (OLD.ai_request_id IS NOT NULL AND NEW.ai_request_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'note AI source may only be detached'); END;

-- trigger immutable_ai_terminal on ai_requests
CREATE TRIGGER immutable_ai_terminal BEFORE UPDATE OF
  status, response_json, error_json, usage_json, finished_at ON ai_requests WHEN OLD.finished_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'AI terminal result is immutable'); END;

-- trigger immutable_ai_cache_source on ai_requests
CREATE TRIGGER immutable_ai_cache_source BEFORE UPDATE OF cached_from_request_id ON ai_requests
WHEN OLD.finished_at IS NOT NULL AND NOT (OLD.cached_from_request_id IS NOT NULL AND NEW.cached_from_request_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'AI cache source may only be detached'); END;

-- trigger immutable_company_dataset on company_datasets
CREATE TRIGGER immutable_company_dataset BEFORE UPDATE ON company_datasets
BEGIN SELECT RAISE(ABORT, 'company dataset versions are immutable'); END;

-- trigger immutable_finished_interview on interview_sessions
CREATE TRIGGER immutable_finished_interview BEFORE UPDATE ON interview_sessions WHEN OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'finished interview is immutable'); END;

-- trigger immutable_official_snapshot on official_submissions
CREATE TRIGGER immutable_official_snapshot BEFORE UPDATE OF
  id, attempt_id, code, code_hash, draft_revision, slug, source_id, created_at ON official_submissions
BEGIN SELECT RAISE(ABORT, 'official submission snapshot is immutable'); END;

-- trigger immutable_official_id on official_submissions
CREATE TRIGGER immutable_official_id BEFORE UPDATE OF submission_id ON official_submissions
WHEN OLD.submission_id IS NOT NULL AND OLD.submission_id IS NOT NEW.submission_id
BEGIN SELECT RAISE(ABORT, 'official submission id is immutable'); END;

-- trigger immutable_official_result on official_submissions
CREATE TRIGGER immutable_official_result BEFORE UPDATE ON official_submissions
WHEN OLD.status IN ('completed','unknown','error')
BEGIN SELECT RAISE(ABORT, 'official terminal result is immutable'); END;

-- trigger immutable_problem_review_plan on problem_review_plans
CREATE TRIGGER immutable_problem_review_plan BEFORE UPDATE OF id,problem_id,algorithm_version,parameters_json,created_at ON problem_review_plans
BEGIN SELECT RAISE(ABORT, 'problem review identity and algorithm are immutable'); END;

-- trigger immutable_problem_review_event on problem_review_events
CREATE TRIGGER immutable_problem_review_event BEFORE UPDATE OF
  id,request_id,sequence,plan_id,problem_id,kind,source,rating,observed_at,learning_date,time_zone,created_at,corrects_event_id,algorithm_version,opportunity_id,stable_key
  ON problem_review_events BEGIN SELECT RAISE(ABORT, 'problem review events are immutable'); END;

-- trigger detach_problem_review_event on problem_review_events
CREATE TRIGGER detach_problem_review_event BEFORE UPDATE OF attempt_id ON problem_review_events
WHEN NOT (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'problem review source may only be detached'); END;

-- trigger immutable_problem_review_deleted on problem_review_events
CREATE TRIGGER immutable_problem_review_deleted BEFORE UPDATE OF source_deleted ON problem_review_events WHEN NEW.source_deleted < OLD.source_deleted
BEGIN SELECT RAISE(ABORT, 'deleted review source cannot be restored'); END;

-- trigger immutable_problem_review_day on problem_review_day_assessments
CREATE TRIGGER immutable_problem_review_day BEFORE UPDATE ON problem_review_day_assessments
BEGIN SELECT RAISE(ABORT, 'review day slots are immutable'); END;

-- trigger immutable_problem_review_request on problem_review_requests
CREATE TRIGGER immutable_problem_review_request BEFORE UPDATE ON problem_review_requests
BEGIN SELECT RAISE(ABORT, 'review request identities are immutable'); END;

-- trigger immutable_review_ac_identity on review_daily_ac_opportunities
CREATE TRIGGER immutable_review_ac_identity BEFORE UPDATE OF
  id,plan_id,problem_id,learning_date,time_zone,accepted_at,official_submission_id,problem_version,code_hash,created_at ON review_daily_ac_opportunities
BEGIN SELECT RAISE(ABORT, 'Accepted evidence is immutable'); END;

-- trigger detach_review_ac_record on review_daily_ac_opportunities
CREATE TRIGGER detach_review_ac_record BEFORE UPDATE OF submission_record_id ON review_daily_ac_opportunities
WHEN NOT (OLD.submission_record_id IS NOT NULL AND NEW.submission_record_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'Accepted source may only be detached'); END;

-- trigger detach_review_ac_attempt on review_daily_ac_opportunities
CREATE TRIGGER detach_review_ac_attempt BEFORE UPDATE OF attempt_id ON review_daily_ac_opportunities
WHEN NOT (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'Accepted attempt may only be detached'); END;

-- trigger immutable_review_ac_resolution on review_daily_ac_opportunities
CREATE TRIGGER immutable_review_ac_resolution BEFORE UPDATE OF state ON review_daily_ac_opportunities
WHEN OLD.state = 'assessed' AND NEW.state <> OLD.state
BEGIN SELECT RAISE(ABORT, 'resolved Accepted opportunity cannot be reopened'); END;

-- trigger immutable_review_ac_claim on review_daily_ac_opportunities
CREATE TRIGGER immutable_review_ac_claim BEFORE UPDATE OF claimed_at ON review_daily_ac_opportunities
WHEN OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS NOT OLD.claimed_at
BEGIN SELECT RAISE(ABORT, 'automatic review opportunity was already consumed'); END;

-- trigger immutable_review_ac_deleted on review_daily_ac_opportunities
CREATE TRIGGER immutable_review_ac_deleted BEFORE UPDATE OF source_deleted ON review_daily_ac_opportunities WHEN NEW.source_deleted < OLD.source_deleted
BEGIN SELECT RAISE(ABORT, 'deleted Accepted source cannot be restored'); END;

-- trigger immutable_review_session_identity on review_sessions
CREATE TRIGGER immutable_review_session_identity BEFORE UPDATE OF id,request_id,input_hash,problem_ids_json,queue_policy,scheduled_dates_json,created_at ON review_sessions
BEGIN SELECT RAISE(ABORT, 'review session queue is immutable'); END;

-- trigger immutable_review_session_terminal on review_sessions
CREATE TRIGGER immutable_review_session_terminal BEFORE UPDATE ON review_sessions WHEN OLD.status = 'ended'
BEGIN SELECT RAISE(ABORT, 'ended review session is immutable'); END;

-- trigger problem_review_plan_insert_revision on problem_review_plans
CREATE TRIGGER problem_review_plan_insert_revision AFTER INSERT ON problem_review_plans BEGIN UPDATE problem_review_meta SET revision = revision + 1 WHERE id = 1; END;

-- trigger problem_review_plan_update_revision on problem_review_plans
CREATE TRIGGER problem_review_plan_update_revision AFTER UPDATE ON problem_review_plans BEGIN UPDATE problem_review_meta SET revision = revision + 1 WHERE id = 1; END;

-- trigger problem_review_event_insert_revision on problem_review_events
CREATE TRIGGER problem_review_event_insert_revision AFTER INSERT ON problem_review_events BEGIN UPDATE problem_review_meta SET revision = revision + 1 WHERE id = 1; END;

-- trigger problem_review_event_update_revision on problem_review_events
CREATE TRIGGER problem_review_event_update_revision AFTER UPDATE ON problem_review_events BEGIN UPDATE problem_review_meta SET revision = revision + 1 WHERE id = 1; END;

-- trigger review_ac_insert_revision on review_daily_ac_opportunities
CREATE TRIGGER review_ac_insert_revision AFTER INSERT ON review_daily_ac_opportunities BEGIN UPDATE problem_review_meta SET revision = revision + 1 WHERE id = 1; END;

-- trigger review_ac_update_revision on review_daily_ac_opportunities
CREATE TRIGGER review_ac_update_revision AFTER UPDATE ON review_daily_ac_opportunities BEGIN UPDATE problem_review_meta SET revision = revision + 1 WHERE id = 1; END;

-- trigger immutable_attempt on attempts
CREATE TRIGGER immutable_attempt BEFORE UPDATE OF
  id, problem_id, language, problem_version, mode, started_at, draft_scope_id ON attempts
BEGIN SELECT RAISE(ABORT, 'attempt identity is immutable'); END;

-- trigger immutable_attempt_source on attempts
CREATE TRIGGER immutable_attempt_source BEFORE UPDATE OF restored_from_run_id ON attempts
WHEN NOT (OLD.restored_from_run_id IS NOT NULL AND NEW.restored_from_run_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'attempt source may only be detached'); END;

-- trigger immutable_finished_attempt on attempts
CREATE TRIGGER immutable_finished_attempt BEFORE UPDATE OF
  ended_at, final_code, final_code_hash, final_draft_revision, final_last_run_id, last_run_matches_final, final_test_config_json
  ON attempts WHEN OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'finished attempt is immutable'); END;

-- trigger coherent_attempt_final on attempts
CREATE TRIGGER coherent_attempt_final BEFORE UPDATE ON attempts WHEN NEW.ended_at IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.final_code IS NULL OR NEW.final_code_hash IS NULL OR NEW.final_draft_revision IS NULL
    THEN RAISE(ABORT, 'finished attempt requires a final draft snapshot') END;
  SELECT CASE WHEN NEW.final_last_run_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM runs WHERE id = NEW.final_last_run_id AND attempt_id = NEW.id)
    THEN RAISE(ABORT, 'final run must belong to the attempt') END;
END;

-- trigger immutable_attempt_format on attempts
CREATE TRIGGER immutable_attempt_format BEFORE UPDATE OF answer_format, spec_version ON attempts
BEGIN SELECT RAISE(ABORT, 'attempt format is immutable'); END;
`;
