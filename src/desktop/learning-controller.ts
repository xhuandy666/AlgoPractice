import { dialog, Notification, safeStorage, shell, type BrowserWindow } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PracticeStore, type StoredRun } from '../storage/practice-store';
import { AiService, CredentialVault, normalizeProviderConfig, helpCardDecision, sha256 } from '../ai/index';
import type { AiProviderConfig, AiRequestInput, AiTrustedContext, AiRunEvidence, AiHelpRun, AiDiagnostic } from '../shared/ai';
import type { AddReviewItemInput, ConfirmNoteInput, CorrectReviewInput, NoteFilter, ReviewFeedbackInput, ReviewFilter, SaveNoteInput } from '../shared/learning';
import type { BackupSummary, RestoreLifecycle } from '../shared/maintenance';
import type { Page } from '../shared/bridge';
import type { ProblemContent } from '../shared/library';
import type { RunResult } from '../runner/types';
import { AttachmentService, attachmentExtensions } from './attachment-service';
import { BackupService } from './backup-service';
import { ReminderService } from './reminder-service';
const id = (value: unknown) => { if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error('标识无效。'); return value; };
const integer = (value: unknown) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('版本无效。'); return value; };
interface Options { dataDirectory: string; version: string; window: BrowserWindow; store(): PracticeStore; handle(channel: string, handler: (...args: unknown[]) => unknown): void; changed(): void; reveal(page: Page): void; lifecycle: RestoreLifecycle; isIdle(): boolean; interviewContext?(context: AiTrustedContext): AiTrustedContext; log(event: string, data: Record<string, string | number | boolean | null>): void; }
export class LearningController {
  readonly vault: CredentialVault; readonly attachments: AttachmentService; readonly backups: BackupService; readonly reminders: ReminderService;
  ai!: AiService; #provider: AiProviderConfig | null = null; #automatic: ReturnType<typeof setInterval> | null = null; #autoTask: Promise<unknown> | null = null;
  #attachmentQueue: Promise<void> = Promise.resolve(); #gcTask: Promise<void> | null = null;
  #pulse: { attemptId: string; at: number } | null = null; #previews = new Map<string, BackupSummary>(); readonly #providerPath: string;
  constructor(private readonly options: Options) {
    this.#providerPath = join(options.dataDirectory, 'ai-provider.json');
    this.vault = new CredentialVault({ directory: join(options.dataDirectory, 'credentials'), safeStorage });
    this.attachments = new AttachmentService({ directory: join(options.dataDirectory, 'attachments'), getAttachment: hash => options.store().getAttachment(hash), registerAttachment: attachment => options.store().registerAttachment(attachment) });
    const notifications = new Map<string, Notification>();
    this.reminders = new ReminderService({ directory: options.dataDirectory, timeZone: () => options.store().getLearningSettings().timeZone, dueCount: () => options.store().getTodayQueue().dueCount,
      notifier: { notify: input => { if (!Notification.isSupported()) throw new Error('当前系统不支持桌面提醒。'); const notification = new Notification({ title: input.title, body: input.body }); notifications.set(input.id, notification); notification.on('click', input.onClick); notification.on('failed', (_event, message) => input.onFailure(message)); notification.on('close', () => notifications.delete(input.id)); notification.show(); }, dismiss: key => { notifications.get(key)?.close(); notifications.delete(key); } },
      onNavigateQueue: () => options.reveal('today'), onChanged: options.changed });
    this.backups = new BackupService({ dataDirectory: options.dataDirectory, appVersion: options.version, snapshotDatabase: destination => options.store().backupTo(destination), inspectSnapshot: PracticeStore.inspectBackupSnapshot, getReminderSettings: () => this.reminders.settings(), getAiProvider: () => this.#provider, lifecycle: options.lifecycle });
    this.rebind(); this.#register();
  }
  rebind() {
    const savedProvider = existsSync(this.#providerPath) ? JSON.parse(readFileSync(this.#providerPath, 'utf8')) : null;
    this.#provider = savedProvider === null ? null : normalizeProviderConfig(savedProvider);
    this.ai = new AiService({ repository: this.options.store(), vault: this.vault, resolveProvider: () => this.#provider, resolveContext: input => this.#context(input), onEvent: event => { if (!this.options.window.isDestroyed()) this.options.window.webContents.send('ai:event', event); if (['completed','failed','cancelled','interrupted'].includes(event.phase)) this.options.changed(); } });
    this.ai.recoverInterrupted(); this.#pulse = null;
  }
  #runEvidence(row: StoredRun | undefined): AiRunEvidence | null {
    if (!row || row.status === 'queued' || row.status === 'interrupted') return null;
    const result = row.result as unknown as RunResult;
    const diagnostics: AiDiagnostic[] = (result.diagnostics ?? []).map(value => ({ message: value.message, source: value.source ?? 'runner', ...(value.line ? { line: value.line } : {}), ...(value.column ? { column: value.column } : {}) }));
    return { id: row.id, attemptId: row.attemptId, problemVersion: row.problemVersion, codeHash: row.codeHash, status: row.status, trustworthyExpected: (result.caseResults ?? []).some(test => test.expected !== undefined), diagnostics, caseResults: (result.caseResults ?? []).map(test => ({ index: test.index, status: test.status, ...(test.actual !== undefined ? { actual: test.actual } : {}), ...(test.expected !== undefined ? { expected: test.expected } : {}) })), stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
  #context(input: AiRequestInput): AiTrustedContext {
    const store = this.options.store(), attempt = store.getAttempt(input.attemptId); if (!attempt) throw new Error('练习不存在。');
    const content = attempt.problemSnapshot as unknown as ProblemContent;
    const draft = store.getDraft(attempt.problemId, attempt.language, attempt.draftScopeId);
    const allRuns = store.listRuns(attempt.id);
    const selectedRun = input.runId ? allRuns.find(run => run.id === input.runId) : undefined;
    if (input.runId && !selectedRun) throw new Error('运行快照不属于当前练习。');
    const interview = store.getInterviewForAttempt(attempt.id), item = interview?.items.find(item => item.attemptId === attempt.id);
    const code = selectedRun?.code ?? (item ? (interview!.endedAt ? item.final!.code : item.accepted.code) : draft?.code) ?? content.starter[attempt.language] ?? '';
    const run = selectedRun ?? allRuns.filter(row => row.codeHash === sha256(code)).at(-1);
    const notes = (input.noteIds ?? []).map(noteId => { const note = store.getNote(noteId); if (!note?.confirmed || (note.kind === 'problem' && note.subjectId !== attempt.problemId)) throw new Error('所选笔记未确认或不属于当前题目。'); return { id: note.id, version: String(note.confirmed.version), title: note.confirmed.title, markdown: note.confirmed.markdown }; });
    const conversation = (input.conversationIds ?? []).flatMap(requestId => { const record = store.getAIRequest(requestId); if (!record || record.attemptId !== attempt.id || record.status !== 'completed' || !record.response) throw new Error('对话不属于当前练习或尚未完成。'); return [{ id: requestId, role: 'assistant' as const, content: JSON.stringify({ question: record.snapshot.question, response: record.response }) }]; });
    const context: AiTrustedContext = { attemptId: attempt.id, problemId: attempt.problemId, problemVersion: attempt.problemVersion, language: attempt.language, mode: attempt.mode, isActive: attempt.isActive, draftScopeId: attempt.draftScopeId, draftRevision: item ? (interview!.endedAt ? item.final! : item.accepted).revision : draft?.revision ?? 0, code, ...(item ? { reasoning: !selectedRun || selectedRun.code === (interview!.endedAt ? item.final! : item.accepted).code ? (interview!.endedAt ? item.final! : item.accepted).reasoning : '' } : {}), problem: { title: content.title, description: content.description, constraints: content.constraints ?? [] }, run: this.#runEvidence(run), notes, conversation };
    return this.options.interviewContext?.(context) ?? context;
  }
  async clearCredentials() {
    await this.ai.stopAll();
    const directory = this.vault.directory;
    if (existsSync(directory)) for (const name of await readdir(directory)) if (/^ai-[a-f0-9]{64}\.credential$/.test(name)) await unlink(join(directory, name));
  }
  #withAttachmentLock<T>(operation: () => Promise<T>): Promise<T> { const task = this.#attachmentQueue.then(operation); this.#attachmentQueue = task.then(() => {}, () => {}); return task; }
  #collectDeletedAttachments(): Promise<void> {
    if (this.#gcTask) return this.#gcTask;
    if (!this.options.isIdle() || this.backups.status().busy) return Promise.resolve();
    const task = this.#withAttachmentLock(async () => {
      if (!this.options.isIdle() || this.backups.status().busy) return;
      const directory = this.attachments.directory;
      if (existsSync(directory)) { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('附件目录类型无效，已停止清理。'); }
      for (const candidate of this.options.store().listAttachmentDeletionCandidates()) {
        if (!/^[a-f0-9]{64}$/.test(candidate.hash)) throw new Error('附件清理标识无效。');
        if (!this.options.store().purgeAttachmentMetadataIfUnreferenced(candidate)) continue;
        try { await unlink(join(directory, candidate.hash)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        this.options.store().finishAttachmentDeletionCandidate(candidate.hash);
      }
    });
    this.#gcTask = task; void task.finally(() => { if (this.#gcTask === task) this.#gcTask = null; }).catch(() => {}); return task;
  }
  resetActivity() { this.#pulse = null; }
  async start() { await this.reminders.start(); if (this.#automatic) return; this.#automatic = setInterval(() => { this.#auto(); }, 60000); this.#auto(); }
  #auto() {
    if (!this.options.isIdle() || this.#autoTask || this.backups.status().busy) return;
    this.#autoTask = this.#collectDeletedAttachments().catch(() => this.options.log('attachment.cleanup-deferred', { operation: 'automatic' })).then(() => this.options.isIdle() ? this.#withAttachmentLock(() => this.backups.autoBackup(this.options.store().getLearningSettings().timeZone)) : null).then(result => { if (result) this.options.changed(); }).catch(() => this.options.log('backup.failed', { operation: 'automatic' })).finally(() => { this.#autoTask = null; });
  }
  async pause() { if (this.#automatic) clearInterval(this.#automatic); this.#automatic = null; this.reminders.stop(); this.resetActivity(); await Promise.allSettled([this.#autoTask, this.#gcTask, this.#attachmentQueue]); await this.ai.stopAll(); }
  async resume() { await this.reminders.reloadSettings(); await this.start(); }
  async stop() { await this.pause(); }
  async #exportAttachment(hash: string) { const attachment = this.options.store().getAttachment(hash); if (!attachment) throw new Error('附件不存在。'); const selected = await dialog.showSaveDialog(this.options.window, { title: '导出附件', defaultPath: attachment.name }); if (selected.canceled || !selected.filePath) return false; await this.attachments.exportFile(hash, selected.filePath); return true; }
  #register() {
    const { handle, changed, window: win } = this.options, get = this.options.store;
    const mutate = <T>(operation: () => T) => { const result = operation(); changed(); return result; };
    handle('learning:settings', () => get().getLearningSettings());
    handle('learning:save-settings', input => mutate(() => get().updateLearningSettings(input as { dailyReviewBudget: number | null; timeZone: string })));
    handle('review:today', () => get().getTodayQueue()); handle('review:list', filter => get().listReviewItems(filter as ReviewFilter));
    handle('review:add', input => mutate(() => { const value = input as AddReviewItemInput; return get().addReviewItem({ problemId: value.problemId, target: value.target, language: value.language }); }));
    handle('review:update', (key, input) => mutate(() => get().setReviewPlan(id(key), input as { suspended?: boolean; scheduledAt?: string | null })));
    handle('review:events', key => get().listReviewEvents(id(key)));
    handle('review:feedback', input => mutate(() => { const value = input as ReviewFeedbackInput; return get().recordReview({ requestId: value.requestId, itemId: value.itemId, rating: value.rating, ...(value.attemptId ? { attemptId: value.attemptId } : {}) }); }));
    handle('review:correct', input => mutate(() => get().correctReview(input as CorrectReviewInput)));
    handle('learning:statistics', () => get().getArchiveStatistics());
    handle('learning:pulse', key => { const attemptId = id(key), at = performance.now(), previous = this.#pulse; const attempt = get().getAttempt(attemptId); if (!attempt?.isActive || !win.isVisible() || !win.isFocused()) { this.#pulse = null; return; } this.#pulse = { attemptId, at }; if (previous?.attemptId === attemptId) { const duration = Math.round(at - previous.at); if (duration >= 1000 && duration <= 15000) get().recordActivity({ requestId: randomUUID(), attemptId, durationMs: duration, occurredAt: new Date().toISOString() }); } });
    handle('note:list', filter => get().listNotes(filter as NoteFilter)); handle('note:get', key => get().getNote(id(key)) ?? null); handle('note:versions', key => get().listNoteVersions(id(key)));
    handle('note:save', input => { const value = input as SaveNoteInput; let result; try { result = get().saveNote({ ...value, origin: 'user', state: 'draft', aiRequestId: undefined }); } catch (error) { throw new Error(`NOTE_WRITE_REJECTED: 笔记未保存：${error instanceof Error ? error.message : '写入失败'}`); } changed(); return result; });
    handle('note:confirm', input => mutate(() => get().confirmNote(input as ConfirmNoteInput)));
    handle('note:delete', async (key, version) => { const result = mutate(() => get().deleteNoteWithAttachmentCandidates(id(key), integer(version))); await this.#collectDeletedAttachments().catch(() => this.options.log('attachment.cleanup-deferred', { operation: 'delete-note' })); return result.deleted; });
    handle('archive:delete', key => mutate(() => get().deleteEndedAttempt(id(key))));
    handle('attachment:get', key => get().getAttachment(id(key)) ?? null); handle('attachment:export', key => this.#exportAttachment(id(key)));
    handle('attachment:add', async () => { const selected = await dialog.showOpenDialog(win, { title: '添加本机附件（最大 20 MiB）', properties: ['openFile'], filters: [{ name: '图片、PDF、纯文本', extensions: attachmentExtensions }] }); if (selected.canceled) return null; return this.#withAttachmentLock(() => this.attachments.addFile(selected.filePaths[0])); });
    handle('note:export', async (key, revision) => {
      const note = get().getNoteVersion(id(key), integer(revision)); if (!note) throw new Error('笔记版本不存在。');
      const selected = await dialog.showSaveDialog(win, { title: '导出 Markdown 与附件', defaultPath: note.title.replace(/[\\/:*?"<>|]/g, '_') + '.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (selected.canceled || !selected.filePath) return false;
      let markdown = `# ${note.title}\n\n${note.markdown}`; const assetName = `${basename(selected.filePath, '.md')}-assets-${randomUUID().slice(0, 8)}`;
      if (note.attachmentHashes.length) { const assetDirectory = join(dirname(selected.filePath), assetName); await mkdir(assetDirectory); for (const hash of note.attachmentHashes) { const attachment = get().getAttachment(hash); if (!attachment) throw new Error('笔记附件缺失。'); const name = hash.slice(0, 12) + '-' + attachment.name.replace(/[\\/:*?"<>|\[\]]/g, '_'); await this.attachments.exportFile(hash, join(assetDirectory, name)); markdown = markdown.split(`algopractice://app/attachment/${hash}`).join(`${assetName}/${name}`); } }
      await writeFile(selected.filePath, markdown, { mode: 0o600 }); return true;
    });
    handle('ai:provider', () => this.ai.providerState());
    handle('ai:save-provider', async (input, key) => { const config = normalizeProviderConfig(input as AiProviderConfig); await this.ai.stopAll(); if (key !== undefined) { if (typeof key !== 'string') throw new Error('Key 格式无效。'); await this.vault.setKey(config, key); } const temporary = this.#providerPath + '.' + randomUUID() + '.partial'; try { await writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600 }); await rename(temporary, this.#providerPath); this.#provider = config; } finally { await unlink(temporary).catch(() => {}); } return this.ai.providerState(); });
    handle('ai:clear-key', async () => { await this.ai.clearKey(); return this.ai.providerState(); }); handle('ai:test', () => this.ai.testConnection());
    handle('ai:requests', key => get().listAIRequests(id(key))); handle('ai:ask', input => this.ai.request(input as AiRequestInput)); handle('ai:cancel', key => this.ai.cancel(id(key)));
    handle('ai:preview-patch', key => this.ai.preparePatch(id(key)));
    handle('ai:apply-patch', async key => { const patch = await this.ai.preparePatch(id(key)); const attempt = get().getAttempt(patch.attemptId); const draft = get().getDraft(patch.problemId, patch.language, patch.draftScopeId); if (!attempt?.isActive || attempt.mode === 'strict' || attempt.problemVersion !== patch.problemVersion || !draft || draft.codeHash !== patch.baseCodeHash || draft.revision !== patch.expectedDraftRevision) throw new Error('代码或练习已经变化，请重新请求修改建议。'); return mutate(() => get().saveDraft({ problemId: patch.problemId, language: patch.language, scopeId: patch.draftScopeId, code: patch.code, expectedRevision: patch.expectedDraftRevision })); });
    handle('ai:save-note', key => { const record = get().getAIRequest(id(key)); if (!record?.response?.noteDraft || record.status !== 'completed') throw new Error('没有可保存的笔记草稿。'); const proposal = record.response.noteDraft; return mutate(() => get().saveNote({ requestId: `ai-note-${record.id}`, kind: 'problem', subjectId: record.snapshot.problemId, title: proposal.title, markdown: proposal.markdown, tags: proposal.tags, origin: 'ai', state: 'draft', aiRequestId: record.id })); });
    handle('ai:help', key => { const attempt = get().getAttempt(id(key)); if (!attempt) throw new Error('练习不存在。'); const runs: AiHelpRun[] = get().listRuns(attempt.id).map(row => { const evidence = this.#runEvidence(row); return { id: row.id, attemptId: row.attemptId, status: row.status, language: row.language, executed: ['passed','completed','wrong_answer','runtime_error','timeout','output_limit'].includes(row.status), attributableToUser: Boolean(evidence) && !['environment_error','invalid_request','internal_error','cancelled','interrupted','queued'].includes(row.status) && (row.status !== 'compile_error' || evidence!.diagnostics.some(value => value.source === 'user')), trustworthyExpected: evidence?.trustworthyExpected ?? false, diagnostics: evidence?.diagnostics ?? [] }; }); const decision = helpCardDecision({ attemptId: attempt.id, mode: attempt.mode, isActive: attempt.isActive, runs, state: get().getAIHelpState(attempt.id) }); if (decision.show && !get().markAIHelpShown(attempt.id)) return { ...decision, show: false }; return decision; });
    handle('ai:dismiss-help', key => get().dismissAIHelp(id(key)));
    handle('review-reminder:state', () => this.reminders.status()); handle('review-reminder:save', async input => { await this.reminders.updateSettings(input as Parameters<ReminderService['updateSettings']>[0]); changed(); return this.reminders.status(); }); handle('review-reminder:snooze', () => this.reminders.snooze());
    handle('backup:list', async () => { const state = this.backups.status(); return { busy: state.busy, backups: state.busy ? [] : await this.backups.list(), lastError: state.lastError }; });
    handle('backup:create', async () => { const selected = await dialog.showSaveDialog(win, { title: '保存完整备份', defaultPath: `AlgoPractice-${new Date().toISOString().slice(0, 10)}.algobak`, filters: [{ name: 'AlgoPractice 备份', extensions: ['algobak'] }] }); if (selected.canceled || !selected.filePath) return null; return this.#withAttachmentLock(() => this.backups.create('manual', selected.filePath!)); });
    handle('backup:preview', async () => { const selected = await dialog.showOpenDialog(win, { title: '选择要恢复的备份', properties: ['openFile'], filters: [{ name: 'AlgoPractice 备份', extensions: ['algobak'] }] }); if (selected.canceled) return null; const summary = await this.backups.inspect(selected.filePaths[0]), previewId = randomUUID(); this.#previews.clear(); this.#previews.set(previewId, summary); return { id: previewId, manifest: summary.manifest, bytes: summary.bytes }; });
    handle('backup:restore', key => { const preview = this.#previews.get(id(key)); if (!preview) throw new Error('恢复预览已失效，请重新选择文件。'); this.#previews.clear(); return this.backups.restore(preview.path, preview.manifest); });
    handle('app:open-web-link', value => { const raw = id(value); if (raw.length > 2048) throw new Error('链接过长。'); const url = new URL(raw); if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('仅允许打开网页链接。'); return shell.openExternal(url.href); });
  }
}
