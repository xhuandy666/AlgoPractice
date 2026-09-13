import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_JOB_SOURCE } from '../src/runner/windows-job.ts';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const compileTimeoutMs = 120000;
const outputLimitBytes = 65536;

function compile(compiler, args, cwd, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let output = Buffer.alloc(0), failure;
    const child = spawn(compiler, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = error => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(signal.reason ?? new Error('Windows helper compilation cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error(`Windows helper compilation exceeded ${compileTimeoutMs} ms`)), compileTimeoutMs);
    const capture = chunk => {
      const remaining = outputLimitBytes - output.length;
      output = Buffer.concat([output, chunk.subarray(0, remaining)]);
      if (chunk.length > remaining) stop(new Error('Windows helper compiler output exceeded its limit'));
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', error => { failure ??= new Error(`Cannot start the Windows .NET Framework compiler: ${error.message}`); });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Windows helper compilation failed (exit ${code}): ${output.toString('utf8').trim()}`));
      else resolve();
    });
  });
}

export async function prepareWindowsHelper({ signal, root = defaultRoot } = {}) {
  if (process.platform !== 'win32') return undefined;
  if (process.arch !== 'x64') throw new Error('The Windows process helper requires Windows x64');
  signal?.throwIfAborted();
  const directory = path.join(path.resolve(root), '.runtime-tools');
  const executable = path.join(directory, 'windows-job-helper.exe');
  const metadata = path.join(directory, 'windows-job-helper.json');
  const sourceSha256 = sha256(WINDOWS_JOB_SOURCE);
  try {
    const cached = JSON.parse(await readFile(metadata, 'utf8'));
    if (cached.schema === 1 && cached.sourceSha256 === sourceSha256 && cached.target === 'win32-x64' && cached.executableSha256 === sha256(await readFile(executable))) return executable;
  } catch { /* Missing or changed build artifacts are regenerated from authored source. */ }
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(path.join(directory, 'compile-'));
  const source = path.join(temporary, 'windows-job-helper.cs');
  const compiled = path.join(temporary, 'windows-job-helper.exe');
  try {
    await writeFile(source, WINDOWS_JOB_SOURCE, 'utf8');
    const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    await compile(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${compiled}`, source], temporary, signal);
    signal?.throwIfAborted();
    const executableSha256 = sha256(await readFile(compiled));
    const nextMetadata = path.join(temporary, 'windows-job-helper.json');
    await writeFile(nextMetadata, JSON.stringify({ schema: 1, target: 'win32-x64', sourceSha256, executableSha256 }, null, 2) + '\n');
    await rename(compiled, executable);
    await rename(nextMetadata, metadata);
    return executable;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = performance.now();
  const executable = await prepareWindowsHelper();
  if (executable) {
    const metadata = JSON.parse(await readFile(path.join(path.dirname(executable), 'windows-job-helper.json'), 'utf8'));
    console.log(JSON.stringify({ event: 'windows-helper-ready', durationMs: Math.round(performance.now() - started), executable, sourceSha256: metadata.sourceSha256, executableSha256: metadata.executableSha256 }));
  }
}
