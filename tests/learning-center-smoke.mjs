import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
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
execFileSync(process.execPath, ['--import', require.resolve('tsx'), join(root, 'tests/learning-center-fixture.ts'), dataDirectory, fixturePath], { cwd: root, stdio: 'pipe' });
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
  if (await notices.count()) await notices.click();
  assert.equal(await page.locator('.error-banner').count(), 0);
  await page.evaluate(lower => {
    document.activeElement?.blur(); document.scrollingElement?.scrollTo(0, 0);
    for (const element of document.querySelectorAll('.scroll-page,.history-pane')) element.scrollTo(0, 0);
    if (lower) document.querySelector('.review-planner')?.scrollIntoView({ block: 'start' });
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
  await page.getByRole('img', { name: `今日完成 ${fixture.dashboard.days.at(-1).completedProblems} 题，目标 5 题`, exact: true }).waitFor();
  pass('Default learning center displays actual fixture aggregates and the sidebar has no quick problem list');
  await captureSizes('home');
  await resize(1440, 1100); await screenshot('home-publish-1440x1100.png');
  await resize(1440, 1240); await screenshot('home-publish-1440x1240.png');
  const completeHome = await page.evaluate(() => ({ calendarBottom: document.querySelector('.review-calendar').getBoundingClientRect().bottom, footerBottom: document.querySelector('.center-footer').getBoundingClientRect().bottom, height: innerHeight }));
  assert.ok(completeHome.calendarBottom < completeHome.height - 36 && completeHome.footerBottom < completeHome.height - 36, 'publication home shows the entire calendar and learning footer above the app status bar');
  report.publicationHome = completeHome;
  await resize(1440, 1000);
  if (!screenshotOnly) {
    const extraPlans = (await api('reviewItems')).filter(item => item.scheduledAt && !item.suspended).slice(0, 2);
    for (const item of extraPlans) await api('updateReviewItem', item.id, { scheduledAt: null });
    await api('saveLearningSettings', { dailyReviewBudget: 2 });
    const limitedQueue = await api('todayQueue'); assert.equal(limitedQueue.reviewedToday, 1); assert.equal(limitedQueue.items.length, 1);
    await until(async () => await page.locator('.todo-list .todo-row').count() === limitedQueue.items.length, 'home respects the remaining review budget');
    await page.getByRole('combobox', { name: '复习列表范围', exact: true }).selectOption('due');
    await until(async () => await page.locator('.todo-list .todo-row').count() === 3, 'all due exposes tasks outside the daily budget');
    pass('Homepage uses the actual remaining review queue while All due exposes the additional eligible tasks', { budget: 2, completedToday: 1, homePending: 1, allDue: 3 });
    for (const item of extraPlans) await api('updateReviewItem', item.id, { scheduledAt: item.scheduledAt });
    await api('saveLearningSettings', { dailyReviewBudget: null });
    await page.getByRole('button', { name: '今天', exact: true }).click();
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
    const monthTitle = month => `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`;
    await page.getByRole('button', { name: '上个月', exact: true }).click();
    await page.locator('.calendar-toolbar h4').filter({ hasText: monthTitle(fixture.previousMonth) }).waitFor();
    await readyHome();
    assert.ok((await api('learningDashboard', fixture.previousMonth)).reviewEvents.some(event => event.requestId === 'completed-last-month'));
    await page.getByRole('button', { name: '下个月', exact: true }).click();
    await page.locator('.calendar-toolbar h4').filter({ hasText: monthTitle(fixture.month) }).waitFor();
    await page.getByRole('button', { name: '下个月', exact: true }).click();
    await page.getByRole('button', { name: '今天', exact: true }).click();
    await page.locator('.calendar-toolbar h4').filter({ hasText: monthTitle(fixture.month) }).waitFor();
    await until(async () => await page.locator(`.calendar-day[data-today="true"]`).getAttribute('aria-pressed') === 'true', 'Today resets calendar selection');
    pass('Calendar previous/next month navigation and Today restore the expected month and selected day');
    const scope = page.getByRole('combobox', { name: '复习列表范围', exact: true });
    await scope.selectOption('all');
    const row = page.locator('.todo-row').filter({ has: page.getByRole('button', { name: fixture.official.title, exact: true }) });
    await row.locator('summary').click(); await row.getByRole('button', { name: '暂停复习', exact: true }).click();
    await until(async () => (await api('reviewItems')).find(item => item.id === fixture.pending.id).suspended, 'review pause persisted');
    await scope.selectOption('paused');
    await row.locator('summary').click(); await row.getByRole('button', { name: '恢复复习', exact: true }).click();
    await until(async () => !(await api('reviewItems')).find(item => item.id === fixture.pending.id).suspended, 'review resume persisted');
    assert.equal((await api('reviewItems')).find(item => item.id === fixture.pending.id).dueAt, fixture.pending.dueAt);
    assert.deepEqual(await api('reviewEvents', fixture.pending.id), []);
    pass('Pausing and resuming a todo persist without changing FSRS due dates or inventing completion');
    await page.getByRole('button', { name: '今天', exact: true }).click();
  }
  await page.getByRole('button', { name: `开始复习：${fixture.official.title}`, exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '练习工作台', exact: true }).waitFor();
  await page.locator('.coding-pane .monaco-editor').waitFor();
  if (!screenshotOnly) await activityTimingRegression();
  const syntheticCode = `${fixture.official.code}\n# UI copy validation: 保留空格 🧪  \n`;
  await pasteCode(syntheticCode);
  await page.getByRole('button', { name: '力扣判题 ↗', exact: true }).click();
  await until(async () => (await app.evaluate(() => globalThis.learningCenterSmoke.opened)).length === 1, 'official link passed through trusted IPC');
  const intercepted = await app.evaluate(() => ({ copies: globalThis.learningCenterSmoke.copies, opened: globalThis.learningCenterSmoke.opened }));
  assert.deepEqual(intercepted.copies, [syntheticCode]); assert.deepEqual(intercepted.opened, [fixture.official.url]);
  pass('Review todo enters the existing workbench; official-judge button copies exact synthetic code and opens the source URL through real IPC without touching clipboard or submitting', { copiedBytes: Buffer.byteLength(syntheticCode), opened: intercepted.opened });
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
    const rating = page.getByRole('region', { name: '练习自评与复习计划', exact: true });
    await rating.getByRole('button', { name: /^轻松/ }).click();
    await rating.getByRole('button', { name: '确认自评并安排复习', exact: true }).click();
    await until(async () => (await api('reviewEvents', fixture.pending.id)).length === 1, 'review self-rating committed');
    reviewEvent = (await api('reviewEvents', fixture.pending.id))[0]; assert.equal(reviewEvent.kind, 'review'); assert.equal(reviewEvent.rating, 4);
    await nav('学习中心'); await readyHome();
    await page.locator('.todo-tabs').getByRole('button', { name: /^已完成/ }).click();
    await page.getByRole('button', { name: `${fixture.official.title}，已完成，查看评分`, exact: true }).click();
    const records = page.getByRole('region', { name: '复习评分记录', exact: true });
    await records.getByRole('button', { name: '更正', exact: true }).click();
    await records.getByRole('combobox', { name: '更正评级', exact: true }).selectOption('3');
    await api('saveLearningSettings', { dailyPracticeGoal: 7 });
    // Wait for the real library:changed debounce and consequent dashboard reload.
    await delay(800);
    assert.equal(await records.getByRole('combobox', { name: '更正评级', exact: true }).inputValue(), '3');
    pass('An actual library change and dashboard refresh preserve an in-progress rating correction');
    await records.getByRole('button', { name: '确认更正', exact: true }).click();
    await until(async () => (await api('reviewEvents', fixture.pending.id)).length === 2, 'rating correction appended');
    const events = await api('reviewEvents', fixture.pending.id), dashboard = await api('learningDashboard');
    assert.equal(events[0].reviewedAt, reviewEvent.reviewedAt); assert.equal(events[1].kind, 'correction'); assert.equal(events[1].rating, 3);
    assert.equal(dashboard.reviewEvents.filter(event => event.itemId === fixture.pending.id).length, 1);
    assert.equal(dashboard.reviewEvents.find(event => event.itemId === fixture.pending.id).rating, 3);
    pass('Finishing a practice and self-rating creates a real review; correction appends history and leaves one calendar completion');
    await close(); await load();
    assert.equal((await api('learningSettings')).dailyPracticeGoal, 7);
    assert.equal((await api('reviewEvents', fixture.pending.id)).length, 2);
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
