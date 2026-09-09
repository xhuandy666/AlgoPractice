import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ImportService } from '../../src/desktop/import-service.ts';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { LeetCodeCnSourceAdapter, parseSource, SourceError } from '../../src/source/index.ts';
import type { FetchOptions, ImportInput, Observation, SourcePlan, SourceProblemContent, SourceReference } from '../../src/source/types.ts';
import type { ImportJob, ProblemContent } from '../../src/shared/library.ts';

const url = (slug: string) => `https://leetcode.cn/problems/${slug}/`;
const id = (slug: string) => `leetcode-cn:problem:${slug}`;
const planUrl = 'https://leetcode.cn/studyplan/fixture-plan/';
// All transport results below are deliberately synthetic fixtures. No live source,
// authenticated session, browser, media download or official verdict is exercised.
const observation: Observation = { fetchedAt: '2026-09-08T00:00:00.000Z', httpStatus: 200,
  responseBytes: 0, responseSha256: 'fixture-not-a-live-response', buildId: null,
  transport: 'public-html-embedded-data', authentication: 'none' };

function content(slug: string, description = `测试题面 ${slug}`): ProblemContent {
  return { id: id(slug), title: `Fixture ${slug}`, difficulty: '简单', tags: ['数组'], source: 'leetcode-cn',
    sourceUrl: url(slug), description, descriptionFormat: 'plain', constraints: [], mode: 'function',
    adapter: { method: 'sum', params: [{ array: 'int' }], returns: 'int' },
    cases: [{ args: [[1, 2]], expected: 3 }], starter: { python: 'class Solution:\n    def sum(self, nums):\n        return sum(nums)' } };
}

class FixtureAdapter extends LeetCodeCnSourceAdapter {
  planSlugs = ['a', 'b'];
  calls: string[] = [];
  planCalls = 0;
  contentHandler: (slug: string, options: FetchOptions) => Promise<ProblemContent> = async slug => content(slug);

  override async fetchPlan(input: string | SourceReference, options: FetchOptions = {}): Promise<SourcePlan> {
    options.signal?.throwIfAborted(); this.planCalls++;
    const source = parseSource(typeof input === 'string' ? input : input.canonicalUrl);
    const questions = this.planSlugs.map((slug, index) => ({ sourceKey: id(slug), slug, sourceId: String(index + 1),
      frontendId: String(index + 1), title: `Fixture ${slug}`, translatedTitle: `测试 ${slug}`, difficulty: 'Easy',
      premiumOnly: false, canonicalUrl: url(slug) }));
    return { source, name: '固定夹具题单', premiumOnly: false,
      sections: [{ slug: 'arrays', name: '数组', declaredCount: questions.length, questions }],
      itemCount: questions.length, uniqueItemCount: questions.length, duplicateSourceKeys: [],
      completeness: 'matches-embedded-section-counts', pagination: 'all-members-embedded-in-one-response', observation };
  }

  override async fetchProblemContent(input: string | SourceReference, options: FetchOptions = {}): Promise<SourceProblemContent> {
    options.signal?.throwIfAborted();
    const reference = parseSource(typeof input === 'string' ? input : input.canonicalUrl);
    this.calls.push(reference.slug);
    const fetched = await this.contentHandler(reference.slug, options);
    options.signal?.throwIfAborted();
    return { content: fetched, reference, capability: fetched.description.trim() ? 'sample-verified' : 'link-only',
      warnings: [], observation, rawMetadata: null };
  }
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'algopractice-import-integration '));
  const dbPath = join(directory, 'practice.sqlite');
  const store = new PracticeStore(dbPath);
  const adapter = new FixtureAdapter();
  const logs: Array<{ event: string; fields?: Record<string, string | number | boolean | null> }> = [];
  const service = new ImportService(store, adapter, join(directory, 'media'), () => {},
    (event, fields) => logs.push({ event, fields }), 0);
  t.after(async () => { await service.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, dbPath, store, adapter, service, logs };
}

function fileInput(slugs = ['a', 'b'], name = '文件集成夹具'): ImportInput {
  return { kind: 'json', name, text: JSON.stringify({ schemaVersion: 1, problems: slugs.map(slug => ({
    id: slug, title: `文件题 ${slug}`, description: `文件题面 ${slug}`, chapter: slug === 'a' ? '数组' : '哈希表',
    mode: 'acm', starter: { python: 'print(input())' }, cases: [{ stdin: '1\n', expected: '1\n' }],
  })) }) };
}

async function settled(service: ImportService, jobId: string): Promise<ImportJob> {
  for (let index = 0; index < 200; index++) {
    const job = service.job(jobId);
    if (!['pending', 'running'].includes(job.status)) {
      // Let the process promise's finally handler release the active task slot.
      await delay(0); return service.job(jobId);
    }
    await delay(5);
  }
  assert.fail(`Fixture job did not settle: ${JSON.stringify(service.job(jobId))}`);
}

function archive(store: PracticeStore, problemId: string) {
  const problem = store.getProblem(problemId)!;
  const attempt = store.startAttempt({ problemId, language: 'python', problemVersion: problem.version });
  const run = store.beginRun({ attemptId: attempt.id, code: 'historical fixture code', testSuiteVersion: 'fixture-tests-v1',
    testSnapshot: problem.content.cases as never, adapterVersion: 'fixture-adapter-v1', runtimeVersion: 'fixture runtime' });
  store.finishRun(run.id, { status: 'passed', result: { fixture: true } });
  const draft = store.saveDraft({ problemId, language: 'python', code: 'newer unsent fixture edits' });
  return { problem, attempt: store.getAttempt(attempt.id)!, run: store.getRun(run.id)!, draft };
}

test('reading a real JSON import preview leaves the library, lists, jobs and drafts untouched', async t => {
  const { service, store, adapter } = fixture(t);
  const prepared = await service.prepare(fileInput(['a', 'b', 'a']));
  assert.equal(prepared.preview.complete, true);
  assert.equal(prepared.preview.items.length, 2);
  assert.equal(prepared.preview.duplicates.length, 1);
  assert.deepEqual(prepared.preview.chapters.map(chapter => chapter.title), ['数组', '哈希表']);
  assert.equal(prepared.membership?.added.length, 2);
  assert.deepEqual(store.listProblems(), []);
  assert.deepEqual(store.listLists(), []);
  assert.deepEqual(store.listImportJobs(), []);
  assert.equal(store.getDraft('file:a', 'python'), undefined);
  assert.deepEqual(adapter.calls, []);
});

test('batch completion and repeated request IDs remain idempotent while active, after eviction and after service restart', async t => {
  const { service, store, adapter, directory } = fixture(t);
  const prepared = await service.prepare(fileInput(['a', 'b', 'a']));
  const started = service.start(prepared.id, 'fixture-request');
  assert.equal(service.start(prepared.id, 'fixture-request').id, started.id);
  const done = await settled(service, started.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.counts.imported, 2);
  assert.equal(done.total, 2);
  assert.equal(store.listProblems().length, 2);
  assert.equal(store.listLists()[0].items.length, 2);
  for (let index = 0; index < 13; index++) await service.prepare(fileInput(['a'], `evict-${index}`));
  assert.deepEqual(service.start(prepared.id, 'fixture-request'), done);
  const restarted = new ImportService(store, adapter, join(directory, 'media'), () => {}, () => {}, 0);
  assert.deepEqual(restarted.start(prepared.id, 'fixture-request'), done);
  assert.throws(() => restarted.start('a-different-preview', 'fixture-request'), /不一致/);
  assert.equal(store.listImportJobs().length, 1);
  assert.deepEqual(adapter.calls, []);
  store.integrityCheck();
});

test('unnamed bulk links and JSON inputs have distinct membership identities instead of sharing the default title', async t => {
  const { service, store } = fixture(t);
  const inputs: ImportInput[] = [
    { kind: 'links', text: `${url('a')} ${url('b')}` },
    { kind: 'links', text: `${url('c')} ${url('d')}` },
    { kind: 'json', text: fileInput(['x']).text },
    { kind: 'json', text: fileInput(['y']).text },
  ];
  const prepared = [];
  for (const input of inputs) prepared.push(await service.prepare(input));
  assert.equal(new Set(prepared.map(value => value.preview.listTitle)).size, 1, 'fixture inputs deliberately have the same default title');
  assert.equal(new Set(prepared.map(value => value.membership!.listId)).size, inputs.length);
  for (let index = 0; index < prepared.length; index++) {
    await settled(service, service.start(prepared[index].id, `unnamed-bulk-${index}`).id);
  }
  assert.equal(store.listLists().length, 4);
  for (const item of prepared) {
    assert.deepEqual(store.getList(item.membership!.listId)?.items.map(row => row.problemId), item.preview.items.map(row => row.problemId));
  }
  const repeat = await service.prepare(inputs[0]);
  assert.equal(repeat.membership?.listId, prepared[0].membership?.listId, 'the same unnamed input can refresh its own list');
});

test('link placeholders retain preview titles, difficulty and tags before fetching and after a failed fetch', async t => {
  const { service, store, adapter } = fixture(t);
  adapter.contentHandler = async () => { throw new SourceError('NETWORK_ERROR', 'fixture cannot fetch content', {}, true); };
  const preview = await service.prepare({ kind: 'json', name: '占位元数据夹具', text: JSON.stringify([
    { url: url('a'), title: '保留题名甲', difficulty: '困难', tags: ['图', '最短路'] },
    { url: url('b'), title: '保留题名乙', difficulty: '中等', tags: ['动态规划'] },
  ]) });
  assert.deepEqual(store.listProblems(), []);
  const started = service.start(preview.id, 'placeholder-metadata');
  const first = store.getProblem(id('a'))!;
  const second = store.getProblem(id('b'))!;
  assert.equal(first.content.title, '保留题名甲');
  assert.equal(first.content.difficulty, '困难');
  assert.deepEqual(first.content.tags, ['图', '最短路']);
  assert.equal(second.content.title, '保留题名乙');
  assert.equal(second.content.difficulty, '中等');
  assert.deepEqual(second.content.tags, ['动态规划']);
  const paused = await settled(service, started.id);
  assert.equal(paused.status, 'paused');
  assert.deepEqual(paused.items.map(item => item.status), ['failed', 'pending']);
  assert.deepEqual(store.getProblem(id('a')), first);
  assert.deepEqual(store.getProblem(id('b')), second);
});

test('pausing an in-flight fixture fetch survives database reopening and resumes only the unfinished item', { timeout: 5000 }, async t => {
  const { service, store, adapter, dbPath, directory } = fixture(t);
  let entered!: () => void;
  const secondEntered = new Promise<void>(resolve => { entered = resolve; });
  adapter.contentHandler = async (slug, { signal }) => {
    if (slug === 'b') {
      entered();
      await new Promise<never>((_, reject) => {
        if (signal?.aborted) reject(new SourceError('CANCELLED', 'fixture cancelled'));
        else signal?.addEventListener('abort', () => reject(new SourceError('CANCELLED', 'fixture cancelled')), { once: true });
      });
    }
    return content(slug);
  };
  const preview = await service.prepare({ kind: 'links', text: `${url('a')}\n${url('b')}` });
  const job = service.start(preview.id, 'pause-request');
  await secondEntered;
  const successful = service.job(job.id).items[0];
  assert.equal(successful.status, 'imported');
  const firstHead = store.getProblem(id('a'))!;
  await service.pause(job.id);
  const paused = service.job(job.id);
  assert.equal(paused.status, 'paused');
  assert.deepEqual(paused.items[0], successful);
  assert.equal(paused.items[1].status, 'pending');
  assert.equal(paused.items[1].attempts, 1);
  adapter.contentHandler = async slug => content(slug);
  await service.stop(); store.close();
  const reopened = new PracticeStore(dbPath);
  const restarted = new ImportService(reopened, adapter, join(directory, 'media'), () => {}, () => {}, 0);
  try {
    assert.deepEqual(restarted.job(job.id), paused);
    restarted.resume(job.id);
    const done = await settled(restarted, job.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.items[0], successful);
    assert.deepEqual(reopened.getProblem(id('a')), firstHead);
    assert.equal(done.items[1].attempts, 2);
    assert.deepEqual(adapter.calls, ['a', 'b', 'b']);
  } finally { await restarted.stop(); reopened.close(); }
});

test('a fixture network failure pauses the batch and an explicit retry preserves prior successes', async t => {
  const { service, adapter } = fixture(t);
  let failing = true;
  adapter.contentHandler = async slug => {
    if (slug === 'b' && failing) throw new SourceError('NETWORK_ERROR', 'fixture transient failure', {}, true);
    return content(slug);
  };
  const preview = await service.prepare({ kind: 'links', text: `${url('a')} ${url('b')} ${url('c')}` });
  const started = service.start(preview.id, 'network-retry');
  const paused = await settled(service, started.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.error?.code, 'NETWORK_ERROR');
  assert.deepEqual(paused.items.map(item => item.status), ['imported', 'failed', 'pending']);
  failing = false;
  service.resume(started.id, true);
  const done = await settled(service, started.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.items[0], paused.items[0]);
  assert.deepEqual(done.items.map(item => item.attempts), [1, 2, 1]);
  assert.deepEqual(adapter.calls, ['a', 'b', 'b', 'c']);
});

test('resuming a batch preserves enriched metadata from an already completed link-only item', async t => {
  const { service, store, adapter } = fixture(t);
  let failing = true;
  adapter.contentHandler = async slug => {
    if (slug === 'a') return { ...content(slug, ''), title: '来源已确认的真实题名', difficulty: '困难', tags: ['数论'],
      adapter: undefined, cases: [], starter: {}, supportReason: 'fixture source provides metadata but not the statement' };
    if (failing) throw new SourceError('NETWORK_ERROR', 'fixture temporary failure', {}, true);
    return content(slug);
  };
  const preview = await service.prepare({ kind: 'links', text: `${url('a')} ${url('b')}` });
  const started = service.start(preview.id, 'preserve-link-only');
  const paused = await settled(service, started.id);
  assert.equal(paused.status, 'paused');
  assert.deepEqual(paused.items.map(item => item.status), ['link_only', 'failed']);
  const enriched = store.getProblem(id('a'))!;
  assert.equal(enriched.content.title, '来源已确认的真实题名');
  assert.deepEqual(enriched.content.tags, ['数论']);
  failing = false;
  service.resume(started.id, true);
  const done = await settled(service, started.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.items[0], paused.items[0]);
  assert.deepEqual(store.getProblem(id('a')), enriched);
  assert.deepEqual(adapter.calls, ['a', 'b', 'b']);
});

test('a completed batch with a fixture schema failure retries only its failed item', async t => {
  const { service, adapter } = fixture(t);
  let failing = true;
  adapter.contentHandler = async slug => {
    if (slug === 'b' && failing) throw new SourceError('SCHEMA_CHANGED', 'fixture field missing');
    return content(slug);
  };
  const preview = await service.prepare({ kind: 'links', text: `${url('a')} ${url('b')}` });
  const started = service.start(preview.id, 'schema-retry');
  const withErrors = await settled(service, started.id);
  assert.equal(withErrors.status, 'completed_with_errors');
  assert.equal(withErrors.items[1].error?.code, 'SCHEMA_CHANGED');
  assert.throws(() => service.resume(started.id), /explicit retry/);
  failing = false; service.resume(started.id, true);
  const done = await settled(service, started.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.items[0], withErrors.items[0]);
  assert.deepEqual(adapter.calls, ['a', 'b', 'b']);
});

test('a stale membership preview is rejected before it creates a job or placeholder', async t => {
  const { service, store } = fixture(t);
  const initial = await service.prepare(fileInput(['a']));
  await settled(service, service.start(initial.id, 'initial-list').id);
  const stale = await service.prepare(fileInput(['a', 'stale-only']));
  const fresh = await service.prepare(fileInput(['a', 'fresh-only']));
  await settled(service, service.start(fresh.id, 'fresh-list').id);
  const jobsBefore = store.listImportJobs();
  const listBefore = store.listLists()[0];
  assert.throws(() => service.start(stale.id, 'stale-list'), /题单已变化/);
  assert.deepEqual(store.listImportJobs(), jobsBefore);
  assert.deepEqual(store.listLists()[0], listBefore);
  assert.equal(store.getProblem('file:stale-only'), undefined);
});

test('a verified empty fixture plan can remove the final member while preserving its draft and archive', async t => {
  const { service, store, adapter } = fixture(t);
  adapter.planSlugs = ['a'];
  const initial = await service.prepare({ kind: 'url', text: planUrl });
  await settled(service, service.start(initial.id, 'plan-initial').id);
  const saved = archive(store, id('a'));
  adapter.planSlugs = [];
  const empty = await service.prepare({ kind: 'url', text: planUrl });
  assert.equal(empty.preview.complete, true);
  assert.equal(empty.preview.items.length, 0);
  assert.equal(empty.membership?.removed.length, 1);
  assert.equal(store.listLists()[0].items.length, 1, 'preview alone cannot remove members');
  const done = await settled(service, service.start(empty.id, 'plan-empty').id);
  assert.equal(done.status, 'completed');
  assert.equal(done.total, 0);
  assert.equal(store.listLists()[0].items.length, 0);
  assert.deepEqual(store.getProblem(id('a')), saved.problem);
  assert.deepEqual(store.getDraft(id('a'), 'python'), saved.draft);
  assert.deepEqual(store.getAttempt(saved.attempt.id), saved.attempt);
  assert.deepEqual(store.getRun(saved.run.id), saved.run);
});

test('an unavailable single-problem fixture refresh preserves the cached head, draft and archive', async t => {
  const { service, store, adapter } = fixture(t);
  store.upsertProblem(content('a'));
  const saved = archive(store, id('a'));
  // The actual source retains available snippets before it discovers an absent
  // statement and returns capability=link-only. A snippet cannot replace a cache.
  adapter.contentHandler = async slug => ({ ...content(slug, ''), adapter: undefined, cases: [],
    supportReason: 'fixture: authenticated access is unavailable' });
  await assert.rejects(service.prepareProblem(id('a')), /已有缓存已保留/);
  assert.deepEqual(store.getProblem(id('a')), saved.problem);
  assert.deepEqual(store.getDraft(id('a'), 'python'), saved.draft);
  assert.deepEqual(store.getAttempt(saved.attempt.id), saved.attempt);
  assert.deepEqual(store.getRun(saved.run.id), saved.run);
});

test('an unavailable fixture refresh cannot erase executable file content that has no statement text', async t => {
  const { service, store, adapter } = fixture(t);
  // JSON imports permit test/template content with a source URL and no description.
  const preview = await service.prepare({ kind: 'json', text: JSON.stringify({ problems: [{
    url: url('a'), title: '无题面但有代码与测试的文件夹具', mode: 'acm',
    starter: { python: 'print(input())' }, cases: [{ stdin: '1\n', expected: '1\n' }],
  }] }) });
  await settled(service, service.start(preview.id, 'execution-only-file').id);
  const existing = store.getProblem(id('a'))!;
  assert.equal(existing.content.source, 'file');
  assert.equal(existing.content.description, '');
  assert.equal(existing.content.cases.length, 1);
  assert.ok(existing.content.starter.python);
  adapter.contentHandler = async slug => ({ ...content(slug, ''), adapter: undefined, cases: [], starter: {},
    supportReason: 'fixture: source returned only the link' });
  await assert.rejects(service.prepareProblem(id('a')), /已有缓存已保留/);
  assert.deepEqual(store.getProblem(id('a')), existing);
  assert.equal(store.getProblem(id('a'))?.content.cases.length, 1);
});

test('explicit JSON updates can replace file tests and templates even when neither version has statement text', async t => {
  const { service, store } = fixture(t);
  const executableFile = (code: string, expected: string): ImportInput => ({ kind: 'json', name: '无题面文件更新夹具',
    text: JSON.stringify({ problems: [{ id: 'executable-file', title: '显式文件执行内容', mode: 'acm',
      starter: { python: code }, cases: [{ stdin: '1\n', expected }] }] }) });
  const initial = await service.prepare(executableFile('print(input())', '1\n'));
  await settled(service, service.start(initial.id, 'executable-file-first').id);
  const before = store.getProblem('file:executable-file')!;
  const updated = await service.prepare(executableFile('print(int(input()) + 1)', '2\n'));
  const done = await settled(service, service.start(updated.id, 'executable-file-update').id);
  const after = store.getProblem('file:executable-file')!;
  assert.equal(done.status, 'completed');
  assert.notEqual(after.version, before.version);
  assert.equal(after.content.description, '');
  assert.equal(after.content.starter.python, 'print(int(input()) + 1)');
  assert.equal(after.content.cases[0].expected, '2\n');
  assert.equal(store.getProblem(before.id, before.version)?.content.starter.python, 'print(input())');
});

test('confirmed problem refresh changes only the current head and rejects a later stale preview', async t => {
  const { service, store, adapter } = fixture(t);
  store.upsertProblem(content('a'));
  const saved = archive(store, id('a'));
  adapter.contentHandler = async slug => content(slug, 'fixture updated statement');
  const fresh = await service.prepareProblem(id('a'));
  const stale = await service.prepareProblem(id('a'));
  assert.equal(fresh.changed, true);
  assert.deepEqual(store.getProblem(id('a')), saved.problem, 'reading a diff cannot change the current head');
  const applied = service.applyProblem(fresh.id);
  assert.notEqual(applied.version, saved.problem.version);
  assert.equal(applied.content.description, 'fixture updated statement');
  assert.throws(() => service.applyProblem(stale.id), /其他导入更新/);
  assert.deepEqual(store.getProblem(id('a')), applied);
  assert.deepEqual(store.getDraft(id('a'), 'python'), saved.draft);
  assert.deepEqual(store.getAttempt(saved.attempt.id), saved.attempt);
  assert.deepEqual(store.getRun(saved.run.id), saved.run);
  assert.equal(store.getProblem(id('a'), saved.problem.version)?.content.description, saved.problem.content.description);
});

test('an incomplete JSON preview cannot start a partial import or remove existing list members', async t => {
  const { service, store } = fixture(t);
  const initial = await service.prepare(fileInput());
  await settled(service, service.start(initial.id, 'valid-list').id);
  const problems = store.listProblems();
  const lists = store.listLists();
  const jobs = store.listImportJobs();
  const invalid = await service.prepare({ kind: 'json', name: '文件集成夹具', text: JSON.stringify([
    { id: 'new-only', title: '应仅预览', description: '有效行' }, { title: '缺少链接与题面的无效行' },
  ]) });
  assert.equal(invalid.preview.complete, false);
  assert.equal(invalid.preview.errors.length, 1);
  assert.equal(invalid.preview.items.length, 1);
  assert.throws(() => service.start(invalid.id, 'invalid-list'), /不完整|无效/);
  assert.deepEqual(store.listProblems(), problems);
  assert.deepEqual(store.listLists(), lists);
  assert.deepEqual(store.listImportJobs(), jobs);
});
