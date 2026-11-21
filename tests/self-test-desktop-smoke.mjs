import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Build first. Real Electron/preload/IPC/SQLite/Python in a new profile. One real
// self-test response is held after execution to test late delivery; its result is never mocked.
const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, 'package.json'));
const runtimeDirectory = resolve(process.env.ALGOPRACTICE_RUNTIME_DIR || join(root, '.runtime'));
const directory = await mkdtemp(join(tmpdir(), '题炼-自测输入回归-'));
const dataDirectory = join(directory, 'data'), launchDirectory = join(directory, 'app');
const reportPath = join(directory, 'report.json');
await mkdir(launchDirectory);
const fixture = { ids: ['self-test-input-a', 'self-test-input-b'], titles: ['自测输入回归 A', '自测输入回归 B'] };
const fixtureScript = `
  import { mkdirSync } from 'node:fs'; import { join } from 'node:path';
  import { PracticeStore } from ${JSON.stringify(pathToFileURL(join(root, 'src/storage/practice-store.ts')).href)};
  const directory = process.argv[1]; mkdirSync(directory, { recursive: true });
  const store = new PracticeStore(join(directory, 'practice.sqlite'));
  try {
    (${JSON.stringify(fixture)}).ids.forEach((id, index) => store.upsertProblem({ id, title: ${JSON.stringify(fixture.titles)}[index], source: 'local', difficulty: '简单', tags: [],
      description: '本地自测回归用数组求和题。', descriptionFormat: 'plain', constraints: [], mode: 'function',
      adapter: { method: 'arrayTotal', params: [{ array: 'int' }], returns: 'int' }, cases: [{ args: [[1, 2, 3]], expected: 6 }],
      starter: { python: 'class Solution:\\n    def arrayTotal(self, nums: list[int]) -> int:\\n        return sum(nums)\\n' } }));
    store.integrityCheck();
  } finally { store.close(); }
`;
execFileSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, '--input-type=module', '--eval', fixtureScript, dataDirectory], { cwd: root, stdio: 'pipe' });
await cp(join(root, 'dist'), join(launchDirectory, 'dist'), { recursive: true });
await cp(join(root, 'package.json'), join(launchDirectory, 'package.json'));
const env = { ...process.env, ALGOPRACTICE_DATA_DIR: dataDirectory, ALGOPRACTICE_RUNTIME_DIR: runtimeDirectory, ALGOPRACTICE_DISABLE_AUTO_UPDATE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const report = { startedAt: new Date().toISOString(), directory, dataDirectory, runtimeDirectory, sourceHash: JSON.parse(await readFile(join(launchDirectory, 'dist/build-info.json'), 'utf8')).sourceHash,
  assertions: [], screenshots: [], errors: [], http: [], exits: [],
  scope: 'Authored local examples, actual Python outputs, one explicitly delayed real IPC response, normal app.quit and relaunch. No live account, model, clipboard or network.' };
let app, page;
const api = (method, ...args) => page.evaluate(({ method, args }) => window.algo[method](...args), { method, args });
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const pass = (name, details = true) => { report.assertions.push({ name, details, passed: true }); console.log('PASS', name); };
async function until(check, message, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await delay(50); } throw new Error(`Timed out: ${message}`); }
async function shot(name) { const path = join(directory, name); await page.screenshot({ path }); report.screenshots.push(path); }
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: [launchDirectory], cwd: root, env }); page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await app.context().route(/^https?:\/\//, route => { report.http.push({ source: 'renderer', url: route.request().url() }); return route.abort('blockedbyclient'); });
  await app.evaluate(() => { globalThis.selfTestRegressionHttp = []; const original = globalThis.fetch; globalThis.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (/^https?:\/\//.test(url)) { globalThis.selfTestRegressionHttp.push(url); return Promise.reject(new Error('Self-test regression forbids outbound HTTP')); } return original(input, init);
  }; });
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  assert.equal(resolve((await api('environment')).dataDirectory), dataDirectory);
  const reminders = await api('reminderState'); await api('saveReminderSettings', { ...reminders.settings, enabled: false });
  const cdp = await app.context().newCDPSession(page); await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
}
async function open(index) {
  await nav('题库'); const row = page.locator('.problem-table-row').filter({ has: page.getByRole('button', { name: fixture.titles[index], exact: true }) });
  await row.getByRole('button', { name: '练习', exact: true }).click(); await page.locator('.coding-pane .monaco-editor').waitFor();
  const toggle = page.getByRole('button', { name: '自测输入', exact: true }); if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('textbox', { name: '自测输入内容', exact: true }).waitFor();
  await page.getByRole('separator', { name: '调整测试结果高度', exact: true }).press('End');
}
const input = () => page.getByRole('textbox', { name: '自测输入内容', exact: true });
const result = () => page.locator('.self-test-result');
async function expectResult(submitted, output, stale) {
  await result().waitFor(); await until(async () => await result().locator('dd').first().textContent() === submitted, 'result belongs to submitted input');
  assert.equal(await result().locator('dd').nth(1).textContent(), String(output));
  assert.equal(await result().getByText('针对先前的输入', { exact: true }).count(), Number(stale));
  assert.equal(await result().getAttribute('data-status'), 'completed');
}
async function quit({ immediate = false } = {}) {
  if (!app) return; const current = app, child = current.process();
  if (!immediate) await until(async () => !(await api('backups')).busy, 'backup settles before quit');
  report.http.push(...(await current.evaluate(() => globalThis.selfTestRegressionHttp)).map(url => ({ source: 'main-fetch', url })));
  const closed = current.waitForEvent('close', { timeout: 15000 });
  const requestedAt = await current.evaluate(({ app }) => { const at = Date.now(); app.quit(); return at; }).catch(() => null);
  await closed; await until(() => child.exitCode !== null || child.signalCode !== null, 'owned Electron exits');
  report.exits.push({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, requestedAt }); app = null;
  assert.equal(child.exitCode, 0); return requestedAt;
}
try {
  await launch(); await open(0); await input().fill('[1,2,3]'); await page.getByRole('button', { name: '运行这组输入', exact: true }).click(); await expectResult('[1,2,3]', 6, false);
  await input().fill('[100]'); await expectResult('[1,2,3]', 6, true);
  await input().fill('[1,2,3]'); await expectResult('[1,2,3]', 6, false); pass('Changing A to B marks the A result stale; changing B back to A restores a match');
  await app.evaluate(({ ipcMain }) => {
    const real = ipcMain._invokeHandlers.get('runner:self-test'); if (typeof real !== 'function') throw new Error('Real self-test IPC handler missing');
    ipcMain.removeHandler('runner:self-test'); globalThis.delayedSelfTest = { hold: true, ready: false };
    ipcMain.handle('runner:self-test', async (...args) => {
      const result = await real(...args);
      if (globalThis.delayedSelfTest.hold) { globalThis.delayedSelfTest.hold = false; globalThis.delayedSelfTest.ready = true; await new Promise(resolve => { globalThis.delayedSelfTest.release = resolve; }); }
      return result;
    });
  });
  await page.getByRole('button', { name: '运行这组输入', exact: true }).click();
  await until(() => app.evaluate(() => globalThis.delayedSelfTest.ready), 'actual Python result is waiting for delivery');
  await input().fill('[100]'); assert.equal(await input().isEnabled(), true);
  await app.evaluate(() => globalThis.delayedSelfTest.release()); await page.getByRole('button', { name: '运行这组输入', exact: true }).waitFor();
  await until(async () => !(await page.getByRole('button', { name: '运行这组输入', exact: true }).isDisabled()), 'late response settles');
  await expectResult('[1,2,3]', 6, true); await shot('late-result-keeps-request-input.png'); pass('Editing while a real result is delayed preserves its original input and marks it stale');
  await page.getByRole('button', { name: '运行这组输入', exact: true }).click(); await expectResult('[100]', 100, false);
  assert.deepEqual(await api('history', fixture.ids[0], 'python'), []); pass('A new self-test result binds B input/output and still leaves run history empty');
  await open(1); assert.equal(await result().count(), 0); await input().fill('[7]');
  await open(0); assert.equal(await input().inputValue(), '[100]'); assert.equal(await result().count(), 0); pass('Changing problem identity clears the result and keeps the two input drafts separate');
  const panelToggle = page.getByRole('button', { name: '自测输入', exact: true });
  await input().fill('[808]'); await panelToggle.click(); await input().waitFor({ state: 'detached' });
  await panelToggle.click(); await input().waitFor(); assert.equal(await input().inputValue(), '[808]');
  pass('Collapsing and reopening the panel preserves the edited input');
  await until(async () => !(await api('backups')).busy, 'backup idle before the timed exit');
  await page.evaluate(() => { document.addEventListener('input', event => { if (event.target instanceof HTMLTextAreaElement && event.target.getAttribute('aria-label') === '自测输入内容') globalThis.lastSelfTestInputAt = Date.now(); }); });
  await input().fill('[42424242]'); const typedAt = await page.evaluate(() => globalThis.lastSelfTestInputAt);
  const quitAt = await quit({ immediate: true }); assert.ok(quitAt !== null && quitAt - typedAt < 400, `quit must precede debounce (${quitAt - typedAt}ms)`);
  await launch(); await open(0); assert.equal(await input().inputValue(), '[42424242]'); pass('Normal app.quit before 400ms preserves the latest input on relaunch', { requestedAfterInputMs: quitAt - typedAt });
  await shot('input-restored-after-immediate-quit.png'); await quit(); assert.deepEqual(report.errors, []); assert.deepEqual(report.http, []); report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = error.stack; console.error(error); process.exitCode = 1; if (page && !page.isClosed()) await shot('failure.png').catch(() => {}); }
finally { if (app) { await app.evaluate(() => globalThis.delayedSelfTest?.release?.()).catch(() => {}); await quit().catch(error => { report.cleanupError = error.stack; process.exitCode = 1; }); } await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log('REPORT', reportPath); }
