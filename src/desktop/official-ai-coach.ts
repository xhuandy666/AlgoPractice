import { hashCode, type PracticeStore } from '../storage/practice-store.ts';
import type { AiProviderState, AiRequestInput, AiRequestRecord } from '../shared/ai.ts';
import type { OfficialSubmission } from '../shared/official.ts';

export const officialAnalysisRequestId = (submissionId: string): string => `ai-official-${hashCode(submissionId)}`;
const pending = (record: AiRequestRecord) => ['pending', 'streaming', 'repairing'].includes(record.status);

interface Options {
  store(): PracticeStore;
  /** Includes maintenance, shutdown and interview gates. Checked again after async preparation. */
  allowed(): boolean;
  provider(): Promise<AiProviderState>;
  request(input: AiRequestInput): Promise<AiRequestRecord>;
  busy?(attemptId: string): boolean;
  onError?(): void;
}

/** Official-result events are the only trigger. No startup/history scan and no local-run observer. */
export class OfficialAiCoach {
  readonly #pending = new Map<string, string>();
  readonly #seen = new Set<string>();
  #task: Promise<void> | null = null;
  #paused = false;
  #epoch = 0;
  #wakeAgain = false;
  constructor(private readonly options: Options) {}

  #eligible(id: string): OfficialSubmission | null {
    if (this.#paused || !this.options.allowed() || this.options.store().getLearningSettings().aiAutoAnalyzeOfficial !== true) return null;
    const row = this.options.store().getOfficialSubmission(id);
    if (!row || row.status !== 'completed' || !row.submissionId || !row.result || ['unknown', 'internal_error'].includes(row.result.status)) return null;
    const attempt = this.options.store().getAttempt(row.attemptId);
    if (!attempt?.isActive || attempt.endedAt || attempt.mode === 'strict' || attempt.answerFormat !== 'function'
      || attempt.problemId !== row.problemId || attempt.problemVersion !== row.problemVersion || attempt.language !== row.language) return null;
    return row;
  }

  completed(record: OfficialSubmission): void {
    try {
      if (record.status !== 'completed' || this.#seen.has(record.id)) return;
      const row = this.#eligible(record.id);
      if (!row) return;
      this.#seen.add(row.id);
      if (this.options.store().getAIRequest(officialAnalysisRequestId(row.id))) return;
      this.#pending.set(row.id, row.attemptId);
      this.wake();
    } catch { this.options.onError?.(); }
  }

  /** Called on AI terminal events; a manual conversation finishes before a queued automatic review starts. */
  wake(): void {
    if (this.#paused || !this.#pending.size) return;
    if (this.#task) { this.#wakeAgain = true; return; }
    this.#wakeAgain = false;
    const epoch = this.#epoch;
    // Terminal events are emitted just before AiService releases its active request.
    // The next task lets that cleanup finish before consulting the busy gate.
    const task = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.#drain(epoch)).catch(() => this.options.onError?.()).finally(() => {
      if (this.#task !== task) return;
      this.#task = null;
      const again = this.#wakeAgain; this.#wakeAgain = false;
      if (again && !this.#paused) this.wake();
    });
    this.#task = task;
  }

  async #drain(epoch: number): Promise<void> {
    for (const [id, attemptId] of this.#pending) {
      if (epoch !== this.#epoch || this.#paused) return;
      let row = this.#eligible(id);
      const requestId = officialAnalysisRequestId(id);
      if (!row || this.options.store().getAIRequest(requestId)) { this.#pending.delete(id); continue; }
      if (this.options.busy?.(attemptId) || this.options.store().listAIRequests(attemptId).some(pending)) continue;
      // Reading key availability does not decrypt a credential or prompt for it.
      const provider = await this.options.provider();
      if (epoch !== this.#epoch || this.#paused) return;
      row = this.#eligible(id);
      if (!row || !provider.config || !provider.hasKey) { this.#pending.delete(id); continue; }
      if (this.options.busy?.(attemptId) || this.options.store().listAIRequests(attemptId).some(pending)) continue;
      this.#pending.delete(id);
      try {
        await this.options.request({ requestId, attemptId, kind: 'official-review', question: '', officialSubmissionId: row.id });
      } catch { this.options.onError?.(); }
    }
  }

  /** No automatic replay on resume. Already-started requests are cancelled by the owning AI service. */
  pause(): void { this.#paused = true; this.#epoch++; this.#pending.clear(); this.#wakeAgain = false; }
  resume(): void { this.#paused = false; }
  async idle(): Promise<void> { await this.#task; }
}
