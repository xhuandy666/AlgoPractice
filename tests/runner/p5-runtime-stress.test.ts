import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCode } from '../../src/runner/index.ts';
import { installRuntime } from '../../src/runner/managed-runtime.ts';
import type { RunEvent } from '../../src/runner/types.ts';

const enabled = process.env.ALGOPRACTICE_P5_STRESS === '1';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function assertNetworkDenied() {
  const server = createServer();
  const error = await new Promise<NodeJS.ErrnoException | undefined>(resolve => {
    server.once('error', resolve);
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(undefined)));
  });
  assert.ok(error && ['EPERM', 'EACCES'].includes(error.code ?? ''), 'An OS network deny policy must reject socket binding');
  return error.code;
}

async function runtimeProcesses(data: string) {
  // macOS /bin/ps is setuid and cannot execute inside Seatbelt. The outer supervisor
  // reads the process table while this worker stays alive with network access denied.
  const request = { nonce: Date.now(), ownerPid: process.pid };
  await writeFile(path.join(data, 'process-inspect.json'), JSON.stringify(request));
  for (let retry = 0; retry < 100; retry++) {
    try {
      const response = JSON.parse(await readFile(path.join(data, 'process-inspect-result.json'), 'utf8'));
      if (response.nonce === request.nonce) { assert.equal(response.error, undefined); return response.remainingProcesses as string[]; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await pause(100);
  }
  throw new Error('The outer process observer did not respond within 10 seconds');
}

test('P5: 100 real Python/Java runs in a clean-PATH Unicode data directory under OS network denial', {
  skip: enabled ? false : 'Run node scripts/p5-runtime-acceptance.mjs with the pinned offline archives on macOS', timeout: 300000,
}, async context => {
  assert.equal(process.platform, 'darwin', 'This acceptance entry point currently measures macOS only');
  assert.equal(process.env.PATH, '/usr/bin:/bin');
  const data = process.env.ALGOPRACTICE_DATA_DIR!, archives = process.env.ALGOPRACTICE_OFFLINE_ARCHIVES!;
  const reportFile = process.env.ALGOPRACTICE_P5_REPORT!;
  assert.ok(data && archives && reportFile, 'Missing acceptance inputs');
  assert.match(data, /中文.* /); assert.equal(os.tmpdir(), path.join(data, 'temporary'));
  const root = path.join(data, 'runtimes');
  assert.equal(process.env.ALGOPRACTICE_RUNTIME_DIR, root);
  await mkdir(root, { recursive: true });
  const startedAt = new Date().toISOString(), records: object[] = [], installation: object[] = [];
  const pids: number[] = [], originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls++; throw new Error('Network fetch forbidden in offline acceptance'); }) as typeof fetch;
  let failure: string | undefined;
  try {
    const socketPolicy = await assertNetworkDenied();
    for (const language of ['python', 'java'] as const) {
      const phases: string[] = [];
      const installed = await installRuntime(language, { root, localArchive: path.join(archives, `${language}.tar.gz`), onProgress: progress => phases.push(progress.phase) });
      assert.equal(installed.source, 'offline-archive');
      assert.deepEqual([...new Set(phases)], ['copy', 'verify', 'extract', 'validate', 'commit', 'ready']);
      installation.push({ language, source: installed.source, target: installed.target, sha256: installed.sha256,
        runtimeVersion: installed.runtimeVersion, compilerVersion: installed.compilerVersion, phases: [...new Set(phases)] });
    }
    assert.deepEqual((await readdir(root)).sort(), ['java', 'python']);
    assert.deepEqual(await runtimeProcesses(data), []);
    const python = `import os, socket, errno
class Solution:
    def solve(self, x):
        print('P5-PID:' + str(os.getpid()))
        try:
            with socket.socket() as client:
                client.settimeout(1)
                client.connect(('127.0.0.1', 9))
        except OSError as error:
            if error.errno not in (errno.EPERM, errno.EACCES): raise
        else: raise RuntimeError('Network access was not denied')
        return x * 2`;
    const java = `class Solution {
      public int solve(int x) throws Exception {
        System.out.println("P5-PID:" + ProcessHandle.current().pid());
        try (java.net.Socket socket = new java.net.Socket()) {
          socket.connect(new java.net.InetSocketAddress("127.0.0.1", 9), 1000);
          throw new IllegalStateException("Network access was not denied");
        } catch (java.net.SocketException error) {
          String message = error.getMessage().toLowerCase(java.util.Locale.ROOT);
          if (!message.contains("operation not permitted") && !message.contains("permission denied")) throw error;
        }
        return x * 2;
      }
    }`;
    for (let index = 0; index < 100; index++) {
      const language = index % 2 === 0 ? 'python' : 'java';
      const events: RunEvent[] = [];
      const result = await runCode({ language, mode: 'function', code: language === 'python' ? python : java,
        adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [21], expected: 42 }], timeoutMs: 10000 },
      { onEvent: event => events.push(event) });
      assert.equal(result.status, 'passed', `${language} run ${index}: ${JSON.stringify(result)}`);
      assert.equal(result.caseResults[0].actual, 42); assert.equal(result.caseResults.length, 1);
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(events.map(event => event.phase), ['queued', 'compile', 'run', 'finished']);
      assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4]);
      assert.equal(new Set(events.map(event => event.runId)).size, 1);
      const match = /^P5-PID:(\d+)\s*$/.exec(result.stdout); assert.ok(match, result.stdout);
      const pid = Number(match[1]); pids.push(pid);
      const remaining = (await readdir(os.tmpdir())).filter(name => name.startsWith('algopractice-run-'));
      assert.deepEqual(remaining, [], `Temporary directory remained after run ${index}`);
      records.push({ index, language, status: result.status, actual: result.caseResults[0].actual, pid,
        durationMs: result.durationMs, runtimeVersion: result.runtimeVersion, temporaryDirectoryRemainder: remaining.length });
      if ((index + 1) % 20 === 0) context.diagnostic(`${index + 1}/100 real runs passed`);
    }
    // Guard processes can be reaped just after the runtime closes; allow a bounded 2-second grace.
    const remainingProcesses = await runtimeProcesses(data);
    assert.deepEqual(remainingProcesses, [], 'Runtime or guard command remains in the dedicated data directory');
    const survivingPids = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    assert.deepEqual(survivingPids, [], 'An executed user-program PID remains alive');
    const temporaryDirectoryRemainder = await readdir(os.tmpdir()); assert.deepEqual(temporaryDirectoryRemainder, []);
    assert.equal(fetchCalls, 0);
    await writeFile(reportFile, JSON.stringify({ schema: 1, startedAt, completedAt: new Date().toISOString(),
      platform: process.platform, arch: process.arch, osRelease: os.release(), node: process.version,
      passed: records.length, languages: { python: 50, java: 50 }, path: process.env.PATH, unicodeDataDirectory: true,
      network: { mechanism: 'macOS sandbox-exec deny network*', socketPolicy, fetchCalls, descendantSocketProbes: 100 },
      installation, temporaryDirectoryRemainder, remainingProcesses, survivingPids, records }, null, 2) + '\n');
  } catch (error) {
    failure = String(error);
    await writeFile(reportFile, JSON.stringify({ schema: 1, startedAt, completedAt: new Date().toISOString(), failure, installation, records }, null, 2) + '\n');
    throw error;
  } finally {
    globalThis.fetch = originalFetch;
    if (!failure) context.diagnostic('100 passed; 50 Python + 50 Java; no runtime directories, user PIDs or matching runtime/guard processes remain');
  }
});
