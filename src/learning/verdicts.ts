import type { CompletionBlocker } from '../shared/learning.ts';

// The verdicts every statistic agrees on, as SQL over a runs or official_submissions row (pass its alias, if any).
// A local run solves its problem only against the problem's own expected outputs: ACM cases the user typed in are a
// self-check, and a run without expected outputs is not judged at all.
const column = (alias: string, name: string) => alias ? `${alias}.${name}` : name;
export const trustedPassSql = (alias = '') =>
  `(${column(alias, 'status')} = 'passed' AND ${column(alias, 'expected_output_source')} = 'native-samples')`;
export const officialAcceptedSql = (alias = '') =>
  `(${column(alias, 'status')} = 'completed' AND json_extract(${column(alias, 'result_json')}, '$.status') = 'accepted')`;

/** Run outcomes that judge the code wrong whatever its expected outputs: a failed comparison, or code that did not build or finish. */
const JUDGED_FAILURES = `('wrong_answer','compile_error','runtime_error','timeout','output_limit')`;
/** Runs that executed the code; cancelled, interrupted or environment-failed runs did not. */
const EXECUTED = `('passed','completed','wrong_answer','compile_error','runtime_error','timeout','output_limit')`;
/** One row per attempt (alias a, filtered by `where`). completed_at is when it counts as completed, or NULL:
 * - at its first solve (a pass on the problem's own cases, or an official Accepted), whenever that is;
 * - otherwise at its end, if before ending its final code ran without failing (or reached the official judge) and no
 *   official judge rejected that code. Most LeetCode problems cannot be judged locally, so for them a run and the end
 *   are the signal.
 * end_blocker says why an end does not count: 'failed' (the latest run of the final code before the end failed, or an
 * official judge rejected it) or 'unrun' (the final code was neither run nor submitted before the end). */
export function attemptCompletionsSql(where = '') {
  const failed: CompletionBlocker = 'failed', unrun: CompletionBlocker = 'unrun';
  const blocker = `CASE WHEN ended_at IS NULL THEN NULL
      WHEN rejected OR final_run_status IN ${JUDGED_FAILURES} THEN '${failed}'
      WHEN final_run_status IN ('passed','completed') OR (final_run_status IS NULL AND submitted) THEN NULL
      ELSE '${unrun}' END`;
  // "LIMIT -1" keeps SQLite from flattening these subqueries: flattened, every reference to a column re-runs its
  // correlated subquery, several times per attempt.
  return `SELECT attempt_id, problem_id, end_blocker,
      CASE WHEN solved_at IS NULL OR (end_ok IS NOT NULL AND end_ok < solved_at) THEN end_ok ELSE solved_at END AS completed_at
    FROM (SELECT attempt_id, problem_id, solved_at, end_blocker, CASE WHEN ended_at IS NOT NULL AND end_blocker IS NULL THEN ended_at END AS end_ok
      FROM (SELECT attempt_id, problem_id, solved_at, ended_at, ${blocker} AS end_blocker
      FROM (SELECT a.id AS attempt_id, a.problem_id, a.ended_at,
          (SELECT MIN(at) FROM (SELECT r.created_at AS at FROM runs r WHERE r.attempt_id = a.id AND ${trustedPassSql('r')}
            UNION ALL SELECT s.finished_at FROM official_submissions s WHERE s.attempt_id = a.id AND ${officialAcceptedSql('s')})) AS solved_at,
          (SELECT r.status FROM runs r WHERE r.attempt_id = a.id AND r.code_hash = a.final_code_hash AND r.created_at <= a.ended_at
            AND r.status IN ${EXECUTED} ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS final_run_status,
          EXISTS(SELECT 1 FROM official_submissions s WHERE s.attempt_id = a.id AND s.code_hash = a.final_code_hash
            AND s.created_at <= a.ended_at AND s.submission_id IS NOT NULL) AS submitted,
          EXISTS(SELECT 1 FROM official_submissions s WHERE s.attempt_id = a.id AND s.code_hash = a.final_code_hash
            AND s.status = 'completed' AND json_extract(s.result_json, '$.status') <> 'accepted') AS rejected
        FROM attempts a${where ? ` WHERE ${where}` : ''} LIMIT -1) LIMIT -1) LIMIT -1)`;
}
