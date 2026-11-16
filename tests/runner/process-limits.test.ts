import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { groupResidentBytes, runProcess } from '../../src/runner/process.ts';

// Runtime-free characterization of runProcess limits: the child is this Node binary, so these run on any POSIX
// machine without Python/Java/Go/C++. The runCode-level tests cover the same limits with real language runtimes.
const posix = { skip: process.platform === 'win32' ? 'POSIX launcher; Windows uses the Job helper and its own tests' : false };
const execute = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function workspace(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'algopractice-process-limits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
/** Running means present and not a zombie; container init processes may reap orphans late. */
async function running(pid: number) {
  try { const { stdout } = await execute('/bin/ps', ['-o', 'stat=', '-p', String(pid)]); return stdout.trim() !== '' && !stdout.trim().startsWith('Z'); }
  catch { return false; }
}

test('a run past its deadline is stopped and reported as a timeout', posix, async t => {
  const cwd = await workspace(t), started = performance.now();
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, timeoutMs: 300, outputLimitBytes: 4096 });
  assert.equal(result.reason, 'timeout');
  assert.ok(performance.now() - started < 5000, 'the deadline, not the program, ends the run');
});

test('cancellation stops the run and is reported as cancelled', posix, async t => {
  const cwd = await workspace(t), controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, timeoutMs: 10000, outputLimitBytes: 4096, signal: controller.signal });
  assert.equal(result.reason, 'cancelled');
});

test('output beyond the byte budget stops the run and is truncated to the budget', posix, async t => {
  const cwd = await workspace(t);
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000)); setInterval(() => {}, 1000)'], { cwd, timeoutMs: 10000, outputLimitBytes: 4096 });
  assert.equal(result.reason, 'output_limit');
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 4096);
});

test('a background descendant cannot outlive a completed run', posix, async t => {
  const cwd = await workspace(t);
  const parent = `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); child.unref(); console.log(child.pid);`;
  const result = await runProcess(process.execPath, ['-e', parent], { cwd, timeoutMs: 10000, outputLimitBytes: 4096 });
  assert.equal(result.code, 0); assert.equal(result.reason, undefined);
  const pid = Number(result.stdout.trim()); assert.ok(pid > 0);
  let alive = true; for (let index = 0; index < 100 && alive; index++) { alive = await running(pid); if (alive) await sleep(25); }
  assert.equal(alive, false, 'the process group is killed when the run ends');
});

test('the child sees only the scrubbed environment and its own working directory', posix, async t => {
  const cwd = await workspace(t);
  process.env.ALGOPRACTICE_PARENT_SECRET = 'must-not-leak';
  t.after(() => { delete process.env.ALGOPRACTICE_PARENT_SECRET; });
  const result = await runProcess(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { cwd, timeoutMs: 10000, outputLimitBytes: 65536 });
  const env = JSON.parse(result.stdout) as Record<string, string>;
  assert.equal(env.ALGOPRACTICE_PARENT_SECRET, undefined);
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.deepEqual([env.HOME, env.TMPDIR], [cwd, cwd]);
});

test('unsupported host environment keys are refused before anything runs', posix, async t => {
  const cwd = await workspace(t);
  const result = await runProcess(process.execPath, ['-e', 'console.log("ran")'], { cwd, timeoutMs: 10000, outputLimitBytes: 4096, env: { NODE_OPTIONS: '--inspect' } as never });
  assert.equal(result.reason, 'spawn_error'); assert.equal(result.stdout, '');
});

test('stdin is delivered and the exit code is preserved', posix, async t => {
  const cwd = await workspace(t);
  const result = await runProcess(process.execPath, ['-e', 'let s = ""; process.stdin.on("data", d => s += d).on("end", () => { process.stdout.write(s.toUpperCase()); process.exit(3); })'],
    { cwd, timeoutMs: 10000, outputLimitBytes: 4096, stdin: '中文 input\n' });
  assert.deepEqual([result.code, result.stdout, result.reason], [3, '中文 INPUT\n', undefined]);
});

test('process-group memory is summed from Linux and macOS ps output, and unreadable output fails open', () => {
  const linux = '    1     11520\n 4242      2048\n 4242    100000\n 4300      9999\n';
  const macos = '    1  15888\n 4242   2048\n 4242 100000\n';
  assert.equal(groupResidentBytes(linux, 4242), (2048 + 100000) * 1024);
  assert.equal(groupResidentBytes(macos, 4242), (2048 + 100000) * 1024);
  assert.equal(groupResidentBytes(linux, 7777), 0, 'a group that already exited holds no memory');
  assert.equal(groupResidentBytes('', 4242), null);
  assert.equal(groupResidentBytes('ps: illegal option -- A\nusage: ps\n', 4242), null);
});

test('a run whose process group grows past the memory cap is stopped and reported as memory_limit', posix, async t => {
  const cwd = await workspace(t), started = performance.now();
  // Touch every page so resident memory really grows; without the cap this would take gigabytes before the deadline.
  const hog = 'const keep = []; setInterval(() => keep.push(Buffer.alloc(32 * 1024 * 1024, 1)), 20);';
  const result = await runProcess(process.execPath, ['-e', hog], { cwd, timeoutMs: 15000, outputLimitBytes: 4096, memoryLimitBytes: 256 * 1024 * 1024 });
  assert.equal(result.reason, 'memory_limit');
  assert.ok(performance.now() - started < 10000, 'the cap, not the deadline, ends the run');
});

test('a program within the memory cap runs to completion', posix, async t => {
  const cwd = await workspace(t);
  const modest = 'const block = Buffer.alloc(16 * 1024 * 1024, 1); setTimeout(() => { console.log(block.length); }, 700);';
  const result = await runProcess(process.execPath, ['-e', modest], { cwd, timeoutMs: 10000, outputLimitBytes: 4096, memoryLimitBytes: 512 * 1024 * 1024 });
  assert.deepEqual([result.code, result.reason, result.stdout.trim()], [0, undefined, String(16 * 1024 * 1024)]);
});
