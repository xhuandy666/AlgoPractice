import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PageResult, ProblemListItem } from '../../src/shared/learning.ts';
import type { ReviewPlanListItem, ReviewPlanSnapshot, ReviewSession } from '../../src/shared/review-plan.ts';
import { makeFrozenPracticeSource, makeLibraryPracticeSource, makeReviewPracticeSource, makeReviewSessionPracticeSource,
  practiceNavigationPosition, resolvePracticeNavigation, type PracticeNavigationReader } from '../../src/shared/practice-navigation.ts';
import { PracticeStore } from '../../src/storage/practice-store.ts';

function page<T>(items: T[], offset = 0, limit = 100): PageResult<T> {
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, hasMore: offset + limit < items.length };
}
function libraryRows(ids: string[]): ProblemListItem[] { return ids.map(id => ({ id }) as ProblemListItem); }
function reviewRows(ids: string[]): ReviewPlanListItem[] { return ids.map(problemId => ({ problemId }) as ReviewPlanListItem); }
function snapshot(ids: string[], offset = 0, limit = 100, version = '12:settings:2026-10-01T10:00:00.000Z'): ReviewPlanSnapshot {
  return { snapshotVersion: version, summary: { date: '2026-10-01', timeZone: 'Asia/Shanghai' }, items: page(reviewRows(ids), offset, limit) } as ReviewPlanSnapshot;
}
const noReader = (): PracticeNavigationReader => ({ problemPage: async () => { throw new Error('unexpected library read'); },
  reviewPlan: async () => { throw new Error('unexpected review read'); } });

test('entry sources capture filters without the visible page offset and do not retain mutable inputs', () => {
  const ids = ['one', 'two']; const filter = { listId: 'synthetic-hot100', chapterId: 'hash', difficulty: '中等', search: '数组', ids, offset: 30, limit: 30, support: 'runnable' as const };
  const source = makeLibraryPracticeSource(filter, 'Hot 100 · 当前筛选'); ids.push('three'); filter.search = 'changed';
  assert.equal(source.kind, 'library'); if (source.kind !== 'library') throw new Error('source');
  assert.deepEqual(source.filter, { listId: 'synthetic-hot100', chapterId: 'hash', difficulty: '中等', search: '数组', ids: ['one', 'two'], support: 'runnable' });
  assert.equal(source.label, 'Hot 100 · 当前筛选');
  const query = { view: 'all' as const, status: 'overdue' as const, sort: 'recent' as const, search: 'two', offset: 60, limit: 20 };
  const review = makeReviewPracticeSource(query); query.search = 'changed';
  assert.equal(review.kind, 'review'); if (review.kind !== 'review') throw new Error('source');
  assert.deepEqual(review.query, { view: 'all', status: 'overdue', sort: 'recent', search: 'two' });
});

test('library order comes from the same query and spans every page, not only 30 visible rows', async () => {
  const ids = ['synthetic-two-sum', 'synthetic-anagram-groups', ...Array.from({ length: 251 }, (_, index) => `p${index}`)];
  const requests: unknown[] = []; const api = noReader();
  api.problemPage = async filter => { requests.push(filter); return page(libraryRows(ids), filter?.offset, filter?.limit); };
  const result = await resolvePracticeNavigation(makeLibraryPracticeSource({ listId: 'synthetic-hot100', chapterId: 'hash', difficulty: '中等', support: 'reading', search: 'group', offset: 30 }), api);
  assert.deepEqual(result, ids);
  assert.deepEqual(practiceNavigationPosition(result, ids[0]), { index: 0, total: 253, previousId: null, nextId: 'synthetic-anagram-groups' });
  assert.equal(practiceNavigationPosition(result, ids[99]).nextId, ids[100]);
  assert.equal(practiceNavigationPosition(result, ids[100]).previousId, ids[99]);
  assert.deepEqual(requests, [0, 100, 200].map(offset => ({ listId: 'synthetic-hot100', chapterId: 'hash', difficulty: '中等', support: 'reading', search: 'group', offset, limit: 100 })));
});

test('review navigation retains view/date/list/tag/status/sort and never borrows library ordering', async () => {
  const ids = Array.from({ length: 207 }, (_, index) => `review-${207 - index}`); const requests: unknown[] = [];
  const api = noReader(); api.reviewPlan = async query => { requests.push(query); return snapshot(ids, query?.offset, query?.limit, `12:settings:2026-10-01T10:00:0${requests.length}.000Z`); };
  const query = { view: 'calendar' as const, date: '2026-10-01', month: '2026-10', listId: 'review-list', tag: '树', status: 'due' as const, sort: 'recent' as const, search: 'review', offset: 20 };
  const result = await resolvePracticeNavigation(makeReviewPracticeSource(query, '日期复习列表'), api);
  assert.deepEqual(result, ids);
  assert.equal(practiceNavigationPosition(result, ids[99]).nextId, ids[100]);
  assert.deepEqual(requests, [0, 100, 200].map(offset => ({ ...query, offset, limit: 100 })));
});

test('single, empty, missing and end positions have explicit non-wrapping boundaries', async () => {
  const single = makeFrozenPracticeSource(['only'], '快速搜索');
  assert.deepEqual(await resolvePracticeNavigation(single), ['only']);
  assert.deepEqual(practiceNavigationPosition(['only'], 'only'), { index: 0, total: 1, previousId: null, nextId: null });
  assert.deepEqual(practiceNavigationPosition([], 'only'), { index: -1, total: 0, previousId: null, nextId: null });
  assert.deepEqual(practiceNavigationPosition(['one', 'two'], 'outside'), { index: -1, total: 2, previousId: null, nextId: null });
  assert.deepEqual(practiceNavigationPosition(['one', 'two'], 'two'), { index: 1, total: 2, previousId: 'one', nextId: null });
});

test('a captured review session preserves all queue positions without advancing or completing it', async () => {
  const session: ReviewSession = { id: 'session-one', problemIds: ['already-seen', 'current', 'next'], position: 1, currentProblemId: 'current',
    status: 'active', skippedProblemIds: ['already-seen'], createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', endedAt: null };
  const before = structuredClone(session); const source = makeReviewSessionPracticeSource(session);
  assert.deepEqual(await resolvePracticeNavigation(source, noReader()), session.problemIds);
  assert.deepEqual(practiceNavigationPosition(source.kind === 'frozen' ? source.problemIds : [], 'current'), { index: 1, total: 3, previousId: 'already-seen', nextId: 'next' });
  assert.deepEqual(session, before); assert.equal(source.kind === 'frozen' && source.sessionId, 'session-one');
  session.problemIds.push('new'); assert.equal(source.kind === 'frozen' && source.problemIds.length, 3);
});

test('new sources cannot inherit old neighbors and a resolved order remains frozen across changes', async () => {
  let ids = ['hot-a', 'hot-b']; const api = noReader(); api.problemPage = async filter => page(libraryRows(ids), filter?.offset, filter?.limit);
  const hot = await resolvePracticeNavigation(makeLibraryPracticeSource({ listId: 'hot' }), api);
  ids = ['other-c', 'other-d']; const other = await resolvePracticeNavigation(makeLibraryPracticeSource({ listId: 'other' }), api);
  assert.deepEqual(hot, ['hot-a', 'hot-b']); assert.deepEqual(other, ['other-c', 'other-d']);
  assert.equal(practiceNavigationPosition(other, 'hot-a').nextId, null);
  const direct = await resolvePracticeNavigation(makeFrozenPracticeSource(['outside'], '练习档案'), api);
  assert.deepEqual(direct, ['outside']); assert.equal(practiceNavigationPosition(direct, 'outside').nextId, null);
});

test('aborting a superseded source rejects the late answer before requesting another page', async () => {
  const ids = Array.from({ length: 150 }, (_, index) => `p${index}`); const controller = new AbortController();
  let complete!: (value: PageResult<ProblemListItem>) => void, calls = 0; const api = noReader();
  api.problemPage = async () => { calls++; return await new Promise(resolve => { complete = resolve; }); };
  const pending = resolvePracticeNavigation(makeLibraryPracticeSource({ listId: 'old' }), api, controller.signal);
  controller.abort(); complete(page(libraryRows(ids)));
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls, 1);
  await assert.rejects(resolvePracticeNavigation(makeFrozenPracticeSource(['one'], 'new'), undefined, controller.signal), { name: 'AbortError' });
});

test('changed totals, empty continuing pages and changed review revisions fail closed instead of mixing views', async () => {
  const ids = Array.from({ length: 120 }, (_, index) => `p${index}`); let calls = 0; const api = noReader();
  api.problemPage = async filter => { calls++; const value = page(libraryRows(ids), filter?.offset, filter?.limit); return calls === 2 ? { ...value, total: 121 } : value; };
  await assert.rejects(resolvePracticeNavigation(makeLibraryPracticeSource({}), api), /列表已变化/);
  api.problemPage = async () => ({ items: [], total: 120, offset: 0, limit: 100, hasMore: true });
  await assert.rejects(resolvePracticeNavigation(makeLibraryPracticeSource({}), api), /列表已变化/);
  calls = 0; api.reviewPlan = async query => snapshot(ids, query?.offset, query?.limit, `${++calls}:settings:2026-10-01T10:00:00.000Z`);
  await assert.rejects(resolvePracticeNavigation(makeReviewPracticeSource({ view: 'all' }), api), /复习列表已变化/);
  for (const patch of [{ date: '2026-10-02' }, { timeZone: 'UTC' }]) {
    calls = 0; api.reviewPlan = async query => { const result = snapshot(ids, query?.offset, query?.limit); if (++calls > 1) Object.assign(result.summary, patch); return result; };
    await assert.rejects(resolvePracticeNavigation(makeReviewPracticeSource({ view: 'today' }), api), /复习列表已变化/);
  }
});

test('frozen membership removes duplicate questions without modifying the source input', async () => {
  const ids = ['one', 'one', 'two']; const source = makeFrozenPracticeSource(ids, '所选题目');
  assert.deepEqual(await resolvePracticeNavigation(source), ['one', 'two']); assert.deepEqual(ids, ['one', 'one', 'two']);
});

test('synthetic SQLite metadata honors imported list positions, chapter/difficulty filters and cross-page neighbors', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tilian-navigation-')), store = new PracticeStore(join(directory, 'practice.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ids = Array.from({ length: 105 }, (_, index) => `synthetic-${String(index).padStart(3, '0')}`);
  // Insert in the reverse of the list order so accidental whole-library fallback is visible.
  for (const id of [...ids].reverse()) store.upsertProblem({ id, title: id, source: 'local', difficulty: '中等', tags: ['测试'], description: '合成导航测试题。',
    descriptionFormat: 'plain', constraints: [], mode: 'acm', starter: { python: 'print(input())' }, cases: [{ stdin: '', expected: '' }] });
  store.applyListRefresh(store.previewListRefresh({ id: 'synthetic-list', title: '合成题单', source: 'local', membershipComplete: true,
    chapters: [{ id: 'hash', title: '合成章节', position: 0 }], items: ids.map((problemId, position) => ({ key: problemId, problemId, chapterId: 'hash', position })) }).id);
  const api = noReader(); api.problemPage = async filter => store.listProblemPage(filter);
  const result = await resolvePracticeNavigation(makeLibraryPracticeSource({ listId: 'synthetic-list', chapterId: 'hash', difficulty: '中等', support: 'runnable' }), api);
  assert.deepEqual(result, ids); assert.equal(practiceNavigationPosition(result, ids[99]).nextId, ids[100]);
  const all = await resolvePracticeNavigation(makeLibraryPracticeSource({}), api); assert.deepEqual(all, [...ids].reverse());
});
