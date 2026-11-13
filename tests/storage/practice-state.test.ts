import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import type { PracticeState } from '../../src/shared/learning.ts';

const accepted = { status: 'accepted' as const, statusCode: 10, statusMessage: 'Accepted' };

test('the library filters and labels problems by practice state, and lists report their progress', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T08:00:00.000Z') });
  const directory = mkdtempSync(join(tmpdir(), 'tilian-practice-state-'));
  const store = new PracticeStore(join(directory, 'practice.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.updateLearningSettings({ timeZone: 'UTC' });
  let submission = 100;
  const problem = (slug: string) => store.upsertProblem({ id: `leetcode:${slug}`, source: 'leetcode-cn', sourceUrl: `https://leetcode.cn/problems/${slug}/`, sourceId: String(++submission),
    title: slug, difficulty: '简单', tags: [], description: '题面', descriptionFormat: 'plain', constraints: [], mode: 'function',
    adapter: { method: 'f', params: ['int'], returns: 'int' }, cases: [{ args: [1] }], starter: { python: 'class Solution:\n    def f(self, n: int) -> int:\n        ' } });
  const start = (slug: string) => {
    const item = problem(slug);
    const attempt = store.startAttempt({ problemId: item.id, problemVersion: item.version, language: 'python', problemSnapshot: item.content as never });
    return { item, attempt, draft: store.saveDraft({ problemId: item.id, language: 'python', code: item.content.starter.python! }) };
  };
  problem('untouched');
  start('opened');
  const local = start('passed-locally');
  store.saveRun({ attemptId: local.attempt.id, code: local.draft.code, testSuiteVersion: 'local', expectedOutputSource: 'native-samples', adapterVersion: '1', runtimeVersion: '1', status: 'passed' });
  const ownItem = problem('passed-own-tests');
  const own = store.startAttempt({ problemId: ownItem.id, problemVersion: ownItem.version, language: 'python', problemSnapshot: ownItem.content as never, answerFormat: 'acm' });
  store.saveRun({ attemptId: own.id, code: 'print(1)', testSuiteVersion: 'local', expectedOutputSource: 'user', adapterVersion: '1', runtimeVersion: '1', status: 'passed' });
  const official = start('accepted-officially');
  const record = store.beginOfficialSubmission({ requestId: 'ac', attemptId: official.attempt.id, code: official.draft.code, expectedDraftRevision: official.draft.revision, slug: 'accepted-officially', sourceId: official.item.content.sourceId! });
  store.updateOfficialSubmission(record.id, { status: 'judging', submissionId: '9001' });
  store.updateOfficialSubmission(record.id, { status: 'completed', result: accepted });
  for (const slug of ['due', 'assessed-today', 'suspended']) store.recordProblemReview({ requestId: `rate-${slug}`, problemId: problem(slug).id, rating: 1 });
  t.mock.timers.setTime(Date.parse('2026-11-12T08:00:00.000Z'));
  store.recordProblemReview({ requestId: 'rate-assessed-today-again', problemId: 'leetcode:assessed-today', rating: 3 });
  const suspended = store.getProblemReviewDetail('leetcode:suspended').plan!;
  store.updateProblemReviews({ problemIds: [suspended.problemId], expectedRevisions: { [suspended.problemId]: suspended.revision }, suspended: true });

  const ids = (practice?: PracticeState) => store.listProblemPage({ practice, limit: 100 }).items.map(item => item.id.replace('leetcode:', '')).sort();
  assert.deepEqual(ids('unpracticed'), ['assessed-today', 'due', 'suspended', 'untouched'], 'self-rated problems were never opened in practice');
  assert.deepEqual(ids('practiced'), ['accepted-officially', 'opened', 'passed-locally', 'passed-own-tests']);
  assert.deepEqual(ids('solved'), ['accepted-officially', 'passed-locally'],
    'passing the problem\'s own cases or an official Accepted solves a problem; passing cases the user typed in does not');
  assert.deepEqual(ids('review-due'), ['due'], 'due exactly as the review plan counts it: not suspended and not already assessed today');
  const labelled = new Map(store.listProblemPage({ limit: 100 }).items.map(item => [item.id.replace('leetcode:', ''), item.practice]));
  assert.deepEqual(labelled.get('passed-locally'), { practiced: true, solved: true, reviewDue: false });
  assert.deepEqual(labelled.get('passed-own-tests'), { practiced: true, solved: false, reviewDue: false });
  assert.deepEqual(labelled.get('due'), { practiced: false, solved: false, reviewDue: true });
  assert.throws(() => store.listProblemPage({ practice: 'everything' as PracticeState }), /Invalid practice state filter/);

  store.applyListRefresh(store.previewListRefresh({ id: 'list-progress', title: '进度清单', source: 'local', membershipComplete: true, chapters: [],
    items: ['untouched', 'opened', 'passed-locally', 'passed-own-tests', 'accepted-officially'].map((slug, position) => ({ key: slug, problemId: `leetcode:${slug}`, position })) }).id);
  assert.deepEqual(store.listProgress()['list-progress'], { total: 5, practiced: 4, solved: 2 });
});
