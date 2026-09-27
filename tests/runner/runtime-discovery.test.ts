import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveRuntime, runtimeDiscoveryPaths } from '../../src/runner/runtime-discovery.ts';
import { inspectRuntime, type RuntimeInspection } from '../../src/runner/runtime-inspect.ts';
import type { Language } from '../../src/runner/types.ts';

const result = (language: Language, executable: string, status: RuntimeInspection['status']): RuntimeInspection => ({ language, executable, status, runtimeVersion: status === 'ready' ? 'Python 3.14.7' : '', diagnostics: [] });

test('PATH discovery excludes relative paths, project executables and macOS installer launchers', async () => {
  const candidates = await runtimeDiscoveryPaths('python', { platform: 'darwin', home: '/home/person', cwd: '/work/project', env: { PATH: ':/work/project/bin:.:relative:/usr/bin:/opt/tools:/opt/tools' } });
  assert.ok(!candidates.some(item => item.startsWith('/work/project/')));
  assert.ok(!candidates.includes('/usr/bin/python3'));
  assert.equal(candidates.filter(item => item === '/opt/tools/python3').length, 1);
  assert.ok(candidates.every(item => path.posix.isAbsolute(item)));
});
test('Windows PATH discovery does not probe Store aliases or the current directory', async () => {
  const candidates = await runtimeDiscoveryPaths('python', { platform: 'win32', home: 'C:\\Users\\person', cwd: 'C:\\work', env: { PATH: ';C:\\work;.;C:\\Users\\person\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Python314', LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local' } });
  assert.ok(!candidates.some(item => /WindowsApps/.test(item) || item.startsWith('C:\\work\\')));
  assert.ok(candidates.includes('C:\\Python314\\python.exe'));
});
test('platform-specific Python installation roots precede PATH candidates', async () => {
  const mac = await runtimeDiscoveryPaths('python', { platform: 'darwin', home: '/home/person', cwd: '/work/project', env: { PATH: '/fixture/bin' } });
  assert.deepEqual(mac, [
    '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3',
    '/opt/homebrew/opt/python@3.14/bin/python3.14', '/usr/local/opt/python@3.14/bin/python3.14',
    '/opt/homebrew/bin/python3.14', '/usr/local/bin/python3.14',
    '/fixture/bin/python3.14', '/fixture/bin/python3',
  ]);
  const windows = await runtimeDiscoveryPaths('python', { platform: 'win32', home: 'C:\\Users\\person', cwd: 'C:\\work',
    env: { LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local', ProgramFiles: 'C:\\Program Files', PATH: 'C:\\fixture\\bin' } });
  assert.deepEqual(windows, [
    'C:\\Users\\person\\AppData\\Local\\Programs\\Python\\Python314\\python.exe',
    'C:\\Program Files\\Python314\\python.exe', 'C:\\fixture\\bin\\python.exe', 'C:\\fixture\\bin\\python3.exe',
  ]);
});
test('PATH discovery retains candidate order while enforcing the 64-candidate bound', async () => {
  const directories = Array.from({ length: 80 }, (_, index) => `/fixture/bin-${index}`);
  const candidates = await runtimeDiscoveryPaths('python', { platform: 'linux', home: '/home/person', cwd: '/work/project', env: { PATH: directories.join(':') } });
  assert.equal(candidates.length, 64);
  assert.deepEqual(candidates, directories.slice(0, 32).flatMap(directory => [`${directory}/python3.14`, `${directory}/python3`]));
});
test('GUI launch with root/home cwd does not hide every controlled system installation', async () => {
  for (const cwd of ['/', '/home/person']) {
    const candidates = await runtimeDiscoveryPaths('python', { platform: 'darwin', cwd, home: '/home/person', env: { PATH: '/home/person/.local/bin:/opt/tools' } });
    assert.ok(candidates.includes('/opt/tools/python3')); assert.ok(candidates.includes('/home/person/.local/bin/python3'));
  }
});
test('explicit invalid selection blocks managed/system substitution and does not download', async () => {
  const calls: string[] = [];
  const resolved = await resolveRuntime('python', { root: '/managed', explicitPath: '/explicit/python', testRoot: '/test', inspect: async (language, options) => { calls.push(options!.runtimePath!); return result(language, options!.runtimePath!, 'missing'); } });
  assert.equal(resolved.source, 'explicit'); assert.equal(resolved.blockedByExplicit, true); assert.deepEqual(calls, ['/explicit/python']);
});
test('test override is authoritative and never silently falls through to installed system runtimes', async () => {
  const calls: string[] = [];
  const testRoot = path.join(os.tmpdir(), 'runtime-test-override');
  const resolved = await resolveRuntime('python', { root: '/managed', testRoot, inspect: async (language, options) => { calls.push(options!.runtimePath!); return result(language, options!.runtimePath!, 'missing'); } });
  assert.equal(resolved.source, 'test-override'); assert.equal(resolved.status, 'missing'); assert.equal(calls.length, 1); assert.ok(calls[0].startsWith(`${testRoot}${path.sep}`));
});
test('validated managed runtime takes precedence and discovery is read-only', async () => {
  let calls = 0;
  const resolved = await resolveRuntime('python', { root: '/managed', inspect: async (language, options) => { calls++; return result(language, options!.runtimePath!, 'ready'); } });
  assert.equal(resolved.source, 'managed'); assert.equal(calls, 1);
});
test('bounded PATH discovery finds a compatible installation after rejecting another version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'algopractice-discovery-'));
  try {
    const executableName = process.platform === 'win32' ? 'python.exe' : 'python3';
    const first = path.join(root, 'old'), second = path.join(root, 'compatible'); await mkdir(first); await mkdir(second);
    await writeFile(path.join(first, executableName), 'fixture'); await writeFile(path.join(second, executableName), 'fixture');
    // Exercise PATH-only discovery without probing fixed macOS roots installed on the host.
    // Windows has no fixed Python roots when LOCALAPPDATA/ProgramFiles are absent from env.
    const resolved = await resolveRuntime('python', { root: path.join(root, 'managed'), platform: process.platform === 'win32' ? 'win32' : 'linux', cwd: path.join(root, 'project'), env: { PATH: [first, second].join(path.delimiter) }, inspect: async (language, options) => result(language, options!.runtimePath!, options!.runtimePath === path.join(second, executableName) ? 'ready' : options!.runtimePath === path.join(first, executableName) ? 'incompatible' : 'missing') });
    assert.equal(resolved.source, 'system'); assert.equal(resolved.executable, path.join(second, executableName)); assert.equal(resolved.candidates.filter(item => item.source === 'system').length, 2);
    assert.deepEqual(resolved.candidates.map(item => ({ executable: item.executable, source: item.source, status: item.inspection.status })), [
      { executable: path.join(root, 'managed', 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3'])), source: 'managed', status: 'missing' },
      { executable: path.join(first, executableName), source: 'system', status: 'incompatible' },
      { executable: path.join(second, executableName), source: 'system', status: 'ready' },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('PATH aliases resolving into the project are never probed', { skip: process.platform === 'win32' ? 'Windows symlink creation requires elevated privilege or Developer Mode.' : false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'algopractice-discovery-alias-'));
  try {
    const project = path.join(root, 'project'), bin = path.join(root, 'bin'); await mkdir(project); await mkdir(bin); await writeFile(path.join(project, 'python3'), 'fixture'); await symlink(path.join(project, 'python3'), path.join(bin, 'python3'));
    const calls: string[] = [];
    await resolveRuntime('python', { root: path.join(root, 'managed'), cwd: project, env: { PATH: bin }, inspect: async (language, options) => { calls.push(options!.runtimePath!); return result(language, options!.runtimePath!, 'missing'); } });
    assert.ok(!calls.includes(path.join(bin, 'python3')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('inspection rejects nonabsolute executable and containing directory before execution', async () => {
  assert.equal((await inspectRuntime('python', { runtimePath: 'python3' })).status, 'incompatible');
  assert.equal((await inspectRuntime('python', { runtimePath: os.tmpdir() })).status, 'incompatible');
});
test('macOS developer-tools launcher is never executed', { skip: process.platform !== 'darwin' }, async () => {
  const inspected = await inspectRuntime('java', { runtimePath: '/usr/bin/java' }); assert.equal(inspected.status, 'incompatible'); assert.match(inspected.diagnostics[0].message, /launcher/);
});
test('macOS javac alias pointing at the developer-tools launcher is rejected before probing java', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'algopractice-compiler-alias-'));
  try {
    await writeFile(path.join(root, 'java'), '#!/bin/sh\nexit 99\n', { mode: 0o700 }); await symlink('/usr/bin/javac', path.join(root, 'javac'));
    const inspected = await inspectRuntime('java', { runtimePath: path.join(root, 'java') }); assert.equal(inspected.status, 'incompatible'); assert.match(inspected.diagnostics[0].message, /launcher/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
