import type { AiEvent } from '../shared/ai';
import type { OfficialSubmission } from '../shared/official';

// The daily goal counts practices the user ended, and an official Accepted does not end one on purpose: ending
// cancels the attempt's AI requests and the automatic official analysis only runs for active attempts. So after an
// Accepted the workbench offers an explicit "结束本题练习", held back while AI work for the attempt is in flight.

const ACTIVE_PHASES: ReadonlySet<AiEvent['phase']> = new Set(['queued', 'connecting', 'receiving', 'validating', 'repairing']);
/** In-flight AI request ids for one attempt after an event; events for other attempts leave the set unchanged. */
export function nextAiActivity(active: ReadonlySet<string>, event: Pick<AiEvent, 'requestId' | 'attemptId' | 'phase'>, attemptId: string): ReadonlySet<string> {
  if (event.attemptId !== attemptId) return active;
  const busy = ACTIVE_PHASES.has(event.phase);
  if (busy === active.has(event.requestId)) return active;
  const next = new Set(active);
  if (busy) next.add(event.requestId); else next.delete(event.requestId);
  return next;
}

export type FinishAfterAccepted = 'ready' | 'ai-running' | 'busy';
/** Whether to offer ending the practice: only for an active attempt with an official Accepted. */
export function finishAfterAccepted(input: { attemptActive: boolean; records: readonly Pick<OfficialSubmission, 'status' | 'result'>[]; aiActive: boolean; busy: boolean }): FinishAfterAccepted | null {
  if (!input.attemptActive || !input.records.some(record => record.status === 'completed' && record.result?.status === 'accepted')) return null;
  return input.aiActive ? 'ai-running' : input.busy ? 'busy' : 'ready';
}
