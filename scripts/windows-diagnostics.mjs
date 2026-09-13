import { spawn } from 'node:child_process';
import os from 'node:os';
import { runProcess } from '../src/runner/process.ts';

// Diagnostic only: compare identical authored argv/stdin through Node and the
// production launcher. Never dump the parent environment or user data.
const timeoutMs = 60000;
const outputLimitBytes = 16384;
const source = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{console.log(JSON.stringify({pid:process.pid,ppid:process.ppid,node:process.versions.node,argv:process.argv.slice(1),input}));console.error('diagnostic stderr ✓')});`;
const args = ['-e', source, '', 'two words', '中文 🌳', 'a"b', 'C:\\尾部\\'];
const input = 'diagnostic stdin 输入\n';
function direct() {
  const started = performance.now();
  return new Promise(resolve => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), reason;
    const child = spawn(process.execPath, args, { cwd: os.tmpdir(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { reason = 'timeout'; child.kill('SIGKILL'); }, timeoutMs);
    const capture = (stream, chunk) => {
      const retained = stream === 'stdout' ? stdout : stderr;
      const combined = Buffer.concat([retained, chunk]).subarray(0, outputLimitBytes);
      if (stream === 'stdout') stdout = combined; else stderr = combined;
    };
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.once('error', error => { reason = 'spawn_error'; stderr = Buffer.from(error.message).subarray(0, outputLimitBytes); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ pid: child.pid, code, signal, reason, durationMs: performance.now() - started, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
  });
}
function emit(name, result) {
  console.log(JSON.stringify({ name, ...result }));
}
console.log(JSON.stringify({ diagnostic: 'authored-node-launch-comparison', platform: process.platform, arch: process.arch, node: process.versions.node, ownerPid: process.pid, timeoutMs, containsEnvironmentDump: false }));
emit('direct-node', await direct());
for (let index = 1; index <= 2; index++) {
  emit(`production-launcher-${index}`, await runProcess(process.execPath, args, { cwd: os.tmpdir(), stdin: input, timeoutMs, outputLimitBytes }));
}
