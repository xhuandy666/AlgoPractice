import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Build first. The only mutable application/profile copies live in a unique temporary directory.
// Real Electron IPC, SQLite, Python and javac execute authored demo solutions. No personal DB,
// credentials, live judge/model, runtime download, or mocked execution response is used.
const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, 'package.json'));
const runtimeDirectory = resolve(process.env.ALGOPRACTICE_RUNTIME_DIR || join(root, '.local/p2-runtime'));
const directory = await mkdtemp(join(os.tmpdir(), '题炼-ACM-执行验收-'));
const dataDirectory = join(directory, 'data'), launchDirectory = join(directory, 'app');
const reportPath = join(directory, 'report.json');
await mkdir(dataDirectory); await mkdir(launchDirectory);
await cp(join(root, 'dist'), join(launchDirectory, 'dist'), { recursive: true });
await cp(join(root, 'package.json'), join(launchDirectory, 'package.json'));
if (process.platform === 'win32') {
  await mkdir(join(launchDirectory, '.runtime-tools'));
  await cp(join(root, '.runtime-tools/windows-job-helper.exe'), join(launchDirectory, '.runtime-tools/windows-job-helper.exe'));
}
const mainPath = join(launchDirectory, 'dist/main.cjs'), originalMain = await readFile(mainPath, 'utf8');
// Install transport guards before the copied production main bundle runs, including SourceSession creation.
const bootstrap = `;(() => {
  const electron = require('electron');
  const state = globalThis.acmExecutionSmoke = { httpAttempts: [], startupErrors: [], guardedSessions: 0 };
  const urlOf = input => typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input);
  const guard = (surface, original, receiver) => (input, init) => {
    const url = urlOf(input);
    if (/^https?:\\/\\//i.test(url)) { state.httpAttempts.push({ surface, url }); return Promise.reject(new Error('ACM execution smoke forbids HTTP')); }
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
const env = { ...process.env, ALGOPRACTICE_DATA_DIR: dataDirectory, ALGOPRACTICE_RUNTIME_DIR: runtimeDirectory };
delete env.ELECTRON_RUN_AS_NODE;
const report = {
  startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, directory, dataDirectory, runtimeDirectory,
  build: { mainSha256: createHash('sha256').update(originalMain).digest('hex'), info: JSON.parse(await readFile(join(root, 'dist/build-info.json'), 'utf8')) },
  assertions: [], rendererErrors: [], httpAttempts: [], startupErrors: [], guardedSessions: [],
  scope: 'Real local execution through production Electron IPC; four independent Python/Java × function/ACM workspaces, custom stdin, comparator semantics, immutable history, stale preparation rejection, idempotency and restart persistence.',
  limitations: ['Only the current host platform is exercised.', 'HTTP guards are installed before main initialization but are not an OS network sandbox.', 'The existing verified test runtime is reused; this smoke does not download or test installation.'],
};
let app, page;
const api = (method, ...args) => page.evaluate(({ method, args }) => window.algo[method](...args), { method, args });
const pass = (name, details = true) => { report.assertions.push({ name, passed: true, details }); console.log('PASS', name); };
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function load() {
  app = await electron.launch({ executablePath: require('electron'), args: [launchDirectory], cwd: launchDirectory, env, timeout: 30000 });
  page = await app.firstWindow();
  page.on('pageerror', error => report.rendererErrors.push(error.message));
  await page.waitForFunction(() => window.algo && document.querySelector('nav[aria-label="主导航"]'), null, { timeout: 20000 });
  const environment = await api('environment');
  assert.equal(resolve(environment.dataDirectory), dataDirectory);
  for (const language of ['python', 'java']) {
    assert.equal(environment.runtimeStates[language].status, 'ready', `${language} requires the prepared test runtime at ${runtimeDirectory}`);
    assert.ok(resolve(environment.runtimeStates[language].path).startsWith(runtimeDirectory));
  }
  const guards = await app.evaluate(() => globalThis.acmExecutionSmoke);
  assert.ok(guards.guardedSessions >= 2, 'Default and official-source sessions are guarded before use');
  assert.deepEqual(guards.startupErrors, []); assert.deepEqual(guards.httpAttempts, []);
  const reminder = await api('reminderState'); await api('saveReminderSettings', { ...reminder.settings, enabled: false });
  return environment;
}
async function close() {
  if (!app) return;
  await until(async () => !(await api('backups')).busy, 'automatic backup is idle before clean shutdown');
  const observations = await app.evaluate(() => globalThis.acmExecutionSmoke);
  report.httpAttempts.push(...observations.httpAttempts); report.startupErrors.push(...observations.startupErrors); report.guardedSessions.push(observations.guardedSessions);
  const closing = app; app = null;
  const timeout = setTimeout(() => { report.cleanupError = 'Isolated Electron failed to close within 15 seconds'; process.exitCode = 1; closing.process().kill('SIGKILL'); }, 15000);
  try { await closing.close(); } finally { clearTimeout(timeout); }
}

const problemId = 'array-total', scope = 'acm-execution-smoke';
const baseTests = { version: 1, compare: 'normalized', cases: [{ stdin: '2 4 6\n', expected: '12\n' }, { stdin: '-3 3 5\n', expected: '5\n' }, { stdin: '', expected: '0\n' }] };
const programs = [
  { language: 'python', answerFormat: 'function', code: 'class Solution:\n    def arrayTotal(self, nums: list[int]) -> int:\n        return sum(nums)\n' },
  { language: 'java', answerFormat: 'function', code: 'class Solution {\n    public int arrayTotal(int[] nums) {\n        int total = 0;\n        for (int value : nums) total += value;\n        return total;\n    }\n}\n' },
  { language: 'python', answerFormat: 'acm', code: 'import sys\nprint(sum(map(int, sys.stdin.read().split())))\n' },
  { language: 'java', answerFormat: 'acm', code: 'import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner input = new Scanner(System.in);\n        int total = 0;\n        while (input.hasNextInt()) total += input.nextInt();\n        System.out.println(total);\n    }\n}\n' },
];
async function save({ language, answerFormat, code }, tests, draftScope = scope) {
  const before = await api('workspace', problemId, language, draftScope, answerFormat);
  await api('saveDraft', problemId, language, code, draftScope, { answerFormat, expectedRevision: before.draft?.revision ?? 0, ...(tests ? { testConfig: tests } : {}) });
  const saved = await api('workspace', problemId, language, draftScope, answerFormat);
  assert.equal(saved.draft.code, code); assert.equal(saved.draft.answerFormat, answerFormat);
  if (tests) assert.deepEqual(saved.draft.testConfig, tests);
  return saved;
}
async function execute(program, tests, draftScope = scope, expectedStatus = 'passed') {
  const { language, answerFormat, code } = program;
  await api('startPractice', problemId, language, draftScope, answerFormat);
  const state = await save(program, tests, draftScope);
  const before = await api('runPage', { problemId, language, limit: 100, includeQueued: true });
  const prepared = await api('prepareRun', problemId, language, code, draftScope, state.problem.version, answerFormat);
  assert.equal(prepared.runtime.status, 'ready');
  assert.equal((await api('runPage', { problemId, language, limit: 100, includeQueued: true })).total, before.total, 'Preparation does not create a code-failure/run snapshot');
  const requestId = randomUUID();
  const run = await api('run', problemId, language, code, draftScope, requestId, state.problem.version, { answerFormat, preparationToken: prepared.token });
  assert.equal(run.result.status, expectedStatus, JSON.stringify(run.result));
  assert.equal(run.id, requestId); assert.equal(run.language, language); assert.equal(run.answerFormat, answerFormat); assert.equal(run.code, code);
  assert.equal(run.problemVersion, state.problem.version); assert.equal(run.specVersion, state.spec.specVersion); assert.equal(run.attemptId, state.attempt.id);
  assert.ok(run.result.runtimeVersion.length > 0); assert.equal(run.result.executionScope, 'local-user-code-not-sandboxed');
  assert.deepEqual(await api('runDetail', run.id), run);
  const history = await api('submissionHistory', { problemId, language, answerFormat, limit: 100 });
  assert.ok(history.items.some(item => item.id === run.id && item.answerFormat === answerFormat && item.attemptId === run.attemptId));
  assert.ok(history.items.every(item => item.answerFormat === answerFormat && item.language === language));
  return { run, state };
}

try {
  const initial = await load(); assert.equal(initial.autoInstallRuntimes, false);
  pass('Fresh isolated profile starts offline, guards both sessions, and detects ready Python/Java without downloading');
  const originals = [];
  for (const program of programs) {
    const tests = program.answerFormat === 'acm' ? baseTests : undefined;
    const { run, state } = await execute(program, tests);
    assert.equal(state.problem.content.mode, 'function', 'ACM view does not overwrite the original function problem');
    assert.equal(run.result.caseResults.length, 3); assert.ok(run.result.caseResults.every(item => item.status === 'passed'));
    assert.equal(state.spec.expectedOutputSource, program.answerFormat === 'acm' ? 'user' : 'native-samples');
    originals.push({ program, run, draft: state.draft });
    pass(`${program.language}/${program.answerFormat} runs real authored code with its own draft, spec, attempt and history`, { id: run.id, attemptId: run.attemptId, runtimeVersion: run.result.runtimeVersion });
  }
  assert.equal(new Set(originals.map(item => item.run.attemptId)).size, 4);
  for (const original of originals) {
    const saved = await api('loadDraft', problemId, original.program.language, scope, original.program.answerFormat);
    assert.equal(saved.code, original.program.code); assert.equal(saved.answerFormat, original.program.answerFormat);
    if (original.program.answerFormat === 'acm') assert.deepEqual(saved.testConfig, baseTests);
  }
  pass('Four Python/Java × function/ACM drafts coexist under one problem and scope without overwriting each other');

  const echo = { language: 'python', answerFormat: 'acm', code: 'import sys\nsys.stdout.write(sys.stdin.read())\n' }, semanticsScope = 'acm-semantic-smoke';
  const absent = await execute(echo, { version: 1, compare: 'exact', cases: [{ stdin: '' }] }, semanticsScope, 'completed');
  assert.equal(Object.hasOwn(absent.run.testConfig.cases[0], 'expected'), false);
  const empty = await execute(echo, { version: 1, compare: 'exact', cases: [{ stdin: '', expected: '' }] }, semanticsScope, 'passed');
  assert.equal(Object.hasOwn(empty.run.testConfig.cases[0], 'expected'), true); assert.equal(empty.run.testConfig.cases[0].expected, '');
  pass('Missing expected output is completed-only; an explicitly empty expected output is a real passed comparison');
  const comparisonCases = [{ stdin: '  A \t\r\n\r\n', expected: '  A\n' }];
  const normalized = await execute(echo, { version: 1, compare: 'normalized', cases: comparisonCases }, semanticsScope, 'passed');
  const exact = await execute(echo, { version: 1, compare: 'exact', cases: comparisonCases }, semanticsScope, 'wrong_answer');
  assert.notEqual(normalized.run.testConfigDigest, exact.run.testConfigDigest);
  await execute(echo, { version: 1, compare: 'normalized', cases: [{ stdin: ' A\n', expected: 'A\n' }, { stdin: 'A\n\nB\n', expected: 'A\nB\n' }] }, semanticsScope, 'wrong_answer');
  pass('Normalized comparison handles CRLF, trailing horizontal whitespace/newlines but preserves leading spaces/internal blank lines; exact remains strict');

  let state = await save(echo, { version: 1, compare: 'exact', cases: [{ stdin: 'old\n', expected: 'old\n' }] }, semanticsScope);
  const stale = await api('prepareRun', problemId, 'python', echo.code, semanticsScope, state.problem.version, 'acm');
  const beforeRejected = await api('runPage', { problemId, language: 'python', includeQueued: true, limit: 100 });
  state = await save(echo, { version: 1, compare: 'exact', cases: [{ stdin: 'new\n', expected: 'new\n' }] }, semanticsScope);
  const rejectedRequest = randomUUID();
  await assert.rejects(api('run', problemId, 'python', echo.code, semanticsScope, rejectedRequest, state.problem.version, { answerFormat: 'acm', preparationToken: stale.token }), /变化|重新/);
  const afterRejected = await api('runPage', { problemId, language: 'python', includeQueued: true, limit: 100 });
  assert.equal(afterRejected.total, beforeRejected.total); assert.ok(!afterRejected.items.some(item => item.id === rejectedRequest));
  assert.deepEqual(await api('runDetail', absent.run.id), absent.run); assert.deepEqual(await api('runDetail', normalized.run.id), normalized.run);
  pass('Editing stdin without changing code invalidates the old preparation token and creates no run; prior history remains immutable');

  const prepared = await api('prepareRun', problemId, 'python', echo.code, semanticsScope, state.problem.version, 'acm');
  const requestId = randomUUID(), args = [problemId, 'python', echo.code, semanticsScope, requestId, state.problem.version, { answerFormat: 'acm', preparationToken: prepared.token }];
  const concurrent = await page.evaluate(async args => Promise.all([window.algo.run(...args), window.algo.run(...args)]), args);
  assert.equal(concurrent[0].id, requestId); assert.deepEqual(concurrent[0], concurrent[1]); assert.equal(concurrent[0].result.status, 'passed');
  assert.deepEqual(await api('run', ...args), concurrent[0]);
  const afterDuplicate = await api('runPage', { problemId, language: 'python', includeQueued: true, limit: 100 });
  assert.equal(afterDuplicate.total, afterRejected.total + 1); assert.equal(afterDuplicate.items.filter(item => item.id === requestId).length, 1);
  pass('Concurrent and completed repeats of the same request ID produce exactly one immutable run');

  await close(); await load();
  for (const original of originals) {
    const workspace = await api('workspace', problemId, original.program.language, scope, original.program.answerFormat);
    assert.equal(workspace.draft.code, original.program.code); assert.equal(workspace.attempt.id, original.run.attemptId);
    assert.ok(workspace.history.some(run => run.id === original.run.id));
    assert.deepEqual(await api('runDetail', original.run.id), original.run);
  }
  const restarted = await api('runPage', { problemId, language: 'python', includeQueued: true, limit: 100 });
  assert.equal(restarted.total, afterDuplicate.total); assert.equal(restarted.items.filter(item => item.id === requestId).length, 1);
  pass('Clean application restart restores all four formats/languages and their bound history without replaying code');
  await close();
  assert.deepEqual(report.httpAttempts, []); assert.deepEqual(report.startupErrors, []); assert.deepEqual(report.rendererErrors, []);
  assert.equal(report.cleanupError, undefined);
  pass('Application initialization, environment preparation, every real run and restart attempted zero HTTP downloads or judge requests');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error?.stack ?? String(error); process.exitCode = 1; console.error(report.error);
} finally {
  try { await close(); } catch (error) { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`ACM execution report: ${reportPath}`);
}
