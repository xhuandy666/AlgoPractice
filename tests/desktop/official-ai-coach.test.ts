import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { OfficialAiCoach, officialAnalysisRequestId } from '../../src/desktop/official-ai-coach.ts';
import { buildPracticeAiContext } from '../../src/desktop/learning-context.ts';
import { buildRequestSnapshot, requestHash } from '../../src/ai/context.ts';
import type { AiRequestInput, AiRequestRecord } from '../../src/shared/ai.ts';
import type { OfficialVerdict } from '../../src/shared/official.ts';
import { answer, config } from '../ai/helpers.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tilian-official-ai-'));
  const store = new PracticeStore(join(directory, 'practice.sqlite'));
  const problem = store.upsertProblem({ id: 'leetcode-cn:problem:authored-ai-test', source: 'leetcode-cn', sourceId: '1',
    sourceUrl: 'https://leetcode.cn/problems/two-sum/', title: '原创协议测试', difficulty: '简单', tags: [], description: '返回输入值。',
    descriptionFormat: 'plain', constraints: [], mode: 'function', starter: { python: 'class Solution:\n    def solve(self, n):\n        return n\n' },
    adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1], expected: 1 }] });
  const attempt = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language: 'python', answerFormat: 'function' });
  let draft = store.saveDraft({ problemId: problem.id, language: 'python', code: problem.content.starter.python!, answerFormat: 'function' });
  function submission(id: string, verdict: OfficialVerdict = 'wrong_answer') {
    draft = store.getDraft(problem.id, 'python', 'practice', 'function')!;
    store.beginOfficialSubmission({ requestId: id, attemptId: attempt.id, code: draft.code, expectedDraftRevision: draft.revision, slug: 'two-sum', sourceId: '1' });
    store.updateOfficialSubmission(id, { status: 'judging', submissionId: `10${id.length}` });
    return store.updateOfficialSubmission(id, { status: 'completed', result: { status: verdict, statusMessage: verdict,
      ...(verdict === 'wrong_answer' ? { input: '1', expectedOutput: '1', actualOutput: '0' } : {}) } });
  }
  const calls: AiRequestInput[] = [];
  async function request(input: AiRequestInput): Promise<AiRequestRecord> {
    calls.push(input);
    const source = buildPracticeAiContext(store, input), snapshot = buildRequestSnapshot(input, source, config());
    store.beginAIRequest({ id: input.requestId, attemptId: input.attemptId, requestHash: requestHash(snapshot), snapshot });
    return store.finishAIRequest(input.requestId, { status: 'completed', response: answer(input, source), error: null, usage: null, cachedFromRequestId: null });
  }
  let allowed = true, key = true;
  const options = { store: () => store, allowed: () => allowed, provider: async () => ({ config: config(), hasKey: key, secureStorageAvailable: null }), request };
  const coach = new OfficialAiCoach(options);
  t.after(async () => { coach.pause(); await coach.idle(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, problem, attempt, submission, calls, coach, options, setAllowed: (value: boolean) => { allowed = value; }, setKey: (value: boolean) => { key = value; } };
}

test('automatic review defaults off, enabling it does not scan old results, and only new official results trigger it', async t => {
  const { store, submission, coach, calls } = fixture(t);
  assert.equal(store.getLearningSettings().aiAutoAnalyzeOfficial, false);
  const old = submission('old'); coach.completed(old); await coach.idle(); assert.equal(calls.length, 0);
  store.updateLearningSettings({ aiAutoAnalyzeOfficial: true }); await coach.idle(); assert.equal(calls.length, 0);
  coach.completed(submission('new')); await coach.idle();
  assert.equal(calls.length, 1); assert.equal(calls[0].kind, 'official-review'); assert.equal(calls[0].officialSubmissionId, 'new');
  assert.equal(calls[0].question, '');
});

test('accepted and failing verdicts are analyzed once; unknown, internal errors and unfinished results are not', async t => {
  const { store, submission, coach, calls, options } = fixture(t);
  store.updateLearningSettings({ aiAutoAnalyzeOfficial: true });
  const failed = submission('failed'), accepted = submission('accepted', 'accepted');
  for (const row of [failed, failed, accepted, submission('unknown', 'unknown'), submission('internal', 'internal_error')]) coach.completed(row);
  await coach.idle(); assert.equal(calls.length, 2);
  coach.completed(failed); await coach.idle(); assert.equal(calls.length, 2);
  const restarted = new OfficialAiCoach(options); restarted.completed(failed); await restarted.idle();
  assert.equal(calls.length, 2, 'persisted deterministic request identity prevents a replay after restart');
  assert.ok(store.getAIRequest(officialAnalysisRequestId(failed.id)));
});

test('automatic result analysis uses submitted code even when the current draft has changed', async t => {
  const { store, submission, coach, calls, attempt, problem } = fixture(t);
  store.updateLearningSettings({ aiAutoAnalyzeOfficial: true }); const row = submission('earlier');
  store.saveDraft({ problemId: problem.id, language: 'python', code: '# a later unfinished edit', answerFormat: 'function' });
  coach.completed(row); await coach.idle();
  assert.equal(calls.length, 1);
  const saved = store.getAIRequest(calls[0].requestId)!;
  assert.equal(saved.snapshot.code, row.code); assert.equal(saved.snapshot.codeHash, row.codeHash);
  assert.equal(saved.snapshot.draftRevision, row.draftRevision); assert.equal(saved.snapshot.official?.id, row.id);
  assert.equal(store.getDraft(problem.id, 'python', attempt.draftScopeId, 'function')?.code, '# a later unfinished edit');
});

test('manual request finishes first; repeated wake events cannot duplicate queued official analysis', async t => {
  const { store, submission, coach, calls, attempt } = fixture(t);
  store.updateLearningSettings({ aiAutoAnalyzeOfficial: true });
  const manual: AiRequestInput = { requestId: 'manual', attemptId: attempt.id, kind: 'diagnosis', question: '' };
  const source = buildPracticeAiContext(store, manual), snapshot = buildRequestSnapshot(manual, source, config());
  store.beginAIRequest({ id: manual.requestId, attemptId: attempt.id, requestHash: requestHash(snapshot), snapshot });
  const row = submission('queued'); coach.completed(row); await coach.idle(); assert.equal(calls.length, 0);
  store.finishAIRequest(manual.requestId, { status: 'completed', response: answer(manual, source), error: null, usage: null, cachedFromRequestId: null });
  coach.wake(); coach.wake(); coach.completed(row); await coach.idle(); assert.equal(calls.length, 1);
});

test('disabling the opt-in, maintenance, missing key or ended attempt prevents a queued network call', async t => {
  const { store, submission, coach, calls, setAllowed, setKey, attempt } = fixture(t);
  store.updateLearningSettings({ aiAutoAnalyzeOfficial: true });
  setAllowed(false); coach.completed(submission('maintenance')); await coach.idle(); assert.equal(calls.length, 0);
  setAllowed(true); setKey(false); coach.completed(submission('no-key')); await coach.idle(); assert.equal(calls.length, 0);
  setKey(true); const row = submission('disabled'); coach.completed(row); store.updateLearningSettings({ aiAutoAnalyzeOfficial: false });
  await coach.idle(); assert.equal(calls.length, 0);
  store.updateLearningSettings({ aiAutoAnalyzeOfficial: true }); const ended = submission('ended'); store.finishAttempt(attempt.id);
  coach.completed(ended); await coach.idle(); assert.equal(calls.length, 0);
});

test('a setting or lifecycle change while checking credentials is revalidated before calling the model', async t => {
  const { store, submission, calls, options } = fixture(t); store.updateLearningSettings({ aiAutoAnalyzeOfficial: true });
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }); let preparing = false;
  const coach = new OfficialAiCoach({ ...options, provider: async () => { preparing = true; await waiting; return options.provider(); } });
  coach.completed(submission('delayed'));
  for (let i = 0; i < 20 && !preparing; i++) await delay(1);
  assert.equal(preparing, true); coach.pause(); release(); await coach.idle(); assert.equal(calls.length, 0);
  coach.resume(); await coach.idle(); assert.equal(calls.length, 0, 'resuming never replays a discarded result');
});

test('automatic analysis opt-in is a validated, durable JSON setting without a database version change', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tilian-ai-setting-')), path = join(directory, 'practice.sqlite');
  let store = new PracticeStore(path);
  try {
    store.updateLearningSettings({ aiAutoAnalyzeOfficial: true });
    assert.throws(() => store.updateLearningSettings({ aiAutoAnalyzeOfficial: 'yes' } as never), /automatic analysis/);
    store.close(); store = new PracticeStore(path);
    assert.equal(store.getLearningSettings().aiAutoAnalyzeOfficial, true);
    assert.equal(store.getLearningSettings().dailyReviewBudget, 3);
    store.updateLearningSettings({ dailyReviewBudget: 5 }); assert.equal(store.getLearningSettings().aiAutoAnalyzeOfficial, true);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
