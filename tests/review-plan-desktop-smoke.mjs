import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Real Electron/preload/IPC/SQLite. LeetCode transport and explicitly marked IPC acknowledgement faults are synthetic.
// No real account, key, clipboard, code POST, model request or user database is touched.
const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, 'package.json'));
const directory = await mkdtemp(join(os.tmpdir(), '题炼-复习计划合成验收-'));
const dataDirectory = join(directory, 'data'), launchDirectory = join(directory, 'app'), fixturePath = join(directory, 'fixture.json');
const captureDirectory = join(directory, 'screenshots'); await mkdir(captureDirectory);
execFileSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, join(root, 'tests/review-plan-fixture.ts'), dataDirectory, fixturePath], { cwd: root, stdio: 'pipe' });
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
await mkdir(launchDirectory); await cp(join(root, 'dist'), join(launchDirectory, 'dist'), { recursive: true });
await cp(join(root, 'package.json'), join(launchDirectory, 'package.json'));
const env = { ...process.env, ALGOPRACTICE_DATA_DIR: dataDirectory, ALGOPRACTICE_RUNTIME_DIR: process.env.ALGOPRACTICE_RUNTIME_DIR || join(root, '.runtime') }; delete env.ELECTRON_RUN_AS_NODE;
const report = { startedAt: new Date().toISOString(), synthetic: true, platform: process.platform, arch: process.arch,
  dataDirectory, captureDirectory, assertions: [], screenshots: [], rendererErrors: [], httpAttempts: [],
  limitations: ['Synthetic judge responses are not live LeetCode verification.', 'This local smoke covers the current host, not remote macOS Intel/Windows CI.'] };
let app, page, cdp;
const api = (method, ...args) => page.evaluate(({ method, args }) => window.algo[method](...args), { method, args });
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const pass = (name, details = true) => { report.assertions.push({ name, details, passed: true }); console.log('PASS', name); };
async function until(check, description, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${description}`);
}
async function focus() { await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].show(); BrowserWindow.getAllWindows()[0].focus(); }); }
async function resize(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [width, height]);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
}
async function shot(name) { const path = join(captureDirectory, name); await page.screenshot({ path }); report.screenshots.push(path); }
async function launch(profileDirectory = dataDirectory) {
  app = await electron.launch({ executablePath: require('electron'), args: [launchDirectory], cwd: root, env: { ...env, ALGOPRACTICE_DATA_DIR: profileDirectory }, timeout: 30000 });
  app.context().on('page', window => window.on('pageerror', error => report.rendererErrors.push(error.message)));
  for (const window of app.context().pages()) window.on('pageerror', error => report.rendererErrors.push(error.message));
  await app.context().route(/^https?:\/\//, route => { report.httpAttempts.push(route.request().url()); return route.abort(); });
  await app.evaluate(({ session }) => {
    const isolated = session.fromPartition('persist:leetcode-cn');
    const state = globalThis.reviewPlanSmoke = { verdict: 'wrong_answer', hold: false, sequence: 88000000, records: {}, requests: [], blocked: [],
      loseDraftAck: false, loseSubmitDraftAck: false, holdRecordAck: false, recordAckPending: false, failSnapshot: false, failNextRequest: false };
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    isolated.cookies.get = async () => [{ name: 'LEETCODE_SESSION', value: 'synthetic-never-sent', domain: '.leetcode.cn', path: '/', secure: true },
      { name: 'csrftoken', value: 'synthetic_csrf_token_for_test', domain: '.leetcode.cn', path: '/', secure: true }];
    isolated.fetch = async (input, init = {}) => {
      const url = new URL(String(input)); state.requests.push({ url: url.href, method: init.method || 'GET' });
      if (url.origin !== 'https://leetcode.cn') throw new Error('Unexpected synthetic source origin');
      if (/^\/graphql\/?$/.test(url.pathname)) return json({ data: { userStatus: { isSignedIn: true } } });
      if (url.pathname === '/problems/two-sum/submit/' && init.method === 'POST') {
        const id = String(++state.sequence); state.records[id] = state.verdict; return json({ submission_id: id });
      }
      const check = /^\/submissions\/detail\/(\d+)\/check\/$/.exec(url.pathname);
      if (check) return state.hold ? json({ state: 'STARTED' }) : json({ state: 'SUCCESS', status_code: state.records[check[1]] === 'accepted' ? 10 : 11,
        status_msg: state.records[check[1]] === 'accepted' ? 'Accepted' : 'Wrong Answer', total_correct: '1', total_testcases: '1', status_runtime: '1 ms', status_memory: '1 MB' });
      state.blocked.push(url.href); throw new Error('Unexpected synthetic judge endpoint');
    };
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => { const url = String(input instanceof Request ? input.url : input);
      if (/^https?:\/\//.test(url)) { state.blocked.push(url); return Promise.reject(new Error('Review smoke forbids outbound HTTP')); }
      return original(input, init); };
  });
  page = await app.firstWindow(); await page.getByRole('navigation', { name: '主导航' }).waitFor();
  await app.evaluate(({ ipcMain }) => {
    // Pinned Electron harness: call each real handler before losing only its reply.
    // The renderer still uses the real preload, IPC and persisted SQLite result.
    for (const channel of ['problem-review:save-draft', 'problem-review:record', 'problem-review:snapshot', 'problem-review:request']) {
      const real = ipcMain._invokeHandlers.get(channel);
      if (typeof real !== 'function') throw new Error(`Missing isolated IPC handler: ${channel}`);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        const state = globalThis.reviewPlanSmoke;
        if (channel === 'problem-review:snapshot' && state.failSnapshot) throw new Error('合成验收：复习读取暂时失败');
        if (channel === 'problem-review:request' && state.failNextRequest) { state.failNextRequest = false; throw new Error('合成验收：原请求状态暂时不可读取'); }
        const result = await real(...args);
        if (channel === 'problem-review:save-draft' && (state.loseDraftAck || (state.loseSubmitDraftAck && args[1]?.submitted))) {
          state.loseDraftAck = false; state.loseSubmitDraftAck = false;
          throw new Error('合成验收：草稿已落盘，回复丢失');
        }
        if (channel === 'problem-review:record' && state.holdRecordAck) {
          state.holdRecordAck = false; state.recordAckPending = true;
          await new Promise(resolve => { state.releaseRecordAck = resolve; });
          state.recordAckPending = false; delete state.releaseRecordAck;
          state.failNextRequest = true;
          throw new Error('合成验收：评分已落盘，回复丢失');
        }
        return result;
      });
    }
  });
  cdp = await app.context().newCDPSession(page); await resize(1440, 940); await focus();
  assert.equal(resolve((await api('environment')).dataDirectory), profileDirectory);
  const settings = await api('reminderState'); await api('saveReminderSettings', { ...settings.settings, enabled: false });
}
async function close() {
  if (!app) return;
  await until(async () => !(await api('backups')).busy, 'isolated automatic backup settles');
  const state = await app.evaluate(() => { const state = globalThis.reviewPlanSmoke; state.releaseRecordAck?.(); return { blocked: state.blocked }; });
  report.httpAttempts.push(...state.blocked);
  const closing = app; app = null;
  const guard = setTimeout(() => { report.cleanupError = 'Isolated review test process did not exit within 15 seconds'; process.exitCode = 1; closing.process().kill('SIGKILL'); }, 15000);
  try { await closing.close(); } finally { clearTimeout(guard); }
}

try {
  await launch();
  const surfaces = [
    ['学习中心', '.learning-center'], ['复习计划', '.review-plan-page'], ['学习设置', '.learning-page'],
    ['导入题单', '.import-page'], ['题库', '.library-page'], ['学习笔记', '.learning-page'],
    ['练习档案', '.archives-page'], ['模拟面试', '.interview-page'], ['运行环境', '.settings-page'],
  ];
  for (const [name, selector] of surfaces) {
    await nav(name); const surface = page.locator(selector); await surface.waitFor();
    await resize(740, 620); await resize(1440, 940);
    const text = await surface.innerText();
    for (const removed of ['首次评估不计复习完成；重复通过与更正不重复计数。', '暂停题不计未来负担。安排会随自评与延期改变。', '记录持续的进步']) assert.equal(text.includes(removed), false, `${name}: removed boilerplate must stay removed`);
    assert.ok(await surface.locator('.heading-with-help').evaluateAll(headings => headings.every(group => {
      const heading = group.querySelector('h2, h3'), trigger = group.querySelector('.help-hint-button');
      if (!heading || !trigger) return true;
      const a = heading.getBoundingClientRect(), b = trigger.getBoundingClientRect();
      return Math.abs(a.top + a.height / 2 - b.top - b.height / 2) < 2;
    })), `${name}: heading help vertically aligned`);
    await shot(`copy-${selector.slice(1)}-${name}.png`);
    const hints = surface.locator('.help-hint-button:visible');
    for (let index = 0; index < await hints.count(); index++) {
      const hint = hints.nth(index); await hint.scrollIntoViewIfNeeded(); await hint.focus();
      const box = await hint.boundingBox();
      assert.ok(box && box.width >= 24 && Math.abs(box.width - box.height) < 1, `${name}: help button is round and at least 24px`);
      const description = await hint.getAttribute('aria-describedby');
      await until(async () => await page.evaluate(id => document.getElementById(id)?.matches(':popover-open'), description), `${name}: keyboard-reachable help`);
      assert.ok((await page.locator(`[id="${description}"]`).textContent()).trim().length > 0);
      await page.keyboard.press('Escape');
      await until(async () => !(await page.evaluate(id => document.getElementById(id)?.matches(':popover-open'), description)), `${name}: help Escape dismisses`);
    }
    if (name === '学习设置') assert.match(text, /备份不包含 API Key/);
    if (name === '运行环境') assert.match(text, /安全沙箱/);
  }
  pass('Nine edited surfaces fit desktop widths; removed boilerplate stays absent, help remains keyboard-readable, and backup/runtime safety notices remain visible');
  await nav('复习计划');
  const initial = await api('reviewPlan', { view: 'all', limit: 100 });
  assert.equal(initial.summary.totalCount, 37); assert.equal(initial.summary.reviewedToday, 1);
  assert.equal(initial.summary.firstAssessedToday, 1); assert.equal(initial.summary.remainingBudget, 2);
  assert.equal(new Set(initial.items.items.map(item => item.problemId)).size, 37);
  pass('One problem per plan; first assessment does not consume today review budget', initial.summary);

  for (const [width, height] of [[1440, 940], [1280, 800], [1024, 700], [840, 680], [740, 620]]) {
    await resize(width, height); await shot(`reviews-${width}x${height}.png`);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' }); await shot('reviews-reduced-motion.png');
  await resize(1440, 940); pass('All five desktop widths and low-height viewport fit without page overflow');

  const reviews = page.getByRole('region', { name: '复习计划', exact: true });
  const viewTabs = reviews.getByRole('navigation', { name: '复习视图' });
  await viewTabs.getByRole('button', { name: '全部题目', exact: true }).click();
  await until(async () => await reviews.locator('.review-plan-row').count() === 20, 'bounded first list page');
  await reviews.getByRole('button', { name: '下一页', exact: true }).click();
  await until(async () => await reviews.locator('.review-plan-row').count() === 17, 'bounded second list page');
  await reviews.getByRole('button', { name: '上一页', exact: true }).click();
  await until(async () => await reviews.locator('.review-plan-row').count() === 20, 'return to first page');
  const future = initial.next7.find(day => day.date !== initial.summary.date && day.scheduledCount > 0);
  assert.ok(future, 'fixture has future scheduled work');
  const bar = reviews.locator('.review-bar-button').filter({ hasText: String(future.scheduledCount) }).filter({ hasText: `${Number(future.date.slice(5, 7))}/${Number(future.date.slice(-2))}` });
  await bar.focus(); await page.keyboard.press('Enter');
  const filtered = await api('reviewPlan', { view: 'calendar', date: future.date, month: future.date.slice(0, 7), limit: 100 });
  await until(async () => await reviews.locator('.review-plan-row').count() === filtered.items.total, 'chart-driven date filter');
  assert.equal(await reviews.locator('.review-bar-button[aria-pressed="true"]').count(), 1);
  assert.equal(filtered.items.total, future.scheduledCount, 'future bar value agrees with list');
  await reviews.getByRole('button', { name: '下个月', exact: true }).click();
  await reviews.getByRole('button', { name: '上个月', exact: true }).click();
  pass('Bounded pagination, keyboard-operated load chart and month navigation share real query counts');

  await viewTabs.getByRole('button', { name: '全部题目', exact: true }).click();
  await reviews.getByRole('searchbox', { name: '搜索题目', exact: true }).fill('复习合成题 01');
  await until(async () => await reviews.locator('.review-plan-row').count() === 1, 'title filter');
  const check = reviews.getByRole('checkbox', { name: '选择 复习合成题 01', exact: true });
  await check.check(); await reviews.getByRole('button', { name: '暂停 1 题', exact: true }).click();
  await until(async () => (await api('problemReviewDetail', fixture.ids[0])).plan.suspended, 'UI batch suspension');
  await until(async () => !(await check.isChecked()) && await check.isEnabled(), 'batch pause finishes and clears selection');
  await check.check(); await reviews.getByRole('button', { name: '恢复 1 题', exact: true }).click();
  await until(async () => !(await api('problemReviewDetail', fixture.ids[0])).plan.suspended, 'UI batch resumption');
  await until(async () => !(await check.isChecked()) && await check.isEnabled(), 'batch resume finishes and clears selection');
  await reviews.getByRole('button', { name: '复习合成题 01', exact: true }).click();
  const details = reviews.getByRole('complementary', { name: '题目复习详情' });
  await details.getByRole('button', { name: '回忆思路', exact: true }).click();
  await details.getByRole('heading', { name: '独立回忆', exact: true }).waitFor();
  await details.getByRole('button', { name: '记录今天的复习', exact: true }).click();
  let ratingDialog = page.getByRole('dialog'); await ratingDialog.waitFor();
  await until(async () => await ratingDialog.getByRole('radio').first().isEnabled(), 'manual draft loads');
  assert.equal(await ratingDialog.getByRole('radio', { checked: true }).count(), 0);
  await ratingDialog.getByRole('radio', { name: /良好/ }).check();
  for (let index = 0; index < 12; index++) { await page.keyboard.press('Tab'); assert.equal(await ratingDialog.evaluate(element => element.contains(document.activeElement)), true, 'rating dialog traps focus'); }
  await resize(740, 620); await shot('manual-rating-740x620.png');
  await page.keyboard.press('Escape'); await ratingDialog.waitFor({ state: 'hidden' });
  assert.equal((await api('problemReviewDetail', fixture.ids[0])).events.total, 2, 'closing a draft does not create an observation');
  await details.getByRole('button', { name: '记录今天的复习', exact: true }).click();
  ratingDialog = page.getByRole('dialog'); await ratingDialog.waitFor();
  await until(async () => await ratingDialog.getByRole('radio', { name: /良好/ }).isChecked(), 'durable rating selection restores');
  await ratingDialog.getByRole('button', { name: '记录自评并安排复习', exact: true }).click();
  await ratingDialog.getByRole('heading', { name: '自评已记录', exact: true }).waitFor();
  await ratingDialog.getByRole('button', { name: '关闭自评', exact: true }).click();
  await ratingDialog.waitFor({ state: 'hidden' });
  assert.equal((await api('problemReviewDetail', fixture.ids[0])).events.total, 3);
  await until(async () => await api('reviewAssessmentDraft', `problem-review:manual:${fixture.ids[0]}`) === null, 'confirmed manual draft is cleaned with current revision');
  await resize(1440, 940); await shot('reviews-detail.png');
  await details.getByRole('button', { name: '关闭题目详情', exact: true }).click();
  await until(async () => await page.evaluate(() => document.activeElement?.textContent) === '复习合成题 01', 'detail close restores focus after its animation frame');
  pass('Explicit batch management, recall, focus trapping and SQLite rating-draft recovery work through real UI');
  await reviews.getByRole('searchbox', { name: '搜索题目', exact: true }).fill('');

  // Follow public bridge operations with real UI refresh; no injected window.algo replacement.
  const plan = (await api('problemReviewDetail', fixture.ids[0])).plan;
  const paused = await api('updateProblemReviews', { problemIds: [plan.problemId], expectedRevisions: { [plan.problemId]: plan.revision }, suspended: true });
  assert.equal(paused[0].suspended, true);
  await api('updateProblemReviews', { problemIds: [plan.problemId], suspended: false });
  const session = await api('startReviewSession', { requestId: 'desktop-review-session', problemIds: [fixture.ids[3], fixture.ids[4]] });
  assert.equal(session.currentProblemId, fixture.ids[3]);
  pass('Public atomic batch changes and persistent session use unified problem identities');

  await nav('学习中心'); await nav('复习计划');
  await page.getByRole('button', { name: /继续本轮复习/ }).click();
  await page.getByRole('region', { name: '复习会话', exact: true }).waitFor();
  await page.locator('.coding-pane .monaco-editor').waitFor();
  await until(async () => await page.getByRole('combobox', { name: '编程语言', exact: true }).isEnabled(), 'review workspace is ready');
  assert.equal(await page.getByRole('complementary', { name: '练习记录与 AI', exact: true }).count(), 0, 'answers and AI start collapsed');
  const freshWorkspace = await api('workspace', fixture.ids[3], 'python', `review:${session.id}`);
  assert.equal(freshWorkspace.draft?.code ?? freshWorkspace.problem.content.starter.python, fixture.code, 'fresh review begins at template; an untouched template need not yet be persisted');
  // Exercise Monaco's normal paste path on both native EditContext and textarea hosts.
  // Confirm input reached the model before testing the immediate language-switch save barrier.
  const reviewEditor = page.locator('.coding-pane .monaco-editor');
  await reviewEditor.locator('.view-lines').click({ position: { x: 80, y: 15 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.press('End');
  await reviewEditor.locator('[role=textbox]').evaluate(element => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', '\n# recoverable review draft');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await until(async () => (await reviewEditor.locator('.view-lines').innerText()).replaceAll('\u00a0', ' ').includes('# recoverable review draft'), 'review edit reaches the model before switching');
  await page.getByRole('combobox', { name: '编程语言', exact: true }).selectOption('java');
  await until(async () => await page.getByRole('combobox', { name: '编程语言', exact: true }).isEnabled() && await page.getByRole('combobox', { name: '编程语言', exact: true }).inputValue() === 'java', 'review language switch settles');
  assert.ok((await api('loadDraft', fixture.ids[3], 'python', `review:${session.id}`)).code.includes('# recoverable review draft'));
  await page.getByRole('combobox', { name: '编程语言', exact: true }).selectOption('python');
  await until(async () => await page.getByRole('combobox', { name: '编程语言', exact: true }).isEnabled() && await page.getByRole('combobox', { name: '编程语言', exact: true }).inputValue() === 'python', 'return to review Python');
  await page.getByRole('combobox', { name: '答题格式', exact: true }).selectOption('acm');
  await until(async () => await page.getByRole('combobox', { name: '答题格式', exact: true }).isEnabled() && await page.getByRole('combobox', { name: '答题格式', exact: true }).inputValue() === 'acm', 'review format switch settles');
  await page.getByRole('combobox', { name: '答题格式', exact: true }).selectOption('function');
  await until(async () => await page.getByRole('combobox', { name: '答题格式', exact: true }).isEnabled() && await page.getByRole('combobox', { name: '答题格式', exact: true }).inputValue() === 'function', 'return to review function format');
  await page.getByRole('button', { name: '退出并保留进度', exact: true }).click();
  await reviews.waitFor();
  const edited = await api('loadDraft', fixture.ids[3], 'python', `review:${session.id}`);
  assert.ok(edited.code.includes('# recoverable review draft'));
  assert.equal((await api('loadDraft', fixture.ids[0], 'python', 'practice')).code, fixture.ordinaryCode);
  pass('Review workbench hides references, starts from template and saves only its isolated review scope');

  // Renderer entrypoint is checked after page layout so it exercises the normal event path.
  await nav('题库'); await page.getByRole('searchbox', { name: '搜索题目', exact: true }).fill(fixture.official.title);
  await page.getByRole('table', { name: '题库' }).getByRole('button', { name: fixture.official.title, exact: true }).click();
  await page.locator('.coding-pane .monaco-editor').waitFor(); await focus();
  const workspace = await api('workspace', fixture.official.id, 'python'); assert.ok(workspace.attempt?.isActive);
  const attemptId = workspace.attempt.id;
  const submit = page.getByRole('button', { name: '提交到力扣', exact: true });
  await submit.click();
  await until(async () => (await api('officialSubmissions', attemptId)).some(record => record.status === 'completed' && record.result?.status === 'wrong_answer'), 'first failed official result');
  assert.equal((await api('reviewOpportunities', { problemId: fixture.official.id })).total, 0);
  assert.equal(await page.getByRole('dialog').count(), 0); pass('Official failures create neither a daily opportunity nor an automatic rating');
  await app.evaluate(() => { globalThis.reviewPlanSmoke.verdict = 'accepted'; });
  await submit.click();
  const dialog = page.getByRole('dialog'); await dialog.waitFor({ timeout: 20000 });
  assert.equal(await dialog.getByRole('radio', { checked: true }).count(), 0, 'no default rating');
  await shot('first-accepted-rating.png');
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  const opportunity = (await api('reviewOpportunities', { problemId: fixture.official.id })).items[0];
  assert.equal(opportunity.state, 'skipped'); assert.equal((await api('problemReviewDetail', fixture.official.id)).events.total, 0);
  pass('First trusted Accepted opens an unselected self-rating without AI credentials; Escape saves a pending assessment, not a rating');

  await submit.click();
  await until(async () => (await api('officialSubmissions', attemptId)).filter(record => record.status === 'completed' && record.result?.status === 'accepted').length === 2, 'second accepted result');
  await delay(150); assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal((await api('reviewOpportunities', { problemId: fixture.official.id })).total, 1);
  const assessed = await api('submitReviewOpportunity', { requestId: 'desktop-backfill', opportunityId: opportunity.id, rating: 3 });
  const duplicate = await api('submitReviewOpportunity', { requestId: 'desktop-backfill', opportunityId: opportunity.id, rating: 3 });
  assert.equal(duplicate.event.id, assessed.event.id); assert.ok(Date.parse(assessed.plan.dueAt) >= Date.parse(opportunity.acceptedAt) + 86400000);
  pass('Same-day repeat AC stays quiet; management backfill is idempotent and schedules at day scale');
  await page.getByRole('button', { name: '结束练习', exact: true }).click();
  await delay(100); assert.equal(await page.getByRole('dialog').count(), 0); pass('Ending an attempt does not automatically ask for a rating');
  assert.equal((await api('loadDraft', fixture.ids[0], 'python', 'practice')).code, fixture.ordinaryCode);
  await close(); await launch(); await nav('复习计划');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal((await api('reviewOpportunities', { problemId: fixture.official.id })).items[0].state, 'assessed');
  assert.equal((await api('reviewSession', session.id)).currentProblemId, fixture.ids[3]);
  assert.ok((await api('loadDraft', fixture.ids[3], 'python', `review:${session.id}`)).code.includes('# recoverable review draft'));
  pass('Restart retains session, rating and daily AC ledger, without reviving automatic prompts');

  // An operation failure must not be represented as an empty successful query.
  await nav('学习中心'); await app.evaluate(() => { globalThis.reviewPlanSmoke.failSnapshot = true; });
  await nav('复习计划');
  let restoredReviews = page.getByRole('region', { name: '复习计划', exact: true });
  await restoredReviews.getByRole('button', { name: '重试读取', exact: true }).waitFor();
  assert.equal(await restoredReviews.getByRole('heading', { name: '从第一道复习题开始', exact: true }).count(), 0);
  await app.evaluate(() => { globalThis.reviewPlanSmoke.failSnapshot = false; });
  await restoredReviews.getByRole('button', { name: '重试读取', exact: true }).click();
  await until(async () => await restoredReviews.getByRole('button', { name: '重试读取', exact: true }).count() === 0, 'failed snapshot explicitly retries');
  pass('Failed query has an explicit retry and is never shown as a successful empty plan');

  await restoredReviews.getByRole('navigation', { name: '复习视图' }).getByRole('button', { name: '全部题目', exact: true }).click();
  await restoredReviews.getByRole('searchbox', { name: '搜索题目', exact: true }).fill('复习合成题 02');
  await restoredReviews.getByRole('button', { name: '复习合成题 02', exact: true }).click();
  let faultDetail = restoredReviews.getByRole('complementary', { name: '题目复习详情' });
  await faultDetail.getByRole('button', { name: '记录今天的复习', exact: true }).click();
  let faultDialog = page.getByRole('dialog'); await faultDialog.waitFor();
  await until(async () => await faultDialog.getByRole('radio').first().isEnabled(), 'fault draft loads');
  await app.evaluate(() => { globalThis.reviewPlanSmoke.loseDraftAck = true; });
  await faultDialog.getByRole('radio', { name: /困难/ }).check();
  const faultKey = `problem-review:manual:${fixture.ids[1]}`;
  await until(async () => (await api('reviewAssessmentDraft', faultKey))?.rating === 2, 'real draft commits despite lost reply');
  const originalDraft = await api('reviewAssessmentDraft', faultKey);
  await page.keyboard.press('Escape'); await faultDialog.waitFor({ state: 'hidden' });
  await faultDetail.getByRole('button', { name: '记录今天的复习', exact: true }).click();
  faultDialog = page.getByRole('dialog'); await faultDialog.waitFor();
  await until(async () => await faultDialog.getByRole('radio', { name: /困难/ }).isChecked(), 'lost draft reply preserves original selection');
  assert.equal((await api('reviewAssessmentDraft', faultKey)).requestId, originalDraft.requestId);
  await app.evaluate(() => { globalThis.reviewPlanSmoke.loseSubmitDraftAck = true; globalThis.reviewPlanSmoke.holdRecordAck = true; });
  await faultDialog.getByRole('button', { name: '记录自评并安排复习', exact: true }).click();
  await until(async () => await app.evaluate(() => globalThis.reviewPlanSmoke.recordAckPending), 'real observation commits before delayed lost reply');
  assert.equal(await faultDialog.getByRole('button', { name: '关闭自评', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape'); assert.equal(await faultDialog.isVisible(), true, 'saving cannot close or skip');
  const committed = await api('problemReviewRequest', originalDraft.requestId); assert.ok(committed);
  assert.equal((await api('problemReviewDetail', fixture.ids[1])).events.total, 3);
  await app.evaluate(() => globalThis.reviewPlanSmoke.releaseRecordAck());
  await faultDialog.getByRole('button', { name: '核对并重试原请求', exact: true }).waitFor();
  assert.equal((await api('reviewAssessmentDraft', faultKey)).resolvedEventId, committed.event.id);
  await close(); await launch(); await nav('复习计划');
  restoredReviews = page.getByRole('region', { name: '复习计划', exact: true });
  await restoredReviews.getByRole('navigation', { name: '复习视图' }).getByRole('button', { name: '全部题目', exact: true }).click();
  await restoredReviews.getByRole('searchbox', { name: '搜索题目', exact: true }).fill('复习合成题 02');
  await restoredReviews.getByRole('button', { name: '复习合成题 02', exact: true }).click();
  faultDetail = restoredReviews.getByRole('complementary', { name: '题目复习详情' });
  await faultDetail.getByRole('button', { name: '记录今天的复习', exact: true }).click();
  faultDialog = page.getByRole('dialog');
  await faultDialog.getByRole('heading', { name: '自评已记录', exact: true }).waitFor();
  assert.equal((await api('problemReviewDetail', fixture.ids[1])).events.total, 3);
  assert.equal((await api('problemReviewRequest', originalDraft.requestId)).event.id, committed.event.id);
  await until(async () => await api('reviewAssessmentDraft', faultKey) === null, 'restarted original request cleans only its confirmed draft');
  await faultDialog.getByRole('button', { name: '关闭自评', exact: true }).click();
  pass('Lost draft/freeze/assessment replies, Escape during save and full restart recover the original request without duplicate observations');
  await close(); await launch(join(directory, 'empty-data')); await nav('复习计划');
  const emptyReviews = page.getByRole('region', { name: '复习计划', exact: true });
  await emptyReviews.getByRole('heading', { name: '还没有复习题目', exact: true }).waitFor();
  assert.equal((await api('reviewPlan', { view: 'all' })).summary.totalCount, 0);
  assert.equal(await emptyReviews.getByRole('button', { name: '开始今日复习', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('dialog').count(), 0);
  pass('Fresh isolated database has an accurate actionable empty state and does not fabricate a due date or rating');
  assert.deepEqual(report.rendererErrors, []); assert.deepEqual(report.httpAttempts, []);
  report.success = true;
} catch (error) { report.success = false; report.error = error.stack || String(error);
  if (page && !page.isClosed()) { await shot('failure.png').catch(() => {}); report.visibleFailure = await page.getByRole('dialog').innerText().catch(() => null); }
  console.error(report.error); process.exitCode = 1; }
finally { await close().catch(error => { report.cleanupError = String(error); process.exitCode = 1; });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log('Report:', join(directory, 'report.json')); }
