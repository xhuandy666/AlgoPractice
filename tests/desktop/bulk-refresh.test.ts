import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProblemContent } from '../../src/shared/library.ts';
import type { ProblemListItem } from '../../src/shared/learning.ts';
import { isLocallyRunnable, readOnlyCandidates, refreshReadOnlyProblems, type BulkRefreshApi } from '../../src/renderer/bulk-refresh.ts';

const content = (id: string, runnable: boolean): ProblemContent => ({ id, title: id, difficulty: '简单', tags: [], source: 'leetcode-cn', sourceUrl: `https://leetcode.cn/problems/${id}/`,
  description: '题面', descriptionFormat: 'html', constraints: [], mode: 'function', starter: { python: 'class Solution: pass' },
  cases: runnable ? [{ args: [[1]] }] : [], ...(runnable ? { adapter: { method: 'f', params: [{ array: 'int' }], returns: 'void', inPlaceArg: 0 } } : {}) });
const item = (id: string, source: 'leetcode-cn' | 'file' = 'leetcode-cn') => ({ id, content: { title: id, source, sourceUrl: source === 'file' ? undefined : `https://leetcode.cn/problems/${id}/` } }) as unknown as ProblemListItem;

function fakeApi(runnableAfter: Record<string, boolean>, failOn?: string) {
  const calls: string[] = [];
  const api: BulkRefreshApi = {
    problemPage: async filter => {
      calls.push(`page:${filter.listId}:${filter.support}:${filter.offset}`);
      const all = [item('a'), item('own', 'file'), item('b'), item('c')];
      const offset = filter.offset ?? 0, slice = all.slice(offset, offset + 2);
      return { items: slice, total: all.length, offset, limit: 2, hasMore: offset + 2 < all.length };
    },
    previewProblemRefresh: async id => {
      calls.push(`preview:${id}`);
      if (id === failOn) throw new Error(`Error invoking remote method 'problem:refresh-preview': SourceError: 站点限制请求频率；不会自动无限重试。`);
      return { id: `preview-${id}`, before: { id } as never, after: content(id, runnableAfter[id] ?? false), changed: runnableAfter[id] !== undefined };
    },
    applyProblemRefresh: async previewId => { calls.push(`apply:${previewId}`); return {} as never; },
  };
  return { api, calls };
}
const noWait = async () => {};

test('only runnable LeetCode content is a refresh result worth saving', () => {
  assert.equal(isLocallyRunnable(content('x', true)), true);
  assert.equal(isLocallyRunnable(content('x', false)), false);
  assert.equal(isLocallyRunnable({ ...content('x', true), starter: {} }), false, 'no language template, nothing to run');
});

test('candidates are the read-only LeetCode problems of a list across pages', async () => {
  const { api, calls } = fakeApi({});
  assert.deepEqual((await readOnlyCandidates(api, 'hot100')).map(problem => problem.id), ['a', 'b', 'c'], 'file-sourced problems have nothing to refresh');
  assert.deepEqual(calls, ['page:hot100:reading:0', 'page:hot100:reading:2']);
});

test('a pass saves only refreshes that become runnable, waits between problems, and stops on the first error', async () => {
  const { api, calls } = fakeApi({ a: true, b: false }, 'c');
  const waits: number[] = [], progress: string[] = [];
  const outcome = await refreshReadOnlyProblems(api, [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }],
    { signal: new AbortController().signal, wait: async ms => { waits.push(ms); }, onProgress: value => progress.push(`${value.done}/${value.total}:${value.current}`) });
  assert.deepEqual(outcome, { status: 'stopped', total: 4, upgraded: 1, unchanged: 1, error: '站点限制请求频率；不会自动无限重试。' });
  assert.deepEqual(calls, ['preview:a', 'apply:preview-a', 'preview:b', 'preview:c'], 'b changed nothing runnable, d is never reached');
  assert.deepEqual(waits, [1000, 1000]); assert.deepEqual(progress, ['0/4:A', '1/4:B', '2/4:C']);
});

test('cancelling stops before the next problem', async () => {
  const { api, calls } = fakeApi({ a: true, b: true });
  const controller = new AbortController();
  const outcome = await refreshReadOnlyProblems(api, [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], { signal: controller.signal, wait: async () => { controller.abort(); } });
  assert.deepEqual([outcome.status, outcome.upgraded], ['cancelled', 1]);
  assert.deepEqual(calls, ['preview:a', 'apply:preview-a']);
  assert.equal((await refreshReadOnlyProblems(api, [{ id: 'a', title: 'A' }], { signal: controller.signal, wait: noWait })).status, 'cancelled');
});
