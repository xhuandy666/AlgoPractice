/** v8 preserves original snapshots and reserves unknown drafts instead of guessing a format. */
export const MIGRATE_V8 = `
DROP TRIGGER immutable_finished_attempt;
ALTER TABLE attempts ADD COLUMN answer_format TEXT NOT NULL DEFAULT 'function' CHECK(answer_format IN ('function','acm'));
ALTER TABLE attempts ADD COLUMN spec_version TEXT NOT NULL DEFAULT 'native-v1';
ALTER TABLE attempts ADD COLUMN final_test_config_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(final_test_config_json));
UPDATE attempts SET answer_format = CASE WHEN (SELECT json_extract(snapshot_json, '$.mode') FROM problem_versions
  WHERE problem_id = attempts.problem_id AND version = attempts.problem_version) = 'acm' THEN 'acm' ELSE 'function' END;
CREATE TRIGGER immutable_finished_attempt BEFORE UPDATE OF
  ended_at, final_code, final_code_hash, final_draft_revision, final_last_run_id, last_run_matches_final, final_test_config_json
  ON attempts WHEN OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'finished attempt is immutable'); END;
CREATE TRIGGER immutable_attempt_format BEFORE UPDATE OF answer_format, spec_version ON attempts
BEGIN SELECT RAISE(ABORT, 'attempt format is immutable'); END;
CREATE UNIQUE INDEX attempt_format_identity ON attempts(id, problem_id, language, mode, draft_scope_id, answer_format);
ALTER TABLE active_attempts RENAME TO active_attempts_v7;
CREATE TABLE active_attempts (
  problem_id TEXT NOT NULL, language TEXT NOT NULL, mode TEXT NOT NULL, scope_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE, answer_format TEXT NOT NULL CHECK(answer_format IN ('function','acm')),
  PRIMARY KEY(problem_id, language, mode, scope_id, answer_format),
  FOREIGN KEY(attempt_id, problem_id, language, mode, scope_id, answer_format)
    REFERENCES attempts(id, problem_id, language, mode, draft_scope_id, answer_format)
) STRICT;
INSERT INTO active_attempts SELECT old.*, a.answer_format FROM active_attempts_v7 old JOIN attempts a ON a.id = old.attempt_id;
DROP TABLE active_attempts_v7;
ALTER TABLE drafts RENAME TO drafts_v7;
CREATE TABLE drafts (
  problem_id TEXT NOT NULL REFERENCES problems(id), language TEXT NOT NULL CHECK(language IN ('python','java')),
  scope_id TEXT NOT NULL, code TEXT NOT NULL, code_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0), saved_at TEXT NOT NULL,
  answer_format TEXT NOT NULL CHECK(answer_format IN ('function','acm','legacy')),
  spec_version TEXT NOT NULL, test_config_json TEXT NOT NULL CHECK(json_valid(test_config_json)),
  PRIMARY KEY(problem_id, language, scope_id, answer_format)
) STRICT;
INSERT INTO drafts SELECT d.*, COALESCE(
  (SELECT a.answer_format FROM active_attempts active JOIN attempts a ON a.id = active.attempt_id
    WHERE active.problem_id = d.problem_id AND active.language = d.language AND active.scope_id = d.scope_id
    GROUP BY active.problem_id HAVING COUNT(DISTINCT a.answer_format) = 1),
  (SELECT CASE WHEN COUNT(*) = SUM(CASE WHEN json_extract(v.snapshot_json,'$.mode') IN ('function','acm') THEN 1 ELSE 0 END)
      AND COUNT(DISTINCT json_extract(v.snapshot_json,'$.mode')) = 1 THEN MAX(json_extract(v.snapshot_json,'$.mode')) END
    FROM problem_versions v WHERE v.problem_id = d.problem_id),
  'legacy'), 'native-v1', 'null' FROM drafts_v7 d;
DROP TABLE drafts_v7;
`;
