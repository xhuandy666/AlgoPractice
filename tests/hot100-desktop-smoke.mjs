import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// npm run build && node tests/hot100-desktop-smoke.mjs
// Real Electron / preload / IPC / SQLite, but NEVER live LeetCode content or login.
// Only the isolated source-session Fetch is replaced by synthetic HTML fixtures.
// The production importer, HTML adapter, persistence and React UI are unchanged.
const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, 'package.json'));
const directory = await mkdtemp(join(tmpdir(), 'tilian-hot100-desktop-'));
const launchDirectory = join(directory, 'app'), dataDirectory = join(directory, 'data'), runtimeDirectory = join(directory, 'missing-runtimes');
await mkdir(launchDirectory); await mkdir(dataDirectory); await mkdir(runtimeDirectory);
await cp(join(root, 'dist'), join(launchDirectory, 'dist'), { recursive: true });
await cp(join(root, 'package.json'), join(launchDirectory, 'package.json'));
const env = { ...process.env, ALGOPRACTICE_DATA_DIR: dataDirectory, ALGOPRACTICE_RUNTIME_DIR: runtimeDirectory };
delete env.ELECTRON_RUN_AS_NODE;
const planUrl = 'https://leetcode.cn/studyplan/top-100-liked/';
const listId = 'leetcode-cn:study-plan:top-100-liked';
const slug = index => `hot100-synthetic-${String(index).padStart(3, '0')}`;
const problemId = index => `leetcode-cn:problem:${slug(index)}`;
const problemUrl = index => `https://leetcode.cn/problems/${slug(index)}/`;
const question = index => ({ id: String(900000 + index), titleSlug: slug(index), questionFrontendId: String(900000 + index),
  title: `Synthetic fixture ${index}`, translatedTitle: `自建测试题 ${index}`, difficulty: 'Easy', paidOnly: false });
const html = data => `<html><script type="application/json" id="__NEXT_DATA__">${JSON.stringify({ buildId: 'SYNTHETIC_HOT100_TEST_ONLY',
  props: { pageProps: { dehydratedState: { queries: [{ state: { data } }] } } } })}</script></html>`;
const pages = { [planUrl]: html({ studyPlanV2Detail: { slug: 'top-100-liked', name: '自建 100 题流程夹具（非官方内容）', premiumOnly: false,
  planSubGroups: Array.from({ length: 4 }, (_, chapter) => ({ slug: `synthetic-chapter-${chapter}`, name: `自建章节 ${chapter + 1}`, questionNum: 25,
    questions: Array.from({ length: 25 }, (_, item) => question(chapter * 25 + item + 1)) })) } }) };
for (let index = 1; index <= 100; index++) pages[problemUrl(index)] = html({ question: { ...question(index),
  content: '<p>Synthetic test statement, not platform content.</p>', translatedContent: '<p>仅用于自动化验收的自建说明，不是官方题面。</p>',
  metaData: JSON.stringify({ name: 'echo', params: [{ name: 'value', type: 'integer' }], return: { type: 'integer' } }),
  jsonExampleTestcases: JSON.stringify(['7']), codeSnippets: [
    { langSlug: 'python3', code: 'class Solution:\n    def echo(self, value: int) -> int:\n        return value\n' },
    { langSlug: 'java', code: 'class Solution { public int echo(int value) { return value; } }' },
  ] } });
const report = { directory, dataDirectory, runtimeDirectory, platform: process.platform, arch: process.arch,
  build: JSON.parse(await readFile(join(launchDirectory, 'dist/build-info.json'), 'utf8')).sourceHash,
  assertions: [], rendererErrors: [], fixtureRequests: [], syntheticSessionChecks: [], blockedNetworkAttempts: [],
  limitations: ['All 100 questions, chapter metadata and HTML responses are explicitly synthetic; this does not validate live official content, permission or site availability.',
    'Network guards are installed after Playwright main-process attachment and are not an OS network sandbox.',
    'No real account/session, environment download, code execution, installer/signing or other platform was exercised.'] };
let app, page, launchCount = 0;
const api = (method, ...args) => page.evaluate(({ method, args }) => window.algo[method](...args), { method, args });
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const card = () => page.getByRole('region', { name: 'LeetCode 热题 100', exact: true });
const pass = (name, details = true) => { report.assertions.push({ name, details }); console.log('PASS', name); };
const requests = () => app.evaluate(() => globalThis.hot100Smoke.requests);
async function until(predicate, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  throw new Error(`Timed out: ${description}`);
}
async function launch() {
  launchCount++;
  app = await electron.launch({ executablePath: require('electron'), args: [launchDirectory], cwd: root, env });
  await app.context().route(/^https?:\/\//, route => { report.blockedNetworkAttempts.push({ launch: launchCount, source: 'renderer', url: route.request().url() }); return route.abort('blockedbyclient'); });
  await app.evaluate(({ session }, fixture) => {
    globalThis.hot100Smoke = { requests: [], sessionChecks: [], blocked: [], gatePlan: false, releasePlan: null };
    const state = globalThis.hot100Smoke;
    const describe = input => String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const source = session.fromPartition('persist:leetcode-cn');
    const blockHttp = (details, callback) => {
      state.blocked.push({ source: 'session-web-request', url: details.url }); callback({ cancel: true });
    };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, blockHttp);
    source.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, blockHttp);
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = describe(input);
      if (/^https?:\/\//.test(url)) { state.blocked.push({ source: 'main-fetch', url }); return Promise.reject(new Error('HOT100_SMOKE_REAL_NETWORK_BLOCKED')); }
      return original(input, init);
    };
    source.fetch = async (input, init) => {
      const url = describe(input); init?.signal?.throwIfAborted();
      // Existing import-page login diagnostics are not an automatic content import.
      if (url === 'https://leetcode.cn/graphql/' && init?.method === 'POST' &&
        init?.body === JSON.stringify({ query: 'query globalData { userStatus { isSignedIn } }', operationName: 'globalData' })) {
        state.sessionChecks.push(url);
        return new Response(JSON.stringify({ data: { userStatus: { isSignedIn: false } } }), { headers: { 'content-type': 'application/json' } });
      }
      state.requests.push(url);
      if (init?.method !== 'GET' || !(url in fixture.pages)) {
        state.blocked.push({ source: 'unexpected-source-fetch', url }); throw new Error('HOT100_SMOKE_ONLY_SYNTHETIC_GET_ALLOWED');
      }
      if (url === fixture.planUrl && state.gatePlan) await new Promise((resolve, reject) => {
        const abort = () => { state.releasePlan = null; reject(init.signal.reason); };
        init?.signal?.addEventListener('abort', abort, { once: true });
        state.releasePlan = () => { init?.signal?.removeEventListener('abort', abort); state.releasePlan = null; resolve(); };
      });
      init?.signal?.throwIfAborted();
      return new Response(fixture.pages[url], { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    };
  }, { pages, planUrl });
  page = await app.firstWindow(); page.on('pageerror', error => report.rendererErrors.push(error.message));
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const cdp = await app.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
}
async function close() {
  if (!app) return;
  await until(async () => !(await api('backups')).busy, 'backup completes before close');
  const state = await app.evaluate(() => ({ requests: globalThis.hot100Smoke.requests, sessionChecks: globalThis.hot100Smoke.sessionChecks, blocked: globalThis.hot100Smoke.blocked }));
  report.fixtureRequests.push(...state.requests.map(url => ({ launch: launchCount, url })));
  report.syntheticSessionChecks.push(...state.sessionChecks.map(url => ({ launch: launchCount, url })));
  report.blockedNetworkAttempts.push(...state.blocked.map(item => ({ launch: launchCount, ...item })));
  const closing = app; app = null;
  let timeout;
  try { await Promise.race([closing.close(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Electron did not quit in 15 seconds')), 15000); })]); }
  catch (error) { closing.process().kill('SIGKILL'); throw error; }
  finally { clearTimeout(timeout); }
}

try {
  await launch();
  assert.equal(resolve((await api('environment')).dataDirectory), dataDirectory);
  assert.equal(await app.evaluate(async ({ session }) => (await session.fromPartition('persist:leetcode-cn').cookies.get({})).length), 0);
  const reminders = await api('reminderState'); await api('saveReminderSettings', { ...reminders.settings, enabled: false });
  await nav('题库'); await card().getByRole('button', { name: '一键导入 Hot100', exact: true }).waitFor();
  await nav('导入题单');
  await card().getByRole('button', { name: '一键导入 Hot100', exact: true }).waitFor();
  await delay(700);
  assert.deepEqual(await requests(), []);
  assert.equal((await api('library')).lists.some(list => list.id === listId), false);
  pass('Fresh launch and browsing both Hot100 entry points never fetch a plan or statement or start an import',
    { existingImportPageSessionCheck: 'Synthetic logged-out response only; not a content import' });

  const prepared = await api('previewImport', { kind: 'json', name: '保留本机数据夹具', text: JSON.stringify({ schemaVersion: 1, problems: [{
    url: problemUrl(1), title: '必须保留的本机题面', description: 'LOCAL_STATEMENT_MUST_SURVIVE', mode: 'function',
    adapter: { method: 'echo', params: ['int'], returns: 'int' }, cases: [{ args: [7], expected: 7 }],
    starter: { python: 'class Solution:\n    def echo(self, value):\n        return value\n' },
  }] }) });
  const seed = await api('startImport', prepared.id, randomUUID());
  await until(async () => (await api('importJob', seed.id)).status === 'completed', 'local seed import completes');
  const localProblem = (await api('workspace', problemId(1), 'python', 'practice', 'function')).problem;
  await api('saveDraft', problemId(1), 'python', '# LOCAL_DRAFT_MUST_SURVIVE\n', 'practice', { answerFormat: 'function' });
  const localDraft = await api('loadDraft', problemId(1), 'python', 'practice', 'function');
  const localNote = await api('saveNote', { requestId: randomUUID(), kind: 'problem', subjectId: problemId(1),
    title: '必须保留的个人笔记', markdown: 'LOCAL_NOTE_MUST_SURVIVE', tags: ['自建测试'] });
  assert.deepEqual(await requests(), []);
  await app.evaluate(() => { globalThis.hot100Smoke.gatePlan = true; });
  await card().getByRole('button', { name: '一键导入 Hot100', exact: true }).click();
  await until(async () => (await requests()).filter(url => url === planUrl).length === 1, 'UI invokes real import:hot100 IPC');
  await page.evaluate(() => {
    window.hot100DuplicateResult = null; window.hot100DuplicateError = null;
    void Promise.all(Array.from({ length: 4 }, () => window.algo.importHot100()))
      .then(results => { window.hot100DuplicateResult = results; }, error => { window.hot100DuplicateError = String(error); });
  });
  await delay(100);
  assert.deepEqual(await requests(), [planUrl]);
  await app.evaluate(() => { globalThis.hot100Smoke.releasePlan(); globalThis.hot100Smoke.gatePlan = false; });
  await until(() => page.evaluate(() => window.hot100DuplicateResult !== null || window.hot100DuplicateError !== null), 'concurrent callers settle');
  assert.equal(await page.evaluate(() => window.hot100DuplicateError), null);
  const duplicates = await page.evaluate(() => window.hot100DuplicateResult);
  const jobId = duplicates[0].job.id;
  assert.ok(duplicates.every(result => result.listId === listId && result.job.id === jobId && result.job.input === ''));
  let library = await api('library'), list = library.lists.find(item => item.id === listId);
  assert.equal(list.items.length, 100); assert.equal(new Set(list.items.map(item => item.problemId)).size, 100);
  assert.equal(list.chapters.length, 4);
  assert.equal(library.jobs.filter(job => job.sourceUrl === planUrl).length, 1);
  assert.equal((await api('importJob', jobId)).total, 100);
  pass('One real UI click and four concurrent public-bridge calls create one 100-member list and one task', { listId, jobId });

  await until(async () => (await api('importJob', jobId)).counts.imported >= 2, 'first synthetic statements cache');
  await card().getByRole('button', { name: '暂停导入', exact: true }).click();
  await until(async () => (await api('importJob', jobId)).status === 'paused', 'UI pause is persisted');
  const paused = await api('importJob', jobId), beforeRepeat = await requests();
  assert.equal((await api('importHot100')).job.id, jobId);
  assert.deepEqual(await requests(), beforeRepeat);
  assert.equal((await api('importJob', jobId)).status, 'paused');
  assert.equal(paused.counts.reused, 1); assert.ok(paused.counts.pending > 0);
  assert.equal(beforeRepeat.includes(problemUrl(1)), false, 'prepared user content is reused without fetching');
  assert.deepEqual((await api('workspace', problemId(1), 'python', 'practice', 'function')).problem, localProblem);
  assert.deepEqual(await api('loadDraft', problemId(1), 'python', 'practice', 'function'), localDraft);
  assert.deepEqual(await api('note', localNote.id), localNote);
  await page.screenshot({ path: join(directory, 'hot100-paused.png'), fullPage: true });
  pass('Pause and repeated shortcut preserve progress, existing content, independent drafts and notes without a new fetch');

  await close(); await launch(); await nav('题库');
  await card().getByRole('button', { name: '继续导入 / 重试', exact: true }).waitFor();
  await delay(700);
  assert.deepEqual(await requests(), []);
  assert.deepEqual(await api('importJob', jobId), paused);
  assert.equal((await api('importHot100')).job.id, jobId);
  assert.deepEqual(await requests(), []);
  list = (await api('library')).lists.find(item => item.id === listId);
  assert.equal(list.items.length, 100);
  const removed = list.items.at(-1);
  await api('detachListItem', listId, removed.key, list.revision);
  await api('importHot100');
  list = (await api('library')).lists.find(item => item.id === listId);
  assert.equal(list.items.length, 99); assert.equal(list.items.some(item => item.key === removed.key), false);
  assert.deepEqual(await requests(), []);
  pass('Restart does not resume network activity; invoking the shortcut does not undo user-owned membership changes');

  await card().getByRole('button', { name: '继续导入 / 重试', exact: true }).click();
  await until(async () => (await api('importJob', jobId)).status === 'completed', 'explicit resume completes 100-item fixture task', 90000);
  const done = await api('importJob', jobId);
  assert.equal(done.counts.imported, 99); assert.equal(done.counts.reused, 1);
  assert.equal(done.counts.failed + done.counts.restricted + done.counts.pending + done.counts.running, 0);
  assert.equal((await api('library')).jobs.filter(job => job.sourceUrl === planUrl).length, 1);
  list = (await api('library')).lists.find(item => item.id === listId);
  assert.equal(list.items.length, 99, 'resuming the old task must not reapply its already-applied membership snapshot');
  assert.equal(list.items.some(item => item.key === removed.key), false);
  assert.deepEqual((await api('workspace', problemId(1), 'python', 'practice', 'function')).problem, localProblem);
  assert.deepEqual(await api('loadDraft', problemId(1), 'python', 'practice', 'function'), localDraft);
  assert.deepEqual(await api('note', localNote.id), localNote);
  const completedRequests = await requests(); await api('importHot100');
  assert.deepEqual(await requests(), completedRequests);
  await card().getByRole('button', { name: '查看 Hot100 题单', exact: true }).click();
  await until(async () => await page.getByRole('combobox', { name: /^题库范围/ }).inputValue() === listId, 'view shortcut selects the persisted list');
  await until(async () => (await card().innerText()).includes('已缓存 100'), 'React progress reflects completed persisted task');
  await page.screenshot({ path: join(directory, 'hot100-completed.png'), fullPage: true });
  assert.deepEqual(await readdir(runtimeDirectory), []);
  assert.equal((await api('runPage', { limit: 1 })).total, 0);
  assert.deepEqual(report.rendererErrors, []);
  assert.deepEqual(await app.evaluate(() => globalThis.hot100Smoke.blocked), []);
  pass('Explicit UI resume completes content caching and viewing while retaining user data, membership edits and zero code runs');
  await close();
  assert.deepEqual(report.blockedNetworkAttempts, []);
  assert.equal(report.fixtureRequests.filter(item => item.url === planUrl).length, 1);
  assert.equal(report.fixtureRequests.some(item => item.url === problemUrl(1)), false);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1;
  if (page && !page.isClosed()) {
    report.uiAtFailure = await page.locator('body').innerText().catch(() => null);
    await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  }
} finally {
  try { await close(); } catch (error) { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, assertions: report.assertions, failure: report.failure, cleanupError: report.cleanupError,
    report: join(directory, 'report.json') }, null, 2));
}
