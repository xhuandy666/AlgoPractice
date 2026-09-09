-- Frozen P1 schema (user_version = 1), used to verify a real upgrade rather than a v2-shaped fixture.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE problems (id TEXT PRIMARY KEY NOT NULL) STRICT;
CREATE TABLE problem_versions (
  problem_id TEXT NOT NULL REFERENCES problems(id), version TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), PRIMARY KEY(problem_id, version)
) STRICT;
CREATE TABLE drafts (
  problem_id TEXT NOT NULL REFERENCES problems(id), language TEXT NOT NULL CHECK(language IN ('python', 'java')),
  scope_id TEXT NOT NULL, code TEXT NOT NULL, code_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0), saved_at TEXT NOT NULL,
  PRIMARY KEY(problem_id, language, scope_id)
) STRICT;
CREATE TABLE attempts (
  id TEXT PRIMARY KEY NOT NULL, problem_id TEXT NOT NULL,
  language TEXT NOT NULL CHECK(language IN ('python', 'java')), problem_version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('practice', 'strict', 'coached')), started_at TEXT NOT NULL,
  FOREIGN KEY(problem_id, problem_version) REFERENCES problem_versions(problem_id, version)
) STRICT;
CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL REFERENCES attempts(id),
  code TEXT NOT NULL, code_hash TEXT NOT NULL, test_suite_version TEXT NOT NULL,
  test_snapshot_json TEXT NOT NULL CHECK(json_valid(test_snapshot_json)),
  adapter_version TEXT NOT NULL, runtime_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'passed', 'completed', 'wrong_answer', 'compile_error', 'runtime_error',
    'timeout', 'cancelled', 'output_limit', 'environment_error', 'invalid_request', 'internal_error', 'interrupted')),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL, finished_at TEXT,
  CHECK((status = 'queued' AND finished_at IS NULL AND result_json = 'null') OR (status <> 'queued' AND finished_at IS NOT NULL))
) STRICT;
CREATE INDEX runs_by_attempt ON runs(attempt_id, created_at);
CREATE TRIGGER immutable_problem_version BEFORE UPDATE ON problem_versions
BEGIN SELECT RAISE(ABORT, 'problem version is immutable'); END;
CREATE TRIGGER immutable_attempt BEFORE UPDATE ON attempts
BEGIN SELECT RAISE(ABORT, 'attempt identity is immutable'); END;
CREATE TRIGGER immutable_run_snapshot BEFORE UPDATE OF
  id, attempt_id, code, code_hash, test_suite_version, test_snapshot_json, adapter_version, runtime_version, created_at ON runs
BEGIN SELECT RAISE(ABORT, 'run snapshot is immutable'); END;
CREATE TRIGGER immutable_run_result BEFORE UPDATE ON runs WHEN OLD.status <> 'queued'
BEGIN SELECT RAISE(ABORT, 'run terminal result is immutable'); END;
PRAGMA user_version = 1;
