import type { AiHelpDecision, AiHelpRun, AiHelpState, AiMode } from '../shared/ai.ts';

/** Run outcomes that count as the user's code failing, besides a wrong answer against a trusted expectation. */
export const FAILED_RUN_STATUSES = ['runtime_error', 'timeout', 'output_limit'] as const;

/** Pure: chronological persisted runs in, one display decision out. No API call or code-edit reset.
 * Three consecutive failures of the user's own code (a wrong answer against trusted expectations, a crash, a timeout, or
 * code that does not compile) suggest the AI coach, once per attempt; a trusted pass resets the streak. A single compile
 * or syntax error is routine and must not use up that one suggestion. */
export function helpCardDecision(input: { attemptId: string; mode: AiMode; isActive: boolean; runs: AiHelpRun[]; state: AiHelpState }): AiHelpDecision {
  let consecutiveFailures = 0;
  const seen = new Set<string>();
  for (const run of input.runs) {
    if (run.attemptId !== input.attemptId || seen.has(run.id)) continue;
    seen.add(run.id);
    if (run.status === 'passed' && run.executed && run.trustworthyExpected) { consecutiveFailures = 0; continue; }
    if (!run.attributableToUser) continue;
    if (run.status === 'compile_error'
      || (run.executed && ((run.status === 'wrong_answer' && run.trustworthyExpected) || (FAILED_RUN_STATUSES as readonly string[]).includes(run.status)))) consecutiveFailures++;
  }
  const reason = consecutiveFailures >= 3 ? 'three-failures' as const : null;
  return { show: input.mode !== 'strict' && input.isActive && !input.state.automaticShownAt && !input.state.dismissedAt && reason !== null, reason, consecutiveFailures };
}
