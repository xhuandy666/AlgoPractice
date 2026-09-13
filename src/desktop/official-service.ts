import { setTimeout as delay } from 'node:timers/promises';
import { hashCode, type PracticeStore } from '../storage/practice-store.ts';
import { OfficialJudgeError, officialProblemSlug, type OfficialJudgeTransport } from '../source/official-judge.ts';
import type { OfficialError, OfficialSubmission, OfficialSubmissionUpdate, OfficialSubmitInput } from '../shared/official.ts';

interface Job { controller: AbortController; done: Promise<void>; attemptId: string; }
export class OfficialService {
  #jobs = new Map<string, Job>();
  #paused = false;
  constructor(private store: PracticeStore, private readonly judge: OfficialJudgeTransport,
    private readonly options: { onUpdate?: (record: OfficialSubmission) => void; pollIntervalMs?: number; pollTimeoutMs?: number } = {}) {}

  get(id: string) { return this.store.getOfficialSubmission(id); }
  list(attemptId: string) { return this.store.listOfficialSubmissions(attemptId); }
  hasActive(attemptId?: string) { return this.store.hasActiveOfficialSubmission(attemptId); }
  /** An interrupted POST is never replayed. Known submission IDs remain available for explicit read-only resumption. */
  recover() { return this.store.recoverInterruptedOfficialSubmissions(); }
  rebind(store: PracticeStore) {
    if (this.#jobs.size) throw new Error('Pause official judging before replacing the store');
    this.store = store; this.#paused = false;
  }
  async pause() {
    this.#paused = true;
    try {
      for (const job of this.#jobs.values()) job.controller.abort();
      await Promise.all([...this.#jobs.values()].map(job => job.done));
    } finally { this.#paused = false; }
  }
  async stopAll() { try { await this.pause(); } finally { this.#paused = true; } }
  #emit(record: OfficialSubmission) { this.options.onUpdate?.(record); }
  #update(id: string, input: OfficialSubmissionUpdate) {
    const record = this.store.updateOfficialSubmission(id, input); this.#emit(record); return record;
  }

  async submit(input: OfficialSubmitInput): Promise<OfficialSubmission> {
    if (this.#paused) throw new Error('正在维护本地数据，请稍后再提交。');
    if (!input || typeof input.requestId !== 'string' || typeof input.attemptId !== 'string' || typeof input.code !== 'string') throw new Error('Invalid official submission input');
    const existing = this.get(input.requestId);
    if (existing) {
      if (existing.attemptId !== input.attemptId || existing.codeHash !== hashCode(input.code)) throw new Error('Official request id conflicts with a different snapshot');
      return existing;
    }
    const attempt = this.store.getAttempt(input.attemptId);
    if (!attempt || !attempt.isActive || attempt.endedAt || attempt.mode === 'strict') throw new Error('请在当前普通练习中提交代码。');
    const problem = this.store.getProblem(attempt.problemId, attempt.problemVersion)?.content;
    if (!problem || problem.source !== 'leetcode-cn' || !problem.sourceId || !problem.starter[attempt.language] || problem.mode !== 'function') {
      throw new Error('题目缺少当前语言的官方模板或提交信息，请重新导入。');
    }
    const record = this.store.beginOfficialSubmission({ ...input, slug: officialProblemSlug(problem.sourceUrl), sourceId: problem.sourceId });
    this.#emit(record);
    this.#launch(record, true);
    return record;
  }
  async resume(id: string): Promise<OfficialSubmission> {
    if (this.#paused) throw new Error('正在维护本地数据，请稍后继续查询。');
    const record = this.get(id);
    if (!record) throw new Error('未找到这次官方提交。');
    if (this.#jobs.has(id) || record.status === 'completed') return record;
    if (!record.submissionId || record.status !== 'paused') throw new Error('这次提交没有可恢复的判题编号，请先在力扣提交记录中核对。');
    if (this.hasActive(record.attemptId)) throw new Error('当前练习还有其他官方判题进行中。');
    const resumed = this.#update(id, { status: 'judging' });
    this.#launch(resumed, false);
    return resumed;
  }
  #launch(record: OfficialSubmission, post: boolean) {
    const controller = new AbortController();
    // Schedule after registering the job so even immediately resolved test transports cannot race the registry.
    const done = Promise.resolve().then(() => this.#work(record, post, controller.signal)).finally(() => this.#jobs.delete(record.id));
    this.#jobs.set(record.id, { controller, done, attemptId: record.attemptId });
    // #work handles expected transport failures; a persistence failure must not create an unhandled rejection on shutdown.
    void done.catch(() => {});
  }
  async #work(snapshot: OfficialSubmission, post: boolean, signal: AbortSignal) {
    let record = snapshot, postStarted = false;
    try {
      if (signal.aborted) throw new Error('Interrupted');
      if (post) {
        if (!await this.judge.authenticated(signal)) throw new OfficialJudgeError({ code: 'authentication', message: '请先登录力扣国服，再提交代码。' });
        if (signal.aborted) throw new Error('Interrupted');
        postStarted = true;
        const submissionId = await this.judge.submit(record, signal);
        record = this.#update(record.id, { status: 'judging', submissionId });
      }
      const started = Date.now();
      while (!signal.aborted && Date.now() - started < (this.options.pollTimeoutMs ?? 120_000)) {
        const response = await this.judge.check(record.submissionId!, signal);
        if (!response.pending) {
          if (!response.result) throw new OfficialJudgeError({ code: 'protocol', message: '力扣没有返回可用的判题结果，请稍后继续查询。' });
          this.#update(record.id, { status: 'completed', result: response.result });
          return;
        }
        await delay(this.options.pollIntervalMs ?? 1500, undefined, { signal });
      }
      const error: OfficialError = signal.aborted
        ? { code: 'interrupted', message: '结果查询已暂停，可以继续查询。' }
        : { code: 'timeout', message: '力扣仍在判题，可以稍后继续查询结果。' };
      this.#update(record.id, { status: 'paused', error });
    } catch (error) {
      const current = this.get(record.id);
      if (!current || !['submitting', 'judging'].includes(current.status)) return;
      const detail: OfficialError = signal.aborted
        ? { code: 'interrupted', message: current.submissionId ? '结果查询已暂停，可以继续查询。'
          : postStarted ? '提交被中断，无法确认是否已送达，请先在力扣提交记录中核对。' : '提交已取消，代码尚未发送。' }
        : error instanceof OfficialJudgeError ? error.detail
          : { code: 'network', message: postStarted && !current.submissionId
            ? '未能确认提交是否送达，请先在力扣提交记录中核对。' : '暂时无法查询力扣，请稍后重试。' };
      this.#update(record.id, { status: current.submissionId ? 'paused'
        : postStarted && (signal.aborted || !(error instanceof OfficialJudgeError) || error.uncertain) ? 'unknown' : 'error', error: detail });
    }
  }
}
