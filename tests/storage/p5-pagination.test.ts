import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PracticeStore, type SaveRunInput } from '../../src/storage/practice-store.ts';
import type { ProblemContent } from '../../src/shared/library.ts';
import { capability } from '../../src/shared/capability.ts';

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'Algo P5 pagination '));
  const store = new PracticeStore(join(directory, 'practice.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
const body = 'BODY_MUST_STAY_IN_DETAIL '.repeat(500);
function problem(id: string, changes: Partial<ProblemContent> = {}): ProblemContent {
  return { id, title: `题目 ${id}`, difficulty: '简单', tags: ['数组'], source: 'local', description: body,
    descriptionFormat: 'plain', constraints: [body], mode: 'function', adapter: { method: 'sum', params: [{ array: 'int' }], returns: 'int' },
    cases: [{ args: [[1, 2]], expected: 3 }], starter: { python: `# ${body}\nclass Solution: pass` }, ...changes };
}
const run = (attemptId: string, changes: Partial<SaveRunInput> = {}): SaveRunInput => ({ attemptId, code: body,
  testSuiteVersion: 'suite', testSnapshot: { description: body }, adapterVersion: 'adapter', runtimeVersion: 'runtime',
  status: 'passed', result: { durationMs: 42, stdout: body, caseResults: [{ status: 'passed', actual: body }, { status: 'wrong_answer', actual: body }] }, ...changes });

test('P5 problem pages preserve metadata filters, list ordering/duplicates and capability without fetching bodies', t => {
  const store = fixture(t);
  const candidates = [problem('p0', { title: '100%_\\ Exact', tags: ['DP'] }), problem('p1', { starter: {} }),
    problem('p2', { mode: 'acm', adapter: undefined, description: '', cases: [{ stdin: '1' }], starter: { java: 'class Main {}' } }),
    problem('p3', { difficulty: 'Medium', tags: ['二分'], source: 'file', sourceUrl: 'https://example.invalid/p3', media: { complete: false, missingUrls: ['https://example.invalid/image'] } }), problem('p4')];
  candidates.forEach(value => store.upsertProblem(value));
  store.applyListRefresh(store.previewListRefresh({ id: 'ordered', title: '题单', source: 'file', membershipComplete: true,
    chapters: [{ id: 'c', title: '章节', position: 0 }], items: [
      { key: 'p3-first', problemId: 'p3', chapterId: 'c', position: 0 }, { key: 'p0', problemId: 'p0', position: 1 },
      { key: 'p3-again', problemId: 'p3', chapterId: 'c', position: 2 }] }).id);
  store.getProblem = () => { throw new Error('A list must not fetch a detail'); };
  const first = store.listProblemPage({ limit: 2 });
  assert.equal(first.total, 5); assert.equal(first.hasMore, true); assert.deepEqual(first.items.map(value => value.id), ['p0', 'p1']);
  const tail = store.listProblemPage({ limit: 2, offset: 4 }); assert.deepEqual(tail.items.map(value => value.id), ['p4']); assert.equal(tail.hasMore, false);
  for (const input of candidates) assert.deepEqual(store.listProblemPage({ ids: [input.id] }).items[0].capability, capability(input));
  assert.deepEqual(store.listProblemPage({ search: '%_\\' }).items.map(value => value.id), ['p0']);
  assert.deepEqual(store.listProblemPage({ search: 'dp' }).items.map(value => value.id), ['p0']);
  assert.equal(store.listProblemPage({ search: 'BODY_MUST_STAY' }).total, 0);
  assert.equal(store.listProblemPage({ support: 'reading' }).total, 1);
  assert.deepEqual(store.listProblemPage({ language: 'java', support: 'runnable' }).items.map(value => value.id), ['p2']);
  assert.deepEqual(store.listProblemPage({ difficulty: '中等' }).items.map(value => value.id), ['p3']);
  assert.deepEqual(store.listProblemPage({ listId: 'ordered' }).items.map(value => value.listItem?.key), ['p3-first', 'p0', 'p3-again']);
  assert.equal(store.listProblemPage({ listId: 'ordered', chapterId: 'c', ids: ['p3'] }).total, 2);
  assert.equal(store.listProblemPage({ listId: 'missing' }).total, 0); assert.equal(store.listProblemPage({ ids: [] }).total, 0);
  assert.equal(JSON.stringify(store.listProblemPage()).includes('BODY_MUST_STAY'), false);
  assert.equal('description' in first.items[0].content, false); assert.equal('starter' in first.items[0].content, false);
});

test('P5 archive/run pages retain pinned identity, summary counts and recent order while detail remains exact', t => {
  const store = fixture(t), p = store.upsertProblem(problem('p'));
  const a = store.startAttempt({ problemId: p.id, problemVersion: p.version, language: 'python' });
  store.recordActivity({ requestId: 'activity', attemptId: a.id, durationMs: 300, occurredAt: a.startedAt });
  const r1 = store.saveRun(run(a.id)), r2 = store.saveRun(run(a.id, { code: `${body}2`, status: 'wrong_answer' }));
  store.finishAttempt(a.id, { code: `${body} final` });
  store.upsertProblem(problem('p', { title: 'Refreshed title' }));
  const b = store.startAttempt({ problemId: p.id, problemVersion: p.version, language: 'java' });
  store.saveRun(run(b.id, { status: 'queued', result: undefined }));
  const expectedDetail = store.getRun(r2.id)!; assert.equal(expectedDetail.code, `${body}2`);
  store.getAttempt = () => { throw new Error('A list must not fetch an attempt body'); };
  store.getRun = () => { throw new Error('A list must not fetch a Run body'); };
  store.listRuns = () => { throw new Error('A list must not fetch all Runs'); };
  const page = store.listAttemptPage({ limit: 1 }); assert.equal(page.total, 2); assert.equal(page.items[0].attempt.id, b.id); assert.equal(page.items[0].lastStatus, null);
  const ended = store.listAttemptPage({ state: 'ended', language: 'python', search: '题目' }).items[0];
  assert.equal(ended.title, '题目 p'); assert.equal(ended.runCount, 2); assert.equal(ended.lastStatus, 'wrong_answer'); assert.equal(ended.activeMs, 300);
  assert.equal(ended.attempt.lastRunMatchesFinal, false); assert.equal(ended.attempt.lastRunId, r2.id);
  assert.equal('problemSnapshot' in ended.attempt, false); assert.equal('finalCode' in ended.attempt, false);
  const runs = store.listRunPage({ attemptId: a.id, limit: 1 });
  assert.equal(runs.total, 2); assert.equal(runs.items[0].id, r2.id); assert.equal(runs.items[0].durationMs, 42);
  assert.equal(runs.items[0].caseCount, 2); assert.equal(runs.items[0].passedCaseCount, 1);
  assert.equal(store.listRunPage({ attemptId: a.id, offset: 1 }).items[0].id, r1.id);
  assert.equal(store.listRunPage().total, 2); assert.equal(store.listRunPage({ includeQueued: true }).total, 3);
  assert.equal(store.listRunPage({ language: 'java' }).total, 0);
  assert.equal(JSON.stringify([ended, runs]).includes('BODY_MUST_STAY'), false);
});

test('P5 note pages search historical content but show separate latest/confirmed summaries and relevant confirmed notes', t => {
  const store = fixture(t); store.upsertProblem(problem('p')); store.upsertProblem(problem('other'));
  const n = store.saveNote({ requestId: 'n1', kind: 'problem', subjectId: 'p', title: '已确认标题', markdown: `${body} historical 100%_`, tags: ['DP', 'OnlyUniqueTag_%'], state: 'confirmed' });
  store.saveNote({ requestId: 'n2', noteId: n.id, kind: 'problem', subjectId: 'p', title: '尚未确认新标题', markdown: body, tags: ['数组'], expectedVersion: 1 });
  store.saveNote({ requestId: 'other', kind: 'problem', subjectId: 'other', title: 'Other', markdown: body, state: 'confirmed' });
  store.saveNote({ requestId: 'topic', kind: 'topic', subjectId: 'topic', title: '专题', markdown: body, state: 'confirmed' });
  store.saveNote({ requestId: 'draft', kind: 'topic', subjectId: 'draft', title: '草稿', markdown: body });
  assert.match(store.getNote(n.id)!.confirmed!.markdown, /historical/);
  store.getNote = () => { throw new Error('A list must not fetch a note detail'); };
  const historical = store.listNotePage({ search: '100%_', tag: 'dp' }); assert.equal(historical.total, 1);
  assert.equal(historical.items[0].current.title, '尚未确认新标题'); assert.equal(historical.items[0].confirmed?.title, '已确认标题');
  assert.equal(historical.items[0].current.version, 2); assert.equal(historical.items[0].confirmed?.version, 1);
  assert.deepEqual(store.listNotePage({ search: 'onlyuniquetag_%' }).items.map(value => value.id), [n.id], 'free search includes literal historical tag values absent from every title/body');
  assert.equal(store.listNotePage({ search: '"DP"' }).total, 0, 'JSON syntax around tags is not searchable content');
  const relevant = store.listNotePage({ confirmedOnly: true, relevantProblemId: 'p' }); assert.equal(relevant.total, 2);
  assert.deepEqual(new Set(relevant.items.map(value => value.subjectId)), new Set(['p', 'topic']));
  assert.equal(JSON.stringify(relevant).includes('BODY_MUST_STAY'), false);
  const allIds = [...store.listNotePage({ limit: 2 }).items, ...store.listNotePage({ limit: 2, offset: 2 }).items].map(value => value.id);
  assert.equal(new Set(allIds).size, 4); assert.equal(store.listNotePage({ offset: 100 }).hasMore, false);
});

test('P5 page bounds and filters reject invalid or unbounded input before querying', t => {
  const store = fixture(t);
  for (const query of [store.listProblemPage.bind(store), store.listAttemptPage.bind(store), store.listRunPage.bind(store), store.listNotePage.bind(store)]) {
    for (const limit of [-1, 0, 101, 1.5, Number.NaN]) assert.throws(() => query({ limit }), /limit/);
    for (const offset of [-1, 0.5, Number.NaN, Infinity]) assert.throws(() => query({ offset }), /offset/);
    assert.equal(query({}).limit, 50);
  }
  assert.throws(() => store.listProblemPage({ ids: Array(101).fill('p') }), /100/);
  assert.throws(() => store.listProblemPage({ chapterId: 'c' }), /requires a list/);
  assert.throws(() => store.listProblemPage({ search: 'x'.repeat(501) }), /500/);
  assert.throws(() => store.listRunPage({ includeQueued: 'yes' as never }), /queued/);
  assert.throws(() => store.listNotePage({ confirmedOnly: 'yes' as never }), /confirmed/);
});


test('P5 metadata and Today use JavaScript whitespace semantics for empty statements and templates', t => {
  const store = fixture(t);
  store.upsertProblem(problem('a-empty', { description: '\n\t\u3000', starter: { python: '\n\t\u00a0\uFEFF' } }));
  store.upsertProblem(problem('b-runnable'));
  const page = store.listProblemPage({ ids: ['a-empty'] });
  assert.deepEqual(page.items[0].capability, capability(store.getProblem('a-empty')!.content));
  assert.equal(page.items[0].capabilities.python, false); assert.equal(page.items[0].capabilities.statement, false);
  assert.deepEqual(store.getTodayQueue().newProblemIds, ['b-runnable']);
});
