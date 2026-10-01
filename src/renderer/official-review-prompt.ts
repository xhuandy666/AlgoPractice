import type { OfficialSubmission } from '../shared/official';
import type { ReviewOpportunity } from '../shared/review-plan';

/** A changed notification can overtake the claim reply. Re-read the durable state
 * before displaying; a noisy/changed scene leaves the consumed opportunity in management.
 */
export async function revalidateReviewPrompt(claimed: ReviewOpportunity,
  read: () => Promise<ReviewOpportunity | null>, valid: () => boolean, revision: () => number): Promise<ReviewOpportunity | null> {
  for (let check = 0; check < 3; check++) {
    const before = revision(); const fresh = await read();
    if (!valid() || !fresh || fresh.id !== claimed.id || fresh.problemId !== claimed.problemId ||
      fresh.learningDate !== claimed.learningDate || fresh.state !== 'claimed' || fresh.claimedAt !== claimed.claimedAt) return null;
    if (revision() === before) return fresh;
  }
  return null;
}

export interface ReviewPromptScene {
  workspaceKey: string;
  problemId: string;
  learningDate: string;
  foreground: boolean;
  blocked: boolean;
}
export interface ReviewPromptTicket {
  submissionRecordId: string;
  problemId: string;
  learningDate: string;
  workspaceKey: string;
  generation: number;
}

/** A live result may wait for its submit-button cleanup, never for a new UI scene.
 * This guard is not the daily deduplication ledger: SQLite owns that decision.
 */
export class OfficialReviewPromptGuard {
  #generation = 0;
  #scene: ReviewPromptScene | null = null;
  #seen = new Set<string>();
  update(scene: ReviewPromptScene): void {
    const previous = this.#scene;
    if (!previous || previous.workspaceKey !== scene.workspaceKey || previous.problemId !== scene.problemId ||
      previous.learningDate !== scene.learningDate || !scene.foreground || scene.blocked) this.invalidate();
    this.#scene = scene;
  }
  invalidate(): void { this.#generation++; }
  receive(record: OfficialSubmission): ReviewPromptTicket | null {
    if (record.status !== 'completed' || record.result?.status !== 'accepted' || !record.finishedAt ||
      !record.submissionId || !/^\d+$/.test(record.submissionId) || this.#seen.has(record.id)) return null;
    this.#seen.add(record.id);
    // A bounded memory guard only suppresses duplicate event deliveries in this renderer run.
    if (this.#seen.size > 512) this.#seen.delete(this.#seen.values().next().value!);
    const scene = this.#scene;
    if (!scene || !scene.foreground || scene.blocked || scene.problemId !== record.problemId) return null;
    return { submissionRecordId: record.id, problemId: record.problemId, learningDate: scene.learningDate,
      workspaceKey: scene.workspaceKey, generation: this.#generation };
  }
  current(ticket: ReviewPromptTicket): boolean {
    const scene = this.#scene;
    return Boolean(scene && scene.foreground && !scene.blocked && ticket.generation === this.#generation &&
      ticket.workspaceKey === scene.workspaceKey && ticket.problemId === scene.problemId && ticket.learningDate === scene.learningDate);
  }
}
