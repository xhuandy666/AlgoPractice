import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runProcess } from '../../src/runner/process.ts';

const posix = { skip: process.platform === 'win32' ? 'POSIX process groups; Windows has native Job tests' : false };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const execute = promisify(execFile);
const exists = (file: string) => stat(file).then(() => true, () => false);
async function until(check: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) { if (Date.now() >= deadline) return false; await sleep(25); }
  return true;
}
async function members(groupId: number) {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=']);
  return stdout.trim().split('\n').map(line => {
    const [pid, ppid, pgid, state] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state };
  }).filter(row => row.pgid === groupId);
}
async function assertGroupStopped(groupId: number) {
  await until(async () => (await members(groupId)).length === 0);
  const remaining = await members(groupId);
  assert.deepEqual(remaining.filter(row => !row.state.startsWith('Z')), [], 'Runtime, ordinary descendants and guard must all stop');
  // Some Linux container PID 1 implementations defer reaping dead orphans; these cannot execute code.
  if (process.platform === 'darwin') assert.deepEqual(remaining, [], 'macOS must reap every child and guard');
}

test('POSIX owner SIGKILL closes the liveness pipe and removes the runtime, ordinary child and guard', posix, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'algopractice owner 中文 '));
  const flag = path.join(root, 'ready.json'), leafFlag = path.join(root, 'leaf-ready'), marker = path.join(root, 'survived');
  const leaf = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(leafFlag)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'survived'),1500);setTimeout(()=>process.exit(0),15000);`;
  const runtime = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(flag)},JSON.stringify({pid:process.pid,child:child.pid}));setTimeout(()=>process.exit(0),15000);`;
  const source = `import {runProcess} from ${JSON.stringify(new URL('../../src/runner/process.ts', import.meta.url).href)};await runProcess(process.execPath,['-e',${JSON.stringify(runtime)}],{cwd:${JSON.stringify(root)},timeoutMs:20000,outputLimitBytes:4096});`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '', groupId: number | undefined;
  owner.stderr.on('data', chunk => { errors += chunk.toString(); });
  try {
    assert.ok(await until(async () => await exists(flag) && await exists(leafFlag)), `Runtime did not become ready: ${errors}`);
    const ready = JSON.parse(await readFile(flag, 'utf8')) as { pid: number; child: number };
    groupId = ready.pid;
    const before = await members(groupId);
    assert.ok(before.some(row => row.pid === ready.pid));
    assert.ok(before.some(row => row.pid === ready.child));
    assert.equal(before.length, 3, 'The group must contain exactly the runtime, ordinary child and liveness guard');
    const exit = once(owner, 'exit');
    assert.equal(owner.kill('SIGKILL'), true);
    assert.equal((await exit)[1], 'SIGKILL');
    await assertGroupStopped(groupId);
    await sleep(1600);
    assert.equal(await exists(marker), false, 'Ordinary child must not execute its delayed write after owner death');
  } finally {
    owner.kill('SIGKILL');
    if (groupId) { try { process.kill(-groupId, 'SIGKILL'); } catch {} }
    else if (await exists(flag)) { try { process.kill(-JSON.parse(await readFile(flag, 'utf8')).pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});

test('POSIX guard preserves literal argv, Unicode executable paths, stdin and output, then leaves no guard', posix, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'algopractice argv 中文 '));
  const executable = path.join(root, 'node 中文 runtime'), marker = path.join(root, 'injected');
  await symlink(process.execPath, executable);
  const args = ['', 'two words', 'a"b', `$(touch ${marker})`, '`touch injected`', '🌳'];
  try {
    const source = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({pid:process.pid,args:process.argv.slice(1),input}));console.error('stderr ✓')})";
    const result = await runProcess(executable, ['-e', source, ...args], { cwd: root, stdin: '输入\n', timeoutMs: 5000, outputLimitBytes: 4096 });
    assert.equal(result.reason, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);
    const { pid, ...actual } = JSON.parse(result.stdout);
    assert.deepEqual(actual, { args, input: '输入\n' });
    assert.equal(result.stderr, 'stderr ✓\n');
    assert.equal(await exists(marker), false);
    await assertGroupStopped(pid);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('POSIX launcher distinguishes unavailable executables from a program returning 126', posix, async () => {
  const options = { cwd: os.tmpdir(), timeoutMs: 5000, outputLimitBytes: 4096 };
  assert.equal((await runProcess('/does-not-exist/algopractice-runtime', [], options)).reason, 'spawn_error');
  const result = await runProcess(process.execPath, ['-e', "console.error('user error');process.exit(126)"], options);
  assert.equal(result.reason, undefined);
  assert.equal(result.code, 126);
  assert.equal(result.stderr, 'user error\n');
});
