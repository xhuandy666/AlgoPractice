import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Build first. Every application/profile mutation is in a unique temporary directory.
// Statements, programs, list membership and review observations are authored synthetic data.
// Real Electron/preload/IPC/SQLite and the existing local test runtime are used; no user
// profile, live provider/judge, credential, clipboard read, runtime download or peer process.
const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, 'package.json'));
const runtimeDirectory = resolve(process.env.ALGOPRACTICE_RUNTIME_DIR || join(root, '.local/p2-runtime'));
const directory = await mkdtemp(join(tmpdir(), '题炼-工作台导航合成验收-'));
const dataDirectory = join(directory, 'data'), launchDirectory = join(directory, 'app'), captureDirectory = join(directory, 'screenshots');
const reportPath = join(directory, 'report.json');
await mkdir(launchDirectory); await mkdir(captureDirectory);
const fixtureScript = `
  import { mkdirSync } from 'node:fs';
  import { join } from 'node:path';
  import { mock } from 'node:test';
  import { PracticeStore } from ${JSON.stringify(pathToFileURL(join(root, 'src/storage/practice-store.ts')).href)};
  import { HOT100 } from ${JSON.stringify(pathToFileURL(join(root, 'src/shared/builtin-lists.ts')).href)};
  const directory = process.argv[1]; mkdirSync(directory, { recursive: true });
  const now = Date.now(), code = 'class Solution:\\n    def arrayTotal(self, nums: list[int]) -> int:\\n        return sum(nums)\\n';
  const ids = Array.from({ length: 65 }, (_, i) => i === 0 ? 'nav-two-sum' : i === 1 ? 'nav-anagram-groups' : 'nav-' + String(i).padStart(3, '0'));
  const titles = ids.map((id, i) => i === 0 ? '两数之和 · 合成' : i === 1 ? '字母异位词分组 · 合成' : '导航合成题 ' + String(i + 1).padStart(2, '0'));
  const others = ['nav-other-0', 'nav-other-1', 'nav-other-2'];
  const store = new PracticeStore(join(directory, 'practice.sqlite'));
  const content = (id, title) => ({ id, title, source: 'local', difficulty: '中等', tags: ['合成导航'],
    description: '独立创作的数组求和验收题。标题仅用于合成题单排序测试，不是真实力扣题面或学习数据。',
    descriptionFormat: 'plain', constraints: ['仅用于合成验收'], mode: 'function',
    adapter: { method: 'arrayTotal', params: [{ array: 'int' }], returns: 'int' }, cases: [{ args: [[1, 2, 3]], expected: 6 }, { args: [[]], expected: 0 }],
    starter: { python: code, java: 'class Solution { public int arrayTotal(int[] nums) { int n = 0; for (int x : nums) n += x; return n; } }' } });
  try {
    store.updateLearningSettings({ timeZone: 'Asia/Shanghai', dailyReviewBudget: 3, aiAutoAnalyzeOfficial: false });
    store.upsertProblem(content('array-total', '启动合成题')); store.upsertProblem(content('nav-single', '独立入口合成题'));
    for (const [index, id] of [...ids].reverse().entries()) store.upsertProblem(content(id, titles[ids.indexOf(id)]));
    others.forEach((id, index) => store.upsertProblem(content(id, '对照题单合成题 ' + (index + 1))));
    store.applyListRefresh(store.previewListRefresh({ id: HOT100.id, title: HOT100.title, source: 'local', membershipComplete: true,
      chapters: [{ id: 'hash', title: '合成哈希章节', position: 0 }, { id: 'arrays', title: '合成数组章节', position: 1 }],
      items: ids.map((problemId, position) => ({ key: problemId, problemId, position, chapterId: position < 35 ? 'hash' : 'arrays' })) }).id);
    store.applyListRefresh(store.previewListRefresh({ id: 'nav-other-list', title: '导航对照题单', source: 'local', membershipComplete: true,
      chapters: [], items: others.map((problemId, position) => ({ key: problemId, problemId, position })) }).id);
    mock.timers.enable({ apis: ['Date'], now: now - 12 * 86400000 });
    ids.forEach((id, index) => { mock.timers.setTime(now - 12 * 86400000 + index * 60000); store.addProblemReview(id);
      store.recordProblemReview({ requestId: 'nav-initial-' + index, problemId: id, rating: 1 }); });
    mock.timers.reset();
    const ordinaryCode = code + '# ordinary review-source draft must survive\\n';
    store.saveDraft({ problemId: ids.at(-1), language: 'python', scopeId: 'practice', answerFormat: 'function', code: ordinaryCode });
    store.integrityCheck();
    console.log(JSON.stringify({ synthetic: true, ids, titles, others, hot100: HOT100, code, ordinaryCode,
      reviewOrder: store.getReviewPlanSnapshot({ view: 'all', sort: 'recent', limit: 100 }).items.items.map(row => row.problemId) }));
  } finally { store.close(); mock.timers.reset(); }
`;
const fixture = JSON.parse(execFileSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, '--input-type=module', '--eval', fixtureScript, dataDirectory], { cwd: root, encoding: 'utf8' }));
await cp(join(root, 'dist'), join(launchDirectory, 'dist'), { recursive: true });
await cp(join(root, 'package.json'), join(launchDirectory, 'package.json'));
if (process.platform === 'win32') { await mkdir(join(launchDirectory, '.runtime-tools')); await cp(join(root, '.runtime-tools/windows-job-helper.exe'), join(launchDirectory, '.runtime-tools/windows-job-helper.exe')); }
const mainPath = join(launchDirectory, 'dist/main.cjs'), originalMain = await readFile(mainPath, 'utf8');
const bootstrap = `;(() => {
  const electron = require('electron');
  const state = globalThis.workbenchNavigationSmoke = { httpAttempts: [], startupErrors: [], guardedSessions: 0, queueMutationCalls: [] };
  const urlOf = input => typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input);
  const guard = (surface, original, receiver) => (input, init) => {
    const url = urlOf(input);
    if (/^https?:\\/\\//i.test(url)) { state.httpAttempts.push({ surface, url }); return Promise.reject(new Error('Workbench navigation smoke forbids HTTP')); }
    return original.call(receiver, input, init);
  };
  globalThis.fetch = guard('main-fetch', globalThis.fetch, globalThis);
  electron.net.fetch = guard('electron-net-fetch', electron.net.fetch, electron.net);
  electron.app.on('session-created', session => {
    state.guardedSessions++;
    session.fetch = guard('session-fetch', session.fetch, session);
    session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, done) => {
      state.httpAttempts.push({ surface: 'session-request', url: details.url }); done({ cancel: true });
    });
  });
  electron.dialog.showErrorBox = (title, message) => { state.startupErrors.push({ title, message }); console.error(title, message); };
})();\n`;
await writeFile(mainPath, bootstrap + originalMain);
const env = { ...process.env, ALGOPRACTICE_DATA_DIR: dataDirectory, ALGOPRACTICE_RUNTIME_DIR: runtimeDirectory }; delete env.ELECTRON_RUN_AS_NODE;
const report = { startedAt: new Date().toISOString(), synthetic: true, platform: process.platform, arch: process.arch,
  directory, dataDirectory, runtimeDirectory, captureDirectory, build: { mainSha256: createHash('sha256').update(originalMain).digest('hex'),
    info: JSON.parse(await readFile(join(root, 'dist/build-info.json'), 'utf8')) }, assertions: [], screenshots: [], rendererErrors: [],
  httpAttempts: [], startupErrors: [], layoutMeasurements: [], limitations: ['Current host platform only.', 'Network guards cover the app transports, not an OS network sandbox.', 'A prepared local test runtime is reused; runtime installation is not tested.'] };
let app, page, cdp;
const pass = (name, details = true) => { report.assertions.push({ name, passed: true, details }); console.log('PASS', name); };
const api = (method, ...args) => page.evaluate(({ method, args }) => window.algo[method](...args), { method, args });
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const statement = () => page.getByRole('region', { name: '题目描述', exact: true });
const previous = () => statement().locator('button[aria-keyshortcuts="Alt+ArrowLeft"]');
const next = () => statement().locator('button[aria-keyshortcuts="Alt+ArrowRight"]');
const titleOf = id => fixture.titles[fixture.ids.indexOf(id)] ?? (id === 'nav-single' ? '独立入口合成题' : `对照题单合成题 ${fixture.others.indexOf(id) + 1}`);
async function until(check, description, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(80); }
  throw new Error(`Timed out: ${description}`);
}
async function atProblem(id) {
  await statement().getByRole('heading', { name: titleOf(id), exact: true }).waitFor();
  await page.locator('.coding-pane .monaco-editor [role=textbox]').waitFor();
  await until(async () => !(await next().isDisabled()) || await previous().isEnabled(), 'navigation has loaded');
}
async function resize(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [width, height]);
  await until(async () => await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}x${height} no horizontal page overflow`);
}
async function shot(name) { const path = join(captureDirectory, name); await page.screenshot({ path }); report.screenshots.push(path); }
async function measureLayout(label) {
  const geometry = await page.locator('.workbench').evaluate(element => {
    const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; };
    return { mode: element.dataset.layout, columns: getComputedStyle(element).gridTemplateColumns, box: rect(element),
      children: [...element.children].map(child => ({ className: child.className, column: getComputedStyle(child).gridColumn, row: getComputedStyle(child).gridRow, box: rect(child) })),
      separators: [...element.querySelectorAll('[role=separator]')].map(child => ({ label: child.getAttribute('aria-label'), box: rect(child) })) };
  });
  report.layoutMeasurements.push({ label, ...geometry }); return geometry;
}
async function sidebar(compact) {
  const name = compact ? '展开侧边栏' : '收起侧边栏'; await page.getByRole('button', { name, exact: true }).waitFor();
  const box = await page.locator('.sidebar').boundingBox(); assert.ok(box);
  assert.ok(compact ? box.width <= 100 : box.width >= 150, `sidebar ${compact ? 'compact' : 'expanded'} width: ${box.width}`);
  // Even when only icons are shown, the navigation remains named and reachable.
  assert.equal(await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '题库', exact: true }).count(), 1);
}
async function paste(text) {
  const editor = page.locator('.coding-pane .monaco-editor [role=textbox]'); await editor.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'); await page.keyboard.press('End');
  await editor.evaluate((element, content) => { const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', content);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })); }, text);
}
function readRows(sql, values = []) {
  const db = new DatabaseSync(join(dataDirectory, 'practice.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(...values); } finally { db.close(); }
}
function reviewProgress() {
  return { sessions: readRows('SELECT id,position,status,problem_ids_json,skipped_json,updated_at,ended_at FROM review_sessions ORDER BY id'),
    assessments: readRows('SELECT problem_id,learning_date,event_id FROM problem_review_day_assessments ORDER BY problem_id,learning_date') };
}
async function value(separator, field = 'aria-valuenow') { return Number(await separator.getAttribute(field)); }
async function drag(separator, xDelta, yDelta) {
  const box = await separator.boundingBox(); assert.ok(box && box.width > 0 && box.height > 0);
  // Avoid the explicit adjustment-options button in the middle of each divider.
  const start = box.width > box.height ? { x: box.x + Math.min(40, box.width / 4), y: box.y + box.height / 2 }
    : { x: box.x + box.width / 2, y: box.y + Math.min(60, box.height / 4) };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + xDelta, start.y + yDelta, { steps: 8 }); await page.mouse.up();
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await page.locator('html[data-workbench-resizing]').count(), 0, 'pointer gesture releases the global resize cursor');
}
async function close() {
  if (!app) return;
  await until(async () => !(await api('backups')).busy, 'isolated backup settles before clean shutdown');
  const state = await app.evaluate(() => globalThis.workbenchNavigationSmoke);
  report.httpAttempts.push(...state.httpAttempts); report.startupErrors.push(...state.startupErrors);
  report.guardedSessions = state.guardedSessions; report.queueMutationCalls = state.queueMutationCalls;
  const closing = app; app = null;
  const timeout = setTimeout(() => { report.cleanupError = 'Isolated smoke process did not exit within 15 seconds'; process.exitCode = 1; closing.process().kill('SIGKILL'); }, 15000);
  try { await closing.close(); } finally { clearTimeout(timeout); }
}

try {
  app = await electron.launch({ executablePath: require('electron'), args: [launchDirectory], cwd: launchDirectory, env, timeout: 30000 });
  page = await app.firstWindow(); page.on('pageerror', error => report.rendererErrors.push(error.message));
  await page.getByRole('navigation', { name: '主导航' }).waitFor(); await page.evaluate(() => document.fonts.ready);
  await app.context().route(/^https?:\/\//, route => { report.httpAttempts.push({ surface: 'renderer', url: route.request().url() }); return route.abort(); });
  cdp = await app.context().newCDPSession(page); await resize(1440, 940);
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].show(); BrowserWindow.getAllWindows()[0].focus(); });
  const environment = await api('environment'); assert.equal(resolve(environment.dataDirectory), dataDirectory);
  assert.equal(environment.runtimeStates.python.status, 'ready'); assert.ok(resolve(environment.runtimeStates.python.path).startsWith(runtimeDirectory));
  const reminder = await api('reminderState'); await api('saveReminderSettings', { ...reminder.settings, enabled: false });
  const guards = await app.evaluate(() => globalThis.workbenchNavigationSmoke); assert.ok(guards.guardedSessions >= 2);
  assert.deepEqual(guards.startupErrors, []); assert.deepEqual(guards.httpAttempts, []);
  // Observe actual queue mutations without replacing results or calling the refresh-on-read session API.
  await app.evaluate(({ ipcMain }) => {
    const channel = 'problem-review:advance-session', real = ipcMain._invokeHandlers.get(channel);
    if (typeof real !== 'function') throw new Error(`Missing real queue handler: ${channel}`);
    ipcMain.removeHandler(channel); ipcMain.handle(channel, async (...args) => {
      globalThis.workbenchNavigationSmoke.queueMutationCalls.push(args[1]); return await real(...args);
    });
  });
  pass('New isolated profile, copied production build and ready local test Python; HTTP guards active before main startup');

  await nav('题库'); await sidebar(false);
  const library = () => page.locator('.library-page');
  await library().getByRole('button', { name: '查看 Hot100 题单', exact: true }).click();
  await until(async () => await library().locator('.problem-table-row').count() === 30 && await library().getByRole('combobox', { name: '题库范围' }).inputValue() === fixture.hot100.id, 'Hot100 first page');
  await library().getByRole('button', { name: fixture.titles[0], exact: true }).click(); await atProblem(fixture.ids[0]); await sidebar(true);
  assert.equal(await previous().isDisabled(), true);
  assert.equal(await previous().getAttribute('aria-keyshortcuts'), 'Alt+ArrowLeft'); assert.equal(await next().getAttribute('aria-keyshortcuts'), 'Alt+ArrowRight');
  assert.match(await statement().innerText(), /1\s*\/\s*65/); assert.ok((await statement().innerText()).includes(fixture.hot100.title));
  await next().click(); await atProblem(fixture.ids[1]); assert.match(await statement().innerText(), /2\s*\/\s*65/);
  await previous().click(); await atProblem(fixture.ids[0]);
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click(); await sidebar(false);
  await next().click(); await atProblem(fixture.ids[1]); await sidebar(false);
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click(); await sidebar(true);
  await nav('题库'); await sidebar(false); await nav('练习工作台'); await sidebar(true); await atProblem(fixture.ids[1]);
  pass('Entering workbench auto-compacts a named accessible sidebar; manual expansion survives same-page neighbors and leaving restores expansion');

  await previous().click(); await atProblem(fixture.ids[0]);
  await page.locator('.coding-pane .monaco-editor [role=textbox]').focus(); await page.keyboard.press('Alt+ArrowRight'); await delay(250);
  assert.equal(await statement().getByRole('heading', { level: 2 }).innerText(), fixture.titles[0], 'Monaco Alt+ArrowRight must remain an editor gesture');
  await page.getByRole('combobox', { name: '答题格式', exact: true }).selectOption('acm');
  const input = page.getByRole('textbox', { name: '标准输入 stdin', exact: true }); await input.waitFor(); await input.fill('1 2 3');
  await input.focus(); await page.keyboard.press('Alt+ArrowRight'); await delay(250);
  assert.equal(await statement().getByRole('heading', { level: 2 }).innerText(), fixture.titles[0], 'textarea Alt+ArrowRight must not leave the problem');
  await page.getByRole('combobox', { name: '答题格式', exact: true }).selectOption('function'); await atProblem(fixture.ids[0]);
  await next().focus(); await page.keyboard.press('Alt+ArrowRight'); await atProblem(fixture.ids[1]);
  await previous().focus(); await page.keyboard.press('Alt+ArrowLeft'); await atProblem(fixture.ids[0]);
  pass('Alt+Arrow shortcuts navigate on non-editable controls but not inside Monaco or ACM input; changing answer format keeps the captured list');

  const marker = '\n# exact draft saved before neighbor navigation\n'; await paste(marker); await next().click(); await atProblem(fixture.ids[1]);
  assert.ok((await api('loadDraft', fixture.ids[0], 'python', 'practice', 'function')).code.includes(marker));
  await previous().click(); await atProblem(fixture.ids[0]);
  assert.ok((await api('workspace', fixture.ids[0], 'python', 'practice', 'function')).draft.code.includes(marker));
  const runButton = page.getByRole('button', { name: '运行', exact: true });
  const beforeRun = await measureLayout('default-before-local-run');
  assert.ok(beforeRun.separators.filter(separator => separator.label !== '调整测试结果高度').every(separator => separator.box.width <= 14), 'vertical divider tracks must remain 12px rather than consume a panel column');
  assert.equal(await runButton.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }), true, 'the divider hit area must not cover the run button');
  await runButton.click();
  await until(async () => (await api('runPage', { problemId: fixture.ids[0], language: 'python', limit: 10 })).items.some(row => row.status === 'passed'), 'real local Python run');
  await page.getByRole('button', { name: '运行', exact: true }).waitFor();
  pass('Immediate neighbor navigation saves the precise draft and returning restores it; authored fixture code passes through real local Python');

  const statementSplit = page.getByRole('separator', { name: '调整题面宽度', exact: true });
  const historySplit = page.getByRole('separator', { name: '调整记录宽度', exact: true });
  const resultsSplit = page.getByRole('separator', { name: '调整测试结果高度', exact: true });
  for (const [split, orientation] of [[statementSplit, 'vertical'], [historySplit, 'vertical'], [resultsSplit, 'horizontal']]) {
    await split.waitFor(); assert.equal(await split.getAttribute('aria-orientation'), orientation); assert.equal(await split.getAttribute('tabindex'), '0');
  }
  await resultsSplit.focus(); await page.keyboard.press('Home'); assert.equal(await value(resultsSplit), await value(resultsSplit, 'aria-valuemin'));
  const resultMin = await value(resultsSplit); await page.keyboard.press('ArrowUp'); assert.equal(await value(resultsSplit), resultMin + 24);
  await page.keyboard.press('End'); assert.equal(await value(resultsSplit), await value(resultsSplit, 'aria-valuemax'));
  const resultMax = await value(resultsSplit); await page.keyboard.press('ArrowDown'); assert.equal(await value(resultsSplit), resultMax - 24);
  await page.keyboard.press('Enter'); const beforeResult = await value(resultsSplit); await drag(resultsSplit, 0, -90);
  assert.ok(await value(resultsSplit) >= beforeResult + 70, 'dragging the results boundary up grows the test/result area');
  await statementSplit.focus(); await page.keyboard.press('Home'); const statementMin = await value(statementSplit); await page.keyboard.press('ArrowRight'); assert.equal(await value(statementSplit), statementMin + 24);
  await historySplit.focus(); await page.keyboard.press('Home'); const historyMin = await value(historySplit); await page.keyboard.press('ArrowLeft'); assert.equal(await value(historySplit), historyMin + 24);
  await page.keyboard.press('End'); assert.equal(await value(historySplit), await value(historySplit, 'aria-valuemax'));
  assert.ok((await page.locator('.history-pane').boundingBox()).width > 500, 'right panel expands well beyond the former 320px cap');
  await page.getByRole('button', { name: 'AI 教练', exact: true }).click();
  await page.locator('.ai-panel').waitFor(); assert.ok((await page.locator('.ai-panel').boundingBox()).width > 460);
  await shot('ai-panel-expanded.png');
  for (const [width, height] of [[1024, 700], [900, 680], [740, 620], [1280, 800], [1440, 940]]) {
    await resize(width, height);
    await measureLayout(`${width}x${height}`);
    for (const split of [statementSplit, historySplit, resultsSplit]) {
      if (!await split.isVisible()) continue;
      const now = await value(split), min = await value(split, 'aria-valuemin'), max = await value(split, 'aria-valuemax');
      assert.ok(now >= min && now <= max, `${width}: resized divider stays within its measured range`);
    }
    await shot(`workbench-${width}x${height}.png`);
  }
  await statementSplit.focus(); await page.keyboard.press('Enter'); await historySplit.focus(); await page.keyboard.press('Enter'); await resultsSplit.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '收起题面', exact: true }).click();
  const expandStatement = page.getByRole('button', { name: '展开题面', exact: true }); await expandStatement.focus(); await page.keyboard.press('Enter'); await statement().waitFor();
  await page.getByRole('button', { name: '收起记录', exact: true }).click();
  const expandHistory = page.getByRole('button', { name: '展开记录', exact: true }); await expandHistory.focus(); await page.keyboard.press('Enter'); await historySplit.waitFor();
  await page.getByRole('button', { name: '运行记录', exact: true }).click();
  pass('All dividers expose keyboard ranges; results pointer drag and Home/End/24px steps work, right panel exceeds 500px, resized layouts clamp and hidden panes remain keyboard-reachable');

  await nav('题库'); await library().getByRole('button', { name: '查看 Hot100 题单', exact: true }).click();
  await until(async () => await library().locator('.problem-table-row').count() === 30, 'Hot100 page reload');
  await library().getByRole('button', { name: fixture.titles[29], exact: true }).click(); await atProblem(fixture.ids[29]);
  await next().click(); await atProblem(fixture.ids[30]); assert.match(await statement().innerText(), /31\s*\/\s*65/);
  await nav('题库'); await library().getByRole('button', { name: '查看 Hot100 题单', exact: true }).click();
  await library().getByRole('combobox', { name: '章节', exact: true }).selectOption('hash');
  await library().getByRole('combobox', { name: '难度', exact: true }).selectOption('中等');
  await library().getByRole('combobox', { name: '内容状态', exact: true }).selectOption('runnable');
  await library().getByRole('searchbox', { name: '搜索题目', exact: true }).fill('合成');
  await until(async () => /35 道题目/.test(await library().innerText()) && !/正在读取/.test(await library().innerText()), 'captured chapter and active filters');
  await library().getByRole('button', { name: fixture.titles[29], exact: true }).click(); await atProblem(fixture.ids[29]);
  await next().click(); await atProblem(fixture.ids[30]); assert.match(await statement().innerText(), /31\s*\/\s*35/); assert.match(await statement().innerText(), /当前筛选/);
  await nav('题库'); await library().getByRole('combobox', { name: '题库范围', exact: true }).selectOption('nav-other-list');
  await until(async () => await library().locator('.problem-table-row').count() === 3, 'different source list');
  await library().getByRole('button', { name: '对照题单合成题 1', exact: true }).click(); await atProblem(fixture.others[0]);
  await next().click(); await atProblem(fixture.others[1]); assert.match(await statement().innerText(), /2\s*\/\s*3/); assert.match(await statement().innerText(), /导航对照题单/);
  pass('Question 30 advances across the visible page boundary; chapter/search/difficulty/capability filters produce a complete 35-item sequence, and another list has isolated neighbors');

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const command = page.getByRole('dialog'); await command.waitFor(); await command.locator('input').fill('独立入口合成题');
  await command.getByRole('button', { name: /练习 · 独立入口合成题/ }).click();
  await statement().getByRole('heading', { name: '独立入口合成题', exact: true }).waitFor();
  await until(async () => await previous().isDisabled() && await next().isDisabled(), 'single-entry source boundary');
  assert.equal((await statement().innerText()).includes('导航对照题单'), false);
  pass('Quick search explicitly uses a fresh single-item fallback rather than inheriting the previous list');

  await nav('复习计划'); const reviews = page.getByRole('region', { name: '复习计划', exact: true });
  await reviews.getByRole('navigation', { name: '复习视图' }).getByRole('button', { name: '全部题目', exact: true }).click();
  const advanced = reviews.locator('.review-advanced-filters'); if (!await advanced.evaluate(element => element.open)) await advanced.locator('summary').click();
  await reviews.getByRole('combobox', { name: '排序', exact: true }).selectOption('recent');
  await until(async () => await reviews.locator('.review-plan-row').count() === 20 && await reviews.locator('.review-row-title').first().innerText() === titleOf(fixture.reviewOrder[0]), 'actual review-recent order');
  await reviews.getByRole('button', { name: titleOf(fixture.reviewOrder[0]), exact: true }).click();
  await reviews.getByRole('complementary', { name: '题目复习详情' }).getByRole('button', { name: '开始复习这题', exact: true }).click();
  await atProblem(fixture.reviewOrder[0]); assert.match(await statement().innerText(), /复习列表/); assert.match(await statement().innerText(), /1\s*\/\s*65/);
  const beforeReview = reviewProgress(); assert.equal(beforeReview.sessions.length, 1); assert.equal(beforeReview.sessions[0].position, 0);
  assert.deepEqual(JSON.parse(beforeReview.sessions[0].problem_ids_json), [fixture.reviewOrder[0]]);
  const reviewMarker = '\n# review draft saved without ordinary overwrite or queue advance\n'; await paste(reviewMarker);
  await next().click(); await atProblem(fixture.reviewOrder[1]); assert.match(await statement().innerText(), /2\s*\/\s*65/);
  assert.deepEqual(reviewProgress(), beforeReview, 'neighbor browsing must not advance/skip/assess the active review queue');
  assert.equal((await api('loadDraft', fixture.reviewOrder[0], 'python', 'practice', 'function')).code, fixture.ordinaryCode);
  assert.ok(readRows("SELECT code FROM drafts WHERE problem_id=? AND scope_id LIKE 'review:%' AND answer_format='function'", [fixture.reviewOrder[0]]).some(row => row.code.includes(reviewMarker)));
  const advance = page.getByRole('button', { name: '已自评，下一题', exact: true });
  assert.ok(await advance.count() === 0 || await advance.isDisabled(), 'browsing outside the current queue position cannot pretend to complete it');
  await previous().click(); await atProblem(fixture.reviewOrder[0]); assert.deepEqual(reviewProgress(), beforeReview);
  assert.deepEqual(await app.evaluate(() => globalThis.workbenchNavigationSmoke.queueMutationCalls), []);
  await shot('review-list-neighbors.png');
  pass('Review navigation follows the 65-item recent-sorted review view, keeps independent drafts, preserves ordinary code and leaves SQLite session position/skip/ratings unchanged');

  assert.deepEqual(report.rendererErrors, []);
  const finalGuards = await app.evaluate(() => globalThis.workbenchNavigationSmoke); assert.deepEqual(finalGuards.httpAttempts, []); assert.deepEqual(finalGuards.startupErrors, []);
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1; }
finally {
  if (page && app) { try { await shot('final-state.png'); } catch {} }
  try { await close(); } catch (error) { report.cleanupError = String(error.stack || error); report.result = 'failed'; process.exitCode = 1; }
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, assertions: report.assertions, failure: report.failure, httpAttempts: report.httpAttempts,
    rendererErrors: report.rendererErrors, cleanupError: report.cleanupError, report: reportPath, screenshots: report.screenshots }, null, 2));
}
