import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { LANGUAGES } from '../../src/shared/languages.ts';
import { capability } from '../../src/shared/capability.ts';
import type { ProblemContent } from '../../src/shared/library.ts';
import type { Adapter, Language } from '../../src/runner/types.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tilian-language-capability-')), store = new PracticeStore(join(directory, 'practice.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.updateLearningSettings({ timeZone: 'UTC' });
  return store;
}
const adapter: Adapter = { method: 'solve', params: ['int'], returns: 'int' };
function problem(id: string, language: Language, changes: Partial<ProblemContent> = {}): ProblemContent {
  return { id, source: 'local', title: id, difficulty: '简单', tags: [], description: '可读题面', descriptionFormat: 'plain',
    constraints: [], mode: 'function', adapter, cases: [{ args: [1], expected: 1 }], starter: { [language]: `${language} starter` }, ...changes };
}

test('four-language metadata filtering stays body-free and mirrors source capability across supported and unsupported signatures', t => {
  const store = fixture(t);
  const problems = [problem('python-only', 'python'), problem('java-only', 'java'), problem('go-only', 'go'), problem('cpp-only', 'cpp'),
    problem('cpp-bigint-param', 'cpp', { adapter: { ...adapter, params: [{ array: { list: 'bigint' } }] } }),
    problem('cpp-bigint-return', 'cpp', { adapter: { ...adapter, returns: { list: { array: 'bigint' } } } }),
    problem('cpp-method-bigint', 'cpp', { adapter: { ...adapter, method: 'bigint' } }),
    problem('cpp-int64', 'cpp', { adapter: { ...adapter, params: [{ array: 'int64' }], returns: 'int64' } }),
    problem('go-bigint', 'go', { adapter: { ...adapter, params: [{ array: 'bigint' }], returns: 'bigint' } }),
    problem('cpp-reading', 'cpp', { adapter: undefined }), problem('cpp-no-cases', 'cpp', { cases: [] }),
    problem('cpp-empty', 'cpp', { starter: { cpp: ' \t\r\n' } }),
    problem('cpp-acm', 'cpp', { mode: 'acm', adapter: undefined, cases: [{ stdin: '1', expected: '1' }] }),
    problem('cpp-acm-does-not-use-adapter', 'cpp', { mode: 'acm', adapter: { ...adapter, returns: 'bigint' }, cases: [{ stdin: '' }] }),
    problem('cpp-bigint-plus-go', 'cpp', { adapter: { ...adapter, returns: 'bigint' }, starter: { cpp: 'cpp starter', go: 'go starter' } })];
  problems.forEach(input => store.upsertProblem(input));
  store.getProblem = () => { throw new Error('Language metadata must not fetch a full body'); };
  store.listProblems = () => { throw new Error('Language metadata must not scan all full bodies'); };
  const page = store.listProblemPage({ limit: 100 }); assert.equal(page.total, problems.length);
  for (const input of problems) {
    const item = page.items.find(row => row.id === input.id)!;
    assert.deepEqual(item.capability, capability(input), input.id);
    assert.equal(item.capabilities.cppTemplate, Boolean(input.starter.cpp?.trim()), `${input.id}: raw C++ template evidence`);
    for (const language of LANGUAGES) {
      const languageItems = store.listProblemPage({ ids: [input.id], language }).items;
      if (input.starter[language]?.trim()) assert.equal(languageItems.length, 1, `${input.id}:${language}: readable templates stay visible`);
      else assert.equal(languageItems.length, 0);
      if (languageItems.length) assert.deepEqual(languageItems[0].capability, capability(input, language), `${input.id}:${language}`);
    }
    assert.equal('description' in item.content, false); assert.equal('starter' in item.content, false);
  }
  const cppRunnable = store.listProblemPage({ language: 'cpp', support: 'runnable' }).items.map(row => row.id);
  assert.deepEqual(cppRunnable, ['cpp-only', 'cpp-method-bigint', 'cpp-int64', 'cpp-acm', 'cpp-acm-does-not-use-adapter']);
  assert.deepEqual(store.listProblemPage({ language: 'cpp', support: 'reading' }).items.map(row => row.id),
    ['cpp-bigint-param', 'cpp-bigint-return', 'cpp-reading', 'cpp-no-cases', 'cpp-bigint-plus-go']);
  assert.equal(page.items.find(row => row.id === 'cpp-reading')!.capabilities.cpp, true, 'no adapter retains template evidence, but cannot run');
  assert.equal(page.items.find(row => row.id === 'cpp-bigint-param')!.capabilities.cpp, false);
  assert.equal(page.items.find(row => row.id === 'cpp-bigint-param')!.capabilities.cppTemplate, true, 'an unsupported adapter is not a missing template');
  assert.equal(page.items.find(row => row.id === 'cpp-bigint-return')!.capabilities.cppTemplate, true);
  assert.equal(page.items.find(row => row.id === 'cpp-empty')!.capabilities.cppTemplate, false);
  assert.equal(page.items.find(row => row.id === 'cpp-bigint-plus-go')!.capabilities.go, true);
  assert.equal(page.items.find(row => row.id === 'cpp-bigint-plus-go')!.capability.canRun, true);
  const pages = [0, 2, 4].flatMap(offset => store.listProblemPage({ language: 'cpp', support: 'runnable', offset, limit: 2 }).items);
  assert.deepEqual(pages.map(row => row.id), cppRunnable); store.integrityCheck();
});

test('the fresh learning queue includes Go/C++ only runnable content and excludes recursive C++ bigint without inventing per-language review plans', t => {
  const store = fixture(t), denied = problem('00-cpp-bigint', 'cpp', { adapter: { ...adapter, params: [{ list: { array: 'bigint' } }] } }),
    readable = problem('01-cpp-reading', 'cpp', { adapter: undefined }), noCases = problem('02-go-no-cases', 'go', { cases: [] }),
    admitted = [problem('10-go', 'go'), problem('11-cpp-method-bigint', 'cpp', { adapter: { ...adapter, method: 'bigint' } }),
      problem('12-cpp-acm', 'cpp', { mode: 'acm', adapter: undefined, cases: [{ stdin: '' }] }),
      problem('13-go-bigint', 'go', { adapter: { ...adapter, returns: 'bigint' } })];
  [denied, readable, noCases, ...admitted].forEach(input => store.upsertProblem(input));
  assert.deepEqual(store.getTodayQueue().newProblemIds, admitted.slice(0, 3).map(input => input.id));
  const first = store.getProblem(admitted[0].id)!;
  store.startAttempt({ problemId: first.id, problemVersion: first.version, language: 'go' });
  assert.deepEqual(store.getTodayQueue().newProblemIds, admitted.slice(1).map(input => input.id));
  const plan = store.addReviewItem({ problemId: admitted[1].id, target: 'rewrite', language: 'cpp' });
  assert.equal(plan.language, 'none'); assert.equal(plan.target, 'understanding');
  assert.equal(store.addReviewItem({ problemId: admitted[1].id, target: 'rewrite', language: 'java' }).id, plan.id);
  assert.deepEqual(store.getTodayQueue().newProblemIds, admitted.slice(2).map(input => input.id));
  store.integrityCheck();
});
