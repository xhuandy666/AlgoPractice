import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OfficialSubmission } from '../../src/shared/official.ts';
import { OfficialReviewPromptGuard, revalidateReviewPrompt, type ReviewPromptScene } from '../../src/renderer/official-review-prompt.ts';
import type { ReviewOpportunity } from '../../src/shared/review-plan.ts';

const scene = (patch: Partial<ReviewPromptScene> = {}): ReviewPromptScene => ({ workspaceKey: 'one:python:practice:function',
  problemId: 'one', learningDate: '2026-10-01', foreground: true, blocked: false, ...patch });
const record = (patch: Partial<OfficialSubmission> = {}): OfficialSubmission => ({ id: 'record-1', problemId: 'one',
  status: 'completed', submissionId: '123', finishedAt: '2026-10-01T09:00:00.000Z', result: { status: 'accepted' }, ...patch } as OfficialSubmission);

test('only newly delivered, numbered official Accepted results create a live ticket', () => {
  const guard = new OfficialReviewPromptGuard(); guard.update(scene());
  assert.equal(guard.receive(record({ status: 'judging' })), null);
  assert.equal(guard.receive(record({ submissionId: null })), null);
  assert.equal(guard.receive(record({ result: { status: 'wrong_answer' } } as Partial<OfficialSubmission>)), null);
  const ticket = guard.receive(record()); assert.ok(ticket); assert.equal(guard.current(ticket), true);
  assert.equal(guard.receive(record()), null);
});

test('background, modal, other problem, navigation, restart, and midnight never revive a live chain', () => {
  for (const change of [scene({ foreground: false }), scene({ blocked: true }), scene({ problemId: 'two' }),
    scene({ workspaceKey: 'other-route' }), scene({ learningDate: '2026-10-02' })]) {
    const guard = new OfficialReviewPromptGuard(); guard.update(scene()); const ticket = guard.receive(record()); assert.ok(ticket);
    guard.update(change); guard.update(scene()); assert.equal(guard.current(ticket), false);
  }
  const guard = new OfficialReviewPromptGuard(); guard.update(scene({ foreground: false }));
  assert.equal(guard.receive(record()), null); guard.update(scene()); assert.equal(guard.receive(record()), null);
});

test('button cleanup does not invalidate an otherwise unchanged safe scene; explicit navigation does', () => {
  const guard = new OfficialReviewPromptGuard(); guard.update(scene()); const ticket = guard.receive(record()); assert.ok(ticket);
  guard.update(scene()); assert.equal(guard.current(ticket), true);
  guard.invalidate(); assert.equal(guard.current(ticket), false);
});

const claimed = { id: 'ac-1', problemId: 'one', learningDate: '2026-10-01', state: 'claimed', claimedAt: '2026-10-01T09:00:01Z' } as ReviewOpportunity;
test('assessment notification overtaking a delayed claim reply cannot display the old claimed snapshot', async () => {
  let revision = 0, reads = 0;
  const value = await revalidateReviewPrompt(claimed, async () => {
    reads++;
    if (reads === 1) { revision++; return claimed; }
    return { ...claimed, state: 'assessed', assessmentEventId: 'manual' };
  }, () => true, () => revision);
  assert.equal(value, null); assert.equal(reads, 2);
});
test('claim revalidation respects navigation, stable fresh evidence and a bounded change storm', async () => {
  assert.equal(await revalidateReviewPrompt(claimed, async () => claimed, () => false, () => 0), null);
  assert.deepEqual(await revalidateReviewPrompt(claimed, async () => ({ ...claimed, sourceDeleted: true }), () => true, () => 0), { ...claimed, sourceDeleted: true });
  let revision = 0, reads = 0;
  assert.equal(await revalidateReviewPrompt(claimed, async () => { reads++; revision++; return claimed; }, () => true, () => revision), null);
  assert.equal(reads, 3);
});
