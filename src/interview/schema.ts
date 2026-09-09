export const MIGRATE_V5 = `
CREATE TABLE company_datasets (
 id TEXT PRIMARY KEY NOT NULL, file_hash TEXT UNIQUE NOT NULL,
 data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;
CREATE TRIGGER immutable_company_dataset BEFORE UPDATE ON company_datasets
BEGIN SELECT RAISE(ABORT, 'company dataset versions are immutable'); END;
CREATE TABLE interview_sessions (
 id TEXT PRIMARY KEY NOT NULL, request_id TEXT UNIQUE NOT NULL,
 ended_at TEXT, data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;
CREATE UNIQUE INDEX one_active_interview ON interview_sessions((1)) WHERE ended_at IS NULL;
CREATE TRIGGER immutable_finished_interview BEFORE UPDATE ON interview_sessions WHEN OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'finished interview is immutable'); END;
CREATE TABLE interview_attempts (
 attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES attempts(id),
 session_id TEXT NOT NULL REFERENCES interview_sessions(id)
) STRICT;
`;
