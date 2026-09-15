import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Build first. Real Electron/IPC/SQLite/Markdown/Python in an isolated profile.
// Coach transport, secret storage, clipboard and explicitly marked IPC faults are isolated doubles.
// No user profile, system clipboard, live submission, or real model is accessed.
const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, 'package.json'));
const packaged = process.env.ALGOPRACTICE_PACKAGED_APP;
const runtimeDirectory = resolve(process.env.ALGOPRACTICE_RUNTIME_DIR || join(root, '.runtime'));
const directory = await mkdtemp(join(os.tmpdir(), '题炼-笔记与历史验收-'));
const dataDirectory = join(directory, 'data'), launchDirectory = join(directory, 'app'), fixturePath = join(directory, 'fixture.json');
execFileSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, join(root, 'tests/workbench-notes-history-fixture.ts'), dataDirectory, fixturePath], { cwd: root, stdio: 'pipe' });
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (!packaged) {
  await mkdir(launchDirectory);
  await cp(join(root, 'dist'), join(launchDirectory, 'dist'), { recursive: true });
  await cp(join(root, 'package.json'), join(launchDirectory, 'package.json'));
}
const env = { ...process.env, ALGOPRACTICE_DATA_DIR: dataDirectory, ALGOPRACTICE_RUNTIME_DIR: runtimeDirectory };
delete env.ELECTRON_RUN_AS_NODE;
const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, dataDirectory,
  workspaceBuild: JSON.parse(await readFile(join(root, 'dist/build-info.json'), 'utf8')),
  executable: packaged || require('electron'), assertions: [], rendererErrors: [], blockedHttp: [], screenshots: [],
  scope: 'Authored history, real note/remark SQLite, actual Python, synthetic coach context, one delayed history IPC and one rejected note save to exercise UI recovery.',
  limitations: ['No live LeetCode or model request.', 'Only the host platform and selected executable are exercised.'] };
let app, page, cdp, note, draftNote, markedRow;
const api = (method, ...args) => page.evaluate(({ method, args }) => window.algo[method](...args), { method, args });
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const pass = (name, details = true) => { report.assertions.push({ name, details, passed: true }); console.log('PASS', name); };
async function until(check, description, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${description}`);
}
async function viewport(width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const bounds = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.equal(bounds.width, width); assert.ok(bounds.document <= width && bounds.body <= width, JSON.stringify(bounds));
}
async function shot(name) { const path = join(directory, name); await page.screenshot({ path }); report.screenshots.push(path); }
async function load() {
  app = await electron.launch({ executablePath: packaged ? resolve(packaged) : require('electron'), args: packaged ? [] : [launchDirectory], cwd: root, env, timeout: 30000 });
  await app.context().route(/^https?:\/\//, route => { report.blockedHttp.push({ surface: 'renderer', url: route.request().url() }); return route.abort('blockedbyclient'); });
  await app.evaluate(({ safeStorage, clipboard }) => {
    globalThis.workbenchSmoke = { blockedHttp: [], providerRequests: [], copiedCode: [], delayNextDetail: false, detailPending: false, failNextNote: false };
    clipboard.writeText = text => { globalThis.workbenchSmoke.copiedCode.push(text); };
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url === 'https://workbench-coach.invalid/v1/chat/completions') {
        const request = JSON.parse(init.body); globalThis.workbenchSmoke.providerRequests.push(request);
        const payload = JSON.parse(request.messages.find(message => message.role === 'user').content);
        const content = { schemaVersion: 2, kind: payload.kind, title: '合成上下文验收', explanation: '请手动跟踪累加变量随循环的变化。',
          nextSteps: ['检查空数组和负数。'], evidence: [], inferences: [], patch: null, completeSolution: null, noteDraft: null };
        return new Response(JSON.stringify({ model: 'synthetic-workbench', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (/^https?:\/\//.test(url)) { globalThis.workbenchSmoke.blockedHttp.push(url); throw new Error('Workbench smoke forbids HTTP'); }
      return original(input, init);
    };
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.isAsyncEncryptionAvailable = async () => true;
    safeStorage.encryptString = value => Buffer.from(`synthetic:${value}`);
    safeStorage.decryptString = value => value.toString().replace(/^synthetic:/, '');
    safeStorage.encryptStringAsync = async value => Buffer.from(`synthetic:${value}`);
    safeStorage.decryptStringAsync = async value => ({ result: value.toString().replace(/^synthetic:/, ''), shouldReEncrypt: false });
    if (safeStorage.getSelectedStorageBackend) safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
  });
  page = await app.firstWindow();
  page.on('pageerror', error => report.rendererErrors.push(error.message));
  await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 20000 });
  await app.evaluate(({ ipcMain }) => {
    // The pinned Electron test harness keeps the real handlers and adds controlled
    // delivery faults. No fixture response replaces a persisted repository result.
    const realDetail = ipcMain._invokeHandlers.get('submission:detail');
    const realSave = ipcMain._invokeHandlers.get('note:save');
    if (typeof realDetail !== 'function' || typeof realSave !== 'function') throw new Error('Expected real IPC handlers in the isolated process');
    ipcMain.removeHandler('submission:detail');
    ipcMain.handle('submission:detail', async (...args) => {
      if (globalThis.workbenchSmoke.delayNextDetail) {
        globalThis.workbenchSmoke.delayNextDetail = false; globalThis.workbenchSmoke.detailPending = true;
        await new Promise(resolve => { globalThis.workbenchSmoke.releaseDetail = resolve; });
        globalThis.workbenchSmoke.detailPending = false; delete globalThis.workbenchSmoke.releaseDetail;
      }
      return realDetail(...args);
    });
    ipcMain.removeHandler('note:save');
    ipcMain.handle('note:save', (...args) => {
      if (globalThis.workbenchSmoke.failNextNote) { globalThis.workbenchSmoke.failNextNote = false; throw new Error('合成验收：本次保存暂时失败'); }
      return realSave(...args);
    });
  });
  cdp = await app.context().newCDPSession(page); await viewport(1440);
  assert.equal(resolve((await api('environment')).dataDirectory), dataDirectory);
  const reminders = await api('reminderState'); await api('saveReminderSettings', { ...reminders.settings, enabled: false });
}
async function close() {
  if (!app) return;
  await until(async () => !(await api('backups')).busy, 'backup finishes before quit');
  const state = await app.evaluate(() => ({ blockedHttp: globalThis.workbenchSmoke.blockedHttp, providerRequests: globalThis.workbenchSmoke.providerRequests }));
  report.blockedHttp.push(...state.blockedHttp.map(url => ({ surface: 'main-fetch', url })));
  report.syntheticCoachCalls = (report.syntheticCoachCalls || 0) + state.providerRequests.length;
  const closing = app; app = null;
  const guard = setTimeout(() => { report.cleanupError = 'Isolated Electron did not finish quitting within 15 seconds'; report.result = 'failed'; process.exitCode = 1; closing.process().kill('SIGKILL'); }, 15000);
  try { await closing.close(); } finally { clearTimeout(guard); }
}
async function openWorkbench() {
  await nav('题库');
  await page.getByRole('table', { name: '题库' }).getByRole('button', { name: fixture.problem.title, exact: true }).click();
  await page.locator('.coding-pane .monaco-editor').waitFor();
  await until(async () => (await api('loadDraft', fixture.problem.id, 'python'))?.code === fixture.code, 'fixture current draft remains selected');
  await until(async () => (await page.locator('.coding-pane > .editor-host .view-lines').innerText()).includes('return'), 'current code is painted');
}
async function currentCodeUnchanged(before) {
  assert.equal((await api('loadDraft', fixture.problem.id, 'python')).code, fixture.code);
  assert.equal(await page.locator('.coding-pane > .editor-host .view-lines').innerText(), before);
  assert.equal(await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '练习工作台', exact: true }).getAttribute('aria-current'), 'page');
}
const dialog = () => page.getByRole('dialog', { name: '记笔记', exact: true });
async function openNote() {
  await page.getByRole('button', { name: '记笔记', exact: true }).first().click();
  await dialog().waitFor();
  await dialog().getByRole('textbox', { name: 'Markdown 正文', exact: true }).waitFor();
  await until(async () => dialog().getByRole('textbox', { name: '笔记标题（可选）', exact: true }).evaluate(element => !element.disabled && element === document.activeElement), 'note loading completes and initializes focus');
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}
async function formatSelection(action, text) {
  const body = dialog().getByRole('textbox', { name: 'Markdown 正文', exact: true });
  await body.evaluate((element, selected) => { element.focus(); const start = element.value.indexOf(selected); if (start < 0) throw new Error('Selection text missing'); element.setSelectionRange(start, start + selected.length); }, text);
  await dialog().getByRole('toolbar', { name: 'Markdown 格式' }).getByRole('button', { name: action, exact: true }).click();
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}

try {
  await load(); await openWorkbench();
  assert.ok((await api('environment')).python, 'Set ALGOPRACTICE_RUNTIME_DIR to a prepared Python runtime');
  const editorBefore = await page.locator('.coding-pane > .editor-host .view-lines').innerText();
  const initialHistory = await api('submissionHistory', { problemId: fixture.problem.id, language: 'python', offset: 0, limit: 20 });
  assert.equal(initialHistory.total, 48); assert.equal(initialHistory.items.length, 20);
  const secondHistory = await api('submissionHistory', { problemId: fixture.problem.id, language: 'python', offset: 20, limit: 20 });
  const lastHistory = await api('submissionHistory', { problemId: fixture.problem.id, language: 'python', offset: 40, limit: 20 });
  const all = [...initialHistory.items, ...secondHistory.items, ...lastHistory.items];
  assert.equal(new Set(all.map(row => `${row.source}:${row.id}`)).size, 48);
  assert.equal(new Set(all.map(row => row.attemptId)).size, 2);
  assert.deepEqual([...new Set(all.map(row => row.source))].sort(), ['local', 'official']);
  pass('History pagination returns all 48 local and official snapshots across two prior practices');

  await openNote();
  assert.equal(await dialog().getByRole('textbox', { name: '笔记标题（可选）', exact: true }).inputValue(), '');
  assert.ok((await dialog().innerText()).includes(fixture.problem.title));
  assert.equal(await dialog().getByRole('combobox').count(), 0, 'Current problem binding does not require a picker');
  const body = dialog().getByRole('textbox', { name: 'Markdown 正文', exact: true });
  await body.fill('循环不变量\n\n每步累加，保持总和。');
  await formatSelection('二级标题', '循环不变量');
  await formatSelection('加粗', '每步累加');
  await formatSelection('斜体', '保持总和');
  const markdown = await body.inputValue();
  assert.match(markdown, /## 循环不变量/); assert.match(markdown, /\*\*每步累加\*\*/); assert.match(markdown, /\*保持总和\*/);
  await dialog().getByRole('button', { name: '预览', exact: true }).click();
  await dialog().getByRole('heading', { name: '循环不变量', level: 2 }).waitFor();
  assert.equal(await dialog().locator('strong').filter({ hasText: '每步累加' }).count(), 1);
  assert.equal(await dialog().locator('em').filter({ hasText: '保持总和' }).count(), 1);
  await dialog().getByRole('button', { name: '编辑', exact: true }).click();
  for (const width of [320, 820, 1440]) {
    await viewport(width);
    const bounds = await dialog().boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
  }
  await dialog().getByRole('textbox', { name: '笔记标题（可选）', exact: true }).focus();
  for (let index = 0; index < 24; index++) {
    await page.keyboard.press('Tab'); assert.equal(await dialog().evaluate(element => element.contains(document.activeElement)), true, 'Focus stays inside the note dialog');
  }
  await shot('note-dialog.png');
  await dialog().getByRole('button', { name: '保存笔记', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  note = (await api('notes', { subjectId: fixture.problem.id })).find(item => item.current.markdown === markdown);
  assert.ok(note); assert.equal(note.subjectId, fixture.problem.id); assert.equal(note.kind, 'problem'); assert.ok(note.current.title.trim());
  assert.equal(note.current.state, 'confirmed');
  await currentCodeUnchanged(editorBefore);
  pass('In-place note binds the current problem, formats selected Markdown, previews, saves with an automatic title, and leaves code/route unchanged', { title: note.current.title });
  pass('Note dialog fits 320/820/1440 pixels and traps keyboard focus');

  await openNote();
  await dialog().getByText('本题笔记', { exact: false }).first().click();
  await dialog().getByRole('combobox', { name: '本题笔记', exact: true }).selectOption(note.id);
  await until(async () => (await dialog().getByRole('textbox', { name: 'Markdown 正文', exact: true }).inputValue()) === markdown, 'saved note content loads');
  assert.equal(await dialog().getByRole('textbox', { name: 'Markdown 正文', exact: true }).inputValue(), markdown);
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
  await currentCodeUnchanged(editorBefore);
  pass('Saved note reopens inside the same workbench; Escape closes safely');

  await openNote();
  const unfinished = '稍后继续：为什么空数组的初始和是零？';
  await dialog().getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill(unfinished);
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
  draftNote = (await api('notes', { subjectId: fixture.problem.id })).find(item => item.current.markdown === unfinished);
  assert.ok(draftNote); assert.equal(draftNote.current.state, 'draft');
  await openNote();
  await until(async () => (await dialog().getByRole('textbox', { name: 'Markdown 正文', exact: true }).inputValue()) === unfinished, 'unfinished draft automatically resumes');
  await app.evaluate(() => { globalThis.workbenchSmoke.failNextNote = true; });
  const recoverable = `${unfinished}\n\n保存失败也不能丢失这段内容。`;
  await dialog().getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill(recoverable);
  await dialog().getByRole('button', { name: '保存笔记', exact: true }).click();
  await dialog().getByRole('button', { name: '重试保存', exact: true }).waitFor();
  assert.equal(await dialog().isVisible(), true);
  assert.equal(await dialog().getByRole('textbox', { name: 'Markdown 正文', exact: true }).inputValue(), recoverable);
  await dialog().getByRole('button', { name: '重试保存', exact: true }).click();
  await until(async () => (await api('note', draftNote.id)).current.markdown === recoverable, 'failed note save retries without losing content');
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
  draftNote = await api('note', draftNote.id);
  if (await page.locator('.error-banner').count()) await page.locator('.error-banner').getByRole('button', { name: '收起', exact: true }).click();
  pass('Closing immediately after typing saves the unfinished draft and the next opening resumes it automatically');
  pass('A deliberately rejected note save keeps the dialog and content; retry writes the same draft successfully');

  // UI contracts are intentionally accessible names, not screen coordinates.
  const history = page.getByRole('region', { name: '提交历史', exact: true });
  await history.waitFor();
  for (const source of ['local', 'official']) {
    const row = initialHistory.items.find(item => item.source === source);
    await history.locator(`[data-submission-id="${row.id}"]`).click();
    const comparison = page.getByRole('region', { name: '历史代码', exact: true });
    await comparison.waitFor();
    const expectedCode = fixture.rows.find(item => item.id === row.id).code;
    assert.equal((await api('submissionHistoryDetail', row.source, row.id)).code, expectedCode);
    await comparison.getByRole('textbox', { name: '历史提交代码', exact: false }).waitFor();
    const visibleCode = await comparison.locator('.view-lines').innerText();
    assert.ok(visibleCode.replace(/\s/g, '').includes('defarrayTotal(self,nums:list[int])->int:'));
    await comparison.locator('.monaco-editor').hover(); await page.mouse.wheel(0, 800);
    await until(async () => (await comparison.locator('.view-lines').innerText()).replace(/\s/g, '').includes(expectedCode.split('\n').find(line => line.startsWith('# archived')).replace(/\s/g, '')), 'last historical code line is rendered');
    const historicalBefore = await comparison.locator('.view-lines').innerText();
    await comparison.getByRole('textbox', { name: '历史提交代码', exact: false }).focus();
    await page.keyboard.type('cannot-change-history');
    assert.equal(await comparison.locator('.view-lines').innerText(), historicalBefore, 'Historical editor is read only');
    await comparison.getByRole('button', { name: '复制代码', exact: true }).click();
    assert.equal(await app.evaluate(() => globalThis.workbenchSmoke.copiedCode.at(-1)), expectedCode, 'Copy uses the exact historical snapshot without changing the system clipboard during this test');
    assert.equal(await page.locator('.coding-pane .case-detail').count(), 0);
    await currentCodeUnchanged(editorBefore);
    markedRow = row;
  }
  pass('Selecting local and official history shows the immutable code below the live editor and hides case details without replacing the current answer');
  await history.getByRole('button', { name: '下一页', exact: true }).click();
  await until(async () => await history.locator(`[data-submission-id="${secondHistory.items[0].id}"]`).count() === 1, 'next history page renders');
  await history.getByRole('button', { name: '上一页', exact: true }).click();
  await history.locator(`[data-submission-id="${markedRow.id}"]`).click();
  const comparison = page.getByRole('region', { name: '历史代码', exact: true });
  const remark = comparison.getByRole('textbox', { name: '提交备注', exact: true });
  await remark.fill('单次遍历 · 累加变量'); await remark.press('Enter');
  await until(async () => (await api('submissionHistoryDetail', markedRow.source, markedRow.id)).remark === '单次遍历 · 累加变量', 'remark saved');
  const savedRemark = await api('submissionHistoryDetail', markedRow.source, markedRow.id);
  await api('saveSubmissionRemark', { source: markedRow.source, id: markedRow.id, remark: '来自另一个编辑窗口', expectedRevision: savedRemark.remarkRevision });
  await remark.fill('发生冲突也保留我刚写的备注'); await remark.press('Enter');
  await comparison.getByRole('button', { name: '重试保存备注', exact: true }).waitFor();
  assert.equal(await remark.inputValue(), '发生冲突也保留我刚写的备注');
  await comparison.getByRole('button', { name: '重试保存备注', exact: true }).click();
  await until(async () => (await api('submissionHistoryDetail', markedRow.source, markedRow.id)).remark === '发生冲突也保留我刚写的备注', 'explicit conflict retry uses refreshed revision');
  await remark.fill(''); await remark.press('Enter');
  await until(async () => (await api('submissionHistoryDetail', markedRow.source, markedRow.id)).remark === '', 'remark cleared');
  await remark.fill('单次遍历 · 可对照复习'); await remark.press('Enter');
  await until(async () => (await api('submissionHistoryDetail', markedRow.source, markedRow.id)).remark === '单次遍历 · 可对照复习', 'final remark saved');
  await currentCodeUnchanged(editorBefore);
  pass('History navigation pages correctly; one-line remarks save and clear, and a real revision conflict retains the unsaved edit');
  const differentRow = initialHistory.items.find(row => row.id !== markedRow.id);
  await app.evaluate(() => { globalThis.workbenchSmoke.delayNextDetail = true; });
  await history.locator(`[data-submission-id="${differentRow.id}"]`).click();
  await until(async () => app.evaluate(() => globalThis.workbenchSmoke.detailPending), 'history detail request held in flight');
  assert.equal(await remark.isDisabled(), true, 'Current remark cannot change between flush and detail replacement');
  await app.evaluate(() => { globalThis.workbenchSmoke.releaseDetail(); });
  await until(async () => await history.locator(`[data-submission-id="${differentRow.id}"]`).getAttribute('aria-pressed') === 'true', 'delayed history selection finishes');
  await history.locator(`[data-submission-id="${markedRow.id}"]`).click();
  await until(async () => (await remark.inputValue()) === '单次遍历 · 可对照复习', 'marked record selected again');
  await remark.fill('切换语言前也会保存');
  await page.getByRole('combobox', { name: '编程语言', exact: true }).selectOption('java');
  await until(async () => (await api('submissionHistoryDetail', markedRow.source, markedRow.id)).remark === '切换语言前也会保存', 'language switch flushes old remark');
  await page.getByRole('combobox', { name: '编程语言', exact: true }).selectOption('python');
  await history.locator(`[data-submission-id="${markedRow.id}"]`).click();
  await remark.fill('单次遍历 · 可对照复习'); await remark.press('Enter');
  await until(async () => (await api('submissionHistoryDetail', markedRow.source, markedRow.id)).remark === '单次遍历 · 可对照复习', 'remark restored after language switch');
  pass('In-flight history loading disables old edits, and switching language flushes a just-typed remark');
  for (const width of [320, 820, 1440]) await viewport(width);
  await shot('historical-code.png');
  pass('History comparison fits actual 320/820/1440 viewports');

  await api('saveAiProvider', { id: 'workbench-synthetic', baseUrl: 'https://workbench-coach.invalid/v1', model: 'synthetic-workbench',
    temperature: 0.2, maxOutputTokens: 2048, timeoutMs: 10000, jsonMode: false, includeUsage: true }, 'authored-test-only-key');
  await page.getByRole('button', { name: 'AI 教练', exact: true }).click();
  await page.getByRole('region', { name: 'AI 教练' }).getByRole('button', { name: '帮我看看', exact: true }).click();
  await until(async () => (await api('aiRequests', fixture.active.id)).some(record => record.status === 'completed'), 'synthetic coach completes');
  const answer = (await api('aiRequests', fixture.active.id)).find(record => record.status === 'completed');
  assert.equal(answer.snapshot.code, fixture.code); assert.equal(answer.snapshot.run, null); assert.equal(answer.snapshot.official ?? null, null); assert.equal(answer.snapshot.previousRun ?? null, null);
  pass('Viewing another practice code does not inject it or its verdict into the current AI context');

  await page.getByRole('button', { name: '运行', exact: true }).click();
  await until(async () => (await api('history', fixture.problem.id, 'python')).some(run => run.attemptId === fixture.active.id && run.result.status === 'passed'), 'real Python run succeeds', 60000);
  await page.locator('.result-summary strong').filter({ hasText: '通过' }).waitFor();
  assert.equal(await page.getByRole('region', { name: '历史代码', exact: true }).count(), 0);
  assert.equal(await page.locator('.coding-pane .case-detail').count(), 3);
  await currentCodeUnchanged(editorBefore);
  pass('A new real Python run exits historical comparison and shows its three actual case results');
  await close(); await load(); await openWorkbench();
  assert.deepEqual(await api('note', note.id), note);
  assert.deepEqual(await api('note', draftNote.id), draftNote);
  assert.equal((await api('submissionHistoryDetail', markedRow.source, markedRow.id)).remark, '单次遍历 · 可对照复习');
  assert.equal((await api('loadDraft', fixture.problem.id, 'python')).code, fixture.code);
  pass('A full application restart preserves the confirmed note, history remark and current answer');
  await nav('练习档案');
  await api('deleteArchive', fixture.rows[0].attemptId);
  await nav('练习工作台');
  await until(async () => (await page.getByRole('region', { name: '提交历史', exact: true }).innerText()).includes('25 次'), 'history refreshes after a prior practice is deleted');
  assert.equal((await api('submissionHistory', { problemId: fixture.problem.id, language: 'python' })).total, 25);
  pass('Deleting a prior practice refreshes workbench history without leaving deleted code selected');
  await close();
  assert.deepEqual(report.rendererErrors, []); assert.deepEqual(report.blockedHttp, []);
  pass('No renderer exception or unexpected HTTP request occurred');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = String(error.stack || error); process.exitCode = 1; console.error(error);
  if (page && !page.isClosed()) report.failureUi = await page.locator('body').innerText().catch(() => 'unavailable');
  if (page && !page.isClosed()) await shot('failure.png').catch(() => {});
} finally {
  if (app) try { await close(); } catch (error) { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; app?.process().kill(); }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Workbench notes/history report:', join(directory, 'report.json'));
}
