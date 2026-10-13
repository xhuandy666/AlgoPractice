/** v10 widens stable language IDs without changing a historical snapshot or draft dimension.
 * Run only inside the constructor's migration transaction, with foreign_keys disabled BEFORE BEGIN.
 * Creating the replacement first avoids SQLite renaming references to the old parent table.
 */
export const MIGRATE_V10 = `
CREATE TABLE drafts_v10 (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  language TEXT NOT NULL CHECK(language IN ('python','java','go','cpp')),
  scope_id TEXT NOT NULL, code TEXT NOT NULL, code_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0), saved_at TEXT NOT NULL,
  answer_format TEXT NOT NULL CHECK(answer_format IN ('function','acm','legacy')),
  spec_version TEXT NOT NULL, test_config_json TEXT NOT NULL CHECK(json_valid(test_config_json)),
  PRIMARY KEY(problem_id, language, scope_id, answer_format)
) STRICT;
INSERT INTO drafts_v10(rowid, problem_id, language, scope_id, code, code_hash, revision, saved_at,
  answer_format, spec_version, test_config_json)
SELECT rowid, problem_id, language, scope_id, code, code_hash, revision, saved_at,
  answer_format, spec_version, test_config_json FROM drafts;
DROP TABLE drafts;
ALTER TABLE drafts_v10 RENAME TO drafts;
CREATE TABLE attempts_v10 (
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
INSERT INTO attempts_v10(rowid, id, problem_id, language, problem_version, mode, started_at, draft_scope_id,
  ended_at, final_code, final_code_hash, final_draft_revision, final_last_run_id, last_run_matches_final,
  restored_from_run_id, answer_format, spec_version, final_test_config_json)
SELECT rowid, id, problem_id, language, problem_version, mode, started_at, draft_scope_id,
  ended_at, final_code, final_code_hash, final_draft_revision, final_last_run_id, last_run_matches_final,
  restored_from_run_id, answer_format, spec_version, final_test_config_json FROM attempts;
DROP TABLE attempts;
ALTER TABLE attempts_v10 RENAME TO attempts;
CREATE UNIQUE INDEX attempt_scope_identity ON attempts(id, problem_id, language, mode, draft_scope_id);
CREATE UNIQUE INDEX attempt_format_identity ON attempts(id, problem_id, language, mode, draft_scope_id, answer_format);
CREATE INDEX attempts_by_problem_language ON attempts(problem_id, language);
CREATE TRIGGER immutable_attempt BEFORE UPDATE OF
  id, problem_id, language, problem_version, mode, started_at, draft_scope_id ON attempts
BEGIN SELECT RAISE(ABORT, 'attempt identity is immutable'); END;
CREATE TRIGGER immutable_attempt_source BEFORE UPDATE OF restored_from_run_id ON attempts
WHEN NOT (OLD.restored_from_run_id IS NOT NULL AND NEW.restored_from_run_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'attempt source may only be detached'); END;
CREATE TRIGGER immutable_finished_attempt BEFORE UPDATE OF
  ended_at, final_code, final_code_hash, final_draft_revision, final_last_run_id, last_run_matches_final, final_test_config_json
  ON attempts WHEN OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'finished attempt is immutable'); END;
CREATE TRIGGER coherent_attempt_final BEFORE UPDATE ON attempts WHEN NEW.ended_at IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.final_code IS NULL OR NEW.final_code_hash IS NULL OR NEW.final_draft_revision IS NULL
    THEN RAISE(ABORT, 'finished attempt requires a final draft snapshot') END;
  SELECT CASE WHEN NEW.final_last_run_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM runs WHERE id = NEW.final_last_run_id AND attempt_id = NEW.id)
    THEN RAISE(ABORT, 'final run must belong to the attempt') END;
END;
CREATE TRIGGER immutable_attempt_format BEFORE UPDATE OF answer_format, spec_version ON attempts
BEGIN SELECT RAISE(ABORT, 'attempt format is immutable'); END;
`;
