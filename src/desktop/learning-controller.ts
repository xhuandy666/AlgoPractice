import { clipboard, dialog, Notification, safeStorage, shell, type BrowserWindow } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PracticeStore } from '../storage/practice-store';
import { AiService, CredentialVault, normalizeProviderConfig, helpCardDecision } from '../ai/index';
import type { AiProviderConfig, AiProviderState, AiRequestInput, AiTrustedContext, AiHelpRun } from '../shared/ai';
import type { OfficialSubmission } from '../shared/official';
import type { AddReviewItemInput, ConfirmNoteInput, CorrectReviewInput, LearningSettingsInput, NoteFilter, ReviewFeedbackInput, ReviewFilter, SaveNoteInput } from '../shared/learning';
import type { AdvanceReviewSessionInput, ProblemReviewAssessmentInput, ProblemReviewBatchInput, ProblemReviewCorrectionInput,
  ProblemReviewPreviewInput, ReviewAssessmentDraftInput, ReviewOpportunityFilter, ReviewPlanQuery,
  StartReviewSessionInput, SubmitReviewOpportunityInput } from '../shared/review-plan';
import type { BackupSummary, RestoreLifecycle } from '../shared/maintenance';
import type { Page } from '../shared/bridge';
import { AttachmentService, attachmentExtensions } from './attachment-service';
import { BackupService } from './backup-service';
import { ReminderService } from './reminder-service';
import { writeCodeToClipboard } from './code-clipboard';
import { applyPracticeAiPatch, buildPracticeAiContext, runAiEvidence } from './learning-context';
import { OfficialAiCoach } from './official-ai-coach';
const id = (value: unknown) => { if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error('标识无效。'); return value; };
const integer = (value: unknown) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('版本无效。'); return value; };
interface Options { dataDirectory: string; version: string; window: BrowserWindow; store(): PracticeStore; handle(channel: string, handler: (...args: unknown[]) => unknown): void; changed(): void; reveal(page: Page): void; lifecycle: RestoreLifecycle; isIdle(): boolean; allowAutomaticAi?(): boolean; allowReviewPrompt?(): boolean; interviewContext?(context: AiTrustedContext): AiTrustedContext; log(event: string, data: Record<string, string | number | boolean | null>): void; }
export class LearningController {
  readonly vault: CredentialVault; readonly attachments: AttachmentService; readonly backups: BackupService; readonly reminders: ReminderService;
  ai!: AiService; #provider: AiProviderConfig | null = null; #automatic: ReturnType<typeof setInterval> | null = null; #autoTask: Promise<unknown> | null = null;
  #attachmentQueue: Promise<void> = Promise.resolve(); #gcTask: Promise<void> | null = null;
  #pulse: { attemptId: string; at: number } | null = null; #previews = new Map<string, BackupSummary>(); readonly #providerPath: string;
  #officialCoach!: OfficialAiCoach;
  constructor(private readonly options: Options) {
    this.#providerPath = join(options.dataDirectory, 'ai-provider.json');
    this.vault = new CredentialVault({ directory: join(options.dataDirectory, 'credentials'), safeStorage });
    this.attachments = new AttachmentService({ directory: join(options.dataDirectory, 'attachments'), getAttachment: hash => options.store().getAttachment(hash), registerAttachment: attachment => options.store().registerAttachment(attachment) });
    const notifications = new Map<string, Notification>();
    this.reminders = new ReminderService({ directory: options.dataDirectory, timeZone: () => options.store().getLearningSettings().timeZone, dueCount: () => options.store().getTodayQueue().dueCount,
      notifier: { notify: input => { if (!Notification.isSupported()) throw new Error('当前系统不支持桌面提醒。'); const notification = new Notification({ title: input.title, body: input.body }); notifications.set(input.id, notification); notification.on('click', input.onClick); notification.on('failed', (_event, message) => input.onFailure(message)); notification.on('close', () => notifications.delete(input.id)); notification.show(); }, dismiss: key => { notifications.get(key)?.close(); notifications.delete(key); } },
      onNavigateQueue: () => options.reveal('reviews'), onChanged: options.changed });
    this.backups = new BackupService({ dataDirectory: options.dataDirectory, appVersion: options.version, snapshotDatabase: destination => options.store().backupTo(destination), inspectSnapshot: PracticeStore.inspectBackupSnapshot, getReminderSettings: () => this.reminders.settings(), getAiProvider: () => this.#provider, lifecycle: options.lifecycle });
    this.rebind(); this.#register();
  }
  rebind() {
    const savedProvider = existsSync(this.#providerPath) ? JSON.parse(readFileSync(this.#providerPath, 'utf8')) : null;
    this.#provider = savedProvider === null ? null : normalizeProviderConfig(savedProvider);
    this.ai = new AiService({ repository: this.options.store(), vault: this.vault, resolveProvider: () => this.#provider, resolveContext: input => this.#context(input), onEvent: event => { if (!this.options.window.isDestroyed()) this.options.window.webContents.send('ai:event', event); if (['completed','failed','cancelled','interrupted'].includes(event.phase)) { this.options.changed(); this.#officialCoach?.wake(); } } });
    this.#officialCoach = new OfficialAiCoach({ store: this.options.store, allowed: () => this.options.isIdle() && (this.options.allowAutomaticAi?.() ?? true),
      provider: () => this.#providerState(), request: input => this.ai.request(input), busy: attemptId => this.ai.isAttemptBusy(attemptId), onError: () => this.options.log('ai.official-analysis-deferred', { operation: 'automatic' }) });
    this.ai.recoverInterrupted(); this.#pulse = null;
  }
  async #providerState(): Promise<AiProviderState> { return { ...await this.ai.providerState(), autoAnalyzeOfficial: this.options.store().getLearningSettings().aiAutoAnalyzeOfficial === true }; }
  officialCompleted(record: OfficialSubmission): void { this.#officialCoach.completed(record); }
  #context(input: AiRequestInput): AiTrustedContext {
    const context = buildPracticeAiContext(this.options.store(), input);
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
  async pause() { this.#officialCoach.pause(); if (this.#automatic) clearInterval(this.#automatic); this.#automatic = null; this.reminders.stop(); this.resetActivity(); await Promise.allSettled([this.#autoTask, this.#gcTask, this.#attachmentQueue]); await this.ai.stopAll(); await this.#officialCoach.idle(); }
  async resume() { this.#officialCoach.resume(); await this.reminders.reloadSettings(); await this.start(); }
  async stop() { await this.pause(); }
  async #exportAttachment(hash: string) { const attachment = this.options.store().getAttachment(hash); if (!attachment) throw new Error('附件不存在。'); const selected = await dialog.showSaveDialog(this.options.window, { title: '导出附件', defaultPath: attachment.name }); if (selected.canceled || !selected.filePath) return false; await this.attachments.exportFile(hash, selected.filePath); return true; }
  #register() {
    const { handle, changed, window: win } = this.options, get = this.options.store;
    const mutate = <T>(operation: () => T) => { const result = operation(); changed(); return result; };
    handle('learning:settings', () => get().getLearningSettings());
    handle('learning:save-settings', input => mutate(() => get().updateLearningSettings(input as LearningSettingsInput)));
    handle('review:today', () => get().getTodayQueue()); handle('review:list', filter => get().listReviewItems(filter as ReviewFilter));
    handle('review:add', input => mutate(() => { const value = input as AddReviewItemInput; return get().addReviewItem({ problemId: value.problemId, target: value.target, language: value.language }); }));
    handle('review:update', (key, input) => mutate(() => get().setReviewPlan(id(key), input as { suspended?: boolean; scheduledAt?: string | null })));
    handle('review:events', key => get().listReviewEvents(id(key)));
    handle('review:feedback', input => mutate(() => { const value = input as ReviewFeedbackInput; return get().recordReview({ requestId: value.requestId, itemId: value.itemId, rating: value.rating, ...(value.attemptId ? { attemptId: value.attemptId } : {}) }); }));
    handle('review:correct', input => mutate(() => get().correctReview(input as CorrectReviewInput)));
    handle('problem-review:snapshot', query => get().getReviewPlanSnapshot(query as ReviewPlanQuery));
    handle('problem-review:detail', (key, history) => get().getProblemReviewDetail(id(key), history as import('../shared/learning').PageRequest));
    handle('problem-review:add', input => mutate(() => get().addProblemReviews(input as { problemIds: string[] })));
    handle('problem-review:update', input => mutate(() => get().updateProblemReviews(input as ProblemReviewBatchInput)));
    handle('problem-review:preview', input => get().previewProblemReview(input as ProblemReviewPreviewInput));
    // Neither renderer-supplied timestamps nor renderer-supplied AC/FSRS facts reach the trusted write paths.
    handle('problem-review:record', input => mutate(() => { const value = input as ProblemReviewAssessmentInput;
      return get().recordProblemReview({ requestId: value.requestId, problemId: value.problemId, rating: value.rating,
        ...(value.attemptId ? { attemptId: value.attemptId } : {}) }); }));
    handle('problem-review:official-record', input => mutate(() => { const value = input as SubmitReviewOpportunityInput;
      return get().submitReviewOpportunity({ requestId: value.requestId, opportunityId: value.opportunityId, rating: value.rating }); }));
    handle('problem-review:correct', input => mutate(() => { const value = input as ProblemReviewCorrectionInput;
      return get().correctProblemReview({ requestId: value.requestId, eventId: value.eventId, rating: value.rating }); }));
    handle('problem-review:request', key => get().getProblemReviewRequest(id(key)) ?? null);
    handle('problem-review:opportunities', filter => get().reviewOpportunities(filter as ReviewOpportunityFilter));
    handle('problem-review:submission-opportunity', key => get().getReviewOpportunityForSubmission(id(key)) ?? null);
    handle('problem-review:claim', key => {
      if (!this.options.isIdle() || !(this.options.allowReviewPrompt?.() ?? true) || win.isDestroyed() || !win.isVisible() || !win.isFocused()) return null;
      return mutate(() => get().claimReviewOpportunity(id(key)) ?? null);
    });
    handle('problem-review:skip', key => mutate(() => get().skipReviewOpportunity(id(key))));
    handle('problem-review:save-draft', input => mutate(() => get().saveReviewAssessmentDraft(input as ReviewAssessmentDraftInput)));
    handle('problem-review:draft', key => get().getReviewAssessmentDraft(id(key)) ?? null);
    handle('problem-review:delete-draft', (key, revision) => mutate(() => get().deleteReviewAssessmentDraft(id(key), revision === undefined ? undefined : integer(revision))));
    handle('problem-review:start-session', input => mutate(() => get().startReviewSession(input as StartReviewSessionInput)));
    handle('problem-review:session', key => get().getReviewSession(key === undefined ? undefined : id(key)) ?? null);
    handle('problem-review:advance-session', input => mutate(() => get().advanceReviewSession(input as AdvanceReviewSessionInput)));
    handle('problem-review:end-session', key => mutate(() => get().endReviewSession(id(key))));
    handle('learning:statistics', () => get().getArchiveStatistics());
    handle('learning:dashboard', month => get().getLearningDashboard(month as string | undefined));
    handle('learning:pause-activity', () => this.resetActivity());
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
    handle('ai:provider', () => this.#providerState());
    handle('ai:save-auto-analysis', async enabled => { if (typeof enabled !== 'boolean') throw new Error('自动分析设置无效。'); mutate(() => get().updateLearningSettings({ aiAutoAnalyzeOfficial: enabled })); if (!enabled) { this.#officialCoach.pause(); this.#officialCoach.resume(); } return this.#providerState(); });
    handle('ai:save-provider', async (input, key) => { const config = normalizeProviderConfig(input as AiProviderConfig); await this.ai.stopAll(); if (key !== undefined) { if (typeof key !== 'string') throw new Error('Key 格式无效。'); await this.vault.setKey(config, key); } const temporary = this.#providerPath + '.' + randomUUID() + '.partial'; try { await writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600 }); await rename(temporary, this.#providerPath); this.#provider = config; } finally { await unlink(temporary).catch(() => {}); } return this.#providerState(); });
    handle('ai:clear-key', async () => { await this.ai.clearKey(); return this.#providerState(); }); handle('ai:test', () => this.ai.testConnection());
    handle('ai:requests', key => get().listAIRequests(id(key))); handle('ai:ask', input => this.ai.request(input as AiRequestInput).finally(() => this.#officialCoach.wake())); handle('ai:cancel', key => this.ai.cancel(id(key)));
    handle('ai:preview-patch', key => this.ai.preparePatch(id(key)));
    handle('ai:apply-patch', async key => { const patch = await this.ai.preparePatch(id(key)); return mutate(() => applyPracticeAiPatch(get(), patch)); });
    handle('ai:save-note', key => { const record = get().getAIRequest(id(key)); if (!record?.response?.noteDraft || record.status !== 'completed') throw new Error('没有可保存的笔记草稿。'); const proposal = record.response.noteDraft; return mutate(() => get().saveNote({ requestId: `ai-note-${record.id}`, kind: 'problem', subjectId: record.snapshot.problemId, title: proposal.title, markdown: proposal.markdown, tags: proposal.tags, origin: 'ai', state: 'draft', aiRequestId: record.id })); });
    handle('ai:help', key => { const attempt = get().getAttempt(id(key)); if (!attempt) throw new Error('练习不存在。'); const runs: AiHelpRun[] = get().listRuns(attempt.id).map(row => { const evidence = runAiEvidence(row); return { id: row.id, attemptId: row.attemptId, status: row.status, language: row.language, executed: ['passed','completed','wrong_answer','runtime_error','timeout','output_limit'].includes(row.status), attributableToUser: Boolean(evidence) && !['environment_error','invalid_request','internal_error','cancelled','interrupted','queued'].includes(row.status) && (row.status !== 'compile_error' || evidence!.diagnostics.some(value => value.source === 'user')), trustworthyExpected: evidence?.trustworthyExpected ?? false, diagnostics: evidence?.diagnostics ?? [] }; }); const decision = helpCardDecision({ attemptId: attempt.id, mode: attempt.mode, isActive: attempt.isActive, runs, state: get().getAIHelpState(attempt.id) }); if (decision.show && !get().markAIHelpShown(attempt.id)) return { ...decision, show: false }; return decision; });
    handle('ai:dismiss-help', key => get().dismissAIHelp(id(key)));
    handle('review-reminder:state', () => this.reminders.status()); handle('review-reminder:save', async input => { await this.reminders.updateSettings(input as Parameters<ReminderService['updateSettings']>[0]); changed(); return this.reminders.status(); }); handle('review-reminder:snooze', () => this.reminders.snooze());
    handle('backup:list', async () => { const state = this.backups.status(); return { busy: state.busy, backups: state.busy ? [] : await this.backups.list(), lastError: state.lastError }; });
    handle('backup:create', async () => { const selected = await dialog.showSaveDialog(win, { title: '保存完整备份', defaultPath: `题炼-${new Date().toISOString().slice(0, 10)}.algobak`, filters: [{ name: '题炼 备份', extensions: ['algobak'] }] }); if (selected.canceled || !selected.filePath) return null; return this.#withAttachmentLock(() => this.backups.create('manual', selected.filePath!)); });
    handle('backup:preview', async () => { const selected = await dialog.showOpenDialog(win, { title: '选择要恢复的备份', properties: ['openFile'], filters: [{ name: '题炼 备份', extensions: ['algobak'] }] }); if (selected.canceled) return null; const summary = await this.backups.inspect(selected.filePaths[0]), previewId = randomUUID(); this.#previews.clear(); this.#previews.set(previewId, summary); return { id: previewId, manifest: summary.manifest, bytes: summary.bytes }; });
    handle('backup:restore', key => { const preview = this.#previews.get(id(key)); if (!preview) throw new Error('恢复预览已失效，请重新选择文件。'); this.#previews.clear(); return this.backups.restore(preview.path, preview.manifest); });
    // Use the same main-frame origin, maintenance and interview gates as every other app IPC.
    handle('app:copy-code', value => writeCodeToClipboard(value, clipboard));
    handle('app:open-web-link', value => { const raw = id(value); if (raw.length > 2048) throw new Error('链接过长。'); const url = new URL(raw); if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('仅允许打开网页链接。'); return shell.openExternal(url.href); });
  }
}
