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
import { defaultRuntimePath, runCode } from '../runner/index';
import { installRuntime, inspectRuntime, recoverRuntimeInstallations } from '../runner/managed-runtime';
import { runProcess } from '../runner/process';
import { PracticeStore, type JsonValue, type StoredRun } from '../storage/practice-store';
import { LeetCodeCnSourceAdapter, parseSource, SourceError } from '../source/index';
import { demoProblems } from '../shared/demo-problems';
import { demoContent, capability } from '../shared/presentation';
import { LearningController } from './learning-controller';
import { MaintenanceGate } from './maintenance-gate';
import { recoverInterruptedRestore } from './backup-service';
import type { ProblemPageFilter, NotePageFilter, AttemptPageFilter, RunPageFilter } from '../shared/learning';
import type { Page } from '../shared/bridge';
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
app.setAboutPanelOptions({ applicationName: '题炼', applicationVersion: app.getVersion() });
app.setAppUserModelId('local.algopractice.desktop');
if (process.platform === 'win32' && app.isPackaged) setWindowsJobHelperPath(join(process.resourcesPath, 'windows-job-helper.exe'));
protocol.registerSchemesAsPrivileged([{ scheme: 'algopractice', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let win: BrowserWindow;
let tray: Tray;
let store: PracticeStore;
let importer: ImportService;
let sourceSession: SourceSession;
let learning: LearningController;
let interviews: InterviewService;
let interviewTimer: ReturnType<typeof setInterval> | null = null;
const maintenance = new MaintenanceGate();
let maintenanceAck: { id: string; resolve(): void; reject(error: Error): void } | null = null;
let log: ReturnType<typeof createLogger> = () => {};
let quitting = false;
let readyToQuit = false;
let closePending = false;
let activeRun: { id: string; identity: { problemId: string; language: Language; code: string; scopeId: string; version: string | undefined }; controller: AbortController; promise: Promise<RunArchive> } | null = null;
let installing: { language: Language; progress: RuntimeProgress | null; controller: AbortController; promise: Promise<void> } | null = null;
let runtimeNotices: string[] = [];
let reminderTimer: ReturnType<typeof setTimeout> | null = null;
let config: { runtimes: Partial<Record<Language, string>>; reminder: { dueAt: string; deliveredAt?: string } | null };
let configPath: string;
const jsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
function saveConfig(next = config) { const temporary = configPath + '.partial'; writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 }); renameSync(temporary, configPath); config = next; }
function languageValue(value: unknown): Language { if (value !== 'python' && value !== 'java') throw new Error('仅支持 Python 或 Java。'); return value; }
function idValue(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) throw new Error('标识无效。'); return value; }
function scopeValue(value: unknown): string { return value === undefined ? 'practice' : idValue(value); }
function problemValue(value: unknown) { const p = store.getProblem(idValue(value)); if (!p) throw new Error('题目尚未导入。'); return p; }
function codeValue(value: unknown): string { if (typeof value !== 'string' || Buffer.byteLength(value) > 1048576) throw new Error('代码必须是小于 1 MiB 的文本。'); return value; }
function runtimePath(language: Language) { return config.runtimes[language] ?? defaultRuntimePath(language, process.env.ALGOPRACTICE_RUNTIME_DIR ?? join(app.getPath('userData'), 'runtimes')); }
function changed() { if (maintenance.phase !== 'idle') return; if (win && !win.isDestroyed()) win.webContents.send('library:changed'); }
function publicJob(job: ImportJob) { return { ...job, input: '' }; }
function workspace(id: string, language: Language, scope = 'practice'): WorkspaceData {
  const current = problemValue(id); const attempt = store.getActiveAttempt(id, language, 'practice', scope) ?? null;
  let problem = attempt ? store.getProblem(id, attempt.problemVersion) ?? current : current;
  if (!problem.content.descriptionFormat) {
    const legacy = demoProblems.find(p => p.id === id);
    if (legacy) problem = { ...problem, content: { ...demoContent(legacy), ...problem.content } };
  }
  const runs = attempt ? store.listRunPage({ attemptId: attempt.id, limit: 20 }) : null;
  return { problem, latestVersion: current.version, attempt, draft: store.getDraft(id, language, scope) ?? null,
    history: runs ? runs.items.map(row => toArchive(store.getRun(row.id)!)) : [], historyTotal: runs?.total ?? 0 };
}
function beginPractice(id: string, language: Language, scope = 'practice') {
  const state = workspace(id, language, scope);
  if (!state.attempt) store.startAttempt({ problemId: id, language, problemVersion: state.problem.version, problemSnapshot: jsonValue(state.problem.content), draftScopeId: scope });
  return workspace(id, language, scope);
}
function toArchive(row: StoredRun): RunArchive {
  const result = row.status === 'interrupted' ? {
    status: 'interrupted', diagnostics: [{ phase: 'run', message: '应用中断，未取得完整结果。代码快照已保留。' }],
    stdout: '', stderr: '', caseResults: [], runtimeVersion: row.runtimeVersion, durationMs: 0,
    executionScope: 'local-user-code-not-sandboxed', hostPlatform: `${process.platform}-${process.arch}`,
  } : row.result;
  return { id: row.id, attemptId: row.attemptId, problemId: row.problemId, problemVersion: row.problemVersion, code: row.code, language: row.language, createdAt: row.createdAt, result: result as unknown as RunArchive['result'] };
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
  trusted(event); if (quitting && !['draft:save', 'note:save', 'interview:save'].includes(channel)) throw new Error('应用正在退出。');
  try { interviews?.assertChannel(channel, args); const epoch = interviews?.epoch ?? 0; const result = await maintenance.run(channel, () => handler(...args)); interviews?.assertResponse(channel, args, epoch); if (/^(note:|archive:|app:open|source:open)/.test(channel)) interviews?.recordHelp(channel, typeof args[0] === 'string' ? args[0].slice(0,512) : null); return result; } catch (error) { log('ipc.failed', { operation: channel, category: error instanceof SourceError ? error.code : error instanceof Error ? error.name : 'Error' }); throw error; }
}); }
async function stopAndQuit() {
  activeRun?.controller.abort(); installing?.controller.abort();
  if (interviewTimer) clearInterval(interviewTimer);
  try { interviews?.tick(); } catch { log('interview.quit-check-failed', { operation: 'deadline' }); }
  await learning?.stop();
  sourceSession?.close();
  try { await Promise.allSettled([activeRun?.promise, installing?.promise, importer?.stop()]); } catch { /* Interrupted snapshots recover on next startup. */ }
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
    const dataDirectory = app.getPath('userData'); mkdirSync(dataDirectory, { recursive: true });
    log = createLogger(join(dataDirectory, 'logs'));
    configPath = join(dataDirectory, 'settings.json');
    config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : { runtimes: {}, reminder: null };
    if (!config || typeof config.runtimes !== 'object') throw new Error('设置文件不可读取；请保留文件以便恢复。');
    await recoverInterruptedRestore(dataDirectory);
    store = new PracticeStore(join(dataDirectory, 'practice.sqlite')); const interrupted = store.recoverInterruptedRuns(); store.recoverImportJobs();
    for (const demo of demoProblems) if (!store.getProblem(demo.id)) store.upsertProblem(demoContent(demo));
    sourceSession = new SourceSession();
    importer = new ImportService(store, sourceSession.adapter, join(dataDirectory, 'media'), changed, log);
    const recovery = await recoverRuntimeInstallations(join(dataDirectory, 'runtimes'));
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
    win = new BrowserWindow({ width: 1440, height: 940, minWidth: 760, minHeight: 620, title: '题炼', show: false,
      webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
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
      closePending = true; win.webContents.send('app:closing');
    });
    ipcMain.on('app:close-ready', event => { trusted(event); if (!closePending) return; closePending = false; if (quitting) void stopAndQuit(); else win.hide(); });
    ipcMain.on('app:maintenance-ready', (event, requestId, error) => { trusted(event); const ack = maintenanceAck; if (!ack || ack.id !== requestId) return; if (error) ack.reject(new Error('草稿未能完整保存，恢复已取消。')); else ack.resolve(); });
    learning = new LearningController({ dataDirectory, version: app.getVersion(), window: win, store: () => store, handle, changed, reveal, interviewContext: context => interviews?.assertAiContext(context) ?? context, isIdle: () => !quitting && maintenance.phase === 'idle', log,
      lifecycle: {
        hasActiveInterview: () => Boolean(interviews?.active()),
        enterMaintenance: async () => {
          maintenance.beginFlush();
          try {
            await new Promise<void>((resolve, reject) => { const requestId = randomUUID(); const timer = setTimeout(() => { maintenanceAck = null; reject(new Error('等待保存超时，恢复已取消。')); }, 15000); maintenanceAck = { id: requestId, resolve: () => { clearTimeout(timer); maintenanceAck = null; resolve(); }, reject: error => { clearTimeout(timer); maintenanceAck = null; reject(error); } }; win.webContents.send('app:maintenance', requestId); });
            activeRun?.controller.abort(); installing?.controller.abort(); sourceSession.close();
            await learning.pause();
            const importing = importer.stop();
            await maintenance.lockAndDrain();
            await Promise.allSettled([activeRun?.promise, installing?.promise, importing]);
          } catch (error) { maintenance.release(); win.webContents.send('app:maintenance-end'); await learning.resume(); throw error; }
        },
        closeDatabase: () => store.close(),
        openDatabase: () => { const reopened = new PracticeStore(join(dataDirectory, 'practice.sqlite')); try { reopened.integrityCheck(); store = reopened; importer = new ImportService(store, sourceSession.adapter, join(dataDirectory, 'media'), changed, log); learning.rebind(); } catch (error) { reopened.close(); throw error; } },
        clearCredentials: async () => { await learning.clearCredentials(); await sourceSession.clear(); },
        leaveMaintenance: async restored => { maintenance.release(); await learning.resume(); if (restored) { await win.loadURL('algopractice://app/index.html'); } else win.webContents.send('app:maintenance-end'); },
      },
    });
    interviews = new InterviewService({ store: () => store, changed, beforeStart: async pool => {
      if (installing || activeRun || learning.backups.status().busy) throw new Error('请先等待运行、安装或备份结束。');
      await learning.ai.stopAll(); await importer.stop(); sourceSession.close();
      const runtime = await inspectRuntime(pool.rules.language, { runtimePath: runtimePath(pool.rules.language) });
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
      if(activeRun||installing)throw new Error('请等待当前运行或安装完成。');
      const support=capability(problem,language);if(!support.canRun)throw new Error(support.reason);
      const controller=new AbortController();
      const stored=store.saveRun({id:runId,attemptId:item.attemptId,code,testSuiteVersion:createHash('sha256').update(JSON.stringify([problem.cases,problem.acmCompare??'normalized'])).digest('hex'),testSnapshot:jsonValue({cases:problem.cases,acmCompare:problem.acmCompare??'normalized',interviewSupplement:supplement}),adapterVersion:createHash('sha256').update(JSON.stringify(problem.adapter??{mode:'acm'})).digest('hex'),runtimeVersion:'pending-inspection'});
      const promise=(async()=>{
        let result:RunResult;
        try { result=await runCode({language,code,mode:problem.mode,adapter:problem.adapter,cases:problem.cases,acmCompare:problem.acmCompare,runtimePath:runtimePath(language),timeoutMs:10000,outputLimitBytes:1048576},{signal:controller.signal,runId,onEvent:event=>{if(!win.isDestroyed())win.webContents.send('runner:event',event);}}); }
        catch { result={status:'internal_error',diagnostics:[{phase:'run',source:'runner',message:'运行未完成，快照已经保存。'}],stdout:'',stderr:'',caseResults:[],durationMs:0,runtimeVersion:'unknown',hostPlatform:`${process.platform}-${process.arch}`,executionScope:'local-user-code-not-sandboxed'}; }
        const row=store.finishRun(stored.id,{status:result.status,result:jsonValue(result),runtimeVersion:result.runtimeVersion});interviews.tick();changed();return toArchive(row);
      })().finally(()=>{if(activeRun?.id===runId)activeRun=null;});
      activeRun={id:runId,identity:{problemId:problemKey,language,code,scopeId:item.scopeId,version:item.problem.version},controller,promise};return promise;
    });
    win.once('ready-to-show', () => win.show());
    tray = new Tray(trayImage()); tray.setToolTip('题炼');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开工作台', click: () => reveal() }, { label: '今日复习与提醒', click: () => reveal('today') }, { type: 'separator' }, { label: '完全退出', click: () => app.quit() }]));
    tray.on('click', () => reveal());
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: '题炼', submenu: [{ role: 'about' as const, label: '关于题炼' }, { type: 'separator' as const }, { role: 'hide' as const, label: '隐藏题炼' }, { label: '完全退出题炼', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] }] : []),
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }, { label: '完全退出', click: () => app.quit() }] },
    ]));
    handle('app:environment', () => {
      const db = new DatabaseSync(':memory:'); const sqlite = String(db.prepare('SELECT sqlite_version() AS version').get()!.version); db.close();
      return { platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node, sqlite, python: existsSync(runtimePath('python')) ? runtimePath('python') : null, java: existsSync(runtimePath('java')) ? runtimePath('java') : null, dataDirectory, notificationSupported: Notification.isSupported(), reminder: config.reminder, runtimeNotices, installation: installing ? { language: installing.language, progress: installing.progress } : null } satisfies EnvironmentInfo;
    });
    handle('library:index', () => { const page = store.listProblemPage({ limit: 4 }); return { problems: page.items, totalProblems: page.total, lists: store.listLists(), jobs: store.listImportJobs().map(publicJob) }; });
    handle('library:page', filter => store.listProblemPage(filter as ProblemPageFilter));
    handle('note:page', filter => store.listNotePage(filter as NotePageFilter));
    handle('archive:page', filter => store.listAttemptPage(filter as AttemptPageFilter));
    handle('archive:run-page', filter => store.listRunPage(filter as RunPageFilter));
    handle('archive:run-detail', id => { const row = store.getRun(idValue(id)); if (!row || row.status === 'queued') throw new Error('运行快照不存在或尚未完成。'); return toArchive(row); });
    handle('archive:overview', id => { const attempt = store.getAttempt(idValue(id)); if (!attempt) throw new Error('练习档案不存在。'); return { attempt, runCount: store.listRunPage({ attemptId: attempt.id, limit: 1 }).total, activeMs: store.getArchiveStatistics({ attemptId: attempt.id }).activeMs, interviewId: store.getInterviewForAttempt(attempt.id)?.id ?? null }; });
    handle('archive:learning', id => { const key = idValue(id); if (!store.getAttempt(key)) throw new Error('练习档案不存在。'); return { aiRequests: store.listAIRequests(key), noteVersions: store.getAttemptNoteVersions(key) }; });
    handle('library:list', () => ({ problems: store.listProblems(), lists: store.listLists(), jobs: store.listImportJobs().map(publicJob) }));
    handle('practice:workspace', (id, lang, scope) => workspace(idValue(id), languageValue(lang), scopeValue(scope)));
    handle('practice:start', (id, lang, scope) => beginPractice(idValue(id), languageValue(lang), scopeValue(scope)));
    handle('practice:finish', (id, code) => { learning.ai.cancelAttempt(idValue(id)); const result = store.finishAttempt(idValue(id), { code: codeValue(code) }); changed(); return result; });
    handle('draft:load', (id, lang, scope) => store.getDraft(problemValue(id).id, languageValue(lang), scopeValue(scope)) ?? null);
    handle('draft:save', (id, lang, code, scope) => store.saveDraft({ problemId: problemValue(id).id, language: languageValue(lang), code: codeValue(code), scopeId: scopeValue(scope) }));
    handle('run:history', (id, lang, scope) => workspace(idValue(id), languageValue(lang), scopeValue(scope)).history);
    handle('archive:list', () => store.listAttempts().map(attempt => {
      const runs = store.listRuns(attempt.id); const last = runs.filter(run => run.status !== 'queued').at(-1);
      const snapshot = attempt.problemSnapshot as { title?: string } | null;
      return { attempt, title: snapshot?.title || store.getProblem(attempt.problemId)?.content.title || attempt.problemId, runCount: runs.length, lastStatus: last?.status ?? null, activeMs: store.getArchiveStatistics({ attemptId: attempt.id }).activeMs, helpLevel: store.listAIRequests(attempt.id).filter(request => request.status === 'completed').map(request => request.snapshot.level).sort().at(-1) ?? null };
    }));
    handle('archive:get', id => { const attempt = store.getAttempt(idValue(id)); if (!attempt) throw new Error('练习档案不存在。'); return { attempt, runs: store.listRuns(attempt.id).filter(run => run.status !== 'queued').map(toArchive), aiRequests: store.listAIRequests(attempt.id), noteVersions: store.getAttemptNoteVersions(attempt.id), activeMs: store.getArchiveStatistics({ attemptId: attempt.id }).activeMs }; });
    handle('archive:restore', (id, request) => { const restored = store.restoreRunAsDraft(idValue(id), { requestId: idValue(request) }); changed(); return restored; });
    handle('import:preview', input => importer.prepare(input as ImportInput));
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
    handle('source:session', () => sourceSession.state());
    handle('source:login', () => sourceSession.open());
    handle('source:logout', async () => { await importer.stop(); await sourceSession.clear(); });
    handle('runner:run', (id, lang, text, scope, request, expectedVersion) => {
      const problemId = idValue(id); const language = languageValue(lang); const code = codeValue(text); const scopeId = scopeValue(scope);
      const runId = request === undefined ? randomUUID() : idValue(request);
      const requestedVersion = expectedVersion === undefined ? undefined : idValue(expectedVersion);
      if (activeRun?.id === runId) {
        const identity = activeRun.identity;
        if (identity.problemId !== problemId || identity.language !== language || identity.code !== code || identity.scopeId !== scopeId || identity.version !== requestedVersion) throw new Error('运行请求标识与进行中的请求不一致。');
        return activeRun.promise;
      }
      const previous = store.getRun(runId);
      if (previous) {
        const owner = store.getAttempt(previous.attemptId);
        if (previous.problemId !== problemId || previous.language !== language || previous.code !== code || owner?.draftScopeId !== scopeId || (requestedVersion && previous.problemVersion !== requestedVersion)) throw new Error('运行请求标识与已有快照不一致。');
        if (previous.status !== 'queued') return toArchive(previous);
        throw new Error('此前任务尚未取得终态。');
      }
      if (activeRun) throw new Error('已有运行任务，请等待完成或停止。');
      if (installing) throw new Error('运行时正在安装，请等待安装完成。');
      const available = workspace(problemId, language, scopeId);
      if (expectedVersion !== undefined && expectedVersion !== available.problem.version) throw new Error('题面版本已变化，请重新打开后运行。');
      const support = capability(available.problem.content, language); if (!support.canRun) throw new Error(support.reason);
      const state = beginPractice(problemId, language, scopeId); const problem = state.problem.content; const attempt = state.attempt!;
      const controller = new AbortController();
      const promise = (async () => {
        const executable = runtimePath(language);
        const snapshot = { id: runId, attemptId: attempt.id, code, testSuiteVersion: createHash('sha256').update(JSON.stringify([problem.cases, problem.acmCompare ?? 'normalized'])).digest('hex'),
          testSnapshot: jsonValue({ cases: problem.cases, acmCompare: problem.acmCompare ?? 'normalized' }), adapterVersion: createHash('sha256').update(JSON.stringify(problem.adapter ?? { mode: 'acm' })).digest('hex'), runtimeVersion: 'pending-inspection' };
        const currentDraft = store.getDraft(problemId, language, scopeId);
        // A delayed run request must never replace a newer autosaved draft.
        const stored = !currentDraft || currentDraft.code === code ? store.beginRun({ ...snapshot, scopeId }) : store.saveRun(snapshot);
        const version = await runProcess(executable, ['--version'], { cwd: dataDirectory, timeoutMs: 5000, outputLimitBytes: 8192, signal: controller.signal });
        const versionText = (version.stdout + version.stderr).trim() || 'environment-unavailable';
        let result: RunResult;
        try {
          result = await runCode({ language, code, mode: problem.mode, adapter: problem.adapter, cases: problem.cases, acmCompare: problem.acmCompare, runtimePath: executable, timeoutMs: 10000, outputLimitBytes: 1048576 },
            { signal: controller.signal, runId, onEvent: event => { if (!win.isDestroyed()) win.webContents.send('runner:event', event); } });
        } catch {
          result = { status: 'internal_error', diagnostics: [{ phase: 'run', source: 'runner', message: '运行器未正常返回结果；代码快照已保存。' }], stdout: '', stderr: '', caseResults: [], durationMs: 0,
            runtimeVersion: versionText, hostPlatform: `${process.platform}-${process.arch}`, executionScope: 'local-user-code-not-sandboxed' };
        }
        const archive = toArchive(store.finishRun(stored.id, { status: result.status, result: jsonValue(result), runtimeVersion: versionText }));
        log('run.finished', { result: result.status, language, durationMs: result.durationMs }); changed(); return archive;
      })().finally(() => { activeRun = null; });
      activeRun = { id: runId, identity: { problemId, language, code, scopeId, version: requestedVersion }, controller, promise }; return promise;
    });
    handle('runner:cancel', () => { activeRun?.controller.abort(); });
    handle('runtime:cancel-install', () => { installing?.controller.abort(); });
    handle('runtime:select', async value => {
      const language = languageValue(value); if (activeRun || installing) throw new Error('请等待当前任务完成。');
      const result = await dialog.showOpenDialog(win, { title: language === 'python' ? '选择 Python 3.14 可执行文件' : '选择 JDK 25 的 java 可执行文件', properties: ['openFile'] });
      if (result.canceled) return;
      if (maintenance.phase !== 'idle' || activeRun || installing) throw new Error('已有任务开始，请等待完成后重试。');
      const executable = result.filePaths[0];
      const inspection = await inspectRuntime(language, { runtimePath: executable });
      if (inspection.status !== 'ready') throw new Error(inspection.diagnostics.map(diagnostic => diagnostic.message).join('\n') || '运行时不可用。');
      if (maintenance.phase !== 'idle' || activeRun || installing) throw new Error('已有任务开始，请等待完成后重试。');
      saveConfig({ ...config, runtimes: { ...config.runtimes, [language]: executable } });
    });
    handle('runtime:install', async (value, offline) => {
      const language = languageValue(value); if (activeRun || installing) throw new Error('请等待当前任务完成。');
      let localArchive: string | undefined;
      if (offline === true) {
        const selected = await dialog.showOpenDialog(win, { title: '选择固定清单对应的离线运行时包', properties: ['openFile'] });
        if (selected.canceled) return; localArchive = selected.filePaths[0];
        if (maintenance.phase !== 'idle' || activeRun || installing) throw new Error('已有任务开始，请等待完成后重试。');
      }
      const controller = new AbortController();
      const promise = (async () => {
        let lastUpdate = 0;
        const installed = await installRuntime(language, { root: join(dataDirectory, 'runtimes'), localArchive, signal: controller.signal, onProgress: progress => {
          if (installing?.controller === controller) installing.progress = { language, ...progress };
          if (progress.phase !== 'download' || Date.now() - lastUpdate >= 200) { lastUpdate = Date.now(); if (!win.isDestroyed()) win.webContents.send('runtime:progress', { language, ...progress }); }
        } });
        saveConfig({ ...config, runtimes: { ...config.runtimes, [language]: installed.executable } });
      })().finally(() => { installing = null; });
      installing = { language, progress: null, controller, promise };
      return promise;
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
