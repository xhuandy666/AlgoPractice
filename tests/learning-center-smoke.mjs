import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Read an existing build; this script never rebuilds dist. All records are synthetic in a new tmp DB.
// ALGOPRACTICE_APP_DIR=/abs/source-or-staged-app (defaults to project root; must contain dist/package.json)
// ALGOPRACTICE_SCREENSHOT_DIR=/abs/output (defaults to a screenshot folder alongside the tmp report)
// ALGOPRACTICE_SCREENSHOT_ONLY=1 skips goal/review mutations; it still saves and runs the authored example for clean core-page screenshots.
const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, 'package.json'));
const appSource = resolve(process.env.ALGOPRACTICE_APP_DIR || root), packaged = process.env.ALGOPRACTICE_PACKAGED_APP;
const runtimeDirectory = resolve(process.env.ALGOPRACTICE_RUNTIME_DIR || join(root, '.runtime'));
const directory = await mkdtemp(join(os.tmpdir(), '题炼-学习中心验收-')), dataDirectory = join(directory, 'data'), launchDirectory = join(directory, 'app');
const captureDirectory = resolve(process.env.ALGOPRACTICE_SCREENSHOT_DIR || join(directory, 'screenshots'));
const fixturePath = join(directory, 'fixture.json'), screenshotOnly = process.env.ALGOPRACTICE_SCREENSHOT_ONLY === '1';
await mkdir(captureDirectory, { recursive: true });
execFileSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, join(root, 'tests/learning-center-fixture.ts'), dataDirectory, fixturePath], { cwd: root, stdio: 'pipe' });
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (!packaged) {
  await mkdir(launchDirectory);
  await cp(join(appSource, 'dist'), join(launchDirectory, 'dist'), { recursive: true });
  await cp(join(appSource, 'package.json'), join(launchDirectory, 'package.json'));
}
const env = { ...process.env, ALGOPRACTICE_DATA_DIR: dataDirectory, ALGOPRACTICE_RUNTIME_DIR: runtimeDirectory }; delete env.ELECTRON_RUN_AS_NODE;
const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, dataDirectory, captureDirectory,
  appSource, executable: packaged || require('electron'), synthetic: true, screenshotOnly, assertions: [], screenshots: [], rendererErrors: [], httpAttempts: [], exits: [],
  clipboardScope: 'Real trusted IPC; native clipboard write and external-open methods temporarily intercepted in main. System clipboard is never read or changed.',
  scope: 'Actual Electron renderer and preload, SQLite, persisted daily goals and FSRS. No window.algo mocks. Synthetic history is fixture data, not real study evidence.',
};
if (!packaged) report.build = Object.fromEntries(await Promise.all(['main.cjs', 'preload.cjs'].map(async name => [name, createHash('sha256').update(await readFile(join(launchDirectory, 'dist', name))).digest('hex')])));
let app, page, cdp, viewport = [1440, 1000];
const api = (method, ...args) => page.evaluate(({ method, args }) => window.algo[method](...args), { method, args });
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const pass = (name, details = true) => { report.assertions.push({ name, details, passed: true }); console.log('PASS', name); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(check, description, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${description}`);
}
async function resize(width, height) {
  viewport = [width, height];
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), viewport);
}
async function load() {
  app = await electron.launch({ executablePath: packaged ? resolve(packaged) : require('electron'), args: packaged ? [] : [launchDirectory], cwd: root, env, timeout: 30000 });
  const observe = window => {
    window.on('pageerror', error => report.rendererErrors.push({ type: 'pageerror', message: error.message }));
    window.on('console', message => { if (message.type() === 'error') report.rendererErrors.push({ type: 'console', message: message.text() }); });
  };
  app.context().on('page', observe); for (const window of app.context().pages()) observe(window);
  await app.context().route(/^https?:\/\//, route => { report.httpAttempts.push({ source: 'renderer', url: route.request().url() }); return route.abort('blockedbyclient'); });
  await app.evaluate(({ clipboard, shell }) => {
    globalThis.learningCenterSmoke = { copies: [], opened: [], http: [], originalWrite: clipboard.writeText, originalOpen: shell.openExternal, originalFetch: globalThis.fetch };
    clipboard.writeText = text => { globalThis.learningCenterSmoke.copies.push(text); };
    shell.openExternal = async url => { globalThis.learningCenterSmoke.opened.push(url); };
    globalThis.fetch = (input, init) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (/^https?:\/\//.test(url)) { globalThis.learningCenterSmoke.http.push(url); return Promise.reject(new Error('Learning-center smoke forbids outbound HTTP')); }
      return globalThis.learningCenterSmoke.originalFetch(input, init);
    };
  });
  page = await app.firstWindow();
  await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 20000 });
  await page.evaluate(() => document.fonts.ready); cdp = await app.context().newCDPSession(page);
  await resize(...viewport); await readyHome();
  assert.equal(resolve((await api('environment')).dataDirectory), dataDirectory);
  const reminders = await api('reminderState'); await api('saveReminderSettings', { ...reminders.settings, enabled: false });
}
async function readyHome() {
  await page.getByRole('heading', { name: '今日进度', exact: true }).waitFor();
  await until(async () => await page.locator('.learning-center').getAttribute('aria-busy') === 'false', 'learning center data loaded');
}
async function close() {
  if (!app) return;
  const closing = app, child = app.process();
  await until(async () => !(await api('backups')).busy, 'automatic backup settles');
  const intercepted = await closing.evaluate(({ clipboard, shell }) => {
    const saved = globalThis.learningCenterSmoke;
    clipboard.writeText = saved.originalWrite; shell.openExternal = saved.originalOpen; globalThis.fetch = saved.originalFetch;
    return { http: saved.http, copies: saved.copies.length, opened: saved.opened };
  });
  report.httpAttempts.push(...intercepted.http.map(url => ({ source: 'main', url })));
  const pids = [...new Set([child.pid, ...await closing.evaluate(({ app }) => app.getAppMetrics().map(metric => metric.pid))])];
  await closing.close();
  await until(async () => (child.exitCode !== null || child.signalCode !== null) && pids.every(pid => !alive(pid)), 'all recorded app processes exit', 15000);
  report.exits.push({ pid: child.pid, pids, exitCode: child.exitCode, signal: child.signalCode, remaining: pids.filter(alive) });
  app = null;
}
async function screenshot(name, lowerReview = false) {
  const notices = page.locator('.preview-banner').getByRole('button', { name: '收起', exact: true });
  if (await notices.count() && !(await page.locator('dialog[open]').count())) await notices.click();
  assert.equal(await page.locator('.error-banner').count(), 0);
  await page.evaluate(lower => {
    document.activeElement?.blur(); document.scrollingElement?.scrollTo(0, 0);
    for (const element of document.querySelectorAll('.scroll-page,.history-pane')) element.scrollTo(0, 0);
    if (lower) document.querySelector('.center-review-summary')?.scrollIntoView({ block: 'start' });
  }, lowerReview);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const bounds = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
  assert.deepEqual([bounds.width, bounds.height], viewport); assert.ok(bounds.scrollWidth <= bounds.width, 'no horizontal page overflow');
  await page.screenshot({ path: join(captureDirectory, name), clip: { x: 0, y: 0, width: viewport[0], height: viewport[1] }, scale: 'css' });
  report.screenshots.push({ name, ...bounds });
}
async function captureSizes(prefix) {
  for (const size of [[1440, 1000], [1280, 900], [820, 1000]]) {
    await resize(...size); await screenshot(`${prefix}-${size[0]}x${size[1]}.png`);
    if (prefix === 'home' && size[0] === 820) await screenshot('home-820x1000-review.png', true);
  }
  await resize(1440, 1000);
}
async function reviewContrast(selector, label) {
  const result = await page.evaluate(selector => {
    const root = document.querySelector(selector), canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((v, i) => i === 3 ? v / 255 : v); };
    const blend = (front, back) => front.slice(0, 3).map((value, i) => value * front[3] + back[i] * (1 - front[3]));
    const background = element => { const layers = []; for (let node = element; node; node = node.parentElement) layers.push(rgba(getComputedStyle(node).backgroundColor)); return layers.reverse().reduce((back, front) => blend(front, back), [255, 255, 255]); };
    const luminance = rgb => { const v = rgb.map(value => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }); return v[0] * .2126 + v[1] * .7152 + v[2] * .0722; };
    const contrast = (front, back) => { const a = luminance(front), b = luminance(back); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
    const text = [], borders = [], failures = [];
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[hidden],:disabled');
    for (const element of [root, ...root.querySelectorAll('*')]) {
      if (!visible(element)) continue;
      const style = getComputedStyle(element), bg = background(element);
      const direct = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()).map(node => node.textContent.trim()).join(' ');
      if (direct || element.matches('input[type=search],select')) {
        const fore = element.matches('input[type=search]') && !element.value ? getComputedStyle(element, '::placeholder').color : style.color;
        const ratio = contrast(blend(rgba(fore), bg), bg), name = direct.slice(0, 80) || element.getAttribute('aria-label') || element.placeholder || element.tagName;
        text.push({ name, ratio }); if (ratio < 4.5) failures.push({ kind: 'text', name, ratio });
      }
      if (element.matches('.button,input:not([type=checkbox]):not([type=radio]),select,.problem-rating-option,[aria-pressed=true].review-bar-button,[aria-pressed=true].review-calendar-cells button')) {
        const color = rgba(style.borderTopColor); if (!parseFloat(style.borderTopWidth) || color[3] === 0) continue;
        const outside = background(element.parentElement), ratio = contrast(blend(color, outside), outside);
        borders.push({ name: direct.slice(0, 80) || element.tagName, ratio }); if (ratio < 3) failures.push({ kind: 'control-border', name: direct.slice(0, 80) || element.tagName, ratio });
      }
    }
    return { textSamples: text.length, controlBorderSamples: borders.length, minTextRatio: Math.min(...text.map(row => row.ratio)), minControlBorderRatio: Math.min(...borders.map(row => row.ratio)), failures };
  }, selector);
  assert.deepEqual(result.failures, [], `${label}: computed-color contrast failed`);
  pass(`${label}: visible enabled text >= 4.5:1 and styled control boundaries >= 3:1`, result);
  report.reviewContrast ??= []; report.reviewContrast.push({ label, selector, ...result, scope: 'Only visible enabled content in the new review page/modal at these tested states. No claim of a global accessibility audit; native radio/checkbox internals, disabled controls, decorative panel rules and unseen states excluded.' });
}
async function reviewFirstScreen() {
  const original = (await api('reviewPlan', { view: 'all' })).items.items.find(row => row.problemId === 'learning-smoke-1');
  assert.ok(original?.scheduledAt, 'synthetic future plan is available for the layout-only fixture adjustment');
  await api('saveLearningSettings', { dailyReviewBudget: 3 });
  await api('updateProblemReviews', { problemIds: [original.problemId], expectedRevisions: { [original.problemId]: original.revision }, scheduledAt: null });
  await until(async () => await page.locator('.review-plan-row').count() >= 2 && await page.locator('.review-plan-page').getAttribute('aria-busy') === 'false', 'at least two actual due fixture rows render');
  const layouts = [];
  for (const [width, height, expected] of [[1440, 940, 2], [1280, 800, 1]]) {
    await resize(width, height); await page.locator('.review-plan-page').evaluate(element => element.scrollTo(0, 0));
    const state = await page.evaluate(() => { const root = document.querySelector('.review-plan-page'), bounds = root.getBoundingClientRect(), buttons = root.querySelector('.review-action-side > button').getBoundingClientRect(); return { width: innerWidth, height: innerHeight, actionBottom: buttons.bottom, contentBottom: bounds.bottom, rowBounds: [...root.querySelectorAll('.review-plan-row')].map(row => { const r = row.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }), visibleRows: [...root.querySelectorAll('.review-plan-row')].filter(row => { const r = row.getBoundingClientRect(); return r.top >= bounds.top && r.bottom <= Math.min(bounds.bottom, innerHeight); }).length, advancedOpen: root.querySelector('.review-advanced-filters').open }; });
    report.reviewFirstScreen ??= []; report.reviewFirstScreen.push(state);
    assert.equal(state.advancedOpen, false, 'today starts with compact filters'); assert.ok(state.actionBottom < height - 36, 'primary action remains in the first screen'); assert.ok(state.visibleRows >= expected, `${width}x${height}: first screen shows at least ${expected} full review rows`);
    layouts.push(state); await screenshot(`reviews-${width}x${height}.png`);
  }
  await page.getByRole('button', { name: '全部题目', exact: true }).click();
  await until(async () => await page.locator('.review-plan-page').getAttribute('aria-busy') === 'false', 'expanded all-view filters load');
  await reviewContrast('.review-plan-page', 'New review plan page with advanced filters');
  await page.getByRole('button', { name: '今日复习', exact: true }).click();
  const current = await api('problemReviewDetail', original.problemId);
  await api('updateProblemReviews', { problemIds: [original.problemId], expectedRevisions: { [original.problemId]: current.plan.revision }, scheduledAt: original.scheduledAt });
  pass('Review first screen exposes the primary action and real list rows at 1440x940 / 1280x800', layouts);
  await resize(1440, 1000);
}
async function pasteCode(code) {
  const editor = page.locator('.coding-pane .monaco-editor'); await editor.waitFor();
  await editor.locator('.view-lines').click({ position: { x: 80, y: 15 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await editor.locator('[role=textbox]').evaluate((element, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, code);
  await until(async () => (await api('loadDraft', fixture.official.problemId, 'python'))?.code === code, 'synthetic editor text is persisted');
}
async function activityTimingRegression() {
  const workspace = await api('workspace', fixture.official.problemId, 'python');
  assert.ok(workspace.attempt?.isActive, 'use the real isolated attempt opened by the review todo');
  const attemptId = workspace.attempt.id, measured = async () => (await api('archiveOverview', attemptId)).activeMs;
  const focused = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused());
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await until(focused, 'isolated test window is focused before timing');
  const outcomes = []; report.activityDiagnostics = [];
  async function activityState(label) {
    const native = await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; return { focused: win.isFocused(), visible: win.isVisible() }; });
    const renderer = await page.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState, page: document.querySelector('.app-header h1')?.textContent }));
    const result = { label, native, renderer, activeMs: await measured() }; report.activityDiagnostics.push(result); return result;
  }
  const settled = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  async function continuous(name, before) {
    for (let retry = 0; retry < 3; retry++) {
      if (retry) {
        await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
        await until(focused, 'isolated window is focused for the interrupted interval retry');
        await settled(); await api('pauseActivity'); await api('activityPulse', attemptId); before = await measured();
      }
      await activityState(`${name}: before continuous interval ${retry}`);
      const started = performance.now(); await delay(600); const middle = await activityState(`${name}: midpoint ${retry}`);
      await delay(600); const ending = await activityState(`${name}: before second pulse ${retry}`); await api('activityPulse', attemptId);
      await activityState(`${name}: after second pulse ${retry}`);
      const after = await measured(), elapsed = performance.now() - started, credited = after - before;
      if (!middle.native.focused || !ending.native.focused) {
        assert.equal(credited, 0, 'a real native focus loss during the test interval must not receive activity credit');
        outcomes.push({ transition: name, interruptedByNativeFocusLoss: true, creditedMs: credited, waitedMs: Math.round(elapsed) });
        continue;
      }
      assert.ok(credited >= 1000 && credited <= elapsed + 300, `${name}: continuous foreground interval is measured (${credited}ms, elapsed ${elapsed}ms)`);
      outcomes.push({ transition: name, creditedMs: credited, waitedMs: Math.round(elapsed) });
      return after;
    }
    throw new Error('The isolated test window repeatedly lost native focus; a continuous foreground interval cannot be verified on this host right now');
  }
  await api('pauseActivity'); await api('activityPulse', attemptId);
  let before = await measured();
  await nav('题库'); await page.locator('.app-header h1').filter({ hasText: /^题库$/ }).waitFor();
  await delay(1200);
  await nav('练习工作台'); await page.locator('.app-header h1').filter({ hasText: /^练习工作台$/ }).waitFor();
  await settled(); await activityState('returned before first pulse');
  await api('activityPulse', attemptId);
  assert.equal(await measured(), before, 'the first pulse after a short page switch cannot credit the away interval');
  before = await continuous('short page switch', before);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blur());
  await until(async () => !(await focused()), 'isolated test window actually loses focus');
  await delay(1200);
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await until(focused, 'isolated test window regains focus');
  await settled(); await activityState('returned before first pulse');
  await api('activityPulse', attemptId);
  assert.equal(await measured(), before, 'the first pulse after a short blur cannot credit the unfocused interval');
  before = await continuous('short native blur', before);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await until(() => app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()), 'isolated test window actually hides');
  await delay(1200);
  await app.evaluate(({ app, BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); app.focus({ steal: true }); win.focus(); });
  await until(focused, 'isolated test window shows and regains focus');
  await settled(); await activityState('returned before first pulse');
  await api('activityPulse', attemptId);
  assert.equal(await measured(), before, 'the first pulse after a short hide cannot credit the hidden interval');
  await continuous('short native hide', before);
  pass('Short page switches, native blur and hide reset measured activity; each first returning pulse credits zero and the next continuous foreground pulse credits real time', { attemptId, outcomes });
}
let reviewEvent;
try {
  await load();
  assert.equal(await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '学习中心', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('.sidebar').getByText('快捷题目', { exact: true }).count(), 0);
  assert.equal(await page.locator('.sidebar .problem-shortcuts,.sidebar .quick-problems').count(), 0);
  assert.equal(await page.locator('.sidebar').getByText(fixture.official.title, { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const initial = await api('learningDashboard');
  assert.equal(initial.totals.completedAttempts, fixture.dashboard.totals.completedAttempts);
  assert.equal(initial.days.find(day => day.date === fixture.today).completedProblems, fixture.dashboard.days.at(-1).completedProblems);
  const dailyProgress = page.getByRole('progressbar', { name: '今日练习目标', exact: true });
  await dailyProgress.waitFor();
  assert.equal(await dailyProgress.getAttribute('aria-valuetext'), `今日完成 ${fixture.dashboard.days.at(-1).completedProblems} 题，目标 5 题`);
  pass('Default learning center displays actual fixture aggregates and the sidebar has no quick problem list');
  await captureSizes('home');
  await resize(1440, 1100); await screenshot('home-publish-1440x1100.png');
  await resize(1440, 1240); await screenshot('home-publish-1440x1240.png');
  const completeHome = await page.evaluate(() => ({ summaryBottom: document.querySelector('.center-review-summary').getBoundingClientRect().bottom, footerBottom: document.querySelector('.center-footer').getBoundingClientRect().bottom, height: innerHeight }));
  assert.ok(completeHome.summaryBottom < completeHome.height - 36 && completeHome.footerBottom < completeHome.height - 36, 'learning summary and footer remain above the app status bar');
  report.publicationHome = completeHome;
  await resize(1440, 1000);
  if (!screenshotOnly) {
    await api('saveLearningSettings', { dailyReviewBudget: 2 });
    const limitedPlan = await api('reviewPlan', { view: 'today' });
    assert.equal(limitedPlan.summary.reviewedToday, 1);
    const summary = page.getByRole('region', { name: '复习计划摘要', exact: true });
    await until(async () => (await summary.textContent()).includes(`已复习 ${limitedPlan.summary.reviewedToday} 题`), 'home summary matches the unified plan snapshot');
    assert.equal(await page.locator('.todo-list,.review-calendar,.review-records').count(), 0, 'learning center no longer duplicates management');
    await summary.getByRole('button', { name: '查看复习计划', exact: true }).click();
    await page.locator('.review-plan-page').getByRole('heading', { name: '复习计划', exact: true }).waitFor();
    pass('Learning center exposes one summary entry to the independent unified plan page');
    await reviewFirstScreen();
    await api('saveLearningSettings', { dailyReviewBudget: null });
    await nav('学习中心'); await readyHome();
    await page.getByRole('button', { name: '调整目标', exact: true }).click();
    await page.getByRole('spinbutton', { name: '每日练习目标', exact: true }).fill('7');
    await page.locator('.goal-form').getByRole('button', { name: '保存', exact: true }).click();
    await until(async () => (await api('learningSettings')).dailyPracticeGoal === 7, 'daily goal saved');
    pass('Daily practice goal saves through the UI independently from the unlimited review budget', await api('learningSettings'));
    const cell = page.locator('.heatmap-grid').getByRole('button', { name: new RegExp(`^${fixture.yesterday}：`) });
    await cell.click(); await page.locator('.archive-day-filter').getByText(`${fixture.yesterday} 的学习记录`, { exact: true }).waitFor();
    const datePage = await api('attemptPage', { learningDate: fixture.yesterday });
    const index = datePage.items.findIndex(row => row.attempt.id === fixture.crossing.id); assert.ok(index >= 0);
    await until(async () => await page.locator('.archive-list > button').count() === datePage.items.length, 'filtered archive rows render');
    await page.locator('.archive-list > button').nth(index).click();
    await page.locator('.archive-detail').getByRole('heading', { name: fixture.crossing.title, exact: true }).waitFor();
    pass('Heatmap day opens the existing archive filtered by that learning date, including a practice ended across midnight', { date: fixture.yesterday, crossingId: fixture.crossing.id, total: datePage.total });
    await nav('学习中心'); await readyHome();
  }
  await nav('题库');
  await page.locator('.problem-table-row').filter({ has: page.getByRole('button', { name: fixture.official.title, exact: true }) }).getByRole('button', { name: '练习', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '练习工作台', exact: true }).waitFor();
  await page.locator('.coding-pane .monaco-editor').waitFor();
  if (!screenshotOnly) await activityTimingRegression();
  const syntheticCode = `${fixture.official.code}\n# UI draft validation: 保留空格 🧪  \n`;
  await pasteCode(syntheticCode);
  assert.equal(await page.getByRole('button', { name: '提交到力扣', exact: true }).count(), 0, 'A local authored problem with only a source URL has no verified official submission metadata');
  const intercepted = await app.evaluate(() => ({ copies: globalThis.learningCenterSmoke.copies, opened: globalThis.learningCenterSmoke.opened }));
  assert.deepEqual(intercepted.copies, []); assert.deepEqual(intercepted.opened, []);
  pass('Library entry opens the ordinary workbench and preserves the exact draft; a source URL alone does not authorize official submission', { draftBytes: Buffer.byteLength(syntheticCode) });
  // Publication screenshots show the original example and an actual local result, not test annotations.
  await pasteCode(fixture.official.code);
  assert.ok((await api('environment')).python, 'Prepare a Python runtime or pass ALGOPRACTICE_RUNTIME_DIR');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await until(async () => (await api('history', fixture.official.problemId, 'python')).some(run => run.code === fixture.official.code && run.result.status === 'passed'), 'authored Python example passes actual local cases', 60000);
  const verifiedRun = (await api('history', fixture.official.problemId, 'python')).find(run => run.code === fixture.official.code && run.result.status === 'passed');
  assert.equal(verifiedRun.result.caseResults.length, 2); assert.ok(verifiedRun.result.caseResults.every(result => result.status === 'passed'));
  await page.locator('.result-summary strong').filter({ hasText: '本地测试通过' }).waitFor();
  pass('Clean publication code executes against both local cases in the actual Python runtime', { runId: verifiedRun.id, status: verifiedRun.result.status, caseCount: verifiedRun.result.caseResults.length });
  await captureSizes('workbench');
  if (!screenshotOnly) {
    await page.getByRole('button', { name: '结束练习', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0, 'finishing a practice must not automatically open a rating');
    assert.equal((await api('problemReviewDetail', fixture.official.problemId)).events.items.length, 1, 'local pass and finish do not add a review observation');
    await nav('复习计划');
    await page.getByRole('button', { name: '全部题目', exact: true }).click();
    await page.getByRole('button', { name: fixture.official.title, exact: true }).click();
    const details = page.getByRole('complementary', { name: '题目复习详情', exact: true });
    await details.getByRole('button', { name: '记录今天的复习', exact: true }).click();
    const rating = page.getByRole('dialog');
    assert.equal(await rating.getByRole('radio', { checked: true }).count(), 0, 'ratings are not preselected');
    await rating.getByRole('radio', { name: /轻松/ }).check();
    await reviewContrast('.problem-rating-dialog', 'New self-rating modal with selected rating');
    await screenshot('review-rating-1440x1000.png');
    await rating.getByRole('button', { name: '记录自评并安排复习', exact: true }).click();
    await until(async () => (await api('problemReviewDetail', fixture.official.problemId)).events.items.length === 2, 'explicit manual self-rating committed');
    await until(async () => (await api('reviewAssessmentDraft', `problem-review:manual:${fixture.official.problemId}`)) === null, 'successful manual assessment clears the resolved draft using its current revision');
    await rating.getByRole('button', { name: '关闭', exact: true }).click();
    reviewEvent = (await api('problemReviewDetail', fixture.official.problemId)).events.items.find(event => event.requestId !== 'pending-initial');
    assert.equal(reviewEvent.kind, 'review'); assert.equal(reviewEvent.rating, 4);
    const timeline = details.locator('.review-history-event').filter({ has: page.getByText(fixture.today, { exact: true }) });
    await timeline.getByRole('button', { name: '修改这次自评', exact: true }).click();
    const correction = page.getByRole('dialog');
    await correction.getByRole('radio', { name: /良好/ }).check();
    await api('saveLearningSettings', { dailyPracticeGoal: 7 }); await delay(800);
    assert.equal(await correction.getByRole('radio', { name: /良好/ }).isChecked(), true);
    pass('A real library refresh preserves the correction draft and its source identity');
    await correction.getByRole('button', { name: '保存更正', exact: true }).click();
    await until(async () => (await api('problemReviewDetail', fixture.official.problemId)).events.items.length === 3, 'correction appended');
    await correction.getByRole('button', { name: '关闭', exact: true }).click();
    const events = (await api('problemReviewDetail', fixture.official.problemId)).events.items;
    const corrected = events.find(event => event.kind === 'correction');
    assert.equal(corrected.observedAt, reviewEvent.observedAt); assert.equal(corrected.rating, 3);
    const unified = await api('reviewPlan'); assert.equal(unified.summary.reviewedToday, 2);
    pass('Only explicit rating adds a review; correction is traceable and does not add another completion');
    await close(); await load();
    assert.equal((await api('learningSettings')).dailyPracticeGoal, 7);
    assert.equal((await api('problemReviewDetail', fixture.official.problemId)).events.total, 3);
    assert.ok(!(await api('reviewItems')).find(item => item.id === fixture.pending.id).suspended);
    pass('Full application restart preserves the goal, original review, correction and resumed plan');
  }
  await close(); assert.deepEqual(report.rendererErrors, []); assert.deepEqual(report.httpAttempts, []);
  assert.ok(report.exits.every(exit => exit.remaining.length === 0));
  pass('No renderer errors or outbound HTTP; every recorded Electron process exits'); report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = String(error.stack || error); process.exitCode = 1; console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: join(captureDirectory, 'failure.png') }).catch(() => {});
} finally {
  if (app) try { await close(); } catch (error) { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; app?.process().kill(); }
  report.finishedAt = new Date().toISOString(); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Learning center report:', join(directory, 'report.json')); console.log('Screenshots:', captureDirectory);
}
