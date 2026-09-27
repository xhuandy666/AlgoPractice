import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ImportService } from '../../src/desktop/import-service.ts';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { LeetCodeCnSourceAdapter, parseSource, SourceError } from '../../src/source/index.ts';
import type { FetchOptions, Observation, SourcePlan, SourceProblemContent, SourceReference } from '../../src/source/types.ts';
import type { ImportJob, ProblemContent } from '../../src/shared/library.ts';

const hot100Url = 'https://leetcode.cn/studyplan/top-100-liked/';
const hot100Id = 'leetcode-cn:study-plan:top-100-liked';
const requestKey = 'builtin:leetcode-cn:study-plan:top-100-liked:v1';
const problemId = (slug: string) => `leetcode-cn:problem:${slug}`;
const problemUrl = (slug: string) => `https://leetcode.cn/problems/${slug}/`;
const slugs = Array.from({ length: 100 }, (_, i) => `synthetic-hot100-${i + 1}`);
// Synthetic transport fixtures only. Tests never request official statements or log in.
const observation: Observation = { fetchedAt: '2026-09-27T00:00:00.000Z', httpStatus: 200,
  responseBytes: 0, responseSha256: 'synthetic-hot100-fixture', buildId: null,
  transport: 'public-html-embedded-data', authentication: 'none' };

function content(slug: string): ProblemContent {
  return { id: problemId(slug), source: 'leetcode-cn', sourceUrl: problemUrl(slug), title: `合成题 ${slug}`,
    description: `仅供回归测试的合成题面 ${slug}`, descriptionFormat: 'plain', difficulty: '简单', tags: [], constraints: [],
    mode: 'function', adapter: { method: 'sum', params: [{ array: 'int' }], returns: 'int' },
    starter: { python: 'class Solution:\n    def sum(self, nums):\n        return sum(nums)' },
    cases: [{ args: [[1, 2]], expected: 3 }] };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class FixtureAdapter extends LeetCodeCnSourceAdapter {
  planSlugs = [...slugs];
  planCalls: string[] = [];
  contentCalls: string[] = [];
  beforePlan: (options: FetchOptions) => Promise<void> = async () => {};
  contentHandler: (slug: string, options: FetchOptions) => Promise<ProblemContent> = async slug => content(slug);

  override async fetchPlan(input: string | SourceReference, options: FetchOptions = {}): Promise<SourcePlan> {
    const source = parseSource(typeof input === 'string' ? input : input.canonicalUrl);
    this.planCalls.push(source.canonicalUrl);
    await this.beforePlan(options);
    const questions = this.planSlugs.map((slug, index) => ({ sourceKey: problemId(slug), slug,
      sourceId: String(index + 1), frontendId: String(index + 1), title: `Synthetic ${slug}`,
      translatedTitle: `合成题 ${slug}`, difficulty: 'Easy', premiumOnly: false, canonicalUrl: problemUrl(slug) }));
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const question of questions) { if (seen.has(question.sourceKey)) duplicates.add(question.sourceKey); seen.add(question.sourceKey); }
    return { source, name: '合成 Hot100 回归题单', premiumOnly: false,
      sections: [
        { slug: 'synthetic-first', name: '合成章节甲', declaredCount: questions.slice(0, 40).length, questions: questions.slice(0, 40) },
        { slug: 'synthetic-second', name: '合成章节乙', declaredCount: questions.slice(40).length, questions: questions.slice(40) },
      ], itemCount: questions.length, uniqueItemCount: seen.size, duplicateSourceKeys: [...duplicates],
      completeness: 'matches-embedded-section-counts', pagination: 'all-members-embedded-in-one-response', observation };
  }

  override async fetchProblemContent(input: string | SourceReference, options: FetchOptions = {}): Promise<SourceProblemContent> {
    options.signal?.throwIfAborted();
    const reference = parseSource(typeof input === 'string' ? input : input.canonicalUrl);
    this.contentCalls.push(reference.slug);
    const fetched = await this.contentHandler(reference.slug, options);
    options.signal?.throwIfAborted();
    return { content: fetched, reference, capability: 'sample-verified', warnings: [], observation, rawMetadata: null };
  }
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'algopractice-hot100 '));
  const dbPath = join(directory, 'practice.sqlite');
  const store = new PracticeStore(dbPath);
  const adapter = new FixtureAdapter();
  const service = new ImportService(store, adapter, join(directory, 'media'), () => {}, () => {}, 0);
  t.after(async () => { await service.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, dbPath, store, adapter, service };
}

async function settled(service: ImportService, id: string): Promise<ImportJob> {
  for (let i = 0; i < 400; i++) {
    const job = service.job(id);
    if (!['pending', 'running'].includes(job.status)) { await delay(0); return service.job(id); }
    await delay(5);
  }
  assert.fail(`Synthetic import did not settle: ${id}`);
}

function assertNoImport(store: PracticeStore) {
  assert.deepEqual(store.listProblems(), []);
  assert.deepEqual(store.listLists(), []);
  assert.deepEqual(store.listImportJobs(), []);
}

test('Hot100 does not fetch on service creation; one explicit call imports 100 unique ordered members and chapters', async t => {
  const { service, store, adapter } = fixture(t);
  assert.deepEqual(adapter.planCalls, []);
  assertNoImport(store);
  const started = await service.importHot100();
  assert.equal(started.listId, hot100Id);
  assert.ok(started.job);
  const done = await settled(service, started.job.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.total, 100);
  assert.equal(done.requestKey, requestKey);
  const list = store.getList(hot100Id)!;
  assert.deepEqual(list.items.map(item => item.problemId), slugs.map(problemId));
  assert.deepEqual(list.chapters.map(chapter => chapter.title), ['合成章节甲', '合成章节乙']);
  assert.deepEqual(list.items.map(item => item.position), Array.from({ length: 100 }, (_, i) => i));
  assert.equal(list.items.filter(item => item.chapterId === list.chapters[0].id).length, 40);
  assert.equal(list.items.filter(item => item.chapterId === list.chapters[1].id).length, 60);
  assert.deepEqual(adapter.planCalls, [hot100Url]);
  assert.deepEqual(adapter.contentCalls, slugs);
  store.integrityCheck();
});

test('Hot100 reuses prepared content without changing an existing draft, run or pinned attempt', async t => {
  const { service, store, adapter } = fixture(t);
  const before = store.upsertProblem({ ...content(slugs[0]), description: '已有用户缓存，不应用新的合成题面覆盖。' });
  const draft = store.saveDraft({ problemId: before.id, language: 'python', code: 'private unfinished answer' });
  const attempt = store.startAttempt({ problemId: before.id, language: 'python', problemVersion: before.version });
  const run = store.beginRun({ attemptId: attempt.id, code: draft.code, testSuiteVersion: 'synthetic-suite',
    testSnapshot: before.content.cases as never, adapterVersion: 'synthetic-adapter', runtimeVersion: 'synthetic-runtime' });
  store.finishRun(run.id, { status: 'passed', result: { fixture: true } });
  const frozenRun = store.getRun(run.id);
  const result = await service.importHot100();
  const done = await settled(service, result.job!.id);
  assert.equal(done.counts.reused, 1);
  assert.deepEqual(store.getProblem(before.id), before);
  assert.deepEqual(store.getDraft(before.id, 'python'), draft);
  assert.deepEqual(store.getAttempt(attempt.id), attempt);
  assert.deepEqual(store.getRun(run.id), frozenRun);
  assert.equal(adapter.contentCalls.includes(slugs[0]), false);
});

test('Hot100 keeps a manually imported same-source list and all user-removed members, without a second network request', async t => {
  const { service, store, adapter } = fixture(t);
  const prepared = await service.prepare({ kind: 'url', text: `${hot100Url}?tracking=synthetic` });
  const job = service.start(prepared.id, 'manual-same-source');
  await settled(service, job.id);
  const original = store.getList(hot100Id)!;
  const detached = store.applyListRefresh(store.previewListRefresh({ ...original,
    items: original.items.filter(item => item.problemId !== problemId(slugs[0])), membershipComplete: true }).id);
  const network = [adapter.planCalls.length, adapter.contentCalls.length];
  const next = await service.importHot100();
  assert.equal(next.listId, hot100Id);
  assert.equal(next.job?.id, job.id);
  assert.deepEqual(store.getList(hot100Id), detached);
  assert.equal(store.listImportJobs().length, 1);
  assert.deepEqual([adapter.planCalls.length, adapter.contentCalls.length], network);
  assert.ok(store.getProblem(problemId(slugs[0])), 'detaching membership does not delete its cached content');
});

test('an existing empty Hot100 list is intentional and is not filled again', async t => {
  const { service, store, adapter } = fixture(t);
  const empty = store.applyListRefresh(store.previewListRefresh({ id: hot100Id, title: '已清空的 Hot100',
    source: 'leetcode-cn', sourceUrl: hot100Url, chapters: [], items: [], membershipComplete: true }).id);
  const result = await service.importHot100();
  assert.equal(result.job, null);
  assert.deepEqual(store.getList(hot100Id), empty);
  assert.deepEqual(adapter.planCalls, []);
  assert.deepEqual(store.listImportJobs(), []);
});

test('a durable Hot100 job awaiting membership apply is returned without creating an incompatible second preview', async t => {
  const { service, store, adapter } = fixture(t);
  const prepared = await service.prepare({ kind: 'url', text: hot100Url });
  assert.ok(prepared.membership);
  // Model a stop after createImportJob committed but before applyListRefresh ran.
  const saved = store.createImportJob({ requestKey, title: prepared.preview.listTitle, source: 'leetcode-cn',
    sourceUrl: hot100Url, list: prepared.membership.candidate,
    input: JSON.stringify({ preview: prepared.preview, membershipId: prepared.membership.id, previewId: prepared.id }),
    items: prepared.preview.items.map(item => ({ key: item.key, problemId: item.problemId, title: item.title,
      sourceUrl: item.sourceUrl, chapterId: item.chapterId, position: item.order })) });
  assert.equal(store.getList(hot100Id), undefined);
  const result = await service.importHot100();
  assert.deepEqual(result.job, saved);
  assert.equal(store.getList(hot100Id), undefined, 'the shortcut does not silently resume an existing job');
  assert.equal(store.listImportJobs().length, 1);
  assert.deepEqual(adapter.planCalls, [hot100Url]);
  assert.deepEqual(adapter.contentCalls, []);
  service.resume(saved.id);
  const completed = await settled(service, saved.id);
  assert.equal(completed.status, 'completed');
  assert.equal(store.getList(hot100Id)?.items.length, 100);
});

test('an unrelated job cannot claim the persistent built-in Hot100 request key', async t => {
  const { service, store, adapter } = fixture(t);
  const unrelated = store.createImportJob({ requestKey, title: '不同来源的合成任务', source: 'file', input: '{}', items: [] });
  await assert.rejects(service.importHot100(), /身份冲突/);
  assert.deepEqual(store.listImportJobs(), [unrelated]);
  assert.deepEqual(store.listLists(), []);
  assert.deepEqual(store.listProblems(), []);
  assert.deepEqual(adapter.planCalls, []);
});

test('Hot100 repeated concurrent clicks share one preparation and one persistent job', async t => {
  const { service, store, adapter } = fixture(t);
  const entered = deferred(), release = deferred();
  adapter.beforePlan = async () => { entered.resolve(); await release.promise; };
  const first = service.importHot100();
  await entered.promise;
  const second = service.importHot100();
  const third = service.importHot100();
  release.resolve();
  const results = await Promise.all([first, second, third]);
  assert.equal(new Set(results.map(result => result.job!.id)).size, 1);
  await settled(service, results[0].job!.id);
  assert.equal(store.listImportJobs().length, 1);
  assert.deepEqual(adapter.planCalls, [hot100Url]);
});

test('Hot100 preparation cannot overwrite a same-source list imported while its request is pending', async t => {
  const { service, store, adapter } = fixture(t);
  const entered = deferred(), release = deferred();
  adapter.beforePlan = async () => { entered.resolve(); await release.promise; };
  const pending = service.importHot100();
  await entered.promise;
  const manual = store.applyListRefresh(store.previewListRefresh({ id: hot100Id, title: '并发手动题单',
    source: 'leetcode-cn', sourceUrl: hot100Url, chapters: [], items: [], membershipComplete: true }).id);
  release.resolve();
  const result = await pending;
  assert.equal(result.job, null);
  assert.deepEqual(store.getList(hot100Id), manual);
  assert.deepEqual(store.listImportJobs(), []);
  assert.deepEqual(adapter.contentCalls, []);
});

test('reopening a paused Hot100 task does not restart downloads or recreate removed members', async t => {
  const { service, store, adapter, dbPath, directory } = fixture(t);
  adapter.contentHandler = async () => { throw new SourceError('NETWORK_ERROR', 'synthetic offline failure', {}, true); };
  const result = await service.importHot100();
  const paused = await settled(service, result.job!.id);
  assert.equal(paused.status, 'paused');
  const list = store.getList(hot100Id)!;
  const detached = store.applyListRefresh(store.previewListRefresh({ ...list,
    items: list.items.filter(item => item.problemId !== problemId(slugs[0])), membershipComplete: true }).id);
  await service.stop(); store.close();
  const reopened = new PracticeStore(dbPath);
  const restarted = new ImportService(reopened, adapter, join(directory, 'media'), () => {}, () => {}, 0);
  const beforeCalls = [adapter.planCalls.length, adapter.contentCalls.length];
  try {
    const after = await restarted.importHot100();
    assert.equal(after.job?.id, paused.id);
    assert.equal(after.job?.status, 'paused');
    assert.equal(reopened.listImportJobs().length, 1);
    assert.deepEqual(reopened.getList(hot100Id), detached);
    assert.deepEqual([adapter.planCalls.length, adapter.contentCalls.length], beforeCalls);
    adapter.contentHandler = async slug => content(slug);
    restarted.resume(paused.id, true);
    await settled(restarted, paused.id);
    assert.deepEqual(reopened.getList(hot100Id), detached, 'explicit resume cannot replay an already applied membership snapshot');
  } finally { await restarted.stop(); reopened.close(); }
});

test('Hot100 rejects short, empty and duplicate source directories before creating a list, placeholders or job', async t => {
  for (const [name, directory] of [
    ['short', slugs.slice(0, 99)], ['empty', []], ['100 unique plus repeated member', [...slugs, slugs[0]]],
  ] as const) {
    await t.test(name, async sub => {
      const { service, store, adapter } = fixture(sub);
      adapter.planSlugs = [...directory];
      await assert.rejects(service.importHot100());
      assertNoImport(store);
      assert.deepEqual(adapter.contentCalls, []);
    });
  }
});

test('Hot100 plan retrieval failure does not create a partial list or permanent success marker and can be retried', async t => {
  const { service, store, adapter } = fixture(t);
  adapter.beforePlan = async () => { throw new SourceError('NETWORK_ERROR', 'synthetic plan is offline', {}, true); };
  await assert.rejects(service.importHot100());
  assertNoImport(store);
  adapter.beforePlan = async () => {};
  const result = await service.importHot100();
  await settled(service, result.job!.id);
  assert.equal(store.listImportJobs().length, 1);
  assert.equal(adapter.planCalls.length, 2);
});

test('stopping a pending Hot100 fetch prevents its late completion from starting a job', async t => {
  const { service, store, adapter } = fixture(t);
  const entered = deferred(), release = deferred();
  // This deliberately ignores abort while pending, exercising the caller-side cancellation gate.
  adapter.beforePlan = async () => { entered.resolve(); await release.promise; };
  const pending = service.importHot100();
  const rejected = assert.rejects(pending);
  await entered.promise;
  await service.stop();
  release.resolve();
  await rejected;
  assertNoImport(store);
  assert.deepEqual(adapter.contentCalls, []);
});

test('an IPC gate invalidated while Hot100 is reading rejects before committing the import', async t => {
  const { service, store, adapter } = fixture(t);
  const entered = deferred(), release = deferred();
  let allowed = true;
  adapter.beforePlan = async () => { entered.resolve(); await release.promise; };
  const pending = service.importHot100(() => { if (!allowed) throw new Error('synthetic caller is no longer permitted'); });
  const rejected = assert.rejects(pending, /no longer permitted/);
  await entered.promise;
  allowed = false; release.resolve();
  await rejected;
  assertNoImport(store);
  assert.deepEqual(adapter.contentCalls, []);
});

test('Hot100 does not create another job or its list while a different import is active', async t => {
  const { service, store, adapter } = fixture(t);
  const entered = deferred();
  adapter.contentHandler = async (_slug, { signal }) => {
    entered.resolve();
    return new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) reject(new SourceError('CANCELLED', 'synthetic cancelled'));
      else signal?.addEventListener('abort', () => reject(new SourceError('CANCELLED', 'synthetic cancelled')), { once: true });
    });
  };
  const ordinary = await service.prepare({ kind: 'url', text: problemUrl('synthetic-other') });
  const job = service.start(ordinary.id, 'ordinary-active-import');
  await entered.promise;
  await assert.rejects(service.importHot100());
  assert.equal(store.listImportJobs().length, 1);
  assert.equal(store.listImportJobs()[0].id, job.id);
  assert.equal(store.getList(hot100Id), undefined);
  assert.equal(store.listProblems().length, 1);
});

test('another import started during Hot100 preparation prevents a late Hot100 job from being committed', async t => {
  const { service, store, adapter } = fixture(t);
  const entered = deferred(), release = deferred(), fetching = deferred();
  adapter.beforePlan = async () => { entered.resolve(); await release.promise; };
  const pending = service.importHot100();
  const rejected = assert.rejects(pending, /已有导入任务/);
  await entered.promise;
  adapter.contentHandler = async (_slug, { signal }) => {
    fetching.resolve();
    return new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) reject(new SourceError('CANCELLED', 'synthetic cancelled'));
      else signal?.addEventListener('abort', () => reject(new SourceError('CANCELLED', 'synthetic cancelled')), { once: true });
    });
  };
  const ordinary = await service.prepare({ kind: 'url', text: problemUrl('synthetic-concurrent') });
  const job = service.start(ordinary.id, 'ordinary-concurrent-import');
  await fetching.promise;
  release.resolve();
  await rejected;
  assert.equal(store.listImportJobs().length, 1);
  assert.equal(store.listImportJobs()[0].id, job.id);
  assert.equal(store.getList(hot100Id), undefined);
  assert.equal(store.listProblems().length, 1);
});
