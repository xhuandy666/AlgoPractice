import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { previewImport, type ImportInput, type ImportPreview, type ImportPreviewItem, LeetCodeCnSourceAdapter, SourceError, parseSource } from '../source/index';
import { PracticeStore } from '../storage/practice-store';
import type { ImportJob, ListSnapshotInput, ProblemContent } from '../shared/library';
import type { PreparedImport, PreparedProblemRefresh } from '../shared/bridge';
import { cacheProblemMedia } from './media-cache';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const hasPreparedContent = (content: ProblemContent) => Boolean(content.description.trim() || content.cases.length || Object.values(content.starter).some(text => text?.trim()) || content.adapter);
const asError = (error: unknown) => error instanceof SourceError ? { code: error.code, message: error.message, retryable: error.retryable } : { code: 'IMPORT_ERROR', message: error instanceof Error ? error.message : String(error), retryable: true };
function placeholder(item: ImportPreviewItem): ProblemContent {
  return { id: item.problemId, title: item.title, difficulty: item.difficulty, tags: item.tags,
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}), description: '', descriptionFormat: 'plain', constraints: [],
    mode: 'function', cases: [], starter: {}, source: item.sourceUrl ? 'leetcode-cn' : 'file', supportReason: '题面尚未获取，可从导入任务继续准备。' };
}
type StoredInput = { preview: ImportPreview; membershipId: string | null; previewId: string };

export class ImportService {
  #previews = new Map<string, PreparedImport>();
  #problemPreviews = new Map<string, PreparedProblemRefresh>();
  #active: { id: string; controller: AbortController; promise: Promise<void> } | null = null;
  #fetches = new Set<AbortController>();
  constructor(private store: PracticeStore, private adapter: LeetCodeCnSourceAdapter, private mediaDirectory: string,
    private changed: () => void, private log: (event: string, fields?: Record<string, string | number | boolean | null>) => void,
    private requestDelayMs = 600) {}

  async prepare(input: ImportInput): Promise<PreparedImport> {
    if (!input || typeof input !== 'object' || !['url', 'links', 'csv', 'json'].includes(input.kind) || typeof input.text !== 'string' || Buffer.byteLength(input.text) > 5 * 1024 * 1024) throw new Error('导入内容格式无效或超过 5 MiB。');
    const controller = new AbortController(); this.#fetches.add(controller);
    try {
      const preview = await previewImport(input, { adapter: this.adapter, signal: controller.signal });
      const list = this.toList(preview, input.name);
      const membership = list ? this.store.previewListRefresh(list) : null;
      const prepared = { id: randomUUID(), preview, membership };
      if (this.#previews.size >= 12) this.#previews.delete(this.#previews.keys().next().value!);
      this.#previews.set(prepared.id, prepared); return prepared;
    } finally { this.#fetches.delete(controller); }
  }
  private toList(preview: ImportPreview, name?: string): ListSnapshotInput | null {
    if (preview.items.length <= 1 && preview.source !== 'file' && (!preview.sourceUrl || parseSource(preview.sourceUrl).kind === 'problem')) return null;
    const identity = preview.sourceUrl ? parseSource(preview.sourceUrl).sourceKey : `file-list:${hash(name || JSON.stringify(preview.items.map(item => item.key)))}`;
    return { id: identity, title: preview.listTitle, source: preview.source === 'leetcode-cn' || preview.source === 'links' ? 'leetcode-cn' : 'file',
      ...(preview.sourceUrl ? { sourceUrl: preview.sourceUrl } : {}),
      chapters: preview.chapters.map(chapter => ({ id: chapter.id, title: chapter.title, position: chapter.order })),
      items: preview.items.map(item => ({ key: item.key, problemId: item.problemId, chapterId: item.chapterId, position: item.order })),
      membershipComplete: preview.complete,
    };
  }
  start(previewId: string, requestId: string): ImportJob {
    const existing = this.store.listImportJobs().find(job => job.requestKey === requestId);
    if (existing) {
      if ((JSON.parse(existing.input) as StoredInput).previewId !== previewId) throw new Error('导入请求标识与已有预览不一致。');
      return existing;
    }
    if (this.#active) throw new Error('已有导入任务正在运行，请等待或暂停。');
    const prepared = this.#previews.get(previewId); if (!prepared) throw new Error('预览已失效，请重新读取。');
    if (!prepared.preview.items.length && !prepared.membership) throw new Error('没有可导入的条目。');
    if (!prepared.preview.complete || (prepared.membership && !prepared.membership.canApply)) throw new Error(prepared.membership?.reason || '预览存在不完整或无效条目，请先修正后重新读取。');
    const { preview, membership } = prepared;
    if (membership && (this.store.getList(membership.listId)?.revision ?? 0) !== membership.baseRevision) throw new Error('题单已变化，请重新读取预览后导入。');
    const job = this.store.createImportJob({ requestKey: requestId, title: preview.listTitle, input: JSON.stringify({ preview, membershipId: membership?.id ?? null, previewId } satisfies StoredInput),
      source: preview.source === 'file' ? 'file' : 'leetcode-cn', ...(preview.sourceUrl ? { sourceUrl: preview.sourceUrl } : {}), ...(membership ? { list: membership.candidate } : {}),
      items: preview.items.map(item => ({ key: item.key, problemId: item.problemId, title: item.title, sourceUrl: item.sourceUrl, chapterId: item.chapterId, position: item.order })) });
    for (const item of preview.items) { const previous = this.store.getProblem(item.problemId); if (!previous || !hasPreparedContent(previous.content)) this.store.upsertProblem(placeholder(item)); }
    if (membership) this.store.applyListRefresh(membership.id);
    if (job.status === 'completed') return job;
    return this.resume(job.id, job.status === 'completed_with_errors');
  }
  resume(id: string, retryFailed = false): ImportJob {
    if (this.#active) { if (this.#active.id === id) return this.job(id); throw new Error('已有导入任务正在运行。'); }
    const job = this.job(id);
    const input = JSON.parse(job.input) as StoredInput;
    if (!input.preview || !Array.isArray(input.preview.items)) throw new Error('导入快照损坏，未继续执行。');
    const completedKeys = new Set(job.items.filter(item => ['imported', 'reused', 'link_only', 'skipped'].includes(item.status)).map(item => item.key));
    for (const item of input.preview.items) {
      if (completedKeys.has(item.key)) continue;
      const previous = this.store.getProblem(item.problemId);
      if (!previous || !hasPreparedContent(previous.content)) this.store.upsertProblem(placeholder(item));
    }
    if (input.membershipId) this.store.applyListRefresh(input.membershipId);
    if (job.status === 'completed') return job;
    this.store.updateImportJob(id, { status: 'running', retryFailed, error: null });
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.process(id, input.preview, controller.signal)).finally(() => { this.#active = null; this.changed(); });
    this.#active = { id, controller, promise }; this.changed(); return this.job(id);
  }
  job(id: string): ImportJob { const job = this.store.getImportJob(id); if (!job) throw new Error('导入任务不存在。'); return job; }
  async pause(id: string) { if (this.#active?.id === id) { const active = this.#active; active.controller.abort(); await active.promise; } }
  async stop() { for (const controller of this.#fetches) controller.abort(); if (this.#active) await this.pause(this.#active.id); }

  private async process(id: string, preview: ImportPreview, signal: AbortSignal) {
    let current: ImportPreviewItem | null = null;
    try {
      for (const item of preview.items) {
        signal.throwIfAborted();
        const saved = this.job(id).items.find(row => row.key === item.key)!;
        if (saved.status !== 'pending') continue;
        current = item; this.store.updateImportItem(id, item.key, { status: 'running' }); this.changed();
        try {
          const existing = this.store.getProblem(item.problemId);
          if (!item.content && existing?.content.description.trim()) {
            this.store.updateImportItem(id, item.key, { status: 'reused', content: existing.content }); current = null; this.changed(); continue;
          }
          let content: ProblemContent;
          if (item.content) content = item.content;
          else if (item.sourceUrl) { await delay(this.requestDelayMs, undefined, { signal }); content = (await this.adapter.fetchProblemContent(item.sourceUrl, { signal })).content; }
          else content = placeholder(item);
          signal.throwIfAborted(); content = await cacheProblemMedia(content, this.mediaDirectory, signal); signal.throwIfAborted();
          const completion = this.store.updateImportItem(id, item.key, { status: content.description.trim() || (item.content && hasPreparedContent(content)) ? 'imported' : 'link_only', content });
          if (existing?.version === completion.version && content.description.trim()) this.store.updateImportItem(id, item.key, { status: 'reused' });
        } catch (error) {
          if (signal.aborted) throw error;
          const failure = asError(error); const restricted = ['AUTH_REQUIRED', 'ACCESS_DENIED', 'ACCESS_CHALLENGE', 'NOT_FOUND_OR_RESTRICTED'].includes(failure.code);
          this.store.updateImportItem(id, item.key, { status: restricted ? 'restricted' : 'failed', error: failure });
          this.log('import.item.failed', { category: failure.code });
          if (['AUTH_REQUIRED', 'ACCESS_DENIED', 'ACCESS_CHALLENGE', 'RATE_LIMITED', 'NETWORK_ERROR', 'TIMEOUT'].includes(failure.code)) { this.store.updateImportJob(id, { status: 'paused', error: failure }); return; }
        }
        current = null; this.changed();
      }
      const job = this.job(id); this.store.updateImportJob(id, { status: job.counts.failed + job.counts.restricted > 0 ? 'completed_with_errors' : 'completed' });
      this.log('import.finished', { total: job.total, imported: job.counts.imported, reused: job.counts.reused, failed: job.counts.failed });
    } catch (error) {
      if (current && this.job(id).items.find(row => row.key === current!.key)?.status === 'running') this.store.updateImportItem(id, current.key, { status: 'pending' });
      this.store.updateImportJob(id, { status: 'paused', error: signal.aborted ? null : asError(error) });
    }
  }
  async prepareProblem(id: string): Promise<PreparedProblemRefresh> {
    const before = this.store.getProblem(id); if (!before?.content.sourceUrl) throw new Error('此题没有可刷新的线上来源。');
    const controller = new AbortController(); this.#fetches.add(controller);
    try {
      const fetched = await this.adapter.fetchProblemContent(before.content.sourceUrl, { signal: controller.signal });
      let after = fetched.content;
      if (hasPreparedContent(before.content) && (fetched.capability === 'link-only' || !hasPreparedContent(after) || (before.content.description.trim() && !after.description.trim()))) throw new Error('来源暂未返回可用内容，已有缓存已保留；请确认访问权限后重试。');
      after = await cacheProblemMedia(after, this.mediaDirectory, controller.signal);
      const prepared = { id: randomUUID(), before, after, changed: JSON.stringify(before.content) !== JSON.stringify(after) };
      if (this.#problemPreviews.size >= 12) this.#problemPreviews.delete(this.#problemPreviews.keys().next().value!);
      this.#problemPreviews.set(prepared.id, prepared); return prepared;
    } finally { this.#fetches.delete(controller); }
  }
  applyProblem(id: string) {
    const prepared = this.#problemPreviews.get(id); if (!prepared) throw new Error('题面预览已失效。');
    const current = this.store.getProblem(prepared.before.id);
    if (current?.version !== prepared.before.version) throw new Error('题目已被其他导入更新，请重新预览。');
    const problem = this.store.upsertProblem(prepared.after); this.#problemPreviews.delete(id); this.changed(); return problem;
  }
}
