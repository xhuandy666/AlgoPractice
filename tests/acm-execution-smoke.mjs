import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Build first. The only mutable application/profile copies live in a unique temporary directory.
// Real Electron IPC, SQLite and four prepared toolchains execute authored demo solutions. No personal DB,
// credentials, live judge/model, runtime download, or mocked execution response is used.
const root = resolve(import.meta.dirname, '..'), require = createRequire(join(root, 'package.json'));
const runtimeDirectory = resolve(process.env.ALGOPRACTICE_RUNTIME_DIR || join(root, '.local/go-cpp-development-runtime'));
const languages = ['python', 'java', 'go', 'cpp'];
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
  assertions: [], rendererErrors: [], httpAttempts: [], startupErrors: [], guardedSessions: [], interviews: [],
  scope: 'Real local execution through production Electron IPC; eight independent Python/Java/Go/C++ × function/ACM baseline workspaces, eight strict/coached interviews on a separate authored JSON problem, custom stdin, comparator semantics, immutable history, stale preparation rejection, idempotency, stop/recovery, isolated archived-code supplementation and restart persistence.',
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
  for (const language of languages) {
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
  { language: 'go', answerFormat: 'function', code: 'func arrayTotal(nums []int) int {\n    total := 0\n    for _, value := range nums {\n        total += value\n    }\n    return total\n}\n' },
  { language: 'cpp', answerFormat: 'function', code: '#include <vector>\nclass Solution {\npublic:\n    int arrayTotal(std::vector<int>& nums) {\n        int total = 0;\n        for (int value : nums) total += value;\n        return total;\n    }\n};\n' },
  { language: 'python', answerFormat: 'acm', code: 'import sys\nprint(sum(map(int, sys.stdin.read().split())))\n' },
  { language: 'java', answerFormat: 'acm', code: 'import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner input = new Scanner(System.in);\n        int total = 0;\n        while (input.hasNextInt()) total += input.nextInt();\n        System.out.println(total);\n    }\n}\n' },
  { language: 'go', answerFormat: 'acm', code: 'package main\n\nimport (\n    "bufio"\n    "fmt"\n    "os"\n)\n\nfunc main() {\n    input := bufio.NewReader(os.Stdin)\n    total := 0\n    for {\n        var value int\n        if _, err := fmt.Fscan(input, &value); err != nil {\n            break\n        }\n        total += value\n    }\n    fmt.Println(total)\n}\n' },
  { language: 'cpp', answerFormat: 'acm', code: '#include <iostream>\n\nint main() {\n    int total = 0, value;\n    while (std::cin >> value) total += value;\n    std::cout << total << "\\n";\n    return 0;\n}\n' },
];
assert.equal(programs.length, 8);
assert.equal(new Set(programs.map(program => `${program.language}:${program.answerFormat}`)).size, 8);
for (const language of languages) assert.deepEqual(programs.filter(program => program.language === language).map(program => program.answerFormat), ['function', 'acm']);
const foreverPrograms = {
  python: 'while True:\n    pass\n',
  java: 'public class Main {\n    private static volatile int counter;\n    public static void main(String[] args) {\n        while (true) counter++;\n    }\n}\n',
  go: 'package main\n\nfunc main() {\n    for {}\n}\n',
  cpp: 'int main() {\n    volatile unsigned long long counter = 0;\n    for (;;) ++counter;\n}\n',
};
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
  pass('Fresh isolated profile starts offline, guards both sessions, and detects ready Python/Java/Go/C++ without downloading');
  const originals = [], stoppedRuns = [], supplementalRuns = [];
  for (const program of programs) {
    const tests = program.answerFormat === 'acm' ? baseTests : undefined;
    const { run, state } = await execute(program, tests);
    assert.equal(state.problem.content.mode, 'function', 'ACM view does not overwrite the original function problem');
    assert.equal(run.result.caseResults.length, 3); assert.ok(run.result.caseResults.every(item => item.status === 'passed'));
    assert.equal(state.spec.expectedOutputSource, program.answerFormat === 'acm' ? 'user' : 'native-samples');
    await assert.rejects(api('saveDraft', problemId, program.language, `${program.code}\n`, scope,
      { answerFormat: program.answerFormat, expectedRevision: state.draft.revision - 1, ...(tests ? { testConfig: tests } : {}) }), /revision|版本/i);
    assert.deepEqual(await api('loadDraft', problemId, program.language, scope, program.answerFormat), state.draft, 'Stale CAS does not overwrite an acknowledged draft');
    originals.push({ program, run, draft: state.draft });
    pass(`${program.language}/${program.answerFormat} runs real authored code with its own draft, spec, attempt and history`, { id: run.id, attemptId: run.attemptId, runtimeVersion: run.result.runtimeVersion });
  }
  assert.equal(new Set(originals.map(item => item.run.attemptId)).size, 8);
  for (const original of originals) {
    const saved = await api('loadDraft', problemId, original.program.language, scope, original.program.answerFormat);
    assert.equal(saved.code, original.program.code); assert.equal(saved.answerFormat, original.program.answerFormat);
    if (original.program.answerFormat === 'acm') assert.deepEqual(saved.testConfig, baseTests);
  }
  pass('Eight Python/Java/Go/C++ × function/ACM drafts coexist under one problem and scope; stale CAS cannot overwrite any of them');

  // Stop only after the production event confirms the execution phase. Compilation and
  // environment inspection are not evidence that an infinite user program was stopped.
  for (const language of languages) {
    const stopScope = `acm-stop-${language}`, program = { language, answerFormat: 'acm', code: foreverPrograms[language] },
      tests = { version: 1, compare: 'exact', cases: [{ stdin: '' }] };
    await api('startPractice', problemId, language, stopScope, 'acm');
    const state = await save(program, tests, stopScope);
    const prepared = await api('prepareRun', problemId, language, program.code, stopScope, state.problem.version, 'acm');
    assert.equal(prepared.runtime.status, 'ready');
    const id = randomUUID(), args = [problemId, language, program.code, stopScope, id, state.problem.version, { answerFormat: 'acm', preparationToken: prepared.token }];
    await page.evaluate(args => {
      window.acmSmokeRunEvents = []; window.acmSmokeStoppedRun = null; window.acmSmokeStopError = null;
      window.acmSmokeUnsubscribe = window.algo.onRunEvent(event => window.acmSmokeRunEvents.push(event));
      window.algo.run(...args).then(run => { window.acmSmokeStoppedRun = run; }, error => { window.acmSmokeStopError = String(error); });
    }, args);
    try {
      await until(() => page.evaluate(id => window.acmSmokeRunEvents.some(event => event.runId === id && event.phase === 'run'), id), `${language} entered user execution before cancellation`);
      await api('cancel');
      await until(() => page.evaluate(() => Boolean(window.acmSmokeStoppedRun || window.acmSmokeStopError)), `${language} stop reached a persisted terminal result`);
      const result = await page.evaluate(() => ({ run: window.acmSmokeStoppedRun, error: window.acmSmokeStopError, events: window.acmSmokeRunEvents }));
      assert.equal(result.error, null); assert.equal(result.run.id, id); assert.equal(result.run.language, language); assert.equal(result.run.answerFormat, 'acm');
      assert.equal(result.run.result.status, 'cancelled', JSON.stringify(result.run.result));
      assert.equal(result.run.code, program.code); assert.deepEqual(await api('runDetail', id), result.run);
      assert.ok(result.events.some(event => event.runId === id && event.phase === 'finished' && event.status === 'cancelled'));
      stoppedRuns.push(result.run);
      pass(`${language}/ACM stop cancels actual user execution and preserves the cancelled code snapshot`, { id, status: result.run.result.status });
    } finally {
      await page.evaluate(() => { window.acmSmokeUnsubscribe?.(); window.acmSmokeUnsubscribe = null; });
    }
    const authored = programs.find(item => item.language === language && item.answerFormat === 'acm');
    const recovery = await execute(authored, baseTests, stopScope);
    assert.notEqual(recovery.run.id, id); assert.equal(recovery.run.result.caseResults.length, 3);
    assert.deepEqual(await api('runDetail', id), stoppedRuns.at(-1), 'A successful new run does not overwrite the cancelled one');
    pass(`${language}/ACM can run new authored code after cancellation without inheriting an old process or result`, { id: recovery.run.id });
  }

  // Frozen archive code is supplemented through a fresh restored scope, never by
  // changing the ended attempt, its final tests, the normal draft or a prior verdict.
  for (const language of languages) {
    const program = programs.find(item => item.language === language && item.answerFormat === 'acm');
    const frozen = await execute(program, baseTests, `acm-archive-${language}`);
    const ended = await api('finishPractice', frozen.run.attemptId, program.code);
    assert.equal(ended.isActive, false); assert.equal(ended.finalCode, program.code); assert.equal(ended.lastRunMatchesFinal, true);
    assert.deepEqual(ended.finalTestConfig, baseTests);
    const restored = await api('restoreRun', frozen.run.id, randomUUID());
    assert.notEqual(restored.attempt.id, frozen.run.attemptId); assert.equal(restored.attempt.language, language); assert.equal(restored.attempt.answerFormat, 'acm');
    assert.equal(restored.attempt.problemVersion, frozen.run.problemVersion); assert.equal(restored.attempt.restoredFromRunId, frozen.run.id);
    assert.equal(restored.draft.code, program.code); assert.deepEqual(restored.draft.testConfig, baseTests);
    assert.equal(restored.draft.scopeId, restored.attempt.draftScopeId); assert.notEqual(restored.draft.scopeId, scope);
    const supplemented = await execute(program, baseTests, restored.draft.scopeId);
    assert.equal(supplemented.run.attemptId, restored.attempt.id); assert.notEqual(supplemented.run.id, frozen.run.id);
    assert.deepEqual(await api('runDetail', frozen.run.id), frozen.run);
    assert.deepEqual((await api('archiveOverview', ended.id)).attempt, ended);
    assert.equal((await api('loadDraft', problemId, language, scope, 'acm')).code, program.code);
    supplementalRuns.push({ original: frozen.run, ended, supplemented: supplemented.run, scopeId: restored.draft.scopeId });
    pass(`${language}/ACM archived code and stdin restore into an isolated scope for real supplementation while the frozen archive stays unchanged`,
      { originalId: frozen.run.id, supplementedId: supplemented.run.id, restoredAttemptId: restored.attempt.id });
  }

  // Echo bytes unchanged: Python text streams translate newlines on Windows,
  // which would test the fixture's conversion instead of the runner's comparison.
  const echo = { language: 'python', answerFormat: 'acm', code: 'import sys\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n' }, semanticsScope = 'acm-semantic-smoke';
  const absent = await execute(echo, { version: 1, compare: 'exact', cases: [{ stdin: '' }] }, semanticsScope, 'completed');
  assert.equal(Object.hasOwn(absent.run.testConfig.cases[0], 'expected'), false);
  const empty = await execute(echo, { version: 1, compare: 'exact', cases: [{ stdin: '', expected: '' }] }, semanticsScope, 'passed');
  assert.equal(Object.hasOwn(empty.run.testConfig.cases[0], 'expected'), true); assert.equal(empty.run.testConfig.cases[0].expected, '');
  pass('Missing expected output is completed-only; an explicitly empty expected output is a real passed comparison');
  const comparisonCases = [{ stdin: '  A \t\r\n\r\n', expected: '  A\n' }];
  const normalized = await execute(echo, { version: 1, compare: 'normalized', cases: comparisonCases }, semanticsScope, 'passed');
  const exact = await execute(echo, { version: 1, compare: 'exact', cases: comparisonCases }, semanticsScope, 'wrong_answer');
  for (const { run } of [normalized, exact]) {
    assert.equal(run.result.stdout, comparisonCases[0].stdin, JSON.stringify(run.result));
    assert.equal(run.result.caseResults[0].actual, comparisonCases[0].stdin, JSON.stringify(run.result));
  }
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
  assert.equal(concurrent[0].id, requestId); assert.deepEqual(concurrent[0], concurrent[1]); assert.equal(concurrent[0].result.status, 'passed', JSON.stringify(concurrent[0].result));
  assert.equal(concurrent[0].result.stdout, 'new\n', JSON.stringify(concurrent[0].result));
  assert.equal(concurrent[0].result.caseResults[0].actual, 'new\n', JSON.stringify(concurrent[0].result));
  assert.deepEqual(await api('run', ...args), concurrent[0]);
  const afterDuplicate = await api('runPage', { problemId, language: 'python', includeQueued: true, limit: 100 });
  assert.equal(afterDuplicate.total, afterRejected.total + 1); assert.equal(afterDuplicate.items.filter(item => item.id === requestId).length, 1);
  pass('Concurrent and completed repeats of the same request ID produce exactly one immutable run');

  // Import a uniquely tagged authored problem. Do not refresh or change the demo heads:
  // their eight baseline drafts and immutable snapshots remain independent of interviews.
  const interviewTag = `acm-interview-smoke-${randomUUID()}`, interviewProblemId = `file:${interviewTag}`;
  const interviewProblem = {
    id: interviewProblemId, title: '独立面试验收：数组求和', difficulty: '简单', tags: [interviewTag],
    description: '独立编写的验收题：返回数组元素之和；空数组返回 0。', descriptionFormat: 'plain',
    constraints: ['数组长度不超过 1000，元素绝对值不超过 10000。'], mode: 'function',
    adapter: { method: 'arrayTotal', params: [{ array: 'int' }], returns: 'int' },
    cases: [{ args: [[2, 4, 6]], expected: 12 }, { args: [[]], expected: 0 }, { args: [[-3, 3, 5]], expected: 5 }],
    starter: Object.fromEntries(programs.filter(program => program.answerFormat === 'function').map(program => [program.language, program.code])),
  };
  const imported = await api('previewImport', { kind: 'json', name: interviewTag,
    text: JSON.stringify({ schemaVersion: 1, title: interviewTag, problems: [interviewProblem] }) });
  assert.deepEqual(imported.preview.errors, []); assert.equal(imported.preview.items.length, 1);
  const job = await api('startImport', imported.id, randomUUID());
  await until(async () => {
    const current = await api('importJob', job.id);
    if (current.status === 'completed_with_errors' || current.status === 'paused') throw new Error(`Authored interview import failed: ${JSON.stringify(current)}`);
    return current.status === 'completed';
  }, 'authored four-language interview problem imported offline');
  const interviewPracticeDrafts = [];
  for (const language of languages) for (const answerFormat of ['function', 'acm']) {
    const before = await api('workspace', interviewProblemId, language, 'practice', answerFormat);
    const code = `NORMAL_PRACTICE_ONLY_${language}_${answerFormat}`;
    await api('startPractice', interviewProblemId, language, 'practice', answerFormat);
    await api('saveDraft', interviewProblemId, language, code, 'practice',
      { answerFormat, expectedRevision: before.draft?.revision ?? 0, ...(answerFormat === 'acm' ? { testConfig: baseTests } : {}) });
    const draft = await api('loadDraft', interviewProblemId, language, 'practice', answerFormat);
    assert.equal(draft.code, code); interviewPracticeDrafts.push({ language, answerFormat, draft });
  }
  const importedContent = (await api('workspace', interviewProblemId, 'python', 'practice', 'function')).problem;
  assert.equal(importedContent.content.source, 'file'); assert.deepEqual(importedContent.content.tags, [interviewTag]);
  pass('A separate uniquely tagged authored JSON problem supplies all four function templates without changing any demo head');
  for (const language of languages) for (const mode of ['strict', 'coached']) {
    await until(async () => !(await api('backups')).busy, 'background backup is idle before starting an interview');
    const rules = { mode, language, durationMinutes: 45, counts: { easy: 1, medium: 0, hard: 0 }, tags: [interviewTag],
      company: null, datasetId: null, excludeRecentDays: 0, sampling: 'uniform', seed: `${interviewTag}:${language}:${mode}` };
    const preview = await api('previewInterview', rules);
    assert.deepEqual(preview.pool.shortages, []); assert.deepEqual(preview.pool.selectedIds, [interviewProblemId]);
    assert.equal(preview.pool.candidates.length, 1); assert.equal(preview.pool.rules.language, language);
    const started = await api('startInterview', preview.id, randomUUID()), sessionId = started.session.id;
    assert.equal(started.session.mode, mode); assert.equal(started.session.initialMode, mode); assert.equal(started.items.length, 1);
    assert.equal(started.session.pool.rules.language, language); assert.equal(started.items[0].attempt.language, language);
    assert.equal(started.items[0].attempt.answerFormat, 'function'); assert.equal(started.items[0].attempt.specVersion, 'native-v1');
    assert.equal(started.items[0].item.problem.id, interviewProblemId); assert.equal(started.items[0].item.problem.version, importedContent.version);
    const deadlineAt = started.session.deadlineAt;
    assert.equal(Date.parse(deadlineAt) - Date.parse(started.session.startedAt), 45 * 60000);
    assert.ok(started.remainingMs > 0 && started.remainingMs <= 45 * 60000);
    const attemptId = started.items[0].attempt.id, code = interviewProblem.starter[language], reasoning = `${language}/${mode}：累加数组，空数组返回 0。`;
    if (mode === 'strict') {
      // These named IPC methods are local reads/help decisions, never model/judge requests.
      await assert.rejects(api('aiRequests', attemptId), /严格面试进行中/);
      await assert.rejects(api('takeAiHelp', attemptId), /严格面试进行中/);
      await assert.rejects(api('notes', { kind: 'problem', subjectId: interviewProblemId }), /严格面试进行中/);
      await assert.rejects(api('submissionHistory', { problemId: interviewProblemId, language, answerFormat: 'function' }), /严格面试进行中/);
      assert.deepEqual((await api('interviewState')).history, [], 'Strict mode does not expose prior interview reports');
    } else {
      const coachedAgain = await api('coachInterview', sessionId);
      assert.equal(coachedAgain.session.mode, 'coached'); assert.equal(coachedAgain.session.initialMode, 'coached');
      assert.deepEqual(coachedAgain.session.modeChanges, [], 'An already-coached session is not reset or mislabeled by a repeated coach action');
    }
    const saved = await api('saveInterview', sessionId, interviewProblemId, code, reasoning);
    assert.equal(saved.counted, true); assert.equal(saved.answer.code, code); assert.equal(saved.answer.reasoning, reasoning);
    assert.equal(saved.recap, null); assert.ok(saved.answer.revision > 0);
    const run = await api('runInterview', sessionId, interviewProblemId, randomUUID(), false);
    assert.equal(run.language, language); assert.equal(run.code, code); assert.equal(run.attemptId, attemptId);
    assert.equal(run.answerFormat, 'function'); assert.equal(run.specVersion, 'native-v1'); assert.equal(run.problemVersion, importedContent.version);
    assert.equal(run.result.status, 'passed', JSON.stringify(run.result)); assert.equal(run.result.caseResults.length, 3);
    assert.ok(run.result.caseResults.every(test => test.status === 'passed')); assert.equal(run.result.executionScope, 'local-user-code-not-sandboxed');
    const running = await api('interview', sessionId);
    assert.equal(running.session.deadlineAt, deadlineAt); assert.equal(running.session.mode, mode); assert.equal(running.session.endedAt, null);
    assert.ok(running.remainingMs > 0 && running.remainingMs <= started.remainingMs); assert.deepEqual(running.session.clockAnomalies, []);
    assert.equal(running.items[0].item.accepted.code, code); assert.equal(running.items[0].draft.code, code);
    const ended = await api('finishInterview', sessionId);
    assert.equal(ended.session.deadlineAt, deadlineAt); assert.equal(ended.session.endReason, 'manual'); assert.ok(ended.session.endedAt);
    assert.equal(ended.session.mode, mode); assert.equal(ended.session.initialMode, mode); assert.equal(ended.remainingMs, 0);
    assert.deepEqual(ended.session.clockAnomalies, []); assert.deepEqual(ended.items[0].item.final, saved.answer);
    assert.equal(ended.items[0].attempt.isActive, false); assert.equal(ended.items[0].attempt.finalCode, code);
    assert.equal(ended.items[0].attempt.answerFormat, 'function'); assert.equal(ended.items[0].attempt.lastRunMatchesFinal, true);
    assert.deepEqual(ended.items[0].item.problem.content, importedContent.content, 'Strict presentation redaction never changes the persisted original source');
    assert.deepEqual(await api('runDetail', run.id), run);
    await assert.rejects(api('runInterview', sessionId, interviewProblemId, randomUUID(), false), /面试已结束/);
    const recapCode = `RECAP_ONLY_DO_NOT_EXECUTE_${language}_${mode}`;
    const recap = await api('saveInterview', sessionId, interviewProblemId, recapCode, '截止后复盘，不计入本场。');
    assert.equal(recap.counted, false); assert.equal(recap.recap.code, recapCode); assert.deepEqual(recap.answer, saved.answer);
    const supplement = await api('runInterview', sessionId, interviewProblemId, randomUUID(), true);
    assert.equal(supplement.language, language); assert.equal(supplement.attemptId, attemptId); assert.equal(supplement.code, code);
    assert.notEqual(supplement.code, recapCode); assert.equal(supplement.answerFormat, 'function'); assert.equal(supplement.problemVersion, importedContent.version);
    assert.equal(supplement.result.status, 'passed', JSON.stringify(supplement.result)); assert.equal(supplement.result.caseResults.length, 3);
    const completed = await api('interview', sessionId);
    assert.deepEqual(completed.session, ended.session); assert.deepEqual(completed.items[0].attempt, ended.items[0].attempt);
    assert.equal(completed.items[0].recap.code, recapCode); assert.equal(completed.items[0].runs.length, 2);
    assert.deepEqual(await api('runDetail', run.id), run); assert.deepEqual(await api('runDetail', supplement.id), supplement);
    for (const normal of interviewPracticeDrafts) assert.deepEqual(await api('loadDraft', interviewProblemId, normal.language, 'practice', normal.answerFormat), normal.draft);
    report.interviews.push({ language, mode, session: ended.session, attempt: ended.items[0].attempt, run, supplement, recapCode });
    pass(`${language}/${mode} interview runs actual function code, fixes its deadline/source/format, freezes the answer and supplements only frozen code`,
      { sessionId, attemptId, runId: run.id, supplementId: supplement.id, deadlineAt, strictHelpBlocked: mode === 'strict', mode });
  }
  assert.equal(report.interviews.length, 8); assert.equal(new Set(report.interviews.map(item => item.session.id)).size, 8);
  assert.equal((await api('interviewState')).active, null);
  pass('Eight four-language strict/coached interview reports remain separate from all eight normal practice drafts and attempted no model or judge request');

  await close(); await load();
  for (const original of originals) {
    const workspace = await api('workspace', problemId, original.program.language, scope, original.program.answerFormat);
    assert.equal(workspace.draft.code, original.program.code); assert.equal(workspace.attempt.id, original.run.attemptId);
    assert.ok(workspace.history.some(run => run.id === original.run.id));
    assert.deepEqual(await api('runDetail', original.run.id), original.run);
  }
  const restarted = await api('runPage', { problemId, language: 'python', includeQueued: true, limit: 100 });
  assert.equal(restarted.total, afterDuplicate.total); assert.equal(restarted.items.filter(item => item.id === requestId).length, 1);
  for (const stopped of stoppedRuns) assert.deepEqual(await api('runDetail', stopped.id), stopped);
  for (const supplemental of supplementalRuns) {
    assert.deepEqual(await api('runDetail', supplemental.original.id), supplemental.original);
    assert.deepEqual(await api('runDetail', supplemental.supplemented.id), supplemental.supplemented);
    assert.deepEqual((await api('archiveOverview', supplemental.ended.id)).attempt, supplemental.ended);
    const workspace = await api('workspace', problemId, supplemental.supplemented.language, supplemental.scopeId, 'acm');
    assert.equal(workspace.attempt.id, supplemental.supplemented.attemptId); assert.deepEqual(workspace.draft.testConfig, baseTests);
  }
  const persistedInterviews = await api('interviewState');
  assert.equal(persistedInterviews.active, null);
  for (const recorded of report.interviews) {
    assert.ok(persistedInterviews.history.some(item => item.id === recorded.session.id && item.mode === recorded.mode));
    const persisted = await api('interview', recorded.session.id);
    assert.deepEqual(persisted.session, recorded.session); assert.deepEqual(persisted.items[0].attempt, recorded.attempt);
    assert.equal(persisted.items[0].recap.code, recorded.recapCode); assert.equal(persisted.items[0].runs.length, 2);
    assert.deepEqual(await api('runDetail', recorded.run.id), recorded.run); assert.deepEqual(await api('runDetail', recorded.supplement.id), recorded.supplement);
  }
  for (const normal of interviewPracticeDrafts) assert.deepEqual(await api('loadDraft', interviewProblemId, normal.language, 'practice', normal.answerFormat), normal.draft);
  pass('Clean restart retains all eight interview modes, frozen source/deadline/format, original and supplemental results, recap isolation and unchanged normal drafts');
  pass('Clean application restart restores all eight baseline workspaces, cancelled results and isolated supplemental archives without replaying code');
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
