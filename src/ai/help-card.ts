import type { AiHelpDecision, AiHelpRun, AiHelpState, AiMode } from '../shared/ai.ts';

/** Pure: chronological persisted runs in, one display decision out. No API call or code-edit reset. */
export function helpCardDecision(input: { attemptId: string; mode: AiMode; isActive: boolean; runs: AiHelpRun[]; state: AiHelpState }): AiHelpDecision {
  let consecutiveFailures = 0; let reason: AiHelpDecision['reason'] = null;
  const seen = new Set<string>();
  for (const run of input.runs) {
    if (run.attemptId !== input.attemptId || seen.has(run.id)) continue;
    seen.add(run.id);
    if (run.status === 'passed' && run.executed && run.trustworthyExpected) { consecutiveFailures = 0; reason = null; continue; }
    if (!run.attributableToUser) continue;
    const syntax = run.language === 'python' && run.diagnostics.some(diagnostic => diagnostic.source === 'user' && /(?:SyntaxError|IndentationError|TabError)/.test(diagnostic.message));
    if (run.status === 'compile_error' || (run.status === 'runtime_error' && syntax)) { reason = 'compile-error'; continue; }
    if (run.executed && ((run.status === 'wrong_answer' && run.trustworthyExpected) || ['runtime_error', 'timeout', 'output_limit'].includes(run.status))) {
      consecutiveFailures++; if (consecutiveFailures >= 3 && reason !== 'compile-error') reason = 'three-failures';
    }
  }
  return { show: input.mode !== 'strict' && input.isActive && !input.state.automaticShownAt && !input.state.dismissedAt && reason !== null, reason, consecutiveFailures };
}
