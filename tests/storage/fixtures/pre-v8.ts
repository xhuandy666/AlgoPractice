import type { DatabaseSync } from 'node:sqlite';

/** Test fixture only: strip the new dimensions before simulating an older released database. */
export function stripAnswerFormatSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA foreign_keys=OFF;
    DROP TRIGGER immutable_attempt_format;
    DROP TRIGGER immutable_finished_attempt;
    CREATE TRIGGER immutable_finished_attempt BEFORE UPDATE OF
      ended_at, final_code, final_code_hash, final_draft_revision, final_last_run_id, last_run_matches_final
      ON attempts WHEN OLD.ended_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'finished attempt is immutable'); END;
    ALTER TABLE active_attempts RENAME TO active_attempts_v8_fixture;
    CREATE TABLE active_attempts (
      problem_id TEXT NOT NULL, language TEXT NOT NULL, mode TEXT NOT NULL, scope_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY(problem_id, language, mode, scope_id),
      FOREIGN KEY(attempt_id, problem_id, language, mode, scope_id) REFERENCES attempts(id, problem_id, language, mode, draft_scope_id)
    ) STRICT;
    INSERT INTO active_attempts SELECT problem_id, language, mode, scope_id, attempt_id FROM active_attempts_v8_fixture;
    DROP TABLE active_attempts_v8_fixture;
    DROP INDEX attempt_format_identity;
    ALTER TABLE attempts DROP COLUMN answer_format;
    ALTER TABLE attempts DROP COLUMN spec_version;
    ALTER TABLE attempts DROP COLUMN final_test_config_json;
    ALTER TABLE drafts RENAME TO drafts_v8_fixture;
    CREATE TABLE drafts (
      problem_id TEXT NOT NULL REFERENCES problems(id), language TEXT NOT NULL CHECK(language IN ('python','java')),
      scope_id TEXT NOT NULL, code TEXT NOT NULL, code_hash TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), saved_at TEXT NOT NULL,
      PRIMARY KEY(problem_id, language, scope_id)
    ) STRICT;
    INSERT INTO drafts SELECT problem_id, language, scope_id, code, code_hash, revision, saved_at FROM drafts_v8_fixture;
    DROP TABLE drafts_v8_fixture;
    PRAGMA user_version=7; PRAGMA foreign_keys=ON;`);
}
