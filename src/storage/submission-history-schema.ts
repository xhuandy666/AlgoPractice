/** Mutable annotations are separate from immutable code and judge snapshots. */
export const MIGRATE_V7 = `
CREATE TABLE submission_remarks (
  local_run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  official_submission_id TEXT UNIQUE REFERENCES official_submissions(id) ON DELETE CASCADE,
  remark TEXT NOT NULL CHECK(length(remark) <= 240),
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_at TEXT NOT NULL,
  CHECK((local_run_id IS NOT NULL AND official_submission_id IS NULL)
    OR (local_run_id IS NULL AND official_submission_id IS NOT NULL))
) STRICT;
CREATE INDEX attempts_by_problem_language ON attempts(problem_id, language);
`;
