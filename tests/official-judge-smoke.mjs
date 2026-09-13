import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Real Electron/preload/IPC/SQLite; only network and OS secret storage are synthetic.
// No user database, credentials, clipboard, live LeetCode submission, or model call is used.
// Build first. Optional ALGOPRACTICE_PACKAGED_APP selects a built executable.
const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, 'package.json'));
const appSource = resolve(process.env.ALGOPRACTICE_APP_DIR || root), packaged = process.env.ALGOPRACTICE_PACKAGED_APP;
const runtimeDirectory = resolve(process.env.ALGOPRACTICE_RUNTIME_DIR || join(root, '.runtime'));
const directory = await mkdtemp(join(os.tmpdir(), '题炼-官方提交合成验收-'));
const dataDirectory = join(directory, 'data'), launchDirectory = join(directory, 'app'), fixturePath = join(directory, 'fixture.json');
execFileSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, join(root, 'tests/official-judge-fixture.ts'), dataDirectory, fixturePath], { cwd: root, stdio: 'pipe' });
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (!packaged) {
  await mkdir(launchDirectory);
  await cp(join(appSource, 'dist'), join(launchDirectory, 'dist'), { recursive: true });
  await cp(join(appSource, 'package.json'), join(launchDirectory, 'package.json'));
}
const env = { ...process.env, ALGOPRACTICE_DATA_DIR: dataDirectory, ALGOPRACTICE_RUNTIME_DIR: runtimeDirectory }; delete env.ELECTRON_RUN_AS_NODE;
const report = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, synthetic: true, dataDirectory,
  appSource, executable: packaged || require('electron'), assertions: [], rendererErrors: [], blockedHttp: [], transport: [], screenshots: [],
  scope: 'Real Electron renderer, preload, main official-judge service, SQLite and AI context. Source-session fetch/cookies and provider fetch/OS encryption are replaced inside this isolated test process only.',
  limitations: ['Synthetic judge fixtures are not live LeetCode validation.', 'Synthetic model responses do not establish teaching quality.', 'No actual cookie, API key, clipboard or user database is accessed.', 'HTTP guards are installed after Electron attachment; they are not an OS network sandbox.'],
};
let app, page, attemptId;
const api = (method, ...args) => page.evaluate(({ method, args }) => window.algo[method](...args), { method, args });
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const pass = (name, details = true) => { report.assertions.push({ name, details, passed: true }); console.log('PASS', name); };
const state = patch => app.evaluate((_electron, patch) => Object.assign(globalThis.officialJudgeSmoke, patch), patch);
const requests = () => app.evaluate(() => globalThis.officialJudgeSmoke.requests);
const submissions = () => api('officialSubmissions', attemptId);
async function until(check, description, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${description}`);
}
async function load() {
  app = await electron.launch({ executablePath: packaged ? resolve(packaged) : require('electron'), args: packaged ? [] : [launchDirectory], cwd: root, env, timeout: 30000 });
  const observe = window => window.on('pageerror', error => report.rendererErrors.push(error.message));
  app.context().on('page', observe); for (const window of app.context().pages()) observe(window);
  await app.context().route(/^https?:\/\//, route => { report.blockedHttp.push({ surface: 'renderer', url: route.request().url() }); return route.abort('blockedbyclient'); });
  await app.evaluate(({ session, safeStorage }) => {
    const isolated = session.fromPartition('persist:leetcode-cn');
    const test = globalThis.officialJudgeSmoke = { signedIn: false, hold: false, nextVerdict: 'accepted', failNextCheck: false,
      failNextSubmit: false, sequence: 960000000, requests: [], providerRequests: [], blockedHttp: [], results: {} };
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    // The fixture never calls the original cookies.get, avoiding even a read of real session credentials.
    isolated.cookies.get = async () => test.signedIn ? [
      { name: 'LEETCODE_SESSION', value: 'synthetic-session-never-sent', domain: '.leetcode.cn', path: '/', secure: true, httpOnly: true },
      { name: 'csrftoken', value: 'synthetic_csrf_token_for_test_only', domain: '.leetcode.cn', path: '/', secure: true, httpOnly: false },
    ] : [];
    isolated.fetch = async (input, init = {}) => {
      const url = new URL(String(input)), method = init.method || 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      test.requests.push({ url: url.href, method, body, csrfPresent: Boolean(new Headers(init.headers).get('X-CSRFToken')) });
      if (url.origin !== 'https://leetcode.cn') { test.blockedHttp.push(url.href); throw new Error('Unexpected origin in synthetic source session'); }
      if (/^\/graphql\/?$/.test(url.pathname)) return json({ data: { userStatus: { isSignedIn: test.signedIn } } });
      if (url.pathname === '/problems/two-sum/submit/' && method === 'POST') {
        if (test.failNextSubmit) { test.failNextSubmit = false; throw new Error('Synthetic connection lost after request dispatch'); }
        const id = String(++test.sequence); test.results[id] = { verdict: test.nextVerdict, checks: 0 };
        return json({ submission_id: id });
      }
      const check = /^\/submissions\/detail\/(\d+)\/check\/$/.exec(url.pathname);
      if (check && method === 'GET') {
        if (test.failNextCheck) { test.failNextCheck = false; throw new Error('Synthetic query connection failure'); }
        const result = test.results[check[1]];
        if (!result) throw new Error('Unknown synthetic submission');
        result.checks++;
        if (test.hold || result.checks === 1) return json({ state: result.checks === 1 ? 'PENDING' : 'STARTED' });
        if (result.verdict === 'wrong_answer') return json({ state: 'SUCCESS', status_code: 11, status_msg: 'Wrong Answer',
          total_correct: '2', total_testcases: '63', last_testcase: '[3,2,4]\n6', code_output: '[0,1]', expected_output: '[1,2]',
          status_runtime: 'N/A', status_memory: 'N/A' });
        return json({ state: 'SUCCESS', status_code: 10, status_msg: 'Accepted', total_correct: '63', total_testcases: '63',
          status_runtime: '4 ms', status_memory: '17.2 MB' });
      }
      test.blockedHttp.push(url.href); throw new Error('Synthetic official transport refuses an unexpected endpoint');
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url === 'https://coach-smoke.invalid/v1/chat/completions') {
        const body = JSON.parse(init.body); test.providerRequests.push(body);
        const payload = JSON.parse(body.messages.find(message => message.role === 'user').content);
        const kind = payload.kind;
        const response = { schemaVersion: 2, kind, title: '合成教练回答', explanation: '请先跟踪两个位置的值与目标和之间的关系。',
          nextSteps: ['用一个短数组逐步检查当前返回值。'], evidence: [], inferences: [], patch: null, completeSolution: null, noteDraft: null };
        return json({ model: 'synthetic-coach', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(response) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } });
      }
      if (/^https?:\/\//.test(url)) { test.blockedHttp.push(url); throw new Error('Synthetic smoke forbids outbound HTTP'); }
      return originalFetch(input, init);
    };
    // Prevent OS Keychain access. The only credential in the isolated test DB is an authored dummy value.
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.isAsyncEncryptionAvailable = async () => true;
    safeStorage.encryptString = value => Buffer.from(`synthetic:${value}`, 'utf8');
    safeStorage.decryptString = value => value.toString('utf8').replace(/^synthetic:/, '');
    safeStorage.encryptStringAsync = async value => Buffer.from(`synthetic:${value}`, 'utf8');
    safeStorage.decryptStringAsync = async value => ({ result: value.toString('utf8').replace(/^synthetic:/, ''), shouldReEncrypt: false });
    if (safeStorage.getSelectedStorageBackend) safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
  });
  page = await app.firstWindow();
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  const cdp = await app.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.equal(resolve((await api('environment')).dataDirectory), dataDirectory);
  const reminders = await api('reminderState'); await api('saveReminderSettings', { ...reminders.settings, enabled: false });
}
async function close() {
  if (!app) return;
  // Normal flow waits for backup completion. Failure cleanup must still quit a strict-mode shell,
  // where the public backup query is intentionally denied.
  await until(async () => { try { return !(await api('backups')).busy; } catch (error) { if (/严格|Target.*closed|destroyed/.test(String(error))) return true; throw error; } }, 'automatic backup completed');
  const test = await app.evaluate(() => ({ requests: globalThis.officialJudgeSmoke.requests,
    blockedHttp: globalThis.officialJudgeSmoke.blockedHttp, providerRequests: globalThis.officialJudgeSmoke.providerRequests }));
  report.transport.push(...test.requests); report.blockedHttp.push(...test.blockedHttp.map(url => ({ surface: 'main', url })));
  report.providerRequestCount = (report.providerRequestCount || 0) + test.providerRequests.length;
  const closing = app; app = null; await closing.close();
}
async function pasteCode(code) {
  const editor = page.locator('.coding-pane .monaco-editor'); await editor.waitFor();
  await editor.locator('.view-lines').click({ position: { x: 80, y: 15 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await editor.locator('[role=textbox]').evaluate((element, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, code);
  await until(async () => (await api('loadDraft', fixture.problem.id, 'python'))?.code === code, 'current code saved');
}
async function openWorkbench() {
  await nav('题库');
  await page.getByRole('table', { name: '题库' }).getByRole('button', { name: fixture.problem.title, exact: true }).click();
  await page.locator('.coding-pane .monaco-editor').waitFor();
  await pasteCode(fixture.code);
  const workspace = await api('workspace', fixture.problem.id, 'python');
  attemptId = workspace.attempt?.id;
  if (!attemptId) { const started = await api('startPractice', fixture.problem.id, 'python'); attemptId = started.attempt.id; await nav('学习中心'); await nav('练习工作台'); }
}
async function shot(name) {
  const path = join(directory, name); await page.screenshot({ path }); report.screenshots.push(path);
}

try {
  await load(); await openWorkbench();
  const submit = page.getByRole('button', { name: '提交到力扣', exact: true });
  await submit.click();
  await page.getByRole('button', { name: '登录力扣', exact: true }).waitFor();
  assert.equal((await requests()).filter(row => row.url.endsWith('/submit/')).length, 0);
  pass('Unauthenticated submit displays login action and sends zero code POSTs');

  await state({ signedIn: true, hold: true, nextVerdict: 'accepted' });
  await submit.click();
  await until(async () => (await submissions()).some(row => row.status === 'judging'), 'pending judge record persisted');
  const pending = (await submissions()).find(row => row.status === 'judging');
  const same = await api('officialSubmit', { requestId: pending.id, attemptId, code: fixture.code });
  assert.equal(same.id, pending.id);
  assert.equal((await requests()).filter(row => row.url.endsWith('/submit/')).length, 1);
  const panel = page.getByRole('region', { name: '力扣官方判题', exact: true });
  await panel.getByText('判题中', { exact: true }).waitFor();
  await state({ hold: false });
  await until(async () => (await submissions()).find(row => row.id === pending.id)?.status === 'completed', 'synthetic accepted result persisted');
  const accepted = (await submissions()).find(row => row.id === pending.id);
  assert.equal(accepted.result.status, 'accepted'); assert.equal(accepted.result.passedCases, 63); assert.equal(accepted.result.totalCases, 63);
  assert.equal(accepted.result.runtime, '4 ms'); assert.equal(accepted.result.memory, '17.2 MB');
  assert.equal(accepted.codeHash, createHash('sha256').update(fixture.code).digest('hex'));
  const firstPost = (await requests()).find(row => row.url.endsWith('/submit/'));
  assert.deepEqual(firstPost.body, { lang: 'python3', question_id: '1', typed_code: fixture.code }); assert.equal(firstPost.csrfPresent, true);
  assert.equal((await api('history', fixture.problem.id, 'python')).length, 0);
  await panel.getByText('通过', { exact: true }).first().waitFor();
  pass('Pending to Accepted passes real IPC/SQLite; duplicate request ID sends one POST; numeric-string counts are retained independently of local results');

  await state({ nextVerdict: 'wrong_answer' }); await submit.click();
  await until(async () => (await submissions()).some(row => row.result?.status === 'wrong_answer'), 'synthetic wrong answer persisted');
  const wrong = (await submissions()).find(row => row.result?.status === 'wrong_answer');
  assert.equal(wrong.result.passedCases, 2); assert.equal(wrong.result.totalCases, 63);
  assert.equal(wrong.result.input, '[3,2,4]\n6'); assert.equal(wrong.result.actualOutput, '[0,1]'); assert.equal(wrong.result.expectedOutput, '[1,2]');
  pass('Wrong-answer result preserves official failure input, expected and actual output, and exact submitted code');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await until(async () => (await api('history', fixture.problem.id, 'python')).some(row => row.result.status === 'wrong_answer'), 'actual local runtime result');
  const local = (await api('history', fixture.problem.id, 'python')).find(row => row.result.status === 'wrong_answer');
  assert.equal(local.result.caseResults.length, 2); assert.equal((await submissions()).find(row => row.id === wrong.id).result.totalCases, 63);
  pass('Actual local Python result retains two authored cases while synthetic official result retains its separate 63-case count');
  await page.getByRole('group', { name: '判题来源', exact: true }).getByRole('button', { name: '力扣官方', exact: true }).click();
  await shot('official-wrong-answer.png');
  const responsive = await app.context().newCDPSession(page);
  for (const width of [320, 820, 1440]) {
    await responsive.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const metrics = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
    assert.equal(metrics.width, width); assert.ok(metrics.documentWidth <= width && metrics.bodyWidth <= width, JSON.stringify(metrics));
  }
  pass('Official result panel fits actual 320, 820 and 1440 pixel viewports without document overflow');

  await api('saveAiProvider', { id: 'synthetic-smoke-provider', baseUrl: 'https://coach-smoke.invalid/v1', model: 'synthetic-coach',
    temperature: 0.2, maxOutputTokens: 2048, timeoutMs: 10000, jsonMode: false, includeUsage: true }, 'synthetic-smoke-key-never-sent');
  await page.getByRole('button', { name: 'AI 教练', exact: true }).click();
  const coach = page.getByRole('region', { name: 'AI 教练', exact: true });
  assert.equal(await coach.getByRole('combobox', { name: /帮助等级/ }).count(), 0);
  await coach.getByRole('textbox', { name: 'AI 提问', exact: true }).fill('');
  await coach.getByRole('button', { name: '帮我看看', exact: true }).click();
  await until(async () => (await api('aiRequests', attemptId)).some(row => row.status === 'completed'), 'empty question accepted by synthetic coach');
  const firstAi = (await api('aiRequests', attemptId)).find(row => row.status === 'completed');
  assert.equal(firstAi.snapshot.question, ''); assert.equal(Object.hasOwn(firstAi.snapshot, 'level'), false);
  assert.equal(firstAi.snapshot.official.id, wrong.id); assert.equal(firstAi.snapshot.official.status, 'wrong_answer');
  assert.equal(firstAi.snapshot.official.input, wrong.result.input); assert.equal(firstAi.snapshot.official.expectedOutput, wrong.result.expectedOutput);
  assert.equal(firstAi.snapshot.code, fixture.code); assert.match(JSON.stringify(firstAi.snapshot.messages), /Wrong Answer/);
  pass('Coach requires no help-level or user text; exact matching official failure is included in trusted AI context');
  const question = '只解释为什么我的返回下标不对，请不要给完整代码。';
  await coach.getByRole('textbox', { name: 'AI 提问', exact: true }).fill(question);
  await coach.getByRole('button', { name: '帮我看看', exact: true }).click();
  await until(async () => (await api('aiRequests', attemptId)).some(row => row.snapshot.question === question && row.status === 'completed'), 'explicit user request preserved');
  const requested = (await api('aiRequests', attemptId)).find(row => row.snapshot.question === question);
  assert.equal(JSON.parse(requested.snapshot.messages.find(message => message.role === 'user').content).userRequest, question);
  pass('Optional user instruction is preserved separately from untrusted learning material');
  await shot('adaptive-coach.png');

  // A changed code version must not inherit the previous official verdict in the coach context.
  await pasteCode(`${fixture.code}\n# edited after official submission\n`);
  const changed = await api('askAi', { requestId: 'synthetic-stale-result-check', attemptId, kind: 'hint', question: '' });
  assert.equal(changed.status, 'completed'); assert.equal(changed.snapshot.official, null);
  pass('Editing code prevents stale official verdict from becoming evidence for the new code');
  await pasteCode(fixture.code);

  await state({ nextVerdict: 'accepted', failNextCheck: true }); await submit.click();
  await until(async () => (await submissions()).some(row => row.status === 'paused'), 'interrupted check is resumable');
  const paused = (await submissions()).find(row => row.status === 'paused'), beforeResumePosts = (await requests()).filter(row => row.url.endsWith('/submit/')).length;
  await panel.getByRole('button', { name: '继续查询', exact: true }).click();
  await until(async () => (await submissions()).find(row => row.id === paused.id)?.status === 'completed', 'resume returns existing submission result');
  assert.equal((await requests()).filter(row => row.url.endsWith('/submit/')).length, beforeResumePosts);
  pass('Query failure pauses safely; continue query polls the same submission ID and never posts code again');

  // Reproduce a maintenance failure dropping progress events: the actual service pauses on logout,
  // while a test-only event interceptor models the maintenance gate's suppressed updates.
  await state({ hold: true }); await submit.click();
  await until(async () => (await submissions()).some(row => row.status === 'judging'), 'judge active before simulated maintenance');
  const duringMaintenance = (await submissions()).find(row => row.status === 'judging');
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents, original = contents.send;
    globalThis.officialJudgeSmoke.restoreEvents = () => { contents.send = original; };
    contents.send = function (channel, ...args) {
      if (channel === 'official:event' || channel === 'library:changed') return;
      return original.call(this, channel, ...args);
    };
  });
  await api('logoutSource');
  assert.equal((await submissions()).find(row => row.id === duringMaintenance.id).status, 'paused');
  await panel.getByText('判题中', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.officialJudgeSmoke.restoreEvents(); delete globalThis.officialJudgeSmoke.restoreEvents;
    BrowserWindow.getAllWindows()[0].webContents.send('app:maintenance-end');
  });
  await panel.getByRole('button', { name: '继续查询', exact: true }).waitFor();
  await state({ hold: false }); await panel.getByRole('button', { name: '继续查询', exact: true }).click();
  await until(async () => (await submissions()).find(row => row.id === duringMaintenance.id)?.status === 'completed', 'maintenance recovery refreshes paused result');
  pass('Maintenance-end reloads persisted judging state when progress events were suppressed; paused query remains recoverable');

  const saved = await submissions();
  await api('finishPractice', attemptId, fixture.code);
  const archive = await api('archive', attemptId);
  assert.equal(archive.attempt.isActive, false); assert.equal((await submissions()).length, saved.length);
  await close(); await load();
  assert.deepEqual((await submissions()).map(row => [row.id, row.status, row.codeHash]), saved.map(row => [row.id, row.status, row.codeHash]));
  pass('Official submission snapshots survive archive and actual Electron restart');
  await openWorkbench();
  await state({ signedIn: true, failNextSubmit: true });
  await page.getByRole('button', { name: '提交到力扣', exact: true }).click();
  await until(async () => (await submissions()).some(row => row.status === 'unknown'), 'ambiguous transport failure retained');
  const uncertain = (await submissions()).find(row => row.status === 'unknown');
  const postsBeforeRetry = (await requests()).filter(row => row.url.endsWith('/submit/')).length;
  const replay = await api('officialSubmit', { requestId: uncertain.id, attemptId, code: fixture.code });
  assert.equal(replay.status, 'unknown');
  assert.equal((await requests()).filter(row => row.url.endsWith('/submit/')).length, postsBeforeRetry);
  await page.getByRole('button', { name: '查看官网提交记录 ↗', exact: true }).waitFor();
  pass('Ambiguous POST outcome is shown explicitly; replaying its request ID never posts again');
  const preview = await api('previewInterview', { mode: 'strict', language: 'python', durationMinutes: 5,
    counts: { easy: 1, medium: 0, hard: 0 }, tags: ['合成验收'], company: null, datasetId: null,
    excludeRecentDays: 0, sampling: 'uniform', seed: 'synthetic-official-isolation' });
  const strict = await api('startInterview', preview.id, 'synthetic-official-isolation-start');
  await page.reload();
  await page.locator('.interview-shell').waitFor();
  for (const [method, args] of [['officialSubmissions', [attemptId]], ['officialResume', [uncertain.id]],
    ['officialSubmit', [{ requestId: 'strict-bypass-attempt', attemptId, code: fixture.code }]]]) {
    await assert.rejects(api(method, ...args), /严格/);
  }
  await api('finishInterview', strict.session.id);
  pass('Strict interview blocks all official submission, result access and query-resume IPC routes');
  await close();
  assert.deepEqual(report.rendererErrors, []); assert.deepEqual(report.blockedHttp, []);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.stack || String(error);
  if (page && !page.isClosed()) await shot('failure.png').catch(() => {});
  throw error;
} finally {
  await close().catch(error => { report.closeError = String(error); });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('REPORT', join(directory, 'report.json'));
}
