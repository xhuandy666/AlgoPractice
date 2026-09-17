import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Run `npm run build` and `npm run runtime:install` first. No old test data,
// private evidence, credentials, native file dialogs or mocked backend is used.
// Optional: ALGOPRACTICE_PACKAGED_APP=/absolute/path/to/the/app/executable
// Optional: ALGOPRACTICE_RUNTIME_DIR=/absolute/path/to/managed/runtimes
// Optional: ALGOPRACTICE_SCREENSHOT_DIR=/absolute/path/to/output
const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'package.json'));
const packaged = process.env.ALGOPRACTICE_PACKAGED_APP;
const runtimeDirectory = resolve(process.env.ALGOPRACTICE_RUNTIME_DIR || join(root, '.runtime'));
const screenshots = process.env.ALGOPRACTICE_SCREENSHOT_DIR && resolve(process.env.ALGOPRACTICE_SCREENSHOT_DIR);
const directory = await mkdtemp(join(os.tmpdir(), 'AlgoPractice 桌面体验-'));
const dataDirectory = join(directory, 'data'), launchDirectory = join(directory, 'app');
const captureDirectory = join(directory, 'screenshots');
await mkdir(dataDirectory);
if (screenshots) await mkdir(captureDirectory);
if (!packaged) {
  await mkdir(launchDirectory);
  await cp(join(root, 'dist'), join(launchDirectory, 'dist'), { recursive: true });
  await cp(join(root, 'package.json'), join(launchDirectory, 'package.json'));
}
const env = { ...process.env, ALGOPRACTICE_DATA_DIR: dataDirectory, ALGOPRACTICE_RUNTIME_DIR: runtimeDirectory };
delete env.ELECTRON_RUN_AS_NODE;
const report = {
  startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
  executable: packaged || require('electron'), dataDirectory, runtimeDirectory,
  assertions: [], screenshots: [], rendererErrors: [], httpAttempts: [], exits: [],
  scope: 'Real Electron, SQLite, Python, Java, Markdown and FSRS; only the three bundled authored problems.',
  limitations: ['HTTP guards observe renderer requests and main-process Fetch after attachment; this is not an OS network sandbox.',
    'No API Key, model call or teaching-quality claim. The interview screenshot shows setup, not a completed mock interview.',
    'Only the host platform and selected executable are exercised.'],
};
if (!packaged) report.build = Object.fromEntries(await Promise.all(['main.cjs', 'preload.cjs'].map(async name => [name, createHash('sha256').update(await readFile(join(launchDirectory, 'dist', name))).digest('hex')])));
let app, page;
const api = (method, ...args) => page.evaluate(({ method, args }) => window.algo[method](...args), { method, args });
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const pass = (name, details = true) => { report.assertions.push({ name, details, passed: true }); console.log('PASS', name); };
async function until(check, description, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${description}`);
}
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function load() {
  app = await electron.launch({ executablePath: packaged ? resolve(packaged) : require('electron'), args: packaged ? [] : [launchDirectory], cwd: root, env, timeout: 30000 });
  const observed = new WeakSet();
  const observe = window => {
    if (observed.has(window)) return; observed.add(window);
    window.on('pageerror', error => report.rendererErrors.push({ type: 'pageerror', message: error.message }));
    window.on('console', message => { if (message.type() === 'error') report.rendererErrors.push({ type: 'console', message: message.text() }); });
  };
  app.context().on('page', observe);
  for (const window of app.context().pages()) observe(window);
  await app.context().route(/^https?:\/\//, route => { report.httpAttempts.push({ source: 'renderer', url: route.request().url() }); return route.abort('blockedbyclient'); });
  await app.evaluate(() => {
    globalThis.publicSmokeHttpAttempts = [];
    // Guard unexpected outbound Fetch; no request is replaced with a fake response.
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (/^https?:\/\//.test(url)) { globalThis.publicSmokeHttpAttempts.push(url); return Promise.reject(new Error('Desktop smoke forbids HTTP requests')); }
      return original(input, init);
    };
  });
  page = await app.firstWindow(); observe(page);
  await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  const cdp = await app.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [1440, 1000]);
}
async function close() {
  if (!app) return;
  const closing = app, child = closing.process();
  // app.close() is a full quit: clicking the window close button only hides it.
  await until(async () => !(await api('backups')).busy, 'automatic backup finishes before quit');
  report.httpAttempts.push(...(await closing.evaluate(() => globalThis.publicSmokeHttpAttempts)).map(url => ({ source: 'main-fetch', url })));
  const pids = [...new Set([child.pid, ...await closing.evaluate(({ app }) => app.getAppMetrics().map(metric => metric.pid))])];
  await closing.close();
  await until(async () => (child.exitCode !== null || child.signalCode !== null) && pids.every(pid => !isAlive(pid)), 'Electron and its recorded child processes exit', 15000);
  report.exits.push({ pid: child.pid, observedPids: pids, exitCode: child.exitCode, signal: child.signalCode, remainingPids: pids.filter(isAlive) });
  app = null;
}
async function shot(name) {
  if (!screenshots) return;
  const dismissNotice = page.locator('.preview-banner').getByRole('button', { name: '收起', exact: true });
  if (await dismissNotice.count()) await dismissNotice.click();
  assert.equal(await page.locator('.error-banner').count(), 0, 'No application error banner may be hidden in a public screenshot');
  await page.evaluate(async () => {
    document.activeElement?.blur();
    document.scrollingElement?.scrollTo(0, 0);
    for (const element of document.querySelectorAll('.scroll-page,.history-pane')) element.scrollTo(0, 0);
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  const bounds = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(bounds.width, 1440); assert.equal(bounds.height, 1000); assert.ok(bounds.scrollWidth <= bounds.width);
  await page.screenshot({ path: join(captureDirectory, name), clip: { x: 0, y: 0, width: 1440, height: 1000 }, scale: 'css' });
  report.screenshots.push({ name, ...bounds });
}
async function runProblem(id, title, language, code) {
  await nav('题库');
  await page.getByRole('table', { name: '题库' }).getByRole('button', { name: title, exact: true }).click();
  await page.getByRole('combobox', { name: '编程语言', exact: true }).selectOption(language);
  await page.locator('.coding-pane .monaco-editor').waitFor();
  const editor = page.locator('.coding-pane .monaco-editor');
  await editor.locator('.view-lines').click({ position: { x: 80, y: 15 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await editor.locator('[role=textbox]').evaluate((element, text) => {
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, code);
  await until(async () => (await api('loadDraft', id, language))?.code === code, `${language} editor autosaves`);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await until(async () => (await api('history', id, language)).some(run => run.code === code && run.result.status === 'passed'), `${language} real local run`, 60000);
  await page.locator('.result-summary strong').filter({ hasText: '通过' }).waitFor();
  const run = (await api('history', id, language)).find(run => run.code === code && run.result.status === 'passed');
  assert.equal(run.result.caseResults.length, 3);
  assert.ok(run.result.caseResults.every(result => result.status === 'passed'));
  assert.equal(run.code, code); assert.equal(run.language, language);
  return run;
}

const python = 'class Solution:\n    def arrayTotal(self, nums: list[int]) -> int:\n        total = 0\n        for number in nums:\n            total += number\n        return total\n';
const java = 'class Solution {\n    public String mirrorText(String text) {\n        return new StringBuilder(text).reverse().toString();\n    }\n}\n';
const noteTitle = '数组求和：从边界想到循环';
const markdown = '## 先确认边界\n\n空数组返回 0；负数和正数都参与累加。\n\n## 循环里保存什么\n\n`total` 表示已经遍历的元素之和。每读到一个数，就把它加进去。\n\n- 时间复杂度：O(n)\n- 额外空间：O(1)\n\n## 下次重写\n\n先说清楚变量含义，再独立写出循环；最后检查空数组和负数用例。\n';
let confirmedNote, provider, pythonRun, javaRun;
try {
  await load();
  const environment = await api('environment');
  assert.equal(resolve(environment.dataDirectory), dataDirectory);
  assert.ok(environment.python && environment.java, 'Install both runtimes with npm run runtime:install, or set ALGOPRACTICE_RUNTIME_DIR to a prepared runtime directory.');
  assert.equal(await app.evaluate(({ app }) => app.getName()), 'AlgoPractice', 'Keep the existing macOS credential identity');
  assert.equal(await page.title(), '题炼 · 练习工作台');
  assert.equal(await page.locator('.sidebar .wordmark span').last().innerText(), '题炼');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.deepEqual((await api('libraryIndex')).problems.map(problem => problem.id).sort(), ['array-total', 'mirror-text', 'sum-stdin']);
  await page.getByRole('heading', { name: '今日进度', exact: true }).waitFor();
  pass('Fresh startup shows the three bundled problems and both real runtimes', { python: environment.python, java: environment.java });
  const reminder = await api('reminderState');
  await api('saveReminderSettings', { ...reminder.settings, enabled: false });

  await nav('学习设置');
  await page.getByRole('combobox', { name: '模型提供商', exact: true }).selectOption('qwen-cn');
  await page.getByRole('button', { name: '保存 AI 设置', exact: true }).click();
  await page.getByText('接口设置已保存，添加 Key 后可测试连接。', { exact: true }).waitFor();
  provider = await api('aiProvider');
  assert.equal(provider.config.compatibility, 'qwen'); assert.equal(provider.hasKey, false);
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('button', { name: '测试连接', exact: true }).isDisabled(), true);
  pass('Qwen preset saves through the UI without a Key or connection request');

  pythonRun = await runProblem('array-total', '数组求和', 'python', python);
  await shot('workbench.png');
  await page.getByRole('button', { name: '结束练习', exact: true }).click();
  await until(async () => !(await api('archiveOverview', pythonRun.attemptId)).attempt.isActive, 'Python practice archived');
  assert.equal((await api('archiveOverview', pythonRun.attemptId)).attempt.lastRunMatchesFinal, true);
  pass('Python executes all three local cases and archives the tested final code', { runId: pythonRun.id, status: pythonRun.result.status });

  await nav('学习笔记');
  await page.getByRole('button', { name: '新建题目笔记', exact: true }).click();
  await page.getByRole('textbox', { name: '笔记标题', exact: true }).fill(noteTitle);
  await page.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill(markdown);
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await page.getByText('笔记已保存', { exact: true }).waitFor();
  confirmedNote = (await api('notes', { search: noteTitle }))[0];
  assert.equal(confirmedNote.subjectId, 'array-total');
  assert.equal(confirmedNote.current.state, 'confirmed'); assert.equal(confirmedNote.confirmed.markdown, markdown);
  pass('A user-authored Markdown note is saved and explicitly confirmed through the UI');

  javaRun = await runProblem('mirror-text', '反转字符串', 'java', java);
  await page.getByRole('button', { name: '结束练习', exact: true }).click();
  await until(async () => !(await api('archiveOverview', javaRun.attemptId)).attempt.isActive, 'Java practice archived');
  pass('Java executes all three cases, including empty text and Chinese characters', { runId: javaRun.id, status: javaRun.result.status });

  await api('addReviewItem', { problemId: 'array-total', target: 'understanding', language: 'none' });
  const rewrite = await api('addReviewItem', { problemId: 'array-total', target: 'rewrite', language: 'python' });
  await api('reviewFeedback', { requestId: randomUUID(), itemId: rewrite.id, rating: 3, attemptId: pythonRun.attemptId });
  await api('addReviewItem', { problemId: 'mirror-text', target: 'rewrite', language: 'java' });
  assert.equal((await api('reviewItems')).length, 3);
  assert.equal((await api('reviewEvents', rewrite.id)).length, 1);
  await nav('学习中心');
  await page.getByRole('combobox', { name: '复习列表范围', exact: true }).selectOption('all');
  await until(async () => (await page.locator('li.todo-row').count()) === 3, 'all three real review items render');
  await shot('review.png');
  pass('Real FSRS review items keep understanding and language-specific rewriting separate');

  await nav('模拟面试');
  await page.getByRole('heading', { name: '给自己一场真实的限时练习', exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: '面试模式', exact: true }).inputValue(), 'strict');
  await page.getByLabel('抽样种子', { exact: true }).fill('每天进步一点');
  await shot('interview.png');
  pass('Interview setup opens with strict mode; bundled basic demos are not relabelled for sampling');

  await close();
  await load();
  const restored = await api('note', confirmedNote.id);
  assert.deepEqual(restored, confirmedNote);
  assert.deepEqual((await api('aiProvider')).config, provider.config); assert.equal((await api('aiProvider')).hasKey, false);
  assert.equal((await api('runDetail', pythonRun.id)).result.status, 'passed');
  assert.equal((await api('runDetail', javaRun.id)).result.status, 'passed');
  assert.equal((await api('reviewItems')).length, 3);
  await nav('学习笔记');
  await page.getByRole('complementary', { name: '笔记列表', exact: true }).getByRole('button').filter({ hasText: noteTitle }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Markdown 正文', exact: true }).inputValue(), markdown);
  assert.equal(await page.getByRole('button', { name: '保存笔记', exact: true }).isDisabled(), true);
  await shot('notes.png');
  assert.equal(await page.locator('.error-banner').count(), 0);
  pass('A full quit and restart preserves confirmed note, successful runs, reviews and the no-Key preset');
  await close();
  assert.deepEqual(report.rendererErrors, []); assert.deepEqual(report.httpAttempts, []);
  assert.equal(report.exits.length, 2); assert.ok(report.exits.every(exit => exit.remainingPids.length === 0));
  pass('Both full quits leave no recorded Electron processes; no renderer errors or HTTP attempts');
  // Publish only screenshots from an entirely successful run. The diagnostic
  // report and temporary user data stay outside the optional public asset folder.
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    for (const { name } of report.screenshots) await cp(join(captureDirectory, name), join(screenshots, name));
  }
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = String(error.stack || error); process.exitCode = 1; console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => {});
} finally {
  if (app) {
    try { await close(); } catch (error) { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; app?.process().kill(); }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Desktop smoke report:', join(directory, 'report.json'));
}
