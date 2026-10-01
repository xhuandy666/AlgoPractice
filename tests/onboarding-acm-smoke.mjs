import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// npm run build && node tests/onboarding-acm-smoke.mjs
// Real Electron / IPC / SQLite, isolated data, deliberately absent runtime root.
// HTTP Fetch is rejected, never replaced with a successful installer or fake runtime.
const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, 'package.json'));
const directory = await mkdtemp(join(tmpdir(), 'tilian-onboarding-acm-'));
const launchDirectory = join(directory, 'app'), dataDirectory = join(directory, 'data'), runtimeDirectory = join(directory, 'missing-runtimes');
await mkdir(launchDirectory); await mkdir(dataDirectory); await mkdir(runtimeDirectory);
await cp(join(root, 'dist'), join(launchDirectory, 'dist'), { recursive: true });
await cp(join(root, 'package.json'), join(launchDirectory, 'package.json'));
const env = { ...process.env, ALGOPRACTICE_DATA_DIR: dataDirectory, ALGOPRACTICE_RUNTIME_DIR: runtimeDirectory };
delete env.ELECTRON_RUN_AS_NODE;
const report = {
  directory, dataDirectory, runtimeDirectory, platform: process.platform, arch: process.arch,
  build: JSON.parse(await readFile(join(launchDirectory, 'dist/build-info.json'), 'utf8')).sourceHash,
  assertions: [], rendererErrors: [], networkAttempts: [],
  limitations: ['Missing-runtime workflow only; no Python/JDK download or executable was provided.',
    'Network guards cover renderer HTTP and main-process Fetch after Playwright attachment; this is not an OS network sandbox.',
    'Real successful runtime installation, code execution, signing and other OS architectures are separate validations.'],
};
let app, page;
const api = (method, ...args) => page.evaluate(({ method, args }) => window.algo[method](...args), { method, args });
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const pass = (name, details = true) => { report.assertions.push({ name, details }); console.log('PASS', name); };
async function until(predicate, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  throw new Error(`Timed out: ${description}`);
}
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: [launchDirectory], cwd: root, env });
  await app.context().route(/^https?:\/\//, route => { report.networkAttempts.push({ source: 'renderer', url: route.request().url() }); return route.abort('blockedbyclient'); });
  await app.evaluate(() => {
    globalThis.onboardingHttpAttempts = [];
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (/^https?:\/\//.test(url)) {
        globalThis.onboardingHttpAttempts.push(url);
        return Promise.reject(new Error('ONBOARDING_SMOKE_NETWORK_BLOCKED: deliberate offline failure; no download permitted'));
      }
      return original(input, init);
    };
  });
  page = await app.firstWindow(); page.on('pageerror', error => report.rendererErrors.push(error.message));
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const cdp = await app.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
}
async function close() {
  if (!app) return;
  await until(async () => !(await api('backups')).busy, 'backup completes before close');
  report.networkAttempts.push(...(await app.evaluate(() => globalThis.onboardingHttpAttempts)).map(url => ({ source: 'main-fetch', url })));
  const closing = app; app = null;
  let timeout;
  try { await Promise.race([closing.close(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Electron did not quit in 15 seconds')), 15000); })]); }
  catch (error) { closing.process().kill('SIGKILL'); throw error; }
  finally { clearTimeout(timeout); }
}
async function openProblem(title) {
  await nav('题库'); await page.getByRole('table', { name: '题库' }).getByRole('button', { name: title, exact: true }).click();
  await page.locator('.statement').getByRole('heading', { name: title, exact: true }).waitFor();
  await until(async () => await page.getByRole('combobox', { name: '答题格式', exact: true }).isEnabled(), 'workspace controls are ready');
  await page.locator('.coding-pane .monaco-editor').waitFor();
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}
async function choose(label, value) {
  const selector = page.getByRole('combobox', { name: label, exact: true });
  if (await selector.inputValue() === value) return;
  const before = await page.locator('.coding-pane .monaco-editor').getAttribute('data-uri');
  await selector.selectOption(value);
  await until(async () => {
    const editor = page.locator('.coding-pane .monaco-editor');
    return await editor.count() === 1 && (await editor.getAttribute('data-uri')) !== before && await selector.isEnabled();
  }, `${label} changes its draft model`);
}
async function pasteCode(code) {
  const editor = page.locator('.coding-pane .monaco-editor');
  await editor.locator('.view-lines').click({ position: { x: 70, y: 14 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await editor.locator('[role=textbox]').evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, code);
}
const draft = (language, format) => api('loadDraft', 'array-total', language, 'practice', format);
async function saveCode(language, format, code) {
  await choose('编程语言', language); await choose('答题格式', format); await pasteCode(code);
  await until(async () => (await draft(language, format))?.code === code, `${language}/${format} code is saved`);
}
const codes = {
  'python:function': 'class Solution:\n    def arrayTotal(self, nums: list[int]) -> int:\n        # PYTHON_FUNCTION_DRAFT\n        return sum(nums)\n',
  'java:function': 'class Solution {\n    public int arrayTotal(int[] nums) {\n        // JAVA_FUNCTION_DRAFT\n        int total = 0;\n        for (int n : nums) total += n;\n        return total;\n    }\n}\n',
  'python:acm': 'import sys\n# PYTHON_ACM_DRAFT\nprint(sum(map(int, sys.stdin.read().split())))\n',
  'java:acm': 'import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        // JAVA_ACM_DRAFT\n        Scanner input = new Scanner(System.in);\n        int sum = 0;\n        while (input.hasNextInt()) sum += input.nextInt();\n        System.out.println(sum);\n    }\n}\n',
};
let expectedJavaConfig, expectedPythonConfig;
try {
  await launch();
  const environment = await api('environment');
  assert.equal(resolve(environment.dataDirectory), dataDirectory);
  assert.equal(environment.runtimeStates.python.status, 'missing'); assert.equal(environment.runtimeStates.java.status, 'missing');
  assert.equal(environment.autoInstallRuntimes, false);
  assert.deepEqual(environment.installations, {});
  assert.deepEqual(await app.evaluate(() => globalThis.onboardingHttpAttempts), []);
  pass('Fresh install detects two missing environments without a download or automatic opt-in');
  const reminders = await api('reminderState'); await api('saveReminderSettings', { ...reminders.settings, enabled: false });
  await openProblem('数组求和');
  await saveCode('python', 'function', codes['python:function']);
  await saveCode('java', 'function', codes['java:function']);
  await saveCode('java', 'acm', codes['java:acm']);
  await page.getByLabel('标准输入 stdin', { exact: false }).fill('2\n3\n');
  await page.getByLabel('比较期望输出', { exact: false }).check();
  await page.getByLabel('期望输出 stdout', { exact: false }).fill('5\n');
  await page.getByLabel('输出比较规则', { exact: true }).selectOption('exact');
  expectedJavaConfig = { version: 1, compare: 'exact', cases: [{ stdin: '2\n3\n', expected: '5\n' }] };
  await until(async () => isDeepStrictEqual((await draft('java', 'acm'))?.testConfig, expectedJavaConfig), 'Java ACM input and comparator save');
  await saveCode('python', 'acm', codes['python:acm']);
  assert.equal(await page.getByLabel('标准输入 stdin', { exact: false }).inputValue(), '');
  assert.equal(await page.getByLabel('比较期望输出', { exact: false }).isChecked(), false);
  await page.getByLabel('比较期望输出', { exact: false }).check();
  await page.getByRole('button', { name: '新增用例', exact: true }).click();
  await page.getByLabel('标准输入 stdin', { exact: false }).fill('7 8\n');
  expectedPythonConfig = { version: 1, compare: 'normalized', cases: [{ stdin: '', expected: '' }, { stdin: '7 8\n' }] };
  await until(async () => isDeepStrictEqual((await draft('python', 'acm'))?.testConfig, expectedPythonConfig), 'Python ACM empty expected and missing expected save independently');
  for (const [key, code] of Object.entries(codes)) {
    const [language, format] = key.split(':'); await choose('编程语言', language); await choose('答题格式', format);
    assert.equal((await draft(language, format)).code, code);
    await page.locator('.coding-pane .view-lines').getByText(code.match(/(?:PYTHON|JAVA)_(?:FUNCTION|ACM)_DRAFT/)[0], { exact: false }).waitFor();
  }
  assert.deepEqual((await draft('java', 'acm')).testConfig, expectedJavaConfig);
  assert.deepEqual((await draft('python', 'acm')).testConfig, expectedPythonConfig);
  assert.equal((await api('runPage', { limit: 10 })).total, 0);
  assert.deepEqual(await app.evaluate(() => globalThis.onboardingHttpAttempts), []);
  pass('Four Python/Java × function/ACM drafts and independent stdin/expected/comparison configurations survive switching');
  await choose('编程语言', 'python'); await choose('答题格式', 'acm');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await page.locator('.runtime-preparation').getByRole('button', { name: '安装并运行', exact: true }).waitFor();
  assert.equal((await api('runPage', { limit: 10 })).total, 0);
  const pendingWorkspace = await api('workspace', 'array-total', 'python', 'practice', 'acm');
  assert.deepEqual(await api('aiRequests', pendingWorkspace.attempt.id), []);
  await page.getByRole('button', { name: '用例 1', exact: true }).click();
  await page.getByLabel('标准输入 stdin', { exact: false }).fill('9\n');
  expectedPythonConfig.cases[0].stdin = '9\n';
  await page.locator('.runtime-preparation').getByRole('button', { name: '安装环境', exact: true }).waitFor();
  assert.equal(await page.locator('.runtime-preparation').getByRole('button', { name: '安装并运行', exact: true }).count(), 0);
  await page.locator('.runtime-preparation').getByRole('button', { name: '暂不安装', exact: true }).click();
  await until(async () => (await draft('python', 'acm')).testConfig.cases[0].stdin === '9\n', 'pending-input edit persists');
  pass('Missing environment is a preparation prompt, not a failed run or AI failure; editing input invalidates continuation');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await page.locator('.runtime-preparation').getByRole('button', { name: '安装并运行', exact: true }).waitFor();
  const editedCode = `${codes['python:acm']}# EDITED_DURING_PREPARATION\n`;
  await pasteCode(editedCode); codes['python:acm'] = editedCode;
  await page.locator('.runtime-preparation').getByRole('button', { name: '安装环境', exact: true }).waitFor();
  await choose('编程语言', 'java');
  assert.equal(await page.locator('.runtime-preparation').getByRole('button', { name: '安装并运行', exact: true }).count(), 0);
  await page.locator('.runtime-preparation').getByRole('button', { name: '暂不安装', exact: true }).click();
  pass('Editing code or changing language does not retain an executable old request');
  await openProblem('输入输出练习');
  assert.equal(await page.getByRole('combobox', { name: '答题格式', exact: true }).inputValue(), 'acm');
  assert.equal(await page.getByRole('combobox', { name: '答题格式', exact: true }).locator('option[value=function]').evaluate(option => option.disabled), true);
  assert.equal(await page.getByRole('button', { name: /^用例 [123]$/ }).count(), 3);
  assert.equal(await page.getByLabel('标准输入 stdin', { exact: false }).inputValue(), '2 4 6\n');
  pass('Native ACM problem keeps its samples and does not offer an invented function contract');
  await openProblem('数组求和'); await choose('答题格式', 'function');
  assert.equal(await page.locator('.statement').getByRole('heading', {name:'数组求和',exact:true}).count(), 1);
  assert.equal(await page.locator('.acm-input-panel').count(), 0);
  assert.equal((await draft('java', 'function')).code, codes['java:function']);
  assert.deepEqual(report.rendererErrors, []);
  pass('Switching from native ACM back to a function workspace does not mix incompatible snapshots or crash');
  await choose('编程语言', 'python'); await choose('答题格式', 'acm');
  const inputBeforeTooLarge = await page.getByLabel('标准输入 stdin', {exact:false}).inputValue();
  await page.getByLabel('标准输入 stdin', {exact:false}).fill('x'.repeat(1024 * 1024 + 1));
  await page.locator('.error-banner').getByText(/1 MiB/).waitFor();
  assert.equal(await page.getByLabel('标准输入 stdin', {exact:false}).inputValue(), inputBeforeTooLarge);
  assert.deepEqual((await draft('python', 'acm')).testConfig, expectedPythonConfig);
  assert.deepEqual(report.rendererErrors, []);
  await page.locator('.error-banner').getByRole('button', {name:'收起',exact:true}).click();
  pass('Oversized ACM input is rejected visibly while preserving the last valid test configuration and workspace');
  const observedBeforeInstall = await app.evaluate(() => globalThis.onboardingHttpAttempts.length);
  assert.equal(observedBeforeInstall, 0);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await page.locator('.runtime-preparation').getByRole('button', { name: '安装并运行', exact: true }).click();
  await page.locator('.runtime-preparation').getByRole('alert').waitFor();
  assert.match(await page.locator('.runtime-preparation').getByRole('alert').innerText(), /ONBOARDING_SMOKE_NETWORK_BLOCKED/);
  assert.equal(await app.evaluate(() => globalThis.onboardingHttpAttempts.length), 1);
  assert.equal((await api('runPage', { limit: 10 })).total, 0);
  assert.equal((await draft('python', 'acm')).code, codes['python:acm']);
  assert.deepEqual((await draft('python', 'acm')).testConfig, expectedPythonConfig);
  await page.screenshot({ path: join(directory, 'missing-runtime-after-offline-failure.png'), fullPage: true });
  await page.locator('.runtime-preparation').getByRole('button', { name: '暂不安装', exact: true }).click();
  assert.deepEqual((await api('environment')).installations, {});
  pass('Only explicit install attempts network; deliberate offline failure stays recoverable and never creates a code-run record');
  const beforeMalformed = (await api('runPage', { limit: 10 })).total;
  await assert.rejects(api('saveDraft', 'array-total', 'python', codes['python:acm'], 'practice', { answerFormat: 'acm', testConfig: { version: 1, compare: 'exact', cases: [] } }), /1–50|1.50|ACM/);
  const workspace = await api('workspace', 'array-total', 'python', 'practice', 'acm');
  await assert.rejects(api('prepareRun', 'array-total', 'python', codes['python:acm'], 'practice', `${workspace.problem.version}-stale`, 'acm'), /版本/);
  await assert.rejects(api('run', 'array-total', 'python', codes['python:acm'], 'practice', randomUUID(), workspace.problem.version, { answerFormat: 'acm' }), /环境/);
  assert.equal((await api('runPage', { limit: 10 })).total, beforeMalformed);
  pass('Malformed ACM configuration, stale version and missing-runtime direct IPC fail without creating misleading history');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await page.locator('.runtime-preparation').getByRole('button', { name: '安装并运行', exact: true }).waitFor();
  await page.locator('.runtime-preparation').getByText('更多安装选项', { exact: true }).click();
  const workbenchOptIn = page.locator('.runtime-preparation').getByLabel('运行时自动安装缺失的语言环境', { exact: false });
  await workbenchOptIn.click();
  await until(async () => (await api('environment')).autoInstallRuntimes === true, 'explicit auto-install preference saves');
  await until(async () => await workbenchOptIn.isChecked(), 'workbench opt-in reflects persisted preference');
  assert.equal(await app.evaluate(() => globalThis.onboardingHttpAttempts.length), 1, 'Opting in alone must not initiate a download');
  await close(); await launch();
  assert.equal((await api('runPage', { limit: 10 })).total, 0);
  assert.deepEqual(await app.evaluate(() => globalThis.onboardingHttpAttempts), []);
  assert.equal((await api('environment')).autoInstallRuntimes, true);
  await nav('运行环境');
  const autoInstall = page.getByLabel('运行时自动安装缺失的语言环境', { exact: false });
  await until(async () => await autoInstall.isChecked(), 'persisted auto-install opt-in appears');
  await autoInstall.click();
  await until(async () => (await api('environment')).autoInstallRuntimes === false, 'user can revoke auto-install preference');
  await until(async () => !(await autoInstall.isChecked()), 'settings reflect the revoked preference');
  assert.deepEqual(await app.evaluate(() => globalThis.onboardingHttpAttempts), []);
  pass('Explicit auto-install opt-in persists, triggers no download on restart, and can be disabled in settings');
  await openProblem('数组求和');
  assert.equal(await page.getByRole('combobox', { name: '答题格式', exact: true }).inputValue(), 'acm');
  assert.equal(await page.locator('.runtime-preparation').count(), 0);
  for (const [key, code] of Object.entries(codes)) { const [language, format] = key.split(':'); assert.equal((await draft(language, format)).code, code); }
  assert.deepEqual((await draft('java', 'acm')).testConfig, expectedJavaConfig);
  assert.deepEqual((await draft('python', 'acm')).testConfig, expectedPythonConfig);
  assert.deepEqual(await readdir(runtimeDirectory), []);
  assert.deepEqual(report.rendererErrors, []);
  pass('Restart preserves four drafts, test configs and last format, but never replays pending code or resumes downloads');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1;
  if (page && !page.isClosed()) {
    report.uiAtFailure = await page.evaluate(() => ({ statement:document.querySelector('.statement')?.textContent, errors:document.querySelector('.error-banner')?.textContent,
      format:document.querySelector('[aria-label="答题格式"]')?.outerHTML, language:document.querySelector('[aria-label="编程语言"]')?.outerHTML })).catch(() => null);
    await page.screenshot({path:join(directory,'failure.png'),fullPage:true}).catch(() => {});
  }
}
finally {
  try { await close(); } catch (error) { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, assertions: report.assertions, failure: report.failure, cleanupError: report.cleanupError, report: join(directory, 'report.json') }, null, 2));
}
