import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishAfterAccepted, nextAiActivity } from '../../src/renderer/finish-after-accepted.ts';

test('AI activity tracks in-flight requests of one attempt from live events', () => {
  let active: ReadonlySet<string> = new Set();
  const event = (requestId: string, phase: Parameters<typeof nextAiActivity>[1]['phase'], attemptId = 'a1') => { active = nextAiActivity(active, { requestId, attemptId, phase }, 'a1'); };
  event('r1', 'queued'); event('r1', 'receiving'); event('r2', 'connecting');
  assert.deepEqual([...active].sort(), ['r1', 'r2']);
  const before = active; event('r9', 'queued', 'other-attempt');
  assert.equal(active, before, 'other attempts leave the set untouched');
  event('r1', 'completed'); event('r2', 'interrupted');
  assert.equal(active.size, 0, 'completed, failed, cancelled and interrupted requests are no longer in flight');
  const settled = active; event('r1', 'failed');
  assert.equal(active, settled, 'a repeated terminal event changes nothing');
});

test('ending the practice is offered only after an official Accepted on an active practice, and held back while AI works', () => {
  const accepted = [{ status: 'completed' as const, result: { status: 'accepted' as const, statusMessage: 'Accepted' } }];
  const rejected = [{ status: 'completed' as const, result: { status: 'wrong_answer' as const, statusMessage: 'Wrong Answer' } }];
  assert.equal(finishAfterAccepted({ attemptActive: true, records: accepted, aiActive: false, busy: false }), 'ready');
  assert.equal(finishAfterAccepted({ attemptActive: true, records: accepted, aiActive: true, busy: false }), 'ai-running', 'ending would cancel the automatic official analysis');
  assert.equal(finishAfterAccepted({ attemptActive: true, records: accepted, aiActive: false, busy: true }), 'busy');
  assert.equal(finishAfterAccepted({ attemptActive: false, records: accepted, aiActive: false, busy: false }), null, 'an ended practice already counts');
  assert.equal(finishAfterAccepted({ attemptActive: true, records: rejected, aiActive: false, busy: false }), null);
  assert.equal(finishAfterAccepted({ attemptActive: true, records: [{ status: 'judging' as const, result: null }], aiActive: false, busy: false }), null);
});
