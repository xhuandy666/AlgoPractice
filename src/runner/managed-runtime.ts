import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import manifest from '../../runtime-manifest.json' with { type: 'json' };
import { runProcess } from './process.ts';
import { defaultRuntimePath } from './runtime-paths.ts';
import { inspectRuntime, invalidateRuntimeInspection } from './runtime-inspect.ts';
import { ensureToolchainReady } from './toolchain-prewarm.ts';
import { isLanguage, LANGUAGES } from '../shared/languages.ts';
import type { Language } from './types.ts';

export interface InstallProgress { phase: 'download' | 'copy' | 'verify' | 'extract' | 'validate' | 'commit' | 'ready'; receivedBytes: number; totalBytes: number; }
export interface InstallOptions { root: string; localArchive?: string; signal?: AbortSignal; onProgress?: (progress: InstallProgress) => void; /** Host-only timeout override for tests. */ downloadTimeoutMs?: number; }
export interface RecoveryResult { language: Language; status: 'none' | 'active' | 'rolled_back' | 'committed' | 'discarded' | 'needs_attention'; message?: string; }
interface Journal { schema: 1; id: string; pid: number; language: Language; staging: string; backup: string; phase: 'preparing' | 'prepared' | 'switching' | 'warming' | 'committed'; createdAt: string; warmRequired?: boolean; }
const activeInstalls = new Set<string>();
const MARKER = '.algopractice-runtime.json';
const releaseHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
export function approvedRuntimeSource(language: Language, url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return false;
  if (language === 'go') return url.hostname === 'dl.google.com' && /^\/go\/go1\.27\.\d+\.(?:darwin-(?:arm64|amd64)\.tar\.gz|windows-amd64\.zip)$/.test(url.pathname);
  if (language === 'cpp') return url.hostname === 'ziglang.org' && /^\/download\/0\.16\.\d+\/zig-(?:aarch64|x86_64)-(?:macos|windows)-0\.16\.\d+\.(?:tar\.xz|zip)$/.test(url.pathname);
  return url.hostname === 'github.com';
}
async function fetchArtifact(language: Language, url: string, signal: AbortSignal): Promise<Response> {
  let current = new URL(url);
  const hosts = language === 'go' ? new Set(['dl.google.com', 'go.dev']) : language === 'cpp' ? new Set(['ziglang.org']) : releaseHosts;
  for (let hop = 0; hop <= 5; hop++) {
    if (current.protocol !== 'https:' || !hosts.has(current.hostname) || current.username || current.password || current.port) throw new Error('Runtime download source is outside approved HTTPS release hosts');
    const response = await fetch(current.href, { signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location) throw new Error('Runtime download redirect has no destination');
    current = new URL(location, current);
  }
  throw new Error('Runtime download exceeded the bounded redirect limit');
}
const exists = async (file: string) => { try { await stat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
function paths(root: string, language: Language) { return { destination: path.join(root, language), journal: path.join(root, `.${language}-install.json`), lock: path.join(root, `.${language}-install.lock`) }; }
async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.next`; const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
function validJournal(value: unknown, language: Language): value is Journal {
  const j = value as Journal;
  return !!j && j.schema === 1 && j.language === language && /^[a-f0-9-]{36}$/.test(j.id) && Number.isSafeInteger(j.pid) && j.pid > 0
    && new RegExp(`^\\.${language}-install-[a-zA-Z0-9-]+$`).test(j.staging)
    && j.backup === `.${language}-backup-${j.id}` && ['preparing', 'prepared', 'switching', 'warming', 'committed'].includes(j.phase)
    && (j.warmRequired === undefined || j.warmRequired === true && (language === 'go' || language === 'cpp'));
}
async function readJournal(file: string, language: Language): Promise<Journal | undefined> {
  try { const j: unknown = JSON.parse(await readFile(file, 'utf8')); if (!validJournal(j, language)) throw new Error('Invalid installation journal; no paths were removed'); return j; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function recoverOne(root: string, language: Language, journal: Journal): Promise<RecoveryResult> {
  const p = paths(root, language), staging = path.join(root, journal.staging), backup = path.join(root, journal.backup);
  let installedId: string | undefined, warmState: string | undefined;
  try { const marker = JSON.parse(await readFile(path.join(p.destination, MARKER), 'utf8')); installedId = marker.installationId; warmState = marker.warmState; } catch {}
  let status: RecoveryResult['status'];
  if (installedId === journal.id) {
    if (journal.warmRequired && warmState !== 'ready') {
      // A matching installation ID is not proof that final-path bootstrap completed.
      // Preserve/restore the prior installation before removing only this transaction's bytes.
      const detached = path.join(staging, 'extracted');
      if (await exists(detached)) return { language, status: 'needs_attention', message: 'Unprepared destination and extracted staging both exist; both were preserved.' };
      await rename(p.destination, detached);
      if (await exists(backup)) { await rename(backup, p.destination); status = 'rolled_back'; }
      else status = 'discarded';
    } else {
      // Old Python/Java schema-1 markers need no new warmState field.
      await rm(backup, { recursive: true, force: true }); status = 'committed';
    }
  } else if (!(await exists(p.destination)) && await exists(backup)) {
    await rename(backup, p.destination); status = 'rolled_back';
  } else if (await exists(backup)) {
    return { language, status: 'needs_attention', message: 'Destination and backup both exist but the destination is not the prepared installation; both have been preserved.' };
  } else { status = 'discarded'; }
  await rm(staging, { recursive: true, force: true });
  await rm(p.journal, { force: true }); await rm(`${p.journal}.next`, { force: true });
  invalidateRuntimeInspection(language);
  return { language, status };
}
export async function recoverRuntimeInstallations(rootInput: string): Promise<RecoveryResult[]> {
  const root = path.resolve(rootInput); await mkdir(root, { recursive: true });
  const results: RecoveryResult[] = [];
  for (const language of LANGUAGES) {
    const p = paths(root, language);
    if (activeInstalls.has(`${root}:${language}`)) { results.push({ language, status: 'active' }); continue; }
    try {
      if (await exists(p.lock)) {
        let owner: { pid?: number } = {};
        try { owner = JSON.parse(await readFile(p.lock, 'utf8')); } catch {}
        if ((Number.isInteger(owner.pid) && owner.pid! > 0 && alive(owner.pid!)) || (!owner.pid && Date.now() - (await stat(p.lock)).mtimeMs < 30000)) {
          results.push({ language, status: 'active', message: 'Another live installer or a newly-created lock is present.' }); continue;
        }
      }
      const journal = await readJournal(p.journal, language);
      const result = journal ? await recoverOne(root, language, journal) : { language, status: 'none' as const };
      if (result.status !== 'needs_attention') { await rm(p.lock, { force: true }); await rm(`${p.journal}.next`, { force: true }); }
      results.push(result);
    } catch (error) { results.push({ language, status: 'needs_attention', message: String(error) }); }
  }
  return results;
}

export async function installRuntime(language: Language, options: InstallOptions) {
  if (!isLanguage(language)) throw new Error('Unsupported language');
  const target = `${process.platform}-${process.arch}`;
  if (target !== 'darwin-arm64' && target !== 'darwin-x64' && target !== 'win32-x64') throw new Error('Unsupported runtime target');
  const root = path.resolve(options.root), key = `${root}:${language}`, p = paths(root, language);
  if (activeInstalls.has(key)) throw new Error('Runtime installation already in progress');
  const recovery = (await recoverRuntimeInstallations(root)).find(r => r.language === language)!;
  if (recovery.status === 'active' || recovery.status === 'needs_attention') throw new Error(recovery.message ?? 'Runtime installation is busy or requires recovery');
  activeInstalls.add(key);
  let ownsLock = false, journal: Journal | undefined;
  try {
    options.signal?.throwIfAborted();
    const lock = await open(p.lock, 'wx', 0o600); ownsLock = true;
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await lock.sync(); } finally { await lock.close(); }
    const id = randomUUID(); const staging = path.join(root, `.${language}-install-${id}`);
    const warmRequired = language === 'go' || language === 'cpp';
    journal = { schema: 1, id, pid: process.pid, language, staging: path.basename(staging), backup: `.${language}-backup-${id}`, phase: 'preparing', createdAt: new Date().toISOString(), ...(warmRequired ? { warmRequired: true } : {}) };
    await atomicJson(p.journal, journal);
    await mkdir(staging);
    const item = manifest[language].targets[target];
    const artifactUrl = new URL(item.url);
    if (!approvedRuntimeSource(language, artifactUrl)) throw new Error('Runtime manifest must use its approved HTTPS release source');
    const archive = path.join(staging, `archive.${item.archive}`), extracted = path.join(staging, 'extracted');
    await mkdir(extracted); const handle = await open(archive, 'wx', 0o600);
    const hash = createHash('sha256'); let received = 0;
    const progress = (phase: InstallProgress['phase']) => { try { options.onProgress?.({ phase, receivedBytes: received, totalBytes: item.size }); } catch { /* UI observers cannot alter a transaction. */ } };
    try {
      let input: AsyncIterable<Uint8Array>;
      if (options.localArchive) {
        const info = await stat(options.localArchive);
        if (!info.isFile() || info.size !== item.size) throw new Error('Offline archive size does not match the pinned runtime manifest');
        input = createReadStream(options.localArchive, { signal: options.signal });
      } else {
        const downloadSignal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.downloadTimeoutMs ?? 10 * 60 * 1000)]);
        const response = await fetchArtifact(language, item.url, downloadSignal);
        if (!response.ok || !response.body) throw new Error(`Runtime download failed: HTTP ${response.status}`);
        if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('Runtime download redirected to an insecure source');
        input = Readable.fromWeb(response.body as never);
      }
      for await (const chunk of input) {
        options.signal?.throwIfAborted(); const bytes = Buffer.from(chunk); received += bytes.length;
        if (received > item.size) throw new Error('Download exceeds pinned artifact size');
        hash.update(bytes); await handle.writeFile(bytes); progress(options.localArchive ? 'copy' : 'download');
      }
      await handle.sync();
    } finally { await handle.close(); }
    options.signal?.throwIfAborted(); progress('verify');
    const sha256 = hash.digest('hex');
    if (sha256 !== item.sha256 || received !== item.size) throw new Error('Runtime artifact checksum/size mismatch; refused extraction');
    progress('extract');
    const execution = { cwd: staging, timeoutMs: 120000, outputLimitBytes: 65536, signal: options.signal };
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
    const listing = await runProcess(tar, ['-tf', archive], { ...execution, outputLimitBytes: 12000000 });
    if (listing.reason || listing.code !== 0) throw new Error(`Archive listing failed: ${listing.reason ?? listing.stderr}`);
    const entries = listing.stdout.trim().split(/\r?\n/);
    if (!entries.length || entries.length > 100000 || entries.some(entry => { const normalized = entry.replaceAll('\\', '/'); return normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..') || normalized.includes('\0'); })) throw new Error('Runtime archive has an unsafe layout; refused extraction');
    const extraction = await runProcess(tar, ['-xf', archive, '--strip-components=1', '-C', extracted], execution);
    options.signal?.throwIfAborted();
    if (extraction.code !== 0 || extraction.reason) throw new Error(`Extraction failed: ${extraction.reason ?? extraction.stderr}`);
    progress('validate');
    const executable = language === 'python' ? path.join(extracted, process.platform === 'win32' ? 'python.exe' : 'bin/python3')
      : language === 'go' ? path.join(extracted, 'bin', process.platform === 'win32' ? 'go.exe' : 'go')
        : language === 'cpp' ? path.join(extracted, process.platform === 'win32' ? 'zig.exe' : 'zig')
          : path.join(extracted, process.platform === 'darwin' ? 'Contents/Home/bin/java' : process.platform === 'win32' ? 'bin/java.exe' : 'bin/java');
    const inspection = await inspectRuntime(language, { root, runtimePath: executable, signal: options.signal, ...(warmRequired ? { prepare: false } : {}) });
    options.signal?.throwIfAborted();
    const pinnedVersion = language === 'java' ? manifest.java.version.split('+')[0] : manifest[language].version;
    if (inspection.status !== 'ready' || inspection.version !== pinnedVersion) throw new Error(`Extracted runtime validation failed (status=${inspection.status}, expected=${pinnedVersion}, actual=${inspection.version ?? 'unavailable'}): ${inspection.diagnostics.map(item => item.message).join('; ') || 'version mismatch'}`);
    if (warmRequired && !(await exists(path.join(extracted, 'LICENSE')))) throw new Error('Upstream toolchain LICENSE is missing; refused installation');
    const marker = { schema: 1, installationId: id, language, target, version: pinnedVersion, sha256, source: options.localArchive ? 'offline-archive' : item.url, installedAt: new Date().toISOString(), ...(warmRequired ? { warmState: 'pending' } : {}) };
    await atomicJson(path.join(extracted, MARKER), marker);
    journal.phase = 'prepared'; await atomicJson(p.journal, journal);
    options.signal?.throwIfAborted(); progress('commit');
    // Once switching starts, finish or roll back it; late cancellation must not leave half an install.
    journal.phase = 'switching'; await atomicJson(p.journal, journal);
    if (await exists(p.destination)) await rename(p.destination, path.join(root, journal.backup));
    await rename(extracted, p.destination);
    if (language === 'go' || language === 'cpp') {
      journal.phase = 'warming'; await atomicJson(p.journal, journal); progress('validate');
      await ensureToolchainReady(language, { ...inspection, executable: defaultRuntimePath(language, root) }, { cwd: p.destination, root, signal: options.signal, awaitCancelledTaskDrain: true });
      options.signal?.throwIfAborted();
      marker.warmState = 'ready'; await atomicJson(path.join(p.destination, MARKER), marker);
    }
    journal.phase = 'committed'; await atomicJson(p.journal, journal);
    await recoverOne(root, language, journal);
    progress('ready');
    return { language, target, executable: defaultRuntimePath(language, root), runtimeVersion: inspection.runtimeVersion, compilerVersion: inspection.compilerVersion, sha256, url: item.url, source: options.localArchive ? 'offline-archive' as const : 'download' as const, installedAt: new Date().toISOString() };
  } catch (error) {
    if (journal) { const recovery = await recoverOne(root, language, journal); if (recovery.status === 'needs_attention') throw new Error(`${String(error)}; ${recovery.message}`); }
    throw error;
  } finally {
    if (ownsLock) await rm(p.lock, { force: true });
    activeInstalls.delete(key);
  }
}
export { manifest as runtimeManifest };
export { inspectRuntime } from './runtime-inspect.ts';
