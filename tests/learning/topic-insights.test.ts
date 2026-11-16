import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { rankTopics, struggleReasons } from '../../src/learning/topic-insights.ts';
import type { ProblemStruggleSignals } from '../../src/shared/learning.ts';

const signal = (problemId: string, tags: string[], values: Partial<ProblemStruggleSignals> = {}): ProblemStruggleSignals =>
  ({ problemId, title: problemId, tags, passedRuns: 0, failedRuns: 0, officialAccepted: 0, officialRejected: 0, aiHelps: 0, rating: null, ...values });

test('a problem struggles on its current state, never merely for being unsolved', () => {
  assert.deepEqual(struggleReasons(signal('a', [])), [], 'unsolved without failures is unverified, not weak');
  assert.deepEqual(struggleReasons(signal('a', [], { rating: 2 })), ['rated-hard']);
  assert.deepEqual(struggleReasons(signal('a', [], { rating: 1, passedRuns: 3 })), ['rated-hard'], 'a low self-rating counts even after a pass');
  assert.deepEqual(struggleReasons(signal('a', [], { officialRejected: 2, failedRuns: 3, aiHelps: 2 })), ['official-failures', 'local-failures', 'ai-help']);
  assert.deepEqual(struggleReasons(signal('a', [], { officialRejected: 1, failedRuns: 2, aiHelps: 1 })), [], 'below every threshold');
  assert.deepEqual(struggleReasons(signal('a', [], { officialRejected: 5, rating: 3 })), [], 'a later Good self-rating settles old failures');
  assert.deepEqual(struggleReasons(signal('a', [], { officialRejected: 5, officialAccepted: 1 })), [], 'an official Accepted settles them');
  assert.deepEqual(struggleReasons(signal('a', [], { failedRuns: 9, passedRuns: 1 })), [], 'a local all-pass settles them');
});

test('topics rank by struggling problems, count every tag, skip untagged and thinly practiced topics', () => {
  const topics = rankTopics([
    signal('p1', ['数组', '哈希表'], { rating: 1 }),
    signal('p2', ['数组'], { officialRejected: 3 }),
    signal('p3', ['数组']),
    signal('p4', ['哈希表'], { rating: 4 }),
    signal('p5', ['动态规划'], { rating: 2 }),
    signal('p6', [], { rating: 1 }),
    signal('p7', ['链表', '链表 '], { failedRuns: 5 }),
    signal('p8', ['链表']),
  ]);
  assert.deepEqual(topics.map(topic => [topic.tag, topic.practiced, topic.struggling]), [['数组', 3, 2], ['哈希表', 2, 1], ['链表', 2, 1]],
    '动态规划 has one practiced problem; duplicate tags on one problem count once');
  assert.equal(topics[1].struggling / topics[1].practiced, topics[2].struggling / topics[2].practiced, 'equal ties fall back to the tag order');
  assert.deepEqual(topics[0].reasons, { 'rated-hard': 1, 'official-failures': 1, 'local-failures': 0, 'ai-help': 0 });
  assert.deepEqual(topics[0].strugglingProblems.map(problem => problem.id), ['p1', 'p2']);
  assert.deepEqual(rankTopics([signal('x', ['图'])]), [], 'nothing qualifies, so the card renders nothing');
});

const accepted = { status: 'accepted' as const, statusCode: 10, statusMessage: 'Accepted' };
const wrongAnswer = { status: 'wrong_answer' as const, statusMessage: 'Wrong Answer' };

test('store signals use current official, rating, AI and archive state, and recommend unpracticed runnable problems', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-12T08:00:00.000Z') });
  const directory = mkdtempSync(join(tmpdir(), 'tilian-topic-insights-')), path = join(directory, 'practice.sqlite');
  const store = new PracticeStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.updateLearningSettings({ timeZone: 'UTC' });
  let submission = 1000, request = 0;
  const problem = (slug: string, tags: string[], starter: Record<string, string> = { python: 'class Solution:\n    def f(self, n: int) -> int:\n        ' }) =>
    store.upsertProblem({ id: `leetcode:${slug}`, source: 'leetcode-cn', sourceUrl: `https://leetcode.cn/problems/${slug}/`, sourceId: String(++submission),
      title: `题 ${slug}`, difficulty: '中等', tags, description: '题面', descriptionFormat: 'plain', constraints: [], mode: 'function',
      adapter: { method: 'f', params: ['int'], returns: 'int' }, cases: [{ args: [1] }], starter });
  const practice = (slug: string, tags: string[]) => {
    const item = problem(slug, tags);
    const attempt = store.startAttempt({ problemId: item.id, problemVersion: item.version, language: 'python', problemSnapshot: item.content as never });
    const draft = store.saveDraft({ problemId: item.id, language: 'python', code: item.content.starter.python! });
    const official = (result: typeof accepted | typeof wrongAnswer) => {
      const record = store.beginOfficialSubmission({ requestId: `official-${++request}`, attemptId: attempt.id, code: draft.code, expectedDraftRevision: draft.revision, slug, sourceId: item.content.sourceId! });
      store.updateOfficialSubmission(record.id, { status: 'judging', submissionId: String(++submission) });
      store.updateOfficialSubmission(record.id, { status: 'completed', result });
    };
    return { item, attempt, draft, official };
  };
  const rejected = practice('rejected-twice', ['数组', '双指针']); rejected.official(wrongAnswer); rejected.official(wrongAnswer);
  const settled = practice('accepted-later', ['数组']); settled.official(wrongAnswer); settled.official(wrongAnswer); settled.official(accepted);
  const corrected = practice('rated-then-corrected', ['数组']);
  const first = store.recordProblemReview({ requestId: 'rate-good', problemId: corrected.item.id, rating: 3 });
  store.correctProblemReview({ requestId: 'correct-again', eventId: first.event.id, rating: 1 });
  const helped = practice('auto-analysis-only', ['双指针']);
  const writer = new DatabaseSync(path);
  const ai = writer.prepare(`INSERT INTO ai_requests VALUES (?, ?, ?, ?, 'completed', '{}', 'null', 'null', NULL, ?, ?)`);
  for (const kind of ['official-review', 'official-review', 'note-draft']) ai.run(`ai-${++request}`, helped.attempt.id, `hash-${request}`, JSON.stringify({ kind }), '2026-11-12T08:00:00.000Z', '2026-11-12T08:00:00.000Z');
  const asked = practice('asked-twice', ['双指针']);
  for (const kind of ['hint', 'chat']) ai.run(`ai-${++request}`, asked.attempt.id, `hash-${request}`, JSON.stringify({ kind }), '2026-11-12T08:00:00.000Z', '2026-11-12T08:00:00.000Z');
  writer.close();
  const removed = practice('deleted-archive', ['数组']); removed.official(wrongAnswer); removed.official(wrongAnswer);
  store.finishAttempt(removed.attempt.id, { code: removed.draft.code }); assert.equal(store.deleteEndedAttempt(removed.attempt.id), true);
  practice('untagged', []);
  const localPass = (attemptId: string, code: string, expectedOutputSource: 'native-samples' | 'user') =>
    store.saveRun({ attemptId, code, testSuiteVersion: 'local', expectedOutputSource, adapterVersion: '1', runtimeVersion: '1', status: 'passed' });
  const selfChecked = practice('self-checked-only', ['回溯']); selfChecked.official(wrongAnswer); selfChecked.official(wrongAnswer);
  localPass(selfChecked.attempt.id, selfChecked.draft.code, 'user');
  const ownCases = practice('own-cases-pass', ['回溯']); ownCases.official(wrongAnswer); ownCases.official(wrongAnswer);
  localPass(ownCases.attempt.id, ownCases.draft.code, 'native-samples');
  problem('fresh-array', ['数组']); problem('fresh-array-java-only', ['数组'], { java: 'class Solution { public int f(int n) { } }' });

  const byId = new Map(store.getTopicInsights('python').topics.map(topic => [topic.tag, topic]));
  const arrays = byId.get('数组')!;
  assert.deepEqual([arrays.practiced, arrays.struggling], [3, 2], 'the deleted archive no longer counts; accepted-later is settled');
  assert.deepEqual(arrays.reasons, { 'rated-hard': 1, 'official-failures': 1, 'local-failures': 0, 'ai-help': 0 }, 'the correction to Again is the current rating');
  assert.deepEqual(arrays.strugglingProblems.map(problem => problem.id), ['leetcode:rated-then-corrected', 'leetcode:rejected-twice']);
  assert.deepEqual(arrays.recommended.map(problem => problem.id), ['leetcode:deleted-archive', 'leetcode:fresh-array'],
    'only unpracticed problems runnable in Python; the Java-only one is left out');
  assert.deepEqual(byId.get('回溯')!.strugglingProblems.map(problem => problem.id), ['leetcode:self-checked-only'],
    'passing the problem\'s own cases settles earlier failures; passing cases the user typed in does not');
  const pointers = byId.get('双指针')!;
  assert.deepEqual([pointers.practiced, pointers.struggling, pointers.reasons['ai-help']], [3, 2, 1], 'automatic official analysis and note drafts are not help requests');
  assert.equal(store.getTopicInsights('java').topics.find(topic => topic.tag === '数组')!.recommended.map(problem => problem.id).includes('leetcode:fresh-array-java-only'), true);
});
