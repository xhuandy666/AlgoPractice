import { spawn } from 'node:child_process';
import { windowsJobCommand } from './windows-job.ts';

export interface ProcessOptions {
  cwd: string; stdin?: string; timeoutMs: number; outputLimitBytes: number; signal?: AbortSignal;
}
export interface ProcessResult { code: number | null; stdout: string; stderr: string; reason?: 'timeout' | 'cancelled' | 'output_limit' | 'spawn_error'; durationMs: number; }

// The detached shell and its guard share one process group. Only the guard inherits the child
// end of fd 3; EOF means the owning Node/Electron process closed its end (including SIGKILL).
// Signalling group 0 avoids watching or reusing an owner PID. User code stays in argv, not script text.
const POSIX_LAUNCH_SCRIPT = `
if [ -d "$1" ] || ! command -v "$1" >/dev/null 2>&1; then
  printf "%s\\n" "ALGOPRACTICE_LAUNCHER_ERROR: executable is unavailable" >&2
  exit 125
fi
(
  while IFS= read -r ignored <&3; do :; done
  kill -s KILL 0
) </dev/null >/dev/null 2>&1 &
exec "$@" 3<&-
`;

// A process group controls ordinary descendants. This is NOT a filesystem/network sandbox.
export function runProcess(executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  const started = performance.now();
  return new Promise(resolve => {
    if (options.signal?.aborted) return resolve({ code: null, stdout: '', stderr: '', reason: 'cancelled', durationMs: 0 });
    const env: NodeJS.ProcessEnv = { PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin', HOME: options.cwd, TMPDIR: options.cwd, TMP: options.cwd, TEMP: options.cwd, LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8' };
    if (process.platform === 'win32') { env.SystemRoot = process.env.SystemRoot; env.WINDIR = process.env.WINDIR; }
    const launch = process.platform === 'win32' ? windowsJobCommand(executable, args)
      : { executable: '/bin/sh', args: ['-c', POSIX_LAUNCH_SCRIPT, 'algopractice-launcher', executable, ...args] };
    const child = spawn(launch.executable, launch.args, { cwd: options.cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', process.platform === 'win32' ? 'ignore' : 'pipe'] });
    child.stdio[3]?.on('error', () => {});
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), seen = 0, finished = false;
    let reason: ProcessResult['reason'];
    const killGroup = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        // Killing the Job owner closes its non-inheritable Job handle and kills the entire Job.
        try { child.kill('SIGKILL'); } catch {}
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { try { child.kill('SIGKILL'); } catch {} } } }
    };
    const stop = (why: ProcessResult['reason']) => { if (!reason) reason = why; killGroup(); };
    const abort = () => stop('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    // Close the gap between the initial aborted check and listener registration.
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const remaining = Math.max(0, options.outputLimitBytes - seen);
      const kept = chunk.subarray(0, remaining); seen += chunk.length;
      if (stream === 'stdout') stdout = Buffer.concat([stdout, kept]); else stderr = Buffer.concat([stderr, kept]);
      if (seen > options.outputLimitBytes) stop('output_limit');
    };
    child.stdout!.on('data', c => capture('stdout', c)); child.stderr!.on('data', c => capture('stderr', c));
    child.stdin!.on('error', () => {}); child.stdin!.end(options.stdin ?? '');
    child.on('error', error => { reason = 'spawn_error'; const message = process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'ENOENT' ? `Windows process helper is unavailable; run npm install or reinstall the desktop application. ${error.message}` : error.message; stderr = Buffer.from(message).subarray(0, options.outputLimitBytes); });
    // Parent completion must also remove ordinary background descendants still holding pipes open.
    child.on('exit', killGroup);
    child.on('close', code => {
      if (finished) return; finished = true;
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      // Streaming decode omits a truncated final code point instead of expanding it to U+FFFD.
      const decode=(buffer:Buffer)=>new TextDecoder('utf-8').decode(buffer,{stream:true});
      let out=decode(stdout),err=decode(stderr);
      // Invalid UTF-8 expands to replacement characters. Bound the decoded strings as well.
      if(Buffer.byteLength(out)+Buffer.byteLength(err)>options.outputLimitBytes){
        reason ??= 'output_limit';
        out=decode(Buffer.from(out).subarray(0,options.outputLimitBytes));
        err=decode(Buffer.from(err).subarray(0,Math.max(0,options.outputLimitBytes-Buffer.byteLength(out))));
      }
      if(code===125 && err.includes('ALGOPRACTICE_LAUNCHER_ERROR:'))reason='spawn_error';
      // A present executable may still fail exec (for example, its shebang interpreter is missing).
      if(process.platform!=='win32' && (code===126 || code===127) && err.startsWith('algopractice-launcher:'))reason='spawn_error';
      resolve({ code, stdout: out, stderr: err, reason, durationMs: performance.now() - started });
    });
  });
}
