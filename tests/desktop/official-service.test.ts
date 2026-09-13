import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { OfficialService } from '../../src/desktop/official-service.ts';
import { OfficialJudgeError, type OfficialJudgeTransport } from '../../src/source/official-judge.ts';
import type { OfficialSubmission } from '../../src/shared/official.ts';

function fixture(t: { after(fn: () => Promise<void>): void }, judge: OfficialJudgeTransport, options: { pollTimeoutMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tilian-official-service-')); const store = new PracticeStore(join(directory, 'practice.sqlite'));
  const problem = store.upsertProblem({ id: 'leetcode:two-sum', source: 'leetcode-cn', sourceUrl: 'https://leetcode.cn/problems/two-sum/', sourceId: '987',
    title: '两数之和', difficulty: '简单', tags: [], description: '题面', descriptionFormat: 'plain', constraints: [], mode: 'function', cases: [],
    starter: { python: 'class Solution:\n    pass', java: 'class Solution {}' } });
  const attempt = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language: 'python', problemSnapshot: problem.content as never });
  const draft = store.saveDraft({ problemId: problem.id, language: 'python', code: 'class Solution:\n    pass' });
  const updates: OfficialSubmission[] = [];
  const service = new OfficialService(store, judge, { onUpdate: record => updates.push(record), pollIntervalMs: 2, pollTimeoutMs: options.pollTimeoutMs ?? 500 });
  t.after(async () => { await service.stopAll(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service, updates, input: { requestId: 'first', attemptId: attempt.id, code: draft.code, expectedDraftRevision: draft.revision } };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert.fail('official service did not reach expected state');
}

test('one official POST per request ID, only persisted state changes notify, current code snapshot is retained', async t => {
  let posts = 0, checks = 0;
  const { service, input, store, updates } = fixture(t, { authenticated: async () => true,
    submit: async record => { posts++; assert.equal(record.sourceId, '987'); return '777'; },
    check: async () => ++checks < 4 ? { pending: true } : { pending: false, result: { status: 'accepted', statusMessage: 'Accepted', passedCases: 50, totalCases: 50 } } });
  const [first, retry] = await Promise.all([service.submit(input), service.submit(input)]);
  assert.equal(first.id, retry.id); assert.equal(first.status, 'submitting');
  await until(() => service.get(first.id)?.status === 'completed');
  assert.equal(posts, 1); assert.equal(checks, 4);
  assert.deepEqual(updates.map(record => record.status), ['submitting', 'judging', 'completed']);
  await service.submit(input); assert.equal(posts, 1);
  await assert.rejects(service.submit({ ...input, code: 'other' }), /conflicts/);
  assert.equal(store.listRuns(input.attemptId).length, 0);
  assert.equal(service.get(first.id)?.code, input.code);
});

test('authentication rejection is actionable and an uncertain POST never retries itself', async t => {
  let posts = 0;
  const { service, input } = fixture(t, { authenticated: async () => false, submit: async () => { posts++; return '1'; }, check: async () => ({ pending: true }) });
  await service.submit(input); await until(() => service.get(input.requestId)?.status === 'error');
  assert.equal(posts, 0); assert.equal(service.get(input.requestId)?.error?.code, 'authentication');
  const second = fixture(t, { authenticated: async () => true, submit: async () => { posts++; throw new OfficialJudgeError({ code: 'network', message: 'unknown' }, true); }, check: async () => ({ pending: true }) });
  await second.service.submit(second.input); await until(() => second.service.get(second.input.requestId)?.status === 'unknown');
  await second.service.submit(second.input); assert.equal(posts, 1);
  await assert.rejects(second.service.resume(second.input.requestId), /提交记录/); assert.equal(posts, 1);
});

test('a known ID pauses on query failure and resumes by GET only; pause permits later explicit submits', async t => {
  let posts = 0, fail = true;
  const { service, input } = fixture(t, { authenticated: async () => true, submit: async () => String(++posts),
    check: async () => { if (fail) throw new OfficialJudgeError({ code: 'rate_limit', message: 'too frequent' });
      return { pending: false, result: { status: 'wrong_answer', statusMessage: 'Wrong Answer' } }; } });
  await service.submit(input); await until(() => service.get(input.requestId)?.status === 'paused');
  assert.equal(service.get(input.requestId)?.submissionId, '1');
  await service.pause(); fail = false;
  await service.resume(input.requestId); await until(() => service.get(input.requestId)?.status === 'completed');
  assert.equal(posts, 1);
  await service.pause();
  await service.submit({ ...input, requestId: 'second' });
  await until(() => service.get('second')?.status === 'completed'); assert.equal(posts, 2);
});

test('polling is bounded, shutdown interrupts jobs and recovery never replays submitting snapshots', async t => {
  let posts = 0;
  const { service, input, store } = fixture(t, { authenticated: async () => true, submit: async () => String(++posts), check: async () => ({ pending: true }) }, { pollTimeoutMs: 10 });
  await service.submit(input); await until(() => service.get(input.requestId)?.status === 'paused');
  assert.equal(service.get(input.requestId)?.error?.code, 'timeout');
  await service.resume(input.requestId); await service.pause();
  assert.equal(service.get(input.requestId)?.status, 'paused'); assert.equal(posts, 1);
  const orphan = store.beginOfficialSubmission({ ...input, requestId: 'interrupted-post', slug: 'two-sum', sourceId: '987' });
  assert.equal(service.recover(), 1); assert.equal(service.get(orphan.id)?.status, 'unknown');
  await service.submit({ ...input, requestId: orphan.id }); assert.equal(posts, 1);
});

test('unsaved code and noncurrent or strict attempts cannot reach the official transport', async t => {
  let posts = 0;
  const { service, input, store } = fixture(t, { authenticated: async () => true, submit: async () => { posts++; return '1'; }, check: async () => ({ pending: true }) });
  await assert.rejects(service.submit({ ...input, code: 'not saved' }), /代码已变化/);
  await assert.rejects(service.submit({ ...input, expectedDraftRevision: 123 }), /代码已变化/);
  store.finishAttempt(input.attemptId);
  await assert.rejects(service.submit(input), /当前普通练习/);
  assert.equal(posts, 0);
});
