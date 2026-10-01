import { OfficialService } from './official-service';
import type { OfficialSubmitInput } from '../shared/official';
import { setWindowsJobHelperPath } from '../runner/windows-job';
import { startupFailure } from './startup-errors';
import { InterviewService } from '../interview/service';
import type { InterviewRules } from '../shared/interview';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, powerMonitor, protocol, session, shell, Tray } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { runCode } from '../runner/index';
import { inspectRuntime, recoverRuntimeInstallations } from '../runner/managed-runtime';
import { RuntimeManager } from '../runner/runtime-manager';
import { RunPreparations } from './run-preparation';
import { selectPracticeFormat } from './practice-format';
import { assertAnswerFormat, resolvePracticeSpec, defaultAcmTestConfig, validateAcmTestConfig, type AnswerFormat, type AcmTestConfig } from '../shared/answer-format';
import type { RuntimeState } from '../shared/runtime';
import { PracticeStore, testConfigDigest, type JsonValue, type StoredRun } from '../storage/practice-store';
import { LeetCodeCnSourceAdapter, parseSource, SourceError } from '../source/index';
import { demoProblems } from '../shared/demo-problems';
import { demoContent, capability } from '../shared/presentation';
import { LearningController } from './learning-controller';
import { MaintenanceGate } from './maintenance-gate';
import type { SaveSubmissionRemarkInput, SubmissionHistoryFilter, SubmissionHistorySource } from '../shared/submission-history';
import { recoverInterruptedRestore } from './backup-service';
import type { ProblemPageFilter, NotePageFilter, AttemptPageFilter, RunPageFilter } from '../shared/learning';
import type { Page, DraftOptions, RunOptions } from '../shared/bridge';
import { ImportService } from './import-service';
import { SourceSession } from './source-session';
import { createLogger } from './logger';
import type { EnvironmentInfo, RunArchive, RuntimeProgress, WorkspaceData } from '../shared/bridge';
import type { LibraryProblem, ImportJob } from '../shared/library';
import type { ImportInput } from '../source/index';
import type { Language, RunResult } from '../runner/types';

// Keep the existing learning-data directory when the display name changes.
app.setPath('userData', process.env.ALGOPRACTICE_DATA_DIR ? resolve(process.env.ALGOPRACTICE_DATA_DIR) : join(app.getPath('appData'), 'AlgoPractice'));
// The internal name also identifies existing macOS Keychain credentials.
app.setName('AlgoPractice');
const applicationIconPath = join(__dirname, 'assets', 'icon.png');
app.setAboutPanelOptions({ applicationName: '题炼', applicationVersion: app.getVersion(), iconPath: applicationIconPath });
app.setAppUserModelId('local.algopractice.desktop');
if (process.platform === 'win32' && app.isPackaged) setWindowsJobHelperPath(join(process.resourcesPath, 'windows-job-helper.exe'));
protocol.registerSchemesAsPrivileged([{ scheme: 'algopractice', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let win: BrowserWindow;
let tray: Tray;
let store: PracticeStore;
let importer: ImportService;
let sourceSession: SourceSession;
let official: OfficialService;
let learning: LearningController;
let interviews: InterviewService;
let interviewTimer: ReturnType<typeof setInterval> | null = null;
const maintenance = new MaintenanceGate();
let maintenanceAck: { id: string; resolve(): void; reject(error: Error): void } | null = null;
let log: ReturnType<typeof createLogger> = () => {};
let quitting = false;
let readyToQuit = false;
let closePending = false;
let activeRun: { id: string; identity: { problemId: string; language: Language; code: string; scopeId: string; version: string | undefined; optionsKey?: string }; controller: AbortController; promise: Promise<RunArchive> } | null = null;
let runtimes: RuntimeManager;
const preparations = new RunPreparations();
const runtimeStates = new Map<Language, RuntimeState>();
const runtimeChecks = new Map<Language, Promise<RuntimeState>>();
const runtimeStateEpochs = new Map<Language, number>();
let runtimeNotices: string[] = [];
let reminderTimer: ReturnType<typeof setTimeout> | null = null;
let config: { runtimes: Partial<Record<Language, string>>; reminder: { dueAt: string; deliveredAt?: string } | null; autoInstallRuntimes?: boolean; answerFormats?: Record<string, AnswerFormat> };
let configPath: string;
const jsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
function saveConfig(next = config) { const temporary = configPath + '.partial'; writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 }); renameSync(temporary, configPath); config = next; }
function languageValue(value: unknown): Language { if (value !== 'python' && value !== 'java') throw new Error('仅支持 Python 或 Java。'); return value; }
function idValue(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) throw new Error('标识无效。'); return value; }
function scopeValue(value: unknown): string { return value === undefined ? 'practice' : idValue(value); }
function problemValue(value: unknown) { const p = store.getProblem(idValue(value)); if (!p) throw new Error('题目尚未导入。'); return p; }
function codeValue(value: unknown): string { if (typeof value !== 'string' || Buffer.byteLength(value) > 1048576) throw new Error('代码必须是小于 1 MiB 的文本。'); return value; }
function inspectSelectedRuntime(language: Language, signal?: AbortSignal) { return runtimes.inspect(language, { explicitPath: config.runtimes[language], testRoot: process.env.ALGOPRACTICE_RUNTIME_DIR, signal }); }
function invalidateRuntimeState(language: Language): void {
  runtimeStateEpochs.set(language, (runtimeStateEpochs.get(language) ?? 0) + 1);
  runtimeStates.delete(language); runtimeChecks.delete(language);
}
function guardEnvironmentMutation(language?: Language, allowInstalling = false): void {
  if (quitting || maintenance.phase !== 'idle' || interviews?.starting || interviews?.active()) throw new Error('应用或面试状态已变化，请在当前会话结束后重试。');
  if (language && (activeRun?.identity.language === language || (runtimes.state(language).busy && (!allowInstalling || runtimes.state(language).phase === 'uninstalling')))) throw new Error('此语言正在使用，请等待任务完成后重试。');
}
async function runtimeState(language: Language, force = false): Promise<RuntimeState> {
  if (!force && runtimeStates.has(language)) return runtimeStates.get(language)!;
  if (runtimeChecks.has(language)) return runtimeChecks.get(language)!;
  const epoch = runtimeStateEpochs.get(language) ?? 0;
  const task: Promise<RuntimeState> = (async () => {
    const [inspection, details] = await Promise.all([inspectSelectedRuntime(language), runtimes.details(language)]);
    const state: RuntimeState = { status: inspection.status === 'cancelled' ? 'error' : inspection.status,
      source: inspection.source === 'explicit' ? 'selected' : inspection.source === 'managed' ? 'managed' : inspection.source === 'none' ? null : 'discovered',
      path: inspection.source === 'none' ? null : inspection.executable, version: inspection.version ?? null,
      message: inspection.status === 'ready' ? '环境已就绪，可离线运行。' : inspection.blockedByExplicit ? '已选择的环境失效或不兼容，请重新选择，或明确改用托管环境。' : inspection.status === 'incompatible' ? '发现的环境版本不兼容，需要 CPython 3.14.x 或完整 OpenJDK 25。' : inspection.status === 'missing' ? '尚未找到兼容环境。首次运行需要安装或选择已有环境。' : '环境检测未完成，请重新检测或选择有效路径。',
      managedInstalled: details.managed.owned, installedBytes: details.managed.diskBytes,
      artifact: details.artifact.supported && details.artifact.source && details.artifact.downloadBytes !== null ? { version: details.artifact.version, source: details.artifact.source, downloadBytes: details.artifact.downloadBytes, expandedBytes: details.artifact.expandedBytes, peakBytes: details.artifact.peakBytes } : null };
    // A selection/install may change while the probe is awaiting I/O. Never cache or return that old path's state.
    if (epoch !== (runtimeStateEpochs.get(language) ?? 0)) {
      if (quitting || maintenance.phase !== 'idle') throw new Error('环境检测已因应用状态变化而取消。');
      return runtimeState(language, true);
    }
    runtimeStates.set(language, state); return state;
  })().finally(() => { if (runtimeChecks.get(language) === task) runtimeChecks.delete(language); });
  runtimeChecks.set(language, task); return task;
}
function selectedFormat(id: string, language: Language, scope: string, requested?: unknown): AnswerFormat {
  return selectPracticeFormat(problemValue(id).content.mode, config.answerFormats?.[id], requested,
    () => !!store.getActiveAttempt(id, language, 'practice', scope, 'function'));
}
function formatValue(value: unknown): AnswerFormat | undefined { if (value === undefined) return undefined; assertAnswerFormat(value); return value; }
function changed() { if (maintenance.phase !== 'idle') return; if (win && !win.isDestroyed()) win.webContents.send('library:changed'); }
function publicJob(job: ImportJob) { return { ...job, input: '' }; }
function workspace(id: string, language: Language, scope = 'practice', requested?: AnswerFormat): WorkspaceData {
  const format = selectedFormat(id, language, scope, requested);
  const current = problemValue(id); const attempt = store.getActiveAttempt(id, language, 'practice', scope, format) ?? null;
  let problem = attempt ? store.getProblem(id, attempt.problemVersion) ?? current : current;
  if (!problem.content.descriptionFormat) {
    const legacy = demoProblems.find(p => p.id === id);
    if (legacy) problem = { ...problem, content: { ...demoContent(legacy), ...problem.content } };
  }
  const runs = attempt ? store.listRunPage({ attemptId: attempt.id, limit: 20 }) : null;
  const draft = store.getDraft(id, language, scope, format) ?? null;
  const spec = resolvePracticeSpec(problem.content, problem.version, format, draft?.testConfig ?? undefined);
  return { problem, spec, latestVersion: current.version, attempt, draft,
    history: runs ? runs.items.map(row => toArchive(store.getRun(row.id)!)) : [], historyTotal: runs?.total ?? 0 };
}
function beginPractice(id: string, language: Language, scope = 'practice', format?: AnswerFormat) {
  const state = workspace(id, language, scope, format);
  if (!state.attempt) store.startAttempt({ problemId: id, language, problemVersion: state.problem.version, problemSnapshot: jsonValue(state.problem.content), draftScopeId: scope, answerFormat: state.spec!.answerFormat, specVersion: state.spec!.specVersion });
  return workspace(id, language, scope, state.spec!.answerFormat);
}
function preparationIdentity(state: WorkspaceData, language: Language, code: string, scope: string) {
  return JSON.stringify([state.problem.id, state.problem.version, language, state.spec!.answerFormat, state.spec!.specVersion, scope, state.attempt?.id, state.attempt?.isActive, state.draft?.revision ?? 0, code, state.spec!.content.cases, state.spec!.content.acmCompare ?? 'normalized']);
}
function toArchive(row: StoredRun): RunArchive {
  let testConfig: AcmTestConfig | undefined;
  if (row.answerFormat === 'acm') {
    const snapshot = row.testSnapshot as unknown as { cases?: AcmTestConfig['cases']; acmCompare?: AcmTestConfig['compare'] };
    try { testConfig = validateAcmTestConfig({ version: 1, cases: Array.isArray(snapshot) ? snapshot : snapshot?.cases, compare: snapshot?.acmCompare ?? 'normalized' }); }
    catch { /* Legacy snapshots may not contain enough evidence to compare current tests. */ }
  }
  const result = row.status === 'interrupted' ? {
    status: 'interrupted', diagnostics: [{ phase: 'run', message: '应用中断，未取得完整结果。代码快照已保留。' }],
    stdout: '', stderr: '', caseResults: [], runtimeVersion: row.runtimeVersion, durationMs: 0,
    executionScope: 'local-user-code-not-sandboxed', hostPlatform: `${process.platform}-${process.arch}`,
  } : row.result;
  return { id: row.id, attemptId: row.attemptId, problemId: row.problemId, problemVersion: row.problemVersion, code: row.code, language: row.language, createdAt: row.createdAt,
    answerFormat: row.answerFormat, specVersion: row.specVersion, testConfigDigest: row.testConfigDigest,
    testConfig,
    result: result as unknown as RunArchive['result'] };
}
function reveal(page?: Page) { if (win.isDestroyed()) return; win.show(); win.focus(); if (page) win.webContents.send('app:navigate', page); }
function armReminder() {
  if (reminderTimer) clearTimeout(reminderTimer);
  reminderTimer = null;
  if (!config.reminder || config.reminder.deliveredAt || quitting) return;
  const delay = new Date(config.reminder.dueAt).getTime() - Date.now();
  // Expired tasks remain in the queue on startup; only actively scheduled timers deliver.
  if (delay <= 0) return;
  reminderTimer = setTimeout(deliverReminder, Math.min(delay, 2147483647));
}
function deliverReminder() {
  if (!config.reminder || config.reminder.deliveredAt || quitting) return;
  if (new Date(config.reminder.dueAt).getTime() > Date.now()) { armReminder(); return; }
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: '题炼 · 练习提醒', body: '测试提醒已到期。打开工作台查看待办状态。', silent: true });
  notification.on('click', () => reveal('environment'));
  notification.on('failed', (_event, message) => { console.error('notification-failed', message); });
  notification.show();
  try { saveConfig({ ...config, reminder: { ...config.reminder, deliveredAt: new Date().toISOString() } }); }
  catch (error) { console.error('notification-state-save-failed', error); }
}
function trayImage() {
  // Original 18×18 pixel mark: transparent background and three quiet stair steps.
  const width = 18; const pixels = Buffer.alloc((width * 4 + 1) * width);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const on = (x >= 3 && x <= 5 && y >= 10 && y <= 14) || (x >= 7 && x <= 9 && y >= 6 && y <= 14) || (x >= 11 && x <= 13 && y >= 2 && y <= 14);
    const i = y * (width * 4 + 1) + 1 + x * 4; pixels[i] = pixels[i + 1] = pixels[i + 2] = 38; pixels[i + 3] = on ? 255 : 0;
  }
  function chunk(name: string, data: Buffer) { const body = Buffer.concat([Buffer.from(name), data]); let crc = -1; for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ -1) >>> 0); return Buffer.concat([length, body, checksum]); }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(width, 4); header[8] = 8; header[9] = 6;
  const icon = nativeImage.createFromBuffer(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
  if (process.platform === 'darwin') icon.setTemplateImage(true); return icon;
}
function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame?.url !== 'algopractice://app/index.html') throw new Error('IPC 来源无效。');
}
function handle(channel: string, handler: (...args: unknown[]) => unknown) { ipcMain.handle(channel, async (event, ...args) => {
  trusted(event); if (quitting && !['draft:save', 'note:save', 'interview:save', 'submission:save-remark', 'problem-review:save-draft', 'problem-review:draft', 'problem-review:request'].includes(channel)) throw new Error('应用正在退出。');
  try { interviews?.assertChannel(channel, args); const epoch = interviews?.epoch ?? 0; const result = await maintenance.run(channel, () => handler(...args)); interviews?.assertResponse(channel, args, epoch); if (/^(note:|archive:|submission:|app:open|source:open)/.test(channel)) interviews?.recordHelp(channel, typeof args[0] === 'string' ? args[0].slice(0,512) : null); return result; } catch (error) { log('ipc.failed', { operation: channel, category: error instanceof SourceError ? error.code : error instanceof Error ? error.name : 'Error' }); throw error; }
}); }
async function stopAndQuit() {
  preparations.cancel(); activeRun?.controller.abort(); runtimes?.cancelAll();
  if (interviewTimer) clearInterval(interviewTimer);
  try { interviews?.tick(); } catch { log('interview.quit-check-failed', { operation: 'deadline' }); }
  await official?.stopAll();
  await learning?.stop();
  sourceSession?.close();
  try { await Promise.allSettled([activeRun?.promise, ...(runtimes?.pendingPromises ?? []), importer?.stop()]); } catch { /* Interrupted snapshots recover on next startup. */ }
  readyToQuit = true; app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) reveal(); });
  app.on('before-quit', event => {
    if (readyToQuit) return;
    event.preventDefault(); if (maintenance.phase !== 'idle') return; quitting = true;
    if (reminderTimer) clearTimeout(reminderTimer);
    if (!win || win.isDestroyed() || win.webContents.isCrashed() || win.webContents.isDestroyed()) { void stopAndQuit(); return; }
    closePending = true; win.webContents.send('app:closing');
  });
  app.on('will-quit', () => { tray?.destroy(); store?.close(); });
  app.on('activate', () => { if (win) reveal(); });
  void app.whenReady().then(async () => {
    // Packaged macOS apps use the signed bundle icon; source runs use Electron's Dock.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(applicationIconPath);
    const dataDirectory = app.getPath('userData'); mkdirSync(dataDirectory, { recursive: true });
    log = createLogger(join(dataDirectory, 'logs'));
    configPath = join(dataDirectory, 'settings.json');
    config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : { runtimes: {}, reminder: null };
    if (!config || typeof config.runtimes !== 'object') throw new Error('设置文件不可读取；请保留文件以便恢复。');
    await recoverInterruptedRestore(dataDirectory);
    store = new PracticeStore(join(dataDirectory, 'practice.sqlite')); const interrupted = store.recoverInterruptedRuns(); store.recoverImportJobs();
    for (const demo of demoProblems) if (!store.getProblem(demo.id)) store.upsertProblem(demoContent(demo));
    sourceSession = new SourceSession();
    official = new OfficialService(store, sourceSession.officialJudge, { onUpdate: record => { if (win && !win.isDestroyed() && maintenance.phase === 'idle') { win.webContents.send('official:event', record); changed(); learning?.officialCompleted(record); } } });
    official.recover();
    importer = new ImportService(store, sourceSession.adapter, join(dataDirectory, 'media'), changed, log);
    const recovery = await recoverRuntimeInstallations(join(dataDirectory, 'runtimes'));
    runtimes = new RuntimeManager({ root: join(dataDirectory, 'runtimes'), onState: state => {
      // Byte progress does not change the selected executable; keep detection and disk-size caching stable.
      if (!state.progress || !['download', 'copy'].includes(state.phase)) invalidateRuntimeState(state.language);
      if (win && !win.isDestroyed() && state.progress) win.webContents.send('runtime:progress', { language: state.language, ...state.progress });
    } });
    runtimeNotices = recovery.filter(item => item.status === 'needs_attention' || item.status === 'active').map(item => `${item.language === 'python' ? 'Python' : 'Java'}：${item.status === 'active' ? '检测到另一个安装任务，请等待后重启应用。' : '中断的安装需要检查；原有目录已保留，请保留数据目录后处理。'}${item.message ? ` ${item.message}` : ''}`);
    log('app.started', { version: app.getVersion(), platform: process.platform, arch: process.arch, interrupted });
    const rendererRoot = resolve(__dirname, 'renderer');
    protocol.handle('algopractice', async request => {
      const url = new URL(request.url);
      if (url.hostname === 'app' && request.method === 'GET' && /^\/attachment\/[a-f0-9]{64}$/.test(url.pathname)) {
        try { interviews?.assertChannel('attachment:read'); return await maintenance.run('attachment:read', async () => { const { attachment, bytes } = await learning.attachments.read(url.pathname.slice('/attachment/'.length)); if (!attachment.mimeType.startsWith('image/')) return new Response('Use attachment export', { status: 403 }); return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': attachment.mimeType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } }); }); } catch { return new Response('Unavailable', { status: 404 }); }
      }
      if (url.hostname === 'app' && request.method === 'GET' && /^\/media\/[a-f0-9]{64}$/.test(url.pathname)) {
        const imagePath = join(dataDirectory, 'media', url.pathname.slice('/media/'.length));
        if (!existsSync(imagePath)) return new Response('Not found', { status: 404 });
        const bytes = readFileSync(imagePath); const mime = bytes[0] === 137 ? 'image/png' : bytes[0] === 255 ? 'image/jpeg' : bytes.toString('ascii', 0, 3) === 'GIF' ? 'image/gif' : 'image/webp';
        return new Response(bytes, { headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
      }
      const target = resolve(rendererRoot, '.' + decodeURIComponent(url.pathname));
      if (url.hostname !== 'app' || request.method !== 'GET' || !target.startsWith(rendererRoot + sep)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).href);
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    win = new BrowserWindow({ width: 1440, height: 940, minWidth: 760, minHeight: 620, title: '题炼', icon: applicationIconPath, show: false,
      webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    win.on('blur', () => learning?.resetActivity());
    win.on('hide', () => learning?.resetActivity());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (url !== 'algopractice://app/index.html') event.preventDefault(); });
    win.webContents.on('render-process-gone', () => { if (quitting) void stopAndQuit(); });
    win.on('unresponsive', () => {
      void dialog.showMessageBox(win, { type: 'warning', title: '工作台暂时没有响应', message: '可以继续等待，或停止任务并退出。退出会保留已保存的草稿与运行快照。', buttons: ['继续等待', '停止并退出'], defaultId: 0, cancelId: 0 }).then(({ response }) => { if (response === 1) { quitting = true; void stopAndQuit(); } });
    });
    win.on('close', event => {
      if (readyToQuit) return;
      event.preventDefault(); if (maintenance.phase !== 'idle') return;
      if (win.webContents.isCrashed() || win.webContents.isDestroyed()) { if (quitting) void stopAndQuit(); else win.hide(); return; }
      preparations.cancel(); closePending = true; win.webContents.send('app:closing');
    });
    ipcMain.on('app:close-ready', event => { trusted(event); if (!closePending) return; closePending = false; if (quitting) void stopAndQuit(); else win.hide(); });
    ipcMain.on('app:maintenance-ready', (event, requestId, error) => { trusted(event); const ack = maintenanceAck; if (!ack || ack.id !== requestId) return; if (error) ack.reject(new Error('草稿未能完整保存，恢复已取消。')); else ack.resolve(); });
    learning = new LearningController({ dataDirectory, version: app.getVersion(), window: win, store: () => store, handle, changed, reveal, interviewContext: context => interviews?.assertAiContext(context) ?? context, isIdle: () => !quitting && maintenance.phase === 'idle', allowAutomaticAi: () => !interviews?.starting && !interviews?.active(), allowReviewPrompt: () => !closePending && !interviews?.starting && !interviews?.active(), log,
      lifecycle: {
        hasActiveInterview: () => Boolean(interviews?.active()),
        enterMaintenance: async () => {
          maintenance.beginFlush();
          try {
            await new Promise<void>((resolve, reject) => { const requestId = randomUUID(); const timer = setTimeout(() => { maintenanceAck = null; reject(new Error('等待保存超时，恢复已取消。')); }, 15000); maintenanceAck = { id: requestId, resolve: () => { clearTimeout(timer); maintenanceAck = null; resolve(); }, reject: error => { clearTimeout(timer); maintenanceAck = null; reject(error); } }; win.webContents.send('app:maintenance', requestId); });
            preparations.cancel(); activeRun?.controller.abort(); runtimes.cancelAll(); sourceSession.close();
            await official.pause();
            await learning.pause();
            const importing = importer.stop();
            await maintenance.lockAndDrain();
            await Promise.allSettled([activeRun?.promise, ...runtimes.pendingPromises, importing]);
          } catch (error) { maintenance.release(); win.webContents.send('app:maintenance-end'); await learning.resume(); throw error; }
        },
        closeDatabase: () => store.close(),
        openDatabase: () => { const reopened = new PracticeStore(join(dataDirectory, 'practice.sqlite')); try { reopened.integrityCheck(); store = reopened; official.rebind(store); official.recover(); importer = new ImportService(store, sourceSession.adapter, join(dataDirectory, 'media'), changed, log); learning.rebind(); } catch (error) { reopened.close(); throw error; } },
        clearCredentials: async () => { await learning.clearCredentials(); await sourceSession.clear(); },
        leaveMaintenance: async restored => { maintenance.release(); await learning.resume(); if (restored) { await win.loadURL('algopractice://app/index.html'); } else win.webContents.send('app:maintenance-end'); },
      },
    });
    interviews = new InterviewService({ store: () => store, changed, beforeStart: async pool => {
      preparations.cancel();
      if (runtimes.busy || activeRun || learning.backups.status().busy) throw new Error('请先等待运行、安装或备份结束。');
      await official.pause(); await learning.ai.stopAll(); await importer.stop(); sourceSession.close();
      const runtime = await inspectSelectedRuntime(pool.rules.language);
      if (runtime.status !== 'ready') throw new Error('面试运行时未就绪，请先在运行环境中准备对应语言。');
    } });
    interviewTimer = setInterval(() => { try { if (maintenance.phase === 'idle') interviews.tick(); } catch { log('interview.tick-failed', { operation: 'deadline' }); } }, 250);
    powerMonitor.on('resume', () => { try { interviews.tick(true); } catch { log('interview.resume-failed', { operation: 'deadline' }); } });
    handle('interview:state', () => interviews.state());
    handle('interview:preview', rules => interviews.preview(rules as InterviewRules));
    handle('interview:start', (preview, request) => interviews.start(idValue(preview), idValue(request)));
    handle('interview:get', key => interviews.view(idValue(key)));
    handle('interview:save', (key, problem, code, reasoning) => interviews.save(idValue(key), idValue(problem), code, reasoning));
    handle('interview:finish', key => interviews.finish(idValue(key)));
    handle('interview:coach', key => interviews.coach(idValue(key)));
    handle('interview:review', (key, problem) => { const result = interviews.addReview(idValue(key), idValue(problem)); changed(); return result; });
    handle('interview:apply-patch', async (key, request) => {
      const patch = await learning.ai.preparePatch(idValue(request));
      const view = interviews.view(idValue(key)); const item = view.session.items.find(item => item.attemptId === patch.attemptId);
      if (!item || view.session.mode !== 'coached' || view.session.endedAt || item.accepted.codeHash !== patch.baseCodeHash || item.accepted.revision !== patch.expectedDraftRevision) throw new Error('代码或面试状态已变化，请重新分析。');
      return interviews.save(view.session.id, item.problem.id, patch.code, item.accepted.reasoning);
    });
    handle('company:preview', input => interviews.previewCompany(input as { kind: 'csv' | 'json'; text: string; name: string }));
    handle('company:commit', key => interviews.commitCompany(idValue(key)));
    handle('company:complete', async (key, request) => {
      const dataset=store.listCompanyDatasets().find(d=>d.id===idValue(key));if(!dataset)throw new Error('企业数据集不存在。');
      const requestId=idValue(request), existing=store.listImportJobs().find(job=>job.requestKey===requestId);
      if(existing){if(existing.title!==`企业补全 · ${dataset.id}`)throw new Error('导入请求标识冲突。');return publicJob(existing);}
      const urls=[...new Set(dataset.entries.map(entry=>entry.url).filter((url):url is string=>Boolean(url)))];if(!urls.length)throw new Error('此数据集没有题目 URL，请使用普通文件导入补全明确来源标识的题目。');
      const prepared=await importer.prepare({kind:'links',text:urls.join('\n'),name:`企业补全 · ${dataset.id}`});
      interviews.assertChannel('company:complete');return publicJob(importer.start(prepared.id,requestId));
    });
    handle('company:select-file', async () => {
      const selected = await dialog.showOpenDialog(win, { title: '导入企业题单', properties: ['openFile'], filters: [{ name: 'CSV / JSON', extensions: ['csv', 'json'] }] }); if (selected.canceled) return null;
      const file = selected.filePaths[0], extension = extname(file).toLowerCase(); if (!['.csv','.json'].includes(extension) || statSync(file).size > 4*1024*1024) throw new Error('请选择不超过 4 MiB 的 CSV 或 JSON。');
      return { kind: extension === '.csv' ? 'csv' : 'json', text: readFileSync(file,'utf8'), name: basename(file) };
    });
    handle('interview:run', (key, problemId, request, supplement) => {
      const sessionId=idValue(key), problemKey=idValue(problemId), runId=idValue(request);
      if (typeof supplement !== 'boolean') throw new Error('运行类型无效。');
      const target=interviews.runTarget(sessionId,problemKey,supplement), {session,item,code}=target, language=session.pool.rules.language, problem=item.problem.content;
      const previous=store.getRun(runId); if(previous){if(previous.attemptId!==item.attemptId || previous.code!==code)throw new Error('运行请求标识冲突。');if(activeRun?.id===runId)return activeRun.promise;if(previous.status!=='queued')return toArchive(previous);throw new Error('该运行正在等待终态。');}
      if(activeRun||runtimes.state(language).busy)throw new Error('请等待当前运行或此语言的安装完成。');
      const support=capability(problem,language);if(!support.canRun)throw new Error(support.reason);
      const controller=new AbortController();
      const release = runtimes.retain(language, 'run');
      const promise=(async()=>{
        const runtime = await inspectSelectedRuntime(language, controller.signal);
        if (controller.signal.aborted || runtime.status !== 'ready') throw new Error('面试运行环境未就绪；答案已保留，请检查运行环境。');
        interviews.runTarget(sessionId, problemKey, supplement);
        const stored=store.saveRun({id:runId,attemptId:item.attemptId,code,testSuiteVersion:createHash('sha256').update(JSON.stringify([problem.cases,problem.acmCompare??'normalized'])).digest('hex'),testSnapshot:jsonValue({cases:problem.cases,acmCompare:problem.acmCompare??'normalized',interviewSupplement:supplement}),adapterVersion:createHash('sha256').update(JSON.stringify(problem.adapter??{mode:'acm'})).digest('hex'),runtimeVersion:runtime.runtimeVersion});
        let result:RunResult;
        try { result=await runCode({language,code,mode:problem.mode,adapter:problem.adapter,cases:problem.cases,acmCompare:problem.acmCompare,runtimePath:runtime.executable,timeoutMs:10000,outputLimitBytes:1048576},{signal:controller.signal,runId,onEvent:event=>{if(!win.isDestroyed())win.webContents.send('runner:event',event);}}); }
        catch { result={status:'internal_error',diagnostics:[{phase:'run',source:'runner',message:'运行未完成，快照已经保存。'}],stdout:'',stderr:'',caseResults:[],durationMs:0,runtimeVersion:'unknown',hostPlatform:`${process.platform}-${process.arch}`,executionScope:'local-user-code-not-sandboxed'}; }
        const row=store.finishRun(stored.id,{status:result.status,result:jsonValue(result),runtimeVersion:result.runtimeVersion});interviews.tick();changed();return toArchive(row);
      })().finally(()=>{release();if(activeRun?.id===runId)activeRun=null;});
      activeRun={id:runId,identity:{problemId:problemKey,language,code,scopeId:item.scopeId,version:item.problem.version},controller,promise};return promise;
    });
    win.once('ready-to-show', () => win.show());
    tray = new Tray(trayImage()); tray.setToolTip('题炼');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开工作台', click: () => reveal() }, { label: '学习中心', click: () => reveal('today') }, { type: 'separator' }, { label: '完全退出', click: () => app.quit() }]));
    tray.on('click', () => reveal());
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: '题炼', submenu: [{ role: 'about' as const, label: '关于题炼' }, { type: 'separator' as const }, { role: 'hide' as const, label: '隐藏题炼' }, { label: '完全退出题炼', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] }] : []),
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }, { label: '完全退出', click: () => app.quit() }] },
    ]));
    handle('app:environment', async () => {
      const db = new DatabaseSync(':memory:'); const sqlite = String(db.prepare('SELECT sqlite_version() AS version').get()!.version); db.close();
      const [python, java] = await Promise.all([runtimeState('python'), runtimeState('java')]);
      const tasks = runtimes.states().filter(state => state.busy);
      const installations = Object.fromEntries(tasks.map(state => [state.language, { progress: state.progress ? { language: state.language, ...state.progress } : null }]));
      return { platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node, sqlite, python: python.status === 'ready' ? python.path : null, java: java.status === 'ready' ? java.path : null, dataDirectory, notificationSupported: Notification.isSupported(), reminder: config.reminder, runtimeNotices,
        installation: tasks[0] ? { language: tasks[0].language, progress: installations[tasks[0].language].progress } : null,
        installations, runtimeStates: { python, java }, autoInstallRuntimes: config.autoInstallRuntimes === true } satisfies EnvironmentInfo;
    });
    handle('library:index', () => { const page = store.listProblemPage({ limit: 4 }); return { problems: page.items, totalProblems: page.total, lists: store.listLists(), jobs: store.listImportJobs().map(publicJob) }; });
    handle('library:page', filter => store.listProblemPage(filter as ProblemPageFilter));
    handle('note:page', filter => store.listNotePage(filter as NotePageFilter));
    handle('archive:page', filter => store.listAttemptPage(filter as AttemptPageFilter));
    handle('archive:run-page', filter => store.listRunPage(filter as RunPageFilter));
    handle('archive:run-detail', id => { const row = store.getRun(idValue(id)); if (!row || row.status === 'queued') throw new Error('运行快照不存在或尚未完成。'); return toArchive(row); });
    handle('submission:history', filter => store.listSubmissionHistory(filter as SubmissionHistoryFilter));
    handle('submission:detail', (source, id) => store.getSubmissionHistoryDetail(source as SubmissionHistorySource, idValue(id)));
    handle('submission:save-remark', input => { const result = store.saveSubmissionRemark(input as SaveSubmissionRemarkInput); changed(); return result; });
    handle('archive:overview', id => { const attempt = store.getAttempt(idValue(id)); if (!attempt) throw new Error('练习档案不存在。'); return { attempt, runCount: store.listRunPage({ attemptId: attempt.id, limit: 1 }).total, activeMs: store.getArchiveStatistics({ attemptId: attempt.id }).activeMs, interviewId: store.getInterviewForAttempt(attempt.id)?.id ?? null }; });
    handle('archive:learning', id => { const key = idValue(id); if (!store.getAttempt(key)) throw new Error('练习档案不存在。'); return { aiRequests: store.listAIRequests(key), noteVersions: store.getAttemptNoteVersions(key) }; });
    handle('library:list', () => ({ problems: store.listProblems(), lists: store.listLists(), jobs: store.listImportJobs().map(publicJob) }));
    handle('practice:workspace', (id, lang, scope, format) => workspace(idValue(id), languageValue(lang), scopeValue(scope), formatValue(format)));
    handle('practice:start', (id, lang, scope, format) => {
      const key = idValue(id); const result = beginPractice(key, languageValue(lang), scopeValue(scope), formatValue(format)); const selected = result.spec!.answerFormat;
      preparations.cancel(); if (scopeValue(scope) === 'practice') saveConfig({ ...config, answerFormats: { ...config.answerFormats, [key]: selected } }); return result;
    });
    handle('practice:finish', (id, code) => { preparations.cancel(); learning.ai.cancelAttempt(idValue(id)); const result = store.finishAttempt(idValue(id), { code: codeValue(code) }); changed(); return result; });
    handle('draft:load', (id, lang, scope, format) => store.getDraft(problemValue(id).id, languageValue(lang), scopeValue(scope), selectedFormat(idValue(id), languageValue(lang), scopeValue(scope), format)) ?? null);
    handle('draft:save', (id, lang, code, scope, input) => {
      if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error('草稿选项无效。');
      const options = (input ?? {}) as DraftOptions, key = problemValue(id).id, language = languageValue(lang), scopeId = scopeValue(scope);
      const state = workspace(key, language, scopeId, selectedFormat(key, language, scopeId, options.answerFormat));
      return store.saveDraft({ problemId: key, language, code: codeValue(code), scopeId, answerFormat: state.spec!.answerFormat, specVersion: state.spec!.specVersion, testConfig: options.testConfig, expectedRevision: options.expectedRevision });
    });
    handle('run:history', (id, lang, scope) => workspace(idValue(id), languageValue(lang), scopeValue(scope)).history);
    handle('archive:list', () => store.listAttempts().map(attempt => {
      const runs = store.listRuns(attempt.id); const last = runs.filter(run => run.status !== 'queued').at(-1);
      const snapshot = attempt.problemSnapshot as { title?: string } | null;
      return { attempt, title: snapshot?.title || store.getProblem(attempt.problemId)?.content.title || attempt.problemId, runCount: runs.length, lastStatus: last?.status ?? null, activeMs: store.getArchiveStatistics({ attemptId: attempt.id }).activeMs, helpLevel: store.listAIRequests(attempt.id).filter(request => request.status === 'completed').map(request => request.snapshot.level ?? 'adaptive').sort().at(-1) ?? null };
    }));
    handle('archive:get', id => { const attempt = store.getAttempt(idValue(id)); if (!attempt) throw new Error('练习档案不存在。'); return { attempt, runs: store.listRuns(attempt.id).filter(run => run.status !== 'queued').map(toArchive), aiRequests: store.listAIRequests(attempt.id), noteVersions: store.getAttemptNoteVersions(attempt.id), activeMs: store.getArchiveStatistics({ attemptId: attempt.id }).activeMs }; });
    handle('archive:restore', (id, request) => { const restored = store.restoreRunAsDraft(idValue(id), { requestId: idValue(request) }); changed(); return restored; });
    handle('import:preview', input => importer.prepare(input as ImportInput));
    handle('import:hot100', async () => {
      const result = await importer.importHot100(() => {
        if (quitting || maintenance.phase !== 'idle') throw new Error('应用状态已变化，请稍后重试导入。');
        interviews.assertChannel('import:hot100');
      });
      return { ...result, job: result.job ? publicJob(result.job) : null };
    });
    handle('import:select-file', async () => {
      const selected = await dialog.showOpenDialog(win, { title: '导入题目或题单', properties: ['openFile'], filters: [{ name: 'CSV / JSON', extensions: ['csv', 'json'] }] });
      if (selected.canceled) return null;
      const file = selected.filePaths[0]; const extension = extname(file).toLowerCase();
      if (!['.csv', '.json'].includes(extension) || statSync(file).size > 5 * 1024 * 1024) throw new Error('请选择不超过 5 MiB 的 CSV 或 JSON 文件。');
      return { kind: extension === '.csv' ? 'csv' : 'json', text: readFileSync(file, 'utf8'), name: basename(file) } satisfies ImportInput;
    });
    handle('import:start', (preview, request) => publicJob(importer.start(idValue(preview), idValue(request))));
    handle('import:get', id => publicJob(importer.job(idValue(id))));
    handle('import:resume', (id, retry) => publicJob(importer.resume(idValue(id), retry === true)));
    handle('import:pause', id => importer.pause(idValue(id)));
    handle('problem:refresh-preview', id => importer.prepareProblem(idValue(id)));
    handle('problem:refresh-apply', id => importer.applyProblem(idValue(id)));
    handle('list:detach', (id, key, revision) => {
      const list = store.getList(idValue(id)); if (!list || list.revision !== revision) throw new Error('题单已变化，请刷新后重试。');
      const itemKey = idValue(key); if (!list.items.some(item => item.key === itemKey)) throw new Error('题单条目不存在。');
      const preview = store.previewListRefresh({ ...list, items: list.items.filter(item => item.key !== itemKey), membershipComplete: true });
      const result = store.applyListRefresh(preview.id); changed(); return result;
    });
    handle('official:submit', input => { if (interviews.active()) throw new Error('请结束当前面试后再提交到力扣。'); return official.submit(input as OfficialSubmitInput); });
    handle('official:list', key => official.list(idValue(key)));
    handle('official:resume', key => { if (interviews.active()) throw new Error('请结束当前面试后再查询官方结果。'); return official.resume(idValue(key)); });
    handle('source:session', () => sourceSession.state());
    handle('source:login', () => sourceSession.open());
    handle('source:logout', async () => { await official.pause(); await importer.stop(); await sourceSession.clear(); });
    handle('runner:prepare', async (id, lang, text, scope, expectedVersion, requestedFormat) => {
      const problemId = idValue(id), language = languageValue(lang), code = codeValue(text), scopeId = scopeValue(scope);
      const state = workspace(problemId, language, scopeId, selectedFormat(problemId, language, scopeId, requestedFormat));
      if (expectedVersion !== undefined && expectedVersion !== state.problem.version) throw new Error('题面版本已变化，请重新打开后运行。');
      const support = capability(state.spec!.content, language); if (!support.canRun) throw new Error(support.reason);
      if (state.draft && state.draft.code !== code) throw new Error('代码尚未保存，请保存后重新运行。');
      const identity = preparationIdentity(state, language, code, scopeId);
      const token = preparations.create(identity, runtimes.retain(language, 'pending'));
      try {
        const runtime = await runtimeState(language, true);
        preparations.assertCurrent(token, preparationIdentity(workspace(problemId, language, scopeId, state.spec!.answerFormat), language, code, scopeId));
        return { token, runtime, autoInstall: config.autoInstallRuntimes === true };
      } catch (error) { preparations.cancel(token); throw error; }
    });
    handle('runner:cancel-prepared', token => preparations.cancel(idValue(token)));
    handle('runner:run', (id, lang, text, scope, request, expectedVersion, input) => {
      const problemId = idValue(id); const language = languageValue(lang); const code = codeValue(text); const scopeId = scopeValue(scope);
      if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error('运行选项无效。');
      const options = (input ?? {}) as RunOptions, format = selectedFormat(problemId, language, scopeId, options.answerFormat), optionsKey = JSON.stringify([format, options.preparationToken]);
      const runId = request === undefined ? randomUUID() : idValue(request);
      const requestedVersion = expectedVersion === undefined ? undefined : idValue(expectedVersion);
      if (activeRun?.id === runId) {
        const identity = activeRun.identity;
        if (identity.problemId !== problemId || identity.language !== language || identity.code !== code || identity.scopeId !== scopeId || identity.version !== requestedVersion || identity.optionsKey !== optionsKey) throw new Error('运行请求标识与进行中的请求不一致。');
        return activeRun.promise;
      }
      const previous = store.getRun(runId);
      if (previous) {
        const owner = store.getAttempt(previous.attemptId);
        if (previous.problemId !== problemId || previous.language !== language || previous.code !== code || owner?.draftScopeId !== scopeId || owner?.answerFormat !== format || (requestedVersion && previous.problemVersion !== requestedVersion)) throw new Error('运行请求标识与已有快照不一致。');
        if (format === 'acm') { const current = workspace(problemId, language, scopeId, format); if (previous.testConfigDigest !== testConfigDigest(current.draft?.testConfig ?? defaultAcmTestConfig(current.problem.content))) throw new Error('测试输入或比较规则已变化，请使用新的运行请求。'); }
        if (previous.status !== 'queued') return toArchive(previous);
        throw new Error('此前任务尚未取得终态。');
      }
      if (activeRun) throw new Error('已有运行任务，请等待完成或停止。');
      if (runtimes.state(language).busy) throw new Error('此语言环境正在准备，请等待完成。');
      const available = workspace(problemId, language, scopeId, format);
      if (expectedVersion !== undefined && expectedVersion !== available.problem.version) throw new Error('题面版本已变化，请重新打开后运行。');
      const support = capability(available.spec!.content, language); if (!support.canRun) throw new Error(support.reason);
      const identity = preparationIdentity(available, language, code, scopeId);
      if (options.preparationToken) preparations.assertCurrent(idValue(options.preparationToken), identity);
      const controller = new AbortController();
      const release = runtimes.retain(language, 'run');
      const promise = (async () => {
        const inspection = await inspectSelectedRuntime(language, controller.signal);
        if (controller.signal.aborted) throw new Error('运行已取消。');
        if (inspection.status !== 'ready') { invalidateRuntimeState(language); throw new Error('本地语言环境未就绪，请安装或重新选择环境后运行。'); }
        if (maintenance.phase !== 'idle' || quitting || interviews.starting || interviews.active()) throw new Error('当前会话已变化，请重新运行。');
        if (preparationIdentity(workspace(problemId, language, scopeId, format), language, code, scopeId) !== identity) throw new Error('代码、测试配置或练习已变化，请重新运行。');
        if (options.preparationToken) preparations.consume(options.preparationToken, preparationIdentity(workspace(problemId, language, scopeId, format), language, code, scopeId));
        const state = beginPractice(problemId, language, scopeId, format); const problem = state.spec!.content; const attempt = state.attempt!;
        const executable = inspection.executable;
        const testsDigest = format === 'acm' ? testConfigDigest(state.draft?.testConfig ?? defaultAcmTestConfig(state.problem.content)) : null;
        const snapshot = { id: runId, attemptId: attempt.id, code, testSuiteVersion: createHash('sha256').update(JSON.stringify([problem.cases, problem.acmCompare ?? 'normalized'])).digest('hex'),
          testSnapshot: jsonValue({ cases: problem.cases, acmCompare: problem.acmCompare ?? 'normalized', answerFormat: format, specVersion: state.spec!.specVersion, testConfigDigest: testsDigest, expectedOutputSource: state.spec!.expectedOutputSource }), adapterVersion: createHash('sha256').update(JSON.stringify(problem.adapter ?? { mode: 'acm' })).digest('hex'), runtimeVersion: inspection.runtimeVersion, answerFormat: format, specVersion: state.spec!.specVersion, testConfigDigest: testsDigest ?? undefined };
        const currentDraft = store.getDraft(problemId, language, scopeId, format);
        // A delayed run request must never replace a newer autosaved draft.
        const stored = !currentDraft || currentDraft.code === code ? store.beginRun({ ...snapshot, scopeId }) : store.saveRun(snapshot);
        const versionText = inspection.runtimeVersion;
        let result: RunResult;
        try {
          result = await runCode({ language, code, mode: problem.mode, adapter: problem.adapter, cases: problem.cases, acmCompare: problem.acmCompare, runtimePath: executable, timeoutMs: 10000, outputLimitBytes: 1048576 },
            { signal: controller.signal, runId, onEvent: event => { if (!win.isDestroyed()) win.webContents.send('runner:event', event); } });
        } catch {
          result = { status: 'internal_error', diagnostics: [{ phase: 'run', source: 'runner', message: '运行器未正常返回结果；代码快照已保存。' }], stdout: '', stderr: '', caseResults: [], durationMs: 0,
            runtimeVersion: versionText, hostPlatform: `${process.platform}-${process.arch}`, executionScope: 'local-user-code-not-sandboxed' };
        }
        if (result.status === 'environment_error') invalidateRuntimeState(language);
        const archive = toArchive(store.finishRun(stored.id, { status: result.status, result: jsonValue(result), runtimeVersion: versionText }));
        log('run.finished', { result: result.status, language, durationMs: result.durationMs }); changed(); return archive;
      })().finally(() => { release(); if (options.preparationToken) preparations.cancel(options.preparationToken); if (activeRun?.id === runId) activeRun = null; });
      activeRun = { id: runId, identity: { problemId, language, code, scopeId, version: requestedVersion, optionsKey }, controller, promise }; return promise;
    });
    handle('runner:cancel', () => { activeRun?.controller.abort(); });
    handle('runtime:cancel-install', value => { preparations.cancel(); if (value === undefined) runtimes.cancelAll(); else runtimes.cancel(languageValue(value)); });
    handle('runtime:preflight', value => runtimeState(languageValue(value), true));
    handle('runtime:auto-install', value => { if (typeof value !== 'boolean') throw new Error('设置无效。'); guardEnvironmentMutation(); saveConfig({ ...config, autoInstallRuntimes: value }); });
    handle('runtime:reset', value => {
      const language = languageValue(value); guardEnvironmentMutation(language);
      preparations.cancel(); const paths = { ...config.runtimes }; delete paths[language]; saveConfig({ ...config, runtimes: paths }); invalidateRuntimeState(language);
    });
    handle('runtime:uninstall', async value => {
      const language = languageValue(value), details = await runtimes.details(language);
      guardEnvironmentMutation(language);
      if (!details.managed.canUninstall) throw new Error('此托管环境正在使用或需要恢复，暂不能卸载。');
      const result = await dialog.showMessageBox(win, { type: 'warning', title: '卸载托管环境', message: `仅卸载题炼管理的 ${language === 'python' ? 'Python' : 'Java'} 环境？`, detail: '代码、题目、学习记录和你自行安装的环境不会删除。以后可以重新下载安装。', buttons: ['取消', '卸载'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return;
      guardEnvironmentMutation(language);
      await runtimes.uninstall(language);
      guardEnvironmentMutation(language);
      const paths = { ...config.runtimes };
      if (paths[language]?.startsWith(details.managed.directory + sep)) delete paths[language];
      saveConfig({ ...config, runtimes: paths }); invalidateRuntimeState(language);
    });
    handle('runtime:select', async value => {
      const language = languageValue(value); guardEnvironmentMutation(language);
      const result = await dialog.showOpenDialog(win, { title: language === 'python' ? '选择 Python 3.14 可执行文件' : '选择 JDK 25 的 java 可执行文件', properties: ['openFile'] });
      if (result.canceled) return false;
      guardEnvironmentMutation(language);
      const executable = result.filePaths[0];
      const inspection = await inspectRuntime(language, { runtimePath: executable });
      if (inspection.status !== 'ready') throw new Error(inspection.diagnostics.map(diagnostic => diagnostic.message).join('\n') || '运行时不可用。');
      guardEnvironmentMutation(language);
      saveConfig({ ...config, runtimes: { ...config.runtimes, [language]: executable } });
      invalidateRuntimeState(language);
      return true;
    });
    handle('runtime:install', async (value, offline) => {
      const language = languageValue(value); guardEnvironmentMutation(language, true);
      let localArchive: string | undefined;
      if (offline === true) {
        const selected = await dialog.showOpenDialog(win, { title: '选择固定清单对应的离线运行时包', properties: ['openFile'] });
        if (selected.canceled) return false; localArchive = selected.filePaths[0];
        guardEnvironmentMutation(language, true);
      }
      await runtimes.install(language, { localArchive });
      guardEnvironmentMutation(language, true);
      // Explicit installation is consent to use this managed runtime, never a change to system PATH.
      const paths = { ...config.runtimes }; delete paths[language]; saveConfig({ ...config, runtimes: paths }); invalidateRuntimeState(language);
      return true;
    });
    handle('reminder:schedule', value => { if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 3600) throw new Error('提醒时间应在 1 到 3600 秒之间。'); saveConfig({ ...config, reminder: { dueAt: new Date(Date.now() + value * 1000).toISOString() } }); armReminder(); });
    handle('reminder:clear', () => { saveConfig({ ...config, reminder: null }); armReminder(); });
    handle('source:probe', async value => {
      if (typeof value !== 'string' || value.length > 2048) throw new Error('链接格式无效。');
      try { const reference = parseSource(value); const adapter = sourceSession.adapter; return await (reference.kind === 'problem' ? adapter.fetchProblem(reference) : adapter.fetchPlan(reference)); }
      catch (error) { if (error instanceof SourceError) return { error: error.toJSON() }; throw error; }
    });
    handle('source:open', value => { if (typeof value !== 'string') throw new Error('链接格式无效。'); return shell.openExternal(parseSource(value).canonicalUrl); });
    powerMonitor.on('suspend', () => learning.resetActivity());
    powerMonitor.on('suspend', () => { try { interviews.suspend(); } catch { log('interview.suspend-failed', { operation: 'deadline' }); } });
    powerMonitor.on('resume', () => { learning.resetActivity(); if (maintenance.phase === 'idle') void learning.reminders.tick('resume'); if (config.reminder && new Date(config.reminder.dueAt).getTime() <= Date.now()) deliverReminder(); else armReminder(); });
    armReminder();
    await win.loadURL('algopractice://app/index.html');
    await learning.start();
  }).catch(error => { const failure = startupFailure(error, app.getPath('userData')); log('app.startup-failed', { category: failure.kind }); dialog.showErrorBox(failure.title, failure.message); readyToQuit = true; app.quit(); });
}
