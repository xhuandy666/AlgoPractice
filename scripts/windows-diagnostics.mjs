import { spawn } from 'node:child_process';
import os from 'node:os';
import { runProcess } from '../src/runner/process.ts';
import { windowsJobCommand } from '../src/runner/windows-job.ts';

// Diagnostic only: compare identical authored argv/stdin through Node and the
// production launcher. Never dump the parent environment or user data.
const timeoutMs = 60000;
const outputLimitBytes = 16384;
const source = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{console.log(JSON.stringify({pid:process.pid,ppid:process.ppid,node:process.versions.node,argv:process.argv.slice(1),input}));console.error('diagnostic stderr ✓')});`;
const args = ['-e', source, '', 'two words', '中文 🌳', 'a"b', 'C:\\尾部\\'];
const input = 'diagnostic stdin 输入\n';
function direct(executable = process.execPath, launchArgs = args, env) {
  const started = performance.now();
  return new Promise(resolve => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), reason;
    const child = spawn(executable, launchArgs, { cwd: os.tmpdir(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ignore'] });
    let phaseBuffer = '';
    child.stderr.on('data', chunk => {
      phaseBuffer += chunk.toString('utf8');
      const lines = phaseBuffer.split(/\r?\n/); phaseBuffer = lines.pop() ?? '';
      for (const line of lines) if (line.startsWith('ALGOPRACTICE_DIAGNOSTIC_PHASE: ')) {
        console.log(JSON.stringify({ diagnosticPhase: line.slice('ALGOPRACTICE_DIAGNOSTIC_PHASE: '.length), elapsedMs: performance.now() - started }));
      }
    });
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
// Keep this allowlist identical to process.ts: a complete parent environment is
// intentionally not passed to the launcher and never included in diagnostics.
const cwd = os.tmpdir();
const cleanEnvironment = { PATH: `${process.env.SystemRoot}\\System32`, HOME: cwd, TMPDIR: cwd, TMP: cwd, TEMP: cwd, LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8', SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR };
emit('direct-node-clean-environment', await direct(process.execPath, args, cleanEnvironment));
const launch = windowsJobCommand(process.execPath, args);
const encodedIndex = launch.args.length - 1;
let script = Buffer.from(launch.args[encodedIndex], 'base64').toString('utf16le');
const phase = name => `[Console]::Error.WriteLine('ALGOPRACTICE_DIAGNOSTIC_PHASE: ${name}');\n`;
function instrument(needle, replacement) {
  if (!script.includes(needle)) throw new Error('Production launcher changed; diagnostic instrumentation must be updated');
  script = script.replace(needle, replacement);
}
instrument("$ErrorActionPreference='Stop';", phase('powershell-entry') + "$ErrorActionPreference='Stop';");
instrument("Add-Type -TypeDefinition @'", phase('before-add-type') + "Add-Type -TypeDefinition @'");
instrument("\n$d=[Text.Encoding]", "\n" + phase('after-add-type') + "$d=[Text.Encoding]");
instrument("\nexit [APJobLauncher]::Run", "\n" + phase('before-native-run') + "exit [APJobLauncher]::Run");
launch.args[encodedIndex] = Buffer.from(script, 'utf16le').toString('base64');
emit('instrumented-production-launcher-cold', await direct(launch.executable, launch.args, cleanEnvironment));
emit('production-launcher-warm', await runProcess(process.execPath, args, { cwd, stdin: input, timeoutMs, outputLimitBytes }));
