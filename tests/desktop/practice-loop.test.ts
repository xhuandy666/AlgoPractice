import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Adapter, DesignAdapter } from '../../src/runner/types.ts';
import type { DesktopBridge } from '../../src/shared/bridge.ts';
import type { SubmissionHistoryItem } from '../../src/shared/submission-history.ts';
import { caseInputRows, CASE_INPUT_DISPLAY_LIMIT, firstFailedCase } from '../../src/renderer/case-input.ts';
import { parsePracticeMemory, withOpenedProblem, withoutMissing } from '../../src/renderer/practice-memory.ts';
import { resolveResume } from '../../src/renderer/practice-resume.ts';
import { loadReviewReference, pickReferenceRecord, referenceRank } from '../../src/renderer/review-reference.ts';
import { parseSelfTestInputs, SELF_TEST_STORED_PROBLEMS, SELF_TEST_STORED_TEXT, withSelfTestInput } from '../../src/renderer/self-test-store.ts';
import { formatSelfTestInput, parseSelfTestInput, selfTestAdapter, SELF_TEST_INPUT_LIMIT, validateSelfTestArguments } from '../../src/shared/self-test.ts';

test('practice memory keeps only a valid language, problem and list and survives damaged storage', () => {
  assert.deepEqual(parsePracticeMemory(null), { language: 'python' });
  assert.deepEqual(parsePracticeMemory('{broken'), { language: 'python' });
  assert.deepEqual(parsePracticeMemory('[]'), { language: 'python' });
  assert.deepEqual(parsePracticeMemory(JSON.stringify({ language: 'rust', problemId: 7, listId: '' })), { language: 'python' });
  assert.deepEqual(parsePracticeMemory(JSON.stringify({ language: 'cpp', problemId: 'two-sum', listId: 'hot100', listTitle: '热题 100', extra: true })),
    { language: 'cpp', problemId: 'two-sum', listId: 'hot100', listTitle: '热题 100' });
  assert.deepEqual(parsePracticeMemory(JSON.stringify({ language: 'go', problemId: 'x'.repeat(201) })), { language: 'go' });
});

test('opening a problem remembers it; a study list replaces the remembered list and a detour keeps it', () => {
  const start = { language: 'java' as const };
  const fromList = withOpenedProblem(start, 'two-sum', { id: 'hot100', title: '热题 100' });
  assert.deepEqual(fromList, { language: 'java', problemId: 'two-sum', listId: 'hot100', listTitle: '热题 100' });
  // Quick switch, an archive or a search result carries no list: the list being worked through stays.
  assert.deepEqual(withOpenedProblem(fromList, 'lru-cache'), { language: 'java', problemId: 'lru-cache', listId: 'hot100', listTitle: '热题 100' });
  assert.deepEqual(withOpenedProblem(fromList, 'lru-cache', { id: 'top150', title: '面试经典 150' }), { language: 'java', problemId: 'lru-cache', listId: 'top150', listTitle: '面试经典 150' });
  assert.deepEqual(withoutMissing(fromList, { problem: true }), { language: 'java', listId: 'hot100', listTitle: '热题 100' });
  assert.deepEqual(withoutMissing(fromList, { list: true }), { language: 'java', problemId: 'two-sum' });
  assert.deepEqual(withoutMissing(fromList, { problem: true, list: true }), { language: 'java' });
});

type Item = { id: string; content: { title: string }; practice?: { solved: boolean; practiced: boolean } };
function reader(items: Item[], listMembers: string[] = []) {
  const queries: unknown[] = [];
  const api = { problemPage: async (filter: { ids?: string[]; listId?: string; practice?: string; limit?: number } = {}) => {
    queries.push(filter);
    const found = filter.ids ? items.filter(item => filter.ids!.includes(item.id))
      : items.filter(item => listMembers.includes(item.id) && (filter.practice !== 'unpracticed' || !item.practice?.practiced));
    return { items: found.slice(0, filter.limit ?? 30), total: found.length, offset: 0, limit: filter.limit ?? 30, hasMore: false };
  } } as unknown as Pick<DesktopBridge, 'problemPage'>;
  return { api, queries };
}
const lists = [{ id: 'hot100', title: '热题 100' }];

test('resume continues an unsolved problem, then moves to the first unopened problem of its list', async () => {
  const unsolved = reader([{ id: 'two-sum', content: { title: '两数之和' }, practice: { solved: false, practiced: true } }]);
  assert.deepEqual(await resolveResume(unsolved.api, { language: 'python', problemId: 'two-sum', listId: 'hot100' }, lists),
    { choice: { kind: 'continue', problemId: 'two-sum', title: '两数之和', list: { id: 'hot100', title: '热题 100' } }, missing: {} });
  assert.equal(unsolved.queries.length, 1, 'an unsolved problem needs no list query');

  const solved = reader([{ id: 'two-sum', content: { title: '两数之和' }, practice: { solved: true, practiced: true } },
    { id: 'three-sum', content: { title: '三数之和' }, practice: { solved: false, practiced: false } }], ['two-sum', 'three-sum']);
  assert.deepEqual(await resolveResume(solved.api, { language: 'python', problemId: 'two-sum', listId: 'hot100', listTitle: '旧名字' }, lists),
    { choice: { kind: 'next', problemId: 'three-sum', title: '三数之和', list: { id: 'hot100', title: '热题 100' } }, missing: {} });
  assert.deepEqual(solved.queries.at(-1), { listId: 'hot100', practice: 'unpracticed', limit: 1 });
});

test('resume reports what no longer exists and offers nothing when there is nothing to continue', async () => {
  const empty = reader([]);
  assert.deepEqual(await resolveResume(empty.api, { language: 'python' }, lists), { choice: null, missing: {} });
  assert.equal(empty.queries.length, 0);
  assert.deepEqual(await resolveResume(empty.api, { language: 'python', problemId: 'gone', listId: 'removed' }, lists), { choice: null, missing: { problem: true, list: true } });
  assert.deepEqual(empty.queries, [{ ids: ['gone'], limit: 1 }], 'a list that no longer exists is never queried');
  // Solved, with no list to go on: no suggestion rather than the same problem again.
  const done = reader([{ id: 'two-sum', content: { title: '两数之和' }, practice: { solved: true, practiced: true } }], ['two-sum']);
  assert.deepEqual(await resolveResume(done.api, { language: 'python', problemId: 'two-sum' }, lists), { choice: null, missing: {} });
  assert.deepEqual(await resolveResume(done.api, { language: 'python', problemId: 'two-sum', listId: 'hot100' }, lists), { choice: null, missing: {} }, 'every list problem was opened');
});

const twoSum: Adapter = { method: 'twoSum', params: [{ array: 'int' }, 'int'], returns: { array: 'int' } };
const design: DesignAdapter = { kind: 'design', className: 'MinStack', constructorParams: [], methods: [{ name: 'push', params: ['int'], returns: 'void' }] };
const starter = { python: 'class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        pass\n' };

test('the first failed case is the one opened; passed and unjudged cases never are', () => {
  assert.equal(firstFailedCase([{ index: 0, status: 'passed' }, { index: 1, status: 'completed' }, { index: 2, status: 'wrong_answer' }, { index: 3, status: 'runtime_error' }]), 2);
  assert.equal(firstFailedCase([{ index: 0, status: 'timeout' }]), 0);
  assert.equal(firstFailedCase([{ index: 0, status: 'passed' }, { index: 1, status: 'completed' }]), null);
  assert.equal(firstFailedCase([]), null);
});

test('case input uses the statement notation for function arguments and the raw stdin for ACM', () => {
  const content = { mode: 'function' as const, adapter: twoSum, starter, cases: [{ args: [[2, 7, 11, 15], 9], expected: [0, 1] }, { args: [['a'], 'x'] }] };
  assert.deepEqual(caseInputRows(content, 0), [{ name: 'nums', value: '[2,7,11,15]' }, { name: 'target', value: '9' }]);
  assert.deepEqual(caseInputRows(content, 1), [{ name: 'nums', value: '["a"]' }, { name: 'target', value: '"x"' }], 'strings keep their quotes');
  assert.equal(caseInputRows(content, 2), null, 'a case the current problem version does not have');
  assert.deepEqual(caseInputRows({ ...content, starter: undefined }, 0), [{ name: '参数 1', value: '[2,7,11,15]' }, { name: '参数 2', value: '9' }]);
  assert.equal(caseInputRows({ ...content, cases: [{ args: [1] }] }, 0), null, 'argument count must match the signature');
  assert.equal(caseInputRows({ mode: 'function', adapter: design, cases: [{ args: [['MinStack'], [[]]] }] }, 0), null, 'design problems show their step table instead');
  assert.deepEqual(caseInputRows({ mode: 'acm', cases: [{ stdin: '2 4 6\n' }, {}] }, 0), [{ value: '2 4 6\n' }]);
  assert.equal(caseInputRows({ mode: 'acm', cases: [{}] }, 0), null);
  const long = caseInputRows({ mode: 'acm', cases: [{ stdin: 'x'.repeat(CASE_INPUT_DISPLAY_LIMIT + 50) }] }, 0)![0].value;
  assert.equal(long.length, CASE_INPUT_DISPLAY_LIMIT + 1); assert.ok(long.endsWith('…'));
});

test('self-test input is one JSON value per parameter line, typed by the signature', () => {
  assert.deepEqual(parseSelfTestInput('[2,7,11,15]\n9', twoSum), [[2, 7, 11, 15], 9]);
  assert.deepEqual(parseSelfTestInput('\n  []  \r\n\r\n0\n', twoSum), [[], 0], 'blank lines and surrounding spaces are ignored');
  const wide: Adapter = { method: 'f', params: ['int64', 'string', 'treenode', { list: { list: 'char' } }, 'boolean', 'float'], returns: 'int' };
  assert.deepEqual(parseSelfTestInput('9007199254740993\n"a b"\n[1,null,2]\n[["a","b"],[]]\ntrue\n1.5', wide), ['9007199254740993', 'a b', [1, null, 2], [['a', 'b'], []], true, 1.5]);
  assert.deepEqual(parseSelfTestInput('12\n""\n[]\n[]\nfalse\n2', wide)[0], '12', 'a small 64-bit integer also crosses as a decimal string');
  assert.equal(formatSelfTestInput([[2, 7], 'ab', null]), '[2,7]\n"ab"\nnull');
  assert.deepEqual(parseSelfTestInput(formatSelfTestInput([[3, 2, 4], 6]), twoSum), [[3, 2, 4], 6]);
});

test('self-test input errors name the line, the parameter and the expected notation', () => {
  const names = ['nums', 'target'];
  assert.throws(() => parseSelfTestInput('[1,2]', twoSum, names), { message: '需要 2 行输入，每行一个参数（nums、target），现在是 1 行。' });
  assert.throws(() => parseSelfTestInput('', twoSum), { message: '需要 2 行输入，每行一个参数，现在是 0 行。' });
  assert.throws(() => parseSelfTestInput('[1,2\n3', twoSum, names), { message: '第 1 行（nums）不是有效的 JSON 值；需要整数数组，如 [1,2]。' });
  assert.throws(() => parseSelfTestInput('[1,2]\n3.5', twoSum, names), { message: '第 2 行（target）与参数类型不符；需要整数，如 1。' });
  assert.throws(() => parseSelfTestInput('[1,2]\n2147483648', twoSum), { message: '第 2 行与参数类型不符；需要整数，如 1。' });
  assert.throws(() => parseSelfTestInput('abc', { method: 'f', params: ['string'], returns: 'int' }), { message: '第 1 行不是有效的 JSON 值；需要字符串（带双引号），如 "ab"。' });
  assert.throws(() => parseSelfTestInput('[1,null,null,3]', { method: 'f', params: ['treenode'], returns: 'int' }), /二叉树（层序数组，空结点写 null），如 \[1,null,2\]/, 'an unreachable tree value is refused');
  assert.throws(() => parseSelfTestInput('x'.repeat(SELF_TEST_INPUT_LIMIT + 1), twoSum), { message: '自测输入过长，请控制在 64 KB 以内。' });
});

test('self-test arguments are checked again on arrival and only ordinary function problems qualify', () => {
  assert.deepEqual(validateSelfTestArguments([[1, 2], 3], twoSum), [[1, 2], 3]);
  for (const bad of [null, 'x', [[1, 2]], [[1, 2], 3, 4], [[1, '2'], 3], [[1, 2], 3.5], [{ a: 1 }, 3]])
    assert.throws(() => validateSelfTestArguments(bad, twoSum), { message: '自测输入与题目参数不符。' });
  assert.equal(selfTestAdapter('function', twoSum), twoSum);
  assert.equal(selfTestAdapter('function', design), null);
  assert.equal(selfTestAdapter('acm', twoSum), null);
  assert.equal(selfTestAdapter('function', undefined), null);
  assert.equal(selfTestAdapter('function', { method: 'f', params: [], returns: 'int' }), null, 'nothing to type for a function without parameters');
});

test('stored self-test inputs keep the most recent problems and drop blank or oversized text', () => {
  let entries = withSelfTestInput([], 'a', '[1]\n2');
  entries = withSelfTestInput(entries, 'b', '[]');
  entries = withSelfTestInput(entries, 'a', '[3]');
  assert.deepEqual(entries, [['a', '[3]'], ['b', '[]']]);
  assert.deepEqual(withSelfTestInput(entries, 'a', '  \n'), [['b', '[]']]);
  assert.deepEqual(withSelfTestInput(entries, 'b', 'x'.repeat(SELF_TEST_STORED_TEXT + 1)), [['a', '[3]']]);
  let many: [string, string][] = [];
  for (let index = 0; index < SELF_TEST_STORED_PROBLEMS + 5; index++) many = withSelfTestInput(many, `p${index}`, '1');
  assert.equal(many.length, SELF_TEST_STORED_PROBLEMS); assert.equal(many[0][0], `p${SELF_TEST_STORED_PROBLEMS + 4}`);
  assert.deepEqual(parseSelfTestInputs(JSON.stringify([['a', '1'], ['b', 2], 'x', ['c', '3', 'extra'], ['d', '4']])), [['a', '1'], ['d', '4']]);
  assert.deepEqual(parseSelfTestInputs('{}'), []); assert.deepEqual(parseSelfTestInputs('nope'), []); assert.deepEqual(parseSelfTestInputs(null), []);
});

const record = (id: string, source: 'local' | 'official', status: string, verdict: string | null = null, answerFormat: 'function' | 'acm' = 'function') =>
  ({ id, source, status, verdict, answerFormat }) as unknown as SubmissionHistoryItem;

test('the review reference is the newest record of the best kind: official Accepted, then a local pass', () => {
  assert.equal(referenceRank(record('a', 'official', 'completed', 'accepted')), 3);
  assert.equal(referenceRank(record('a', 'official', 'completed', 'wrong_answer')), 0);
  assert.equal(referenceRank(record('a', 'official', 'judging')), 0);
  assert.equal(referenceRank(record('a', 'local', 'passed')), 2);
  assert.equal(referenceRank(record('a', 'local', 'passed', null, 'acm')), 1);
  assert.equal(referenceRank(record('a', 'local', 'wrong_answer')), 0);
  // Newest first: the later local pass does not displace the official Accepted, and the newer of two equals wins.
  assert.equal(pickReferenceRecord([record('r4', 'local', 'passed'), record('r3', 'official', 'completed', 'accepted'), record('r2', 'official', 'completed', 'accepted'), record('r1', 'local', 'passed')])?.id, 'r3');
  assert.equal(pickReferenceRecord([record('r3', 'local', 'wrong_answer'), record('r2', 'local', 'passed', null, 'acm'), record('r1', 'local', 'passed')])?.id, 'r1');
  assert.equal(pickReferenceRecord([record('r1', 'local', 'runtime_error'), record('r0', 'official', 'completed', 'timeout')]), null);
  assert.equal(pickReferenceRecord([]), null);
});

test('loading a review reference prefers the current language, falls back to another, and keeps only notes with text', async () => {
  const calls: string[] = [];
  const histories: Record<string, ReturnType<typeof record>[]> = { python: [record('py-fail', 'local', 'wrong_answer')], java: [record('java-ok', 'local', 'passed')], go: [], cpp: [record('cpp-ac', 'official', 'completed', 'accepted')] };
  const api = {
    submissionHistory: async (filter: { problemId: string; language: string; limit?: number }) => { calls.push(`history:${filter.language}:${filter.limit}`); return { items: histories[filter.language], total: histories[filter.language].length, offset: 0, limit: 50, hasMore: false }; },
    submissionHistoryDetail: async (source: string, id: string) => { calls.push(`detail:${source}:${id}`); return { ...record(id, source as 'local', 'passed'), language: id.split('-')[0] === 'java' ? 'java' : 'cpp', createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z', code: `// ${id}` }; },
    notePage: async (filter: unknown) => { calls.push(`notes:${JSON.stringify(filter)}`); return { items: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }], total: 3, offset: 0, limit: 5, hasMore: false }; },
    note: async (id: string) => id === 'n3' ? null : { id, updatedAt: '2026-11-02T00:00:00Z', current: { title: id === 'n1' ? '双指针要点' : '', markdown: id === 'n1' ? '## 思路\n左右指针' : '  \n' } },
  } as unknown as Parameters<typeof loadReviewReference>[0];
  const reference = await loadReviewReference(api, 'two-sum', 'python');
  assert.deepEqual(reference.code, { source: 'local', language: 'java', answerFormat: 'function', createdAt: '2026-11-01T00:00:05Z', code: '// java-ok' });
  assert.deepEqual(reference.notes, [{ id: 'n1', title: '双指针要点', markdown: '## 思路\n左右指针', updatedAt: '2026-11-02T00:00:00Z' }], 'a blank note and a removed note are left out');
  assert.deepEqual(calls.slice(0, 3), ['history:python:50', 'history:java:50', 'detail:local:java-ok'], 'languages after the first solution are not read');
  assert.equal(calls[3], 'notes:{"kind":"problem","subjectId":"two-sum","limit":5}');

  histories.java = [];
  assert.equal((await loadReviewReference(api, 'two-sum', 'cpp')).code?.code, '// cpp-ac');
  histories.cpp = [];
  assert.equal((await loadReviewReference(api, 'two-sum', 'python')).code, null, 'no passing record in any language');
});
