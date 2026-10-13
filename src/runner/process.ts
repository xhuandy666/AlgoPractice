import { spawn } from 'node:child_process';
import { createWindowsJobControl, windowsJobCommand } from './windows-job.ts';

export const TOOLCHAIN_ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'GOTOOLCHAIN', 'GOENV', 'GOWORK', 'GOPROXY', 'GOSUMDB', 'GOVCS', 'CGO_ENABLED', 'GO111MODULE', 'GOOS', 'GOARCH', 'GOCACHE', 'GOPATH', 'GOMODCACHE', 'ZIG_GLOBAL_CACHE_DIR', 'ZIG_LOCAL_CACHE_DIR', 'ZIG_LIB_DIR', 'DEVELOPER_DIR', 'SDKROOT'] as const;
export type ToolchainProcessEnvironment = Partial<Record<typeof TOOLCHAIN_ENV_KEYS[number], string>>;
export interface ProcessOptions {
  cwd: string; stdin?: string; timeoutMs: number; outputLimitBytes: number; signal?: AbortSignal;
  /** Host-owned toolchain settings only. Never exposed in RunRequest or inherited wholesale. */
  env?: ToolchainProcessEnvironment;
}
export interface ProcessResult { code: number | null; stdout: string; stderr: string; reason?: 'timeout' | 'cancelled' | 'output_limit' | 'spawn_error'; terminationError?: string; durationMs: number; }

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
export async function runProcess(executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  const started = performance.now();
  let control: Awaited<ReturnType<typeof createWindowsJobControl>> | undefined;
  try {
    if (process.platform === 'win32' && !options.signal?.aborted) control = await createWindowsJobControl();
    return await new Promise(resolve => {
    if (options.signal?.aborted) return resolve({ code: null, stdout: '', stderr: '', reason: 'cancelled', durationMs: 0 });
    const env: NodeJS.ProcessEnv = { PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin', HOME: options.cwd, TMPDIR: options.cwd, TMP: options.cwd, TEMP: options.cwd, LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8' };
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!(TOOLCHAIN_ENV_KEYS as readonly string[]).includes(key) || typeof value !== 'string' || value.includes('\0')) {
        return resolve({ code: null, stdout: '', stderr: 'Refused an unsupported host toolchain environment setting.', reason: 'spawn_error', durationMs: performance.now() - started });
      }
      env[key] = value;
    }
    if (process.platform === 'win32') { env.SystemRoot = process.env.SystemRoot; env.WINDIR = process.env.WINDIR; }
    const launch = process.platform === 'win32' ? windowsJobCommand(executable, args, process.pid, control?.name)
      : { executable: '/bin/sh', args: ['-c', POSIX_LAUNCH_SCRIPT, 'algopractice-launcher', executable, ...args] };
    const child = spawn(launch.executable, launch.args, { cwd: options.cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', process.platform === 'win32' ? 'ignore' : 'pipe'] });
    child.stdio[3]?.on('error', () => {});
    // Append bounded chunks, then concatenate once. Recopying the entire prefix on
    // each chunk becomes quadratic during a vendor stdlib bootstrap's warnings.
    let stdout: Buffer[] = [], stderr: Buffer[] = [], seen = 0, finished = false;
    let reason: ProcessResult['reason'];
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        // Killing the Job owner closes its non-inheritable Job handle and kills the entire Job.
        try { child.kill('SIGKILL'); } catch {}
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { try { child.kill('SIGKILL'); } catch {} } } }
    };
    const stop = (why: ProcessResult['reason']) => {
      if (reason || finished) return;
      reason = why;
      if (control) {
        // Leave the Job owner alive to terminate and drain its exact Job. Killing
        // only the launcher resolves Node's close before the binary image releases.
        control.stop();
        terminationTimer = setTimeout(killGroup, 1500);
      } else killGroup();
    };
    const abort = () => stop('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    // Close the gap between the initial aborted check and listener registration.
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const remaining = Math.max(0, options.outputLimitBytes - seen);
      const kept = chunk.subarray(0, remaining); seen += chunk.length;
      if (kept.length) { if (stream === 'stdout') stdout.push(kept); else stderr.push(kept); }
      if (seen > options.outputLimitBytes) stop('output_limit');
    };
    child.stdout!.on('data', c => capture('stdout', c)); child.stderr!.on('data', c => capture('stderr', c));
    child.stdin!.on('error', () => {}); child.stdin!.end(options.stdin ?? '');
    child.on('error', error => { reason = 'spawn_error'; const message = process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'ENOENT' ? `Windows process helper is unavailable; run npm install or reinstall the desktop application. ${error.message}` : error.message; stderr = [Buffer.from(message).subarray(0, options.outputLimitBytes)]; });
    // Parent completion must also remove ordinary background descendants still holding pipes open.
    child.on('exit', () => { if (process.platform !== 'win32') killGroup(); });
    child.on('close', async code => {
      if (finished) return; finished = true;
      clearTimeout(timer); if (terminationTimer) clearTimeout(terminationTimer); options.signal?.removeEventListener('abort', abort);
      // Streaming decode omits a truncated final code point instead of expanding it to U+FFFD.
      const decode=(buffer:Buffer)=>new TextDecoder('utf-8').decode(buffer,{stream:true});
      let out=decode(Buffer.concat(stdout)),err=decode(Buffer.concat(stderr));
      // Invalid UTF-8 expands to replacement characters. Bound the decoded strings as well.
      if(Buffer.byteLength(out)+Buffer.byteLength(err)>options.outputLimitBytes){
        reason ??= 'output_limit';
        out=decode(Buffer.from(out).subarray(0,options.outputLimitBytes));
        err=decode(Buffer.from(err).subarray(0,Math.max(0,options.outputLimitBytes-Buffer.byteLength(out))));
      }
      let terminationError: string | undefined;
      if(code===125 && err.includes('ALGOPRACTICE_LAUNCHER_ERROR:'))reason='spawn_error';
      if(control && child.pid) {
        // Child close may race delivery of the final private-pipe byte. Wait only
        // for that already-produced acknowledgement, not another user-code budget.
        let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
        const drained = await Promise.race([control.drained, new Promise<boolean>(resolve => { acknowledgementTimer = setTimeout(() => resolve(false), 100); })]);
        if (acknowledgementTimer) clearTimeout(acknowledgementTimer);
        if (!drained && reason!=='spawn_error') {
          terminationError = `Failed to confirm termination of ${reason ?? 'completed'} process Job.${err ? ` ${err.trim()}` : ''}`;
          reason = 'spawn_error';
        }
      }
      // A present executable may still fail exec (for example, its shebang interpreter is missing).
      if(process.platform!=='win32' && (code===126 || code===127) && err.startsWith('algopractice-launcher:'))reason='spawn_error';
      resolve({ code, stdout: out, stderr: err, reason, ...(terminationError ? { terminationError } : {}), durationMs: performance.now() - started });
    });
    });
  } catch(error) {
    const stderr = new TextDecoder('utf-8').decode(Buffer.from(String(error)).subarray(0, options.outputLimitBytes), { stream: true });
    return { code: null, stdout: '', stderr, reason: 'spawn_error', durationMs: performance.now() - started };
  } finally { await control?.close(); }
}
