import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { PracticeStore } from '../src/storage/practice-store.ts';
import { resolvePracticeSpec } from '../src/shared/answer-format.ts';

// Real renderer components and a temporary store. Only latency/faults are injected: no Electron, account or network.
const root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'algopractice-loading-'));
const store = new PracticeStore(join(directory, 'practice.sqlite'));
const content = (id, title) => ({ id, title, difficulty: '中等', tags: [], source: 'local', description: '返回给定数字。',
  descriptionFormat: 'plain', constraints: [], mode: 'function', adapter: { method: 'solve', params: ['int'], returns: 'int' },
  cases: [{ args: [1], expected: 1 }], starter: { python: 'class Solution:\n    def solve(self, n): return n', java: 'class Solution {}', go: 'func solve(n int) int { return n }', cpp: 'class Solution {};' } });
for (const [id, title] of [['a1', 'A 的第一题'], ['a2', 'A 的第二题'], ['b1', 'B 的第一题'], ['remembered', '上次练习'], ['array-total', '内置样例']]) store.upsertProblem(content(id, title));
for (const [id, title, ids] of [['list-a', '题单 A', ['a1', 'a2']], ['list-b', '题单 B', ['b1']]]) {
  store.applyListRefresh(store.previewListRefresh({ id, title, source: 'local', membershipComplete: true, chapters: [],
    items: ids.map((problemId, position) => ({ key: `${id}-${problemId}`, problemId, position })) }).id);
}
store.saveDraft({ problemId: 'remembered', language: 'java', code: 'class SavedDraft {}', answerFormat: 'function', specVersion: 'native-v1' });
const library = { problems: [], totalProblems: 5, lists: store.listLists(), jobs: [] };
let holdRows = false;
const pendingRows = [];
let holdWorkspace = false;
const pendingWorkspaces = [];
const faults = { workspace: false, identity: false, formattedWorkspace: false };
const backendCalls = [];
const releaseRows = () => { for (const resolve of pendingRows.splice(0)) resolve(); };
const releaseWorkspaces = () => { for (const resolve of pendingWorkspaces.splice(0)) resolve(); };
const compiled = await build({ stdin: { resolveDir: root, loader: 'tsx', sourcefile: 'practice-loading-fixture.tsx', contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import './tokens.css';
  import './src/renderer/styles.css';
  import './src/renderer/shell.css';
  import { LibraryPage } from './src/renderer/LibraryPage';
  import { usePractice } from './src/renderer/usePractice';
  import { WorkbenchLoading } from './src/renderer/WorkbenchLoading';
  import { readPracticeMemory, savePracticeMemory, withOpenedProblem } from './src/renderer/practice-memory';
  const calls = [], app = createRoot(document.getElementById('root')); let generation = 0;
  const api = {
    problemPage: async filter => { calls.push(['page', filter]); return window.readPage(filter); },
    workspace: async (...args) => { calls.push(['workspace', ...args]); return window.readWorkspace(...args); },
    sourceSession: async () => ({ hasSession: false }), onClosing: () => () => {}, startPractice: async () => {},
    detachListItem: async (...args) => { calls.push(['detach', ...args]); },
  };
  function Practice() {
    const practice = usePractice(api, message => calls.push(['error', message]));
    window.practiceSnapshot = () => ({ target: practice.target, ready: practice.ready, loadError: practice.loadError, code: practice.code, memory: readPracticeMemory() });
    window.practiceOpen = target => practice.open(target);
    return practice.ready ? <h2>已读取：{practice.workspace.problem.content.title}</h2>
      : <WorkbenchLoading error={practice.loadError} disabled={practice.switching} onRetry={practice.retryLoading} onLibrary={() => calls.push(['library'])} />;
  }
  window.fixture = { calls,
    library(data) { const next = ++generation; app.render(<div data-library-generation={next}><LibraryPage key={next} api={api} data={data}
      onOpen={(id, source, list) => { calls.push(['open', id, source, list]); savePracticeMemory(withOpenedProblem(readPracticeMemory(), id, list)); }}
      onImport={() => {}} onChanged={async () => {}} onError={message => calls.push(['error', message])} /></div>); return next; },
    practice(id) { savePracticeMemory({ language: 'java', problemId: id, listId: 'list-a', listTitle: '题单 A' }); const next = ++generation; app.render(<div data-practice-generation={next}><Practice key={next} /></div>); return next; },
  };
` }, bundle: true, platform: 'browser', format: 'iife', write: false, outfile: 'practice-loading-fixture.js', logLevel: 'silent' });
let browser;
const pass = message => console.log('PASS', message);
try {
  browser = await chromium.launch({ headless: true, ...(process.env.ALGOPRACTICE_TEST_BROWSER ? { channel: process.env.ALGOPRACTICE_TEST_BROWSER } : {}) });
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.exposeFunction('readPage', async filter => {
    backendCalls.push(['page', filter]);
    if (filter.ids && faults.identity) throw new Error('注入：题目身份查询暂时失败');
    const result = store.listProblemPage(filter);
    if (filter.limit === 30 && holdRows) await new Promise(resolve => pendingRows.push(resolve));
    return result;
  });
  await page.exposeFunction('readWorkspace', async (id, language, scope, format) => {
    backendCalls.push(['workspace', id, language, scope, format]);
    if (id === 'remembered' && (faults.workspace || faults.formattedWorkspace && format)) throw new Error('注入：工作台暂时不可用');
    const problem = store.getProblem(id);
    if (!problem) throw new Error('题目尚未导入。');
    const draft = store.getDraft(id, language, scope, format ?? problem.content.mode) ?? null;
    const result = { problem, latestVersion: problem.version, draft, attempt: null, history: [], spec: resolvePracticeSpec(problem.content, problem.version, format ?? problem.content.mode) };
    if (holdWorkspace) await new Promise(resolve => pendingWorkspaces.push(resolve));
    return result;
  });
  await page.route(/^https?:\/\//, route => route.abort());
  await page.route('http://practice-loading.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><body><main id="root"></main></body></html>' }));
  await page.goto('http://practice-loading.test/');
  await page.addStyleTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: compiled.outputFiles.find(file => file.path.endsWith('.js')).text });
  const calls = () => page.evaluate(() => window.fixture.calls);
  const pill = name => page.locator('label.filter-pill').filter({ has: page.locator('span.sr-only', { hasText: new RegExp('^' + name + '$') }) }).locator('select');
  const lastOpen = async () => (await calls()).filter(call => call[0] === 'open').at(-1);
  const waitOpen = async before => page.waitForFunction(before => window.fixture.calls.filter(call => call[0] === 'open').length > before, before);
  const waitRows = () => page.locator('[aria-label="题库"][aria-busy="false"]').waitFor();
  const mountA = async () => {
    holdRows = false; releaseRows();
    const generation = await page.evaluate(data => window.fixture.library(data), library);
    await page.locator(`[data-library-generation="${generation}"]`).waitFor();
    await waitRows();
    await pill('题库范围').selectOption('list-a');
    await page.waitForFunction(() => document.querySelectorAll('.problem-table-row').length === 2 && document.querySelector('[aria-label="题库"]').getAttribute('aria-busy') === 'false');
  };
  const openA = async () => {
    const before = (await calls()).filter(call => call[0] === 'open').length;
    await page.getByRole('button', { name: 'A 的第一题', exact: true }).click();
    await waitOpen(before);
    return lastOpen();
  };

  await mountA();
  holdRows = true;
  await pill('题库范围').selectOption('list-b');
  await page.locator('[aria-label="题库"][aria-busy="true"]').waitFor();
  const oldRow = await openA();
  assert.deepEqual([oldRow[1], oldRow[2].filter.listId, oldRow[3]], ['a1', 'list-a', { id: 'list-a', title: '题单 A' }]);
  await page.getByRole('row').filter({ has: page.getByRole('button', { name: 'A 的第一题', exact: true }) }).getByRole('button', { name: '移出题单', exact: true }).click();
  assert.deepEqual((await calls()).filter(call => call[0] === 'detach').at(-1).slice(1), ['list-a', 'list-a-a1', library.lists.find(list => list.id === 'list-a').revision]);
  holdRows = false; releaseRows();
  await page.getByRole('button', { name: 'B 的第一题', exact: true }).waitFor();
  await page.getByRole('button', { name: 'B 的第一题', exact: true }).click();
  assert.equal((await lastOpen())[3].id, 'list-b');
  pass('挂起 A→B 查询时，旧行的练习来源和移出题单仍属于 A；B 响应后切换为 B');

  await mountA();
  holdRows = true;
  await pill('练习进度').selectOption('unpracticed');
  await page.locator('[aria-label="题库"][aria-busy="true"]').waitFor();
  holdRows = false; releaseRows(); await waitRows();
  holdRows = true;
  await pill('练习进度').selectOption('');
  await page.locator('[aria-label="题库"][aria-busy="true"]').waitFor();
  const frozen = await openA();
  assert.equal(frozen[2].kind, 'frozen');
  assert.deepEqual(frozen[2].problemIds, ['a1', 'a2']);
  assert.ok((await calls()).some(call => call[0] === 'page' && call[1].limit === 100 && call[1].practice === 'unpracticed' && call[1].listId === 'list-a'));
  holdRows = false; releaseRows(); await waitRows();
  holdRows = true;
  await pill('练习进度').selectOption('unpracticed');
  await page.locator('[aria-label="题库"][aria-busy="true"]').waitFor();
  const ordinary = await openA();
  assert.equal(ordinary[2].kind, 'library');
  assert.equal(ordinary[2].filter.practice, undefined);
  holdRows = false; releaseRows(); await waitRows();
  pass('两方向切换练习进度时，点击旧结果均沿其自身筛选决定是否冻结题序');

  const snapshot = () => page.evaluate(() => window.practiceSnapshot());
  const mountPractice = async id => {
    const generation = await page.evaluate(id => window.fixture.practice(id), id);
    await page.locator(`[data-practice-generation="${generation}"]`).waitFor();
  };
  const remembered = { language: 'java', problemId: 'remembered', listId: 'list-a', listTitle: '题单 A' };
  faults.workspace = true;
  await mountPractice('remembered');
  await page.getByRole('button', { name: '重新读取工作台', exact: true }).waitFor();
  assert.deepEqual((await snapshot()).memory, remembered);
  assert.equal((await snapshot()).target.id, 'remembered');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('algopractice.practice-memory.v1'))), remembered);
  faults.workspace = false;
  await page.getByRole('button', { name: '重新读取工作台', exact: true }).click();
  await page.getByRole('heading', { name: '已读取：上次练习', exact: true }).waitFor();
  assert.equal((await snapshot()).code, 'class SavedDraft {}');
  assert.deepEqual((await snapshot()).memory, remembered);
  pass('workspace 实际注入异常后保留持久记忆，点击应用重试按钮恢复原题和 Java 草稿');

  holdWorkspace = true;
  const workspaceReads = (await calls()).filter(call => call[0] === 'workspace').length;
  await page.evaluate(() => { window.openFinished = false; void window.practiceOpen(window.practiceSnapshot().target).then(() => { window.openFinished = true; }); });
  await page.waitForFunction(before => window.fixture.calls.filter(call => call[0] === 'workspace').length > before, workspaceReads);
  assert.equal((await snapshot()).ready, true);
  assert.equal(pendingWorkspaces.length, 1);
  assert.equal(await page.evaluate(() => window.openFinished), false);
  holdWorkspace = false; releaseWorkspaces();
  await page.waitForFunction(() => window.openFinished);
  assert.equal((await snapshot()).code, 'class SavedDraft {}');
  pass('同 key 已就绪时保持可用状态，open 返回仍等待 workspace 读取结束');

  faults.workspace = true; faults.identity = true;
  await mountPractice('remembered');
  await page.getByRole('button', { name: '重新读取工作台', exact: true }).waitFor();
  assert.deepEqual((await snapshot()).memory, remembered);
  faults.workspace = false; faults.identity = false;
  await page.getByRole('button', { name: '重新读取工作台', exact: true }).click();
  await page.getByRole('heading', { name: '已读取：上次练习', exact: true }).waitFor();
  pass('workspace 与身份查询同时失败时保留记忆，错误解除后仍可重试');

  faults.workspace = true;
  await mountPractice('remembered');
  await page.getByRole('button', { name: '重新读取工作台', exact: true }).waitFor();
  faults.workspace = false;
  await page.evaluate(() => window.practiceOpen({ id: 'remembered', language: 'java', scope: 'practice' }));
  await page.getByRole('heading', { name: '已读取：上次练习', exact: true }).waitFor();
  assert.equal((await snapshot()).code, 'class SavedDraft {}');
  assert.equal((await snapshot()).ready, true);
  assert.deepEqual((await snapshot()).memory, remembered);
  pass('首次读取失败后直接重新打开相同 target，同样恢复草稿和可运行状态');

  faults.formattedWorkspace = true;
  await mountPractice('remembered');
  await page.getByRole('button', { name: '重新读取工作台', exact: true }).waitFor();
  assert.equal((await snapshot()).target.answerFormat, 'function');
  assert.deepEqual((await snapshot()).memory, remembered);
  faults.formattedWorkspace = false;
  await page.getByRole('button', { name: '重新读取工作台', exact: true }).click();
  await page.getByRole('heading', { name: '已读取：上次练习', exact: true }).waitFor();
  pass('答题格式确定后的第二次读取失败也不会丢失上次题目');

  const missingCalls = backendCalls.length;
  assert.equal(store.getProblem('actually-missing'), undefined);
  await mountPractice('actually-missing');
  await page.getByRole('heading', { name: '已读取：内置样例', exact: true }).waitFor();
  assert.deepEqual((await snapshot()).memory, { language: 'java', listId: 'list-a', listTitle: '题单 A' });
  assert.equal((await snapshot()).target.language, 'java');
  assert.ok(backendCalls.slice(missingCalls).some(call => call[0] === 'page' && call[1].ids?.[0] === 'actually-missing'));
  pass('临时数据库确认题目真实缺失后回退样例，保留语言与题单记忆');
  assert.deepEqual(browserErrors, []);
} finally {
  releaseRows();
  releaseWorkspaces();
  await browser?.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
