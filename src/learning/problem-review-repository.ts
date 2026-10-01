import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { pageBounds, pageResult } from '../storage/pagination.ts';
import { archiveDateBoundary } from '../shared/archive-date.ts';
import type { LearningSettings, PageRequest, PageResult, ReviewRating } from '../shared/learning.ts';
import type {
  AdvanceReviewSessionInput, ProblemReviewAssessmentInput, ProblemReviewBatchInput, ProblemReviewCorrectionInput,
  ProblemReviewDetail, ProblemReviewEvent, ProblemReviewPlan, ProblemReviewPreview, ProblemReviewPreviewInput,
  ProblemReviewResult, ReviewAssessmentDraft, ReviewAssessmentDraftInput, ReviewDayLoad, ReviewOpportunity,
  ReviewOpportunityFilter, ReviewPlanListItem, ReviewPlanQuery, ReviewPlanSnapshot, ReviewSession,
  StartReviewSessionInput, SubmitReviewOpportunityInput,
} from '../shared/review-plan.ts';
import { advanceReviewCard, localDate, newReviewCard, PROBLEM_FSRS_PARAMETERS, PROBLEM_FSRS_VERSION } from './fsrs.ts';

type Row = Record<string, string | number | null>;
type Transaction = <T>(operation: () => T) => T;
export const REVIEW_MERGE_STRATEGY = 'problem-review-merge-v1';
export const reviewDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export const reviewIdentity = (problemId: string) => `pr-${reviewDigest(problemId)}`;
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
function inputHash(value: unknown): string { return reviewDigest(stableJson(value)); }
function text(value: unknown, name: string, max = 200): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}不能为空或超过长度限制。`);
}
function rating(value: unknown): asserts value is ReviewRating {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 4) throw new Error('自评必须为四档之一。');
}
export function reviewTimestamp(value = new Date().toISOString()): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('复习时间无效。');
  return new Date(value).toISOString();
}
function fields(input: object, allowed: string[]): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('复习输入包含未知字段。');
}
function shiftDate(value: string, days: number): string {
  return new Date(Date.parse(`${value}T12:00:00.000Z`) + days * 86400000).toISOString().slice(0, 10);
}
function checkDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || shiftDate(value, 0) !== value) throw new Error('学习日期无效。');
}
function ids(values: unknown): string[] {
  if (!Array.isArray(values) || !values.length || values.length > 10000) throw new Error('请选择有效的复习题目集合。');
  for (const value of values) text(value, '题目身份');
  if (new Set(values).size !== values.length) throw new Error('复习题目集合不能重复。');
  return [...values] as string[];
}
const PLAN_SELECT = `SELECT p.*,
  (SELECT COUNT(*) FROM problem_review_events e WHERE e.plan_id=p.id AND e.kind='review') AS observation_count,
  (SELECT e.observed_at FROM problem_review_effective_events e WHERE e.plan_id=p.id ORDER BY e.observed_at DESC,e.stable_key DESC LIMIT 1) AS last_reviewed_at,
  (SELECT e.effective_rating FROM problem_review_effective_events e WHERE e.plan_id=p.id ORDER BY e.observed_at DESC,e.stable_key DESC LIMIT 1) AS latest_rating,
  (SELECT COUNT(*) FROM review_daily_ac_opportunities o WHERE o.problem_id=p.problem_id AND o.state IN ('pending','claimed','skipped')) AS pending_count,
  (SELECT COUNT(DISTINCT l.old_item_id) FROM review_legacy_links l WHERE l.plan_id=p.id) AS legacy_count
  FROM problem_review_plans p`;

/** One connection, one surrounding Store transaction: no independent writer or renderer-provided AC evidence. */
export class ProblemReviewRepository {
  constructor(private readonly db: DatabaseSync, private readonly transaction: Transaction,
    private readonly settings: () => LearningSettings) {}

  private plan(row: Row): ProblemReviewPlan {
    return { id: String(row.id), problemId: String(row.problem_id), card: row.card_json ? JSON.parse(String(row.card_json)) : null,
      dueAt: row.due_at as string | null, scheduledAt: row.scheduled_at as string | null, suspended: row.suspended === 1,
      algorithmVersion: String(row.algorithm_version), revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      lastReviewedAt: row.last_reviewed_at as string | null, latestRating: row.latest_rating as ReviewRating | null,
      observationCount: Number(row.observation_count ?? 0), pendingAssessmentCount: Number(row.pending_count ?? 0), legacyItemCount: Number(row.legacy_count ?? 0) };
  }
  getProblemReview(problemId: string): ProblemReviewPlan | undefined {
    const row = this.db.prepare(`${PLAN_SELECT} WHERE p.problem_id=?`).get(problemId) as Row | undefined;
    return row ? this.plan(row) : undefined;
  }
  resolveProblemReview(idOrProblem: string): ProblemReviewPlan | undefined {
    const row = this.db.prepare(`${PLAN_SELECT} WHERE p.id=? OR p.problem_id=? OR p.id=(SELECT plan_id FROM review_legacy_links WHERE old_item_id=? LIMIT 1)`)
      .get(idOrProblem, idOrProblem, idOrProblem) as Row | undefined;
    return row ? this.plan(row) : undefined;
  }
  listProblemReviews(): ProblemReviewPlan[] { return (this.db.prepare(`${PLAN_SELECT} ORDER BY p.due_at IS NULL,p.due_at,p.problem_id`).all() as Row[]).map(row => this.plan(row)); }
  addProblemReview(problemId: string, at?: string): ProblemReviewPlan {
    text(problemId, '题目身份'); const created = reviewTimestamp(at);
    return this.transaction(() => {
      const existing = this.getProblemReview(problemId); if (existing) return existing;
      if (!this.db.prepare('SELECT 1 FROM problems WHERE id=?').get(problemId)) throw new Error('题目不存在。');
      this.db.prepare(`INSERT INTO problem_review_plans
        (id,problem_id,legacy_anchor,initial_anchor,card_json,algorithm_version,parameters_json,due_at,scheduled_at,suspended,revision,created_at,updated_at)
        VALUES (?,?,NULL,NULL,NULL,?,?,NULL,NULL,0,1,?,?)`)
        .run(reviewIdentity(problemId), problemId, PROBLEM_FSRS_VERSION, JSON.stringify(PROBLEM_FSRS_PARAMETERS), created, created);
      return this.getProblemReview(problemId)!;
    });
  }
  addProblemReviews(input: { problemIds: string[] }): ProblemReviewPlan[] {
    fields(input, ['problemIds']); const problems = ids(input.problemIds);
    return this.transaction(() => problems.map(id => this.addProblemReview(id)));
  }
  updateProblemReviews(input: ProblemReviewBatchInput): ProblemReviewPlan[] {
    fields(input, ['problemIds', 'expectedRevisions', 'suspended', 'scheduledAt']); const problems = ids(input.problemIds);
    if (input.suspended !== undefined && typeof input.suspended !== 'boolean') throw new Error('暂停状态无效。');
    if (input.suspended === undefined && input.scheduledAt === undefined) throw new Error('请选择需要更新的安排。');
    const scheduled = input.scheduledAt === undefined ? undefined : input.scheduledAt === null ? null : reviewTimestamp(input.scheduledAt);
    return this.transaction(() => {
      const plans = problems.map(problemId => { const plan = this.getProblemReview(problemId); if (!plan) throw new Error('复习计划不存在。'); return plan; });
      if (input.expectedRevisions) {
        if (Object.keys(input.expectedRevisions).some(id => !problems.includes(id))) throw new Error('修订条件包含未选中的题目。');
        for (const plan of plans) if (input.expectedRevisions[plan.problemId] !== plan.revision) throw new Error('复习安排已变化，请刷新后重试。');
      }
      const at = reviewTimestamp();
      for (const plan of plans) this.db.prepare('UPDATE problem_review_plans SET suspended=?,scheduled_at=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(input.suspended === undefined ? Number(plan.suspended) : Number(input.suspended), scheduled === undefined ? plan.scheduledAt : scheduled, at, plan.id);
      return plans.map(plan => this.getProblemReview(plan.problemId)!);
    });
  }
  private event(row: Row): ProblemReviewEvent {
    const originalId = row.kind === 'correction' ? String(row.corrects_event_id) : String(row.id);
    const effective = this.db.prepare('SELECT effective_rating,is_initial FROM problem_review_effective_events WHERE id=?').get(originalId) as Row | undefined;
    const legacy = (this.db.prepare('SELECT old_event_id FROM review_legacy_links WHERE event_id=? AND old_event_id<>\'\' ORDER BY old_sequence,old_event_id').all(originalId) as Row[]).map(item => String(item.old_event_id));
    return { id: String(row.id), requestId: String(row.request_id), planId: String(row.plan_id), problemId: String(row.problem_id),
      kind: row.kind as ProblemReviewEvent['kind'], source: row.source as ProblemReviewEvent['source'], rating: Number(row.rating) as ReviewRating,
      effectiveRating: Number(effective?.effective_rating ?? row.rating) as ReviewRating, observedAt: String(row.observed_at), createdAt: String(row.created_at),
      learningDate: String(row.learning_date), timeZone: String(row.time_zone), correctsEventId: row.corrects_event_id as string | null,
      algorithmVersion: String(row.algorithm_version), attemptId: row.attempt_id as string | null, opportunityId: row.opportunity_id as string | null,
      sourceDeleted: row.source_deleted === 1, isInitialAssessment: row.kind === 'review' && effective?.is_initial === 1, legacySourceEventIds: legacy };
  }
  getProblemReviewEvent(id: string): ProblemReviewEvent | undefined {
    let row = this.db.prepare('SELECT * FROM problem_review_events WHERE id=?').get(id) as Row | undefined;
    if (!row) row = this.db.prepare('SELECT e.* FROM problem_review_events e JOIN review_legacy_links l ON l.event_id=e.id WHERE l.old_event_id=? LIMIT 1').get(id) as Row | undefined;
    return row ? this.event(row) : undefined;
  }
  listProblemReviewEvents(idOrProblem: string): ProblemReviewEvent[] {
    const plan = this.resolveProblemReview(idOrProblem); if (!plan) return [];
    return (this.db.prepare('SELECT * FROM problem_review_events WHERE plan_id=? ORDER BY sequence').all(plan.id) as Row[]).map(row => this.event(row));
  }
  getProblemReviewRequest(requestId: string): ProblemReviewResult | null {
    text(requestId, '请求身份'); const row = this.db.prepare('SELECT event_id FROM problem_review_requests WHERE request_id=?').get(requestId) as Row | undefined;
    if (!row) return null;
    const event = this.getProblemReviewEvent(String(row.event_id))!;
    return { plan: this.getProblemReview(event.problemId)!, event };
  }
  private prior(requestId: string, hash: string): ProblemReviewResult | null {
    const row = this.db.prepare('SELECT input_hash FROM problem_review_requests WHERE request_id=?').get(requestId) as Row | undefined;
    if (!row) return null;
    if (row.input_hash !== hash) throw new Error('同一自评请求身份不能用于不同输入。');
    return this.getProblemReviewRequest(requestId);
  }
  private observations(planId: string): Row[] {
    return this.db.prepare('SELECT * FROM problem_review_effective_events WHERE plan_id=? ORDER BY observed_at,stable_key').all(planId) as Row[];
  }
  private schedule(planId: string, observations: Row[]) {
    const plan = this.db.prepare('SELECT * FROM problem_review_plans WHERE id=?').get(planId) as Row;
    if (plan.algorithm_version !== PROBLEM_FSRS_VERSION || String(plan.parameters_json) !== JSON.stringify(PROBLEM_FSRS_PARAMETERS)) throw new Error('不支持该复习算法或参数，历史未改变。');
    if (!observations.length) return { card: null, anchor: plan.legacy_anchor as string | null };
    const first = String(observations[0].observed_at);
    const anchor = plan.legacy_anchor && String(plan.legacy_anchor) < first ? String(plan.legacy_anchor) : first;
    let card = newReviewCard(anchor);
    for (const event of observations) {
      if (event.algorithm_version !== PROBLEM_FSRS_VERSION) throw new Error('不支持历史观察的算法版本。');
      card = advanceReviewCard(card, String(event.observed_at), Number(event.effective_rating) as ReviewRating, PROBLEM_FSRS_VERSION, JSON.parse(String(plan.parameters_json)));
    }
    return { card, anchor };
  }
  replayProblemReview(problemId: string): void {
    const plan = this.getProblemReview(problemId); if (!plan) throw new Error('复习计划不存在。');
    const scheduled = this.schedule(plan.id, this.observations(plan.id));
    this.db.prepare('UPDATE problem_review_plans SET initial_anchor=?,card_json=?,due_at=?,revision=revision+1,updated_at=? WHERE id=?')
      .run(scheduled.anchor, scheduled.card ? JSON.stringify(scheduled.card) : null, scheduled.card?.due ?? null, reviewTimestamp(), plan.id);
  }
  private dayEvent(problemId: string, day: string): string | null {
    return this.db.prepare('SELECT event_id FROM problem_review_day_assessments WHERE problem_id=? AND learning_date=?').get(problemId, day)?.event_id as string | undefined ?? null;
  }
  private nextSequence(): number { return Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS value FROM problem_review_events').get()!.value); }
  private validateAttempt(attemptId: string | undefined, problemId: string): void {
    if (!attemptId) return;
    const attempt = this.db.prepare('SELECT problem_id FROM attempts WHERE id=?').get(attemptId);
    if (!attempt || attempt.problem_id !== problemId) throw new Error('练习来源与复习题目不匹配。');
  }
  private writeObservation(input: { requestId: string; problemId: string; rating: ReviewRating; hash: string; observedAt: string;
    learningDate: string; timeZone: string; source: 'manual' | 'official'; attemptId?: string | null; opportunityId?: string | null }): ProblemReviewResult {
    const prior = this.prior(input.requestId, input.hash); if (prior) return prior;
    const occupied = this.dayEvent(input.problemId, input.learningDate);
    if (occupied) throw new Error(`这道题当天已有自评，请修改已有记录（${occupied}）。`);
    const plan = this.addProblemReview(input.problemId);
    this.validateAttempt(input.attemptId ?? undefined, input.problemId);
    const id = `review-${reviewDigest(input.requestId)}`, created = reviewTimestamp();
    this.db.prepare(`INSERT INTO problem_review_events
      (id,request_id,sequence,plan_id,problem_id,kind,source,rating,observed_at,learning_date,time_zone,created_at,corrects_event_id,algorithm_version,attempt_id,opportunity_id,stable_key,source_deleted)
      VALUES (?,?,?,?,?,'review',?,?,?,?,?,?,NULL,?,?,?,?,?)`)
      .run(id, input.requestId, this.nextSequence(), plan.id, input.problemId, input.source, input.rating, input.observedAt, input.learningDate, input.timeZone, created,
        PROBLEM_FSRS_VERSION, input.attemptId ?? null, input.opportunityId ?? null, id, input.source === 'official' && input.attemptId === null ? 1 : 0);
    this.db.prepare('INSERT INTO problem_review_day_assessments VALUES (?,?,?,?,0)').run(input.problemId, input.learningDate, input.timeZone, id);
    this.db.prepare('INSERT INTO problem_review_requests VALUES (?,?,?)').run(input.requestId, input.hash, id);
    this.replayProblemReview(input.problemId);
    this.db.prepare("UPDATE review_daily_ac_opportunities SET state='assessed',assessment_event_id=? WHERE problem_id=? AND learning_date=? AND state IN ('pending','claimed','skipped')")
      .run(id, input.problemId, input.learningDate);
    this.db.prepare('UPDATE review_assessment_drafts SET resolved_event_id=?,revision=revision+1,updated_at=? WHERE request_id=? AND resolved_event_id IS NULL').run(id, created, input.requestId);
    return { plan: this.getProblemReview(input.problemId)!, event: this.getProblemReviewEvent(id)! };
  }
  private submittedDraft(requestId: string, source: 'manual' | 'official' | 'correction', problemId: string, grade: ReviewRating,
    sourceId?: string): ReviewAssessmentDraft | null {
    const row = this.db.prepare('SELECT * FROM review_assessment_drafts WHERE request_id=?').get(requestId) as Row | undefined;
    if (!row) return null;
    const draft = this.draft(row);
    if (!draft.submittedAt || draft.source !== source || draft.problemId !== problemId || draft.rating !== grade
      || (source === 'official' && draft.opportunityId !== sourceId) || (source === 'correction' && draft.eventId !== sourceId)) throw new Error('自评草稿尚未冻结，或与本次请求不一致。');
    return draft;
  }
  recordProblemReview(input: ProblemReviewAssessmentInput, at?: string): ProblemReviewResult {
    fields(input, ['requestId', 'problemId', 'rating', 'attemptId']); text(input.requestId, '请求身份'); text(input.problemId, '题目身份'); rating(input.rating);
    const hash = inputHash({ operation: 'manual', ...input }), observed = reviewTimestamp(at);
    return this.transaction(() => {
      const prior = this.prior(input.requestId, hash); if (prior) return prior;
      const draft = this.submittedDraft(input.requestId, 'manual', input.problemId, input.rating);
      const timeZone = draft?.timeZone ?? this.settings().timeZone, observedAt = draft?.observedAt ?? observed;
      return this.writeObservation({ ...input, hash, observedAt, learningDate: draft?.learningDate ?? localDate(observedAt, timeZone), timeZone, source: 'manual' });
    });
  }
  recordCompatibleReview(input: { requestId: string; itemId: string; rating: ReviewRating; reviewedAt?: string; attemptId?: string }): ProblemReviewResult {
    text(input.requestId, '请求身份'); rating(input.rating);
    return this.transaction(() => {
      const hash = inputHash(input), prior = this.prior(input.requestId, hash); if (prior) return prior;
      const plan = this.resolveProblemReview(input.itemId); if (!plan) throw new Error('复习计划不存在。');
      const at = reviewTimestamp(input.reviewedAt), timeZone = this.settings().timeZone;
      return this.writeObservation({ ...input, problemId: plan.problemId, hash, observedAt: at, learningDate: localDate(at, timeZone), timeZone, source: 'manual' });
    });
  }
  correctProblemReview(input: ProblemReviewCorrectionInput): ProblemReviewResult {
    fields(input, ['requestId', 'eventId', 'rating']); text(input.requestId, '请求身份'); text(input.eventId, '原评分身份'); rating(input.rating);
    return this.transaction(() => {
      const hash = inputHash({ operation: 'correction', ...input }), prior = this.prior(input.requestId, hash); if (prior) return prior;
      const original = this.getProblemReviewEvent(input.eventId);
      if (!original || original.kind !== 'review') throw new Error('未找到需要更正的原始自评。');
      this.submittedDraft(input.requestId, 'correction', original.problemId, input.rating, original.id);
      const id = `review-${reviewDigest(input.requestId)}`, created = reviewTimestamp();
      this.db.prepare(`INSERT INTO problem_review_events
        (id,request_id,sequence,plan_id,problem_id,kind,source,rating,observed_at,learning_date,time_zone,created_at,corrects_event_id,algorithm_version,attempt_id,opportunity_id,stable_key,source_deleted)
        VALUES (?,?,?,?,?,'correction',?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.requestId, this.nextSequence(), original.planId, original.problemId, original.source, input.rating,
          original.observedAt, original.learningDate, original.timeZone, created, original.id, PROBLEM_FSRS_VERSION, original.attemptId, original.opportunityId, id, Number(original.sourceDeleted));
      this.db.prepare('INSERT INTO problem_review_requests VALUES (?,?,?)').run(input.requestId, hash, id);
      this.replayProblemReview(original.problemId);
      this.db.prepare('UPDATE review_assessment_drafts SET resolved_event_id=?,revision=revision+1,updated_at=? WHERE request_id=? AND resolved_event_id IS NULL').run(id, created, input.requestId);
      return { plan: this.getProblemReview(original.problemId)!, event: this.getProblemReviewEvent(id)! };
    });
  }
  private opportunity(row: Row): ReviewOpportunity {
    return { id: String(row.id), planId: row.plan_id as string | null, problemId: String(row.problem_id), learningDate: String(row.learning_date), timeZone: String(row.time_zone),
      acceptedAt: String(row.accepted_at), officialSubmissionId: String(row.official_submission_id), submissionRecordId: row.submission_record_id as string | null,
      attemptId: row.attempt_id as string | null, problemVersion: String(row.problem_version), codeHash: String(row.code_hash),
      state: row.state as ReviewOpportunity['state'], claimedAt: row.claimed_at as string | null, skippedAt: row.skipped_at as string | null,
      assessmentEventId: row.assessment_event_id as string | null, sourceDeleted: row.source_deleted === 1, historicalBaseline: row.historical_baseline === 1, createdAt: String(row.created_at) };
  }
  private getOpportunity(id: string): ReviewOpportunity | null {
    const row = this.db.prepare('SELECT * FROM review_daily_ac_opportunities WHERE id=?').get(id) as Row | undefined;
    return row ? this.opportunity(row) : null;
  }
  getReviewOpportunityForSubmission(localRecordId: string): ReviewOpportunity | null {
    text(localRecordId, '官方记录身份'); const row = this.db.prepare('SELECT * FROM review_daily_ac_opportunities WHERE submission_record_id=?').get(localRecordId) as Row | undefined;
    return row ? this.opportunity(row) : null;
  }
  reviewOpportunities(filter: ReviewOpportunityFilter = {}): PageResult<ReviewOpportunity> {
    fields(filter, ['problemId', 'pendingOnly', 'learningDate', 'submissionRecordId', 'offset', 'limit']); const bounds = pageBounds(filter);
    const where: string[] = [], values: (string | number)[] = [];
    for (const [key, column] of [['problemId', 'problem_id'], ['learningDate', 'learning_date'], ['submissionRecordId', 'submission_record_id']] as const) {
      if (filter[key]) { text(filter[key], '资格筛选'); where.push(`${column}=?`); values.push(filter[key]!); }
    }
    if (filter.pendingOnly) where.push("state IN ('pending','claimed','skipped')");
    const condition = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM review_daily_ac_opportunities ${condition}`).get(...values)!.count);
    const items = (this.db.prepare(`SELECT * FROM review_daily_ac_opportunities ${condition} ORDER BY accepted_at DESC,id LIMIT ? OFFSET ?`).all(...values, bounds.limit, bounds.offset) as Row[]).map(row => this.opportunity(row));
    return pageResult(items, total, bounds);
  }
  registerReviewAccepted(localRecordId: string, historical = false, historicalTimeZone?: string): ReviewOpportunity | null {
    text(localRecordId, '官方记录身份');
    return this.transaction(() => {
      const previous = this.getReviewOpportunityForSubmission(localRecordId); if (previous) return previous;
      const row = this.db.prepare('SELECT s.*,a.problem_id,a.problem_version FROM official_submissions s JOIN attempts a ON a.id=s.attempt_id WHERE s.id=?').get(localRecordId) as Row | undefined;
      if (!row || row.status !== 'completed' || !row.submission_id || !row.finished_at) return null;
      const result = JSON.parse(String(row.result_json)); if (result?.status !== 'accepted') return null;
      if (!/^\d{1,30}$/.test(String(row.submission_id)) || reviewDigest(String(row.code)) !== row.code_hash) throw new Error('官方通过的可信快照无效。');
      const acceptedAt = reviewTimestamp(String(row.finished_at)), timeZone = historicalTimeZone ?? this.settings().timeZone;
      const day = localDate(acceptedAt, timeZone), problemId = String(row.problem_id);
      const occupied = this.db.prepare('SELECT * FROM review_daily_ac_opportunities WHERE problem_id=? AND learning_date=?').get(problemId, day) as Row | undefined;
      if (occupied) return this.opportunity(occupied);
      const plan = historical ? this.getProblemReview(problemId) : this.addProblemReview(problemId);
      const event = this.dayEvent(problemId, day), state = historical ? 'historical' : event ? 'assessed' : 'pending';
      const id = `ac-${reviewDigest(`${problemId}\0${day}`)}`;
      this.db.prepare(`INSERT INTO review_daily_ac_opportunities
        (id,plan_id,problem_id,learning_date,time_zone,accepted_at,official_submission_id,submission_record_id,attempt_id,problem_version,code_hash,state,claimed_at,skipped_at,assessment_event_id,historical_baseline,source_deleted,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,0,?)`)
        .run(id, plan?.id ?? null, problemId, day, timeZone, acceptedAt, row.submission_id, localRecordId, row.attempt_id, row.problem_version, row.code_hash,
          state, state === 'assessed' ? event : null, Number(historical), reviewTimestamp());
      return this.getOpportunity(id);
    });
  }
  claimReviewOpportunity(id: string, at?: string): ReviewOpportunity | null {
    text(id, '自评资格身份'); const claimedAt = reviewTimestamp(at);
    return this.transaction(() => {
      const opportunity = this.getOpportunity(id);
      if (!opportunity || opportunity.state !== 'pending' || opportunity.claimedAt || opportunity.historicalBaseline) return null;
      const existing = this.dayEvent(opportunity.problemId, opportunity.learningDate);
      if (existing) { this.db.prepare("UPDATE review_daily_ac_opportunities SET state='assessed',assessment_event_id=? WHERE id=?").run(existing, id); return null; }
      if (opportunity.learningDate !== localDate(claimedAt, this.settings().timeZone)) return null;
      this.db.prepare("UPDATE review_daily_ac_opportunities SET state='claimed',claimed_at=? WHERE id=? AND state='pending' AND claimed_at IS NULL").run(claimedAt, id);
      return this.getOpportunity(id);
    });
  }
  skipReviewOpportunity(id: string): ReviewOpportunity {
    text(id, '自评资格身份');
    return this.transaction(() => {
      const opportunity = this.getOpportunity(id); if (!opportunity) throw new Error('自评资格不存在。');
      if (opportunity.state === 'pending' || opportunity.state === 'claimed') this.db.prepare("UPDATE review_daily_ac_opportunities SET state='skipped',skipped_at=? WHERE id=?").run(reviewTimestamp(), id);
      return this.getOpportunity(id)!;
    });
  }
  submitReviewOpportunity(input: SubmitReviewOpportunityInput): ProblemReviewResult {
    fields(input, ['requestId', 'opportunityId', 'rating']); text(input.requestId, '请求身份'); text(input.opportunityId, '自评资格身份'); rating(input.rating);
    return this.transaction(() => {
      const hash = inputHash({ operation: 'official', ...input }), prior = this.prior(input.requestId, hash); if (prior) return prior;
      const opportunity = this.getOpportunity(input.opportunityId);
      if (!opportunity || opportunity.historicalBaseline) throw new Error('该记录不能新增官方通过自评。');
      if (opportunity.submissionRecordId) {
        const row = this.db.prepare('SELECT s.*,a.problem_id,a.problem_version FROM official_submissions s JOIN attempts a ON a.id=s.attempt_id WHERE s.id=?').get(opportunity.submissionRecordId) as Row | undefined;
        if (!row || row.status !== 'completed' || JSON.parse(String(row.result_json))?.status !== 'accepted' || row.submission_id !== opportunity.officialSubmissionId
          || row.problem_id !== opportunity.problemId || row.problem_version !== opportunity.problemVersion || row.code_hash !== opportunity.codeHash || row.finished_at !== opportunity.acceptedAt) throw new Error('官方通过来源已变化，不能记录自评。');
      } else if (!opportunity.sourceDeleted) throw new Error('官方自评缺少可信来源。');
      this.submittedDraft(input.requestId, 'official', opportunity.problemId, input.rating, opportunity.id);
      return this.writeObservation({ requestId: input.requestId, problemId: opportunity.problemId, rating: input.rating, hash,
        observedAt: opportunity.acceptedAt, learningDate: opportunity.learningDate, timeZone: opportunity.timeZone,
        source: 'official', opportunityId: opportunity.id, attemptId: opportunity.attemptId });
    });
  }
  detachReviewAttempt(attemptId: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE problem_review_events SET attempt_id=NULL,source_deleted=1 WHERE attempt_id=?').run(attemptId);
      this.db.prepare('UPDATE review_daily_ac_opportunities SET attempt_id=NULL,submission_record_id=NULL,source_deleted=1 WHERE attempt_id=?').run(attemptId);
    });
  }
  private assessmentContext(input: ProblemReviewPreviewInput, at?: string) {
    const source = input.source ?? 'manual'; const observed = reviewTimestamp(at), timeZone = this.settings().timeZone;
    if (source === 'official') { const opportunity = this.getOpportunity(input.opportunityId ?? '');
      if (!opportunity || opportunity.problemId !== input.problemId || opportunity.historicalBaseline) throw new Error('官方自评资格无效。');
      return { source, observedAt: opportunity.acceptedAt, learningDate: opportunity.learningDate, timeZone: opportunity.timeZone, original: null };
    }
    if (source === 'correction') { const original = this.getProblemReviewEvent(input.eventId ?? '');
      if (!original || original.problemId !== input.problemId || original.kind !== 'review') throw new Error('需要更正的记录无效。');
      return { source, observedAt: original.observedAt, learningDate: original.learningDate, timeZone: original.timeZone, original };
    }
    if (source !== 'manual') throw new Error('自评来源无效。');
    return { source, observedAt: observed, learningDate: localDate(observed, timeZone), timeZone, original: null };
  }
  previewProblemReview(input: ProblemReviewPreviewInput, at?: string): ProblemReviewPreview {
    fields(input, ['problemId', 'rating', 'source', 'opportunityId', 'eventId', 'requestId']); text(input.problemId, '题目身份'); rating(input.rating);
    if (input.requestId!==undefined) text(input.requestId, '请求身份');
    let context = this.assessmentContext(input, at);
    const draft = input.requestId ? this.submittedDraft(input.requestId, context.source, input.problemId, input.rating,
      context.source==='official' ? input.opportunityId : context.source==='correction' ? context.original!.id : undefined) : null;
    if (draft) context = { ...context, observedAt: draft.observedAt, learningDate: draft.learningDate, timeZone: draft.timeZone };
    const plan = this.getProblemReview(input.problemId);
    if (!plan) throw new Error('复习计划不存在。');
    let observations = this.observations(plan.id).map(row => ({ ...row }));
    const previewId = input.requestId ? `review-${reviewDigest(input.requestId)}` : 'preview';
    if (context.original) observations.find(row => row.id === context.original!.id)!.effective_rating = input.rating;
    else if (!observations.some(row => row.id===previewId)) observations.push({ id: previewId, plan_id: plan.id, source: context.source, observed_at: context.observedAt, effective_rating: input.rating,
      algorithm_version: PROBLEM_FSRS_VERSION, stable_key: previewId, learning_date: context.learningDate });
    observations.sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)) || String(a.stable_key).localeCompare(String(b.stable_key)));
    const schedule = this.schedule(plan.id, observations);
    const assessedId = context.original?.id ?? previewId;
    const isInitialAssessment = !observations.some(row => row.source === 'legacy') && observations[0]?.id === assessedId;
    return { problemId: plan.problemId, learningDate: context.learningDate, timeZone: context.timeZone, observedAt: context.observedAt,
      dueAt: schedule.card!.due, currentDueAt: plan.dueAt, isInitialAssessment,
      conflictEventId: context.original || this.dayEvent(plan.problemId, context.learningDate)===previewId ? null : this.dayEvent(plan.problemId, context.learningDate),
      affectedDates: [...new Set(observations.map(row => String(row.learning_date)))].sort() };
  }
  private completeCounts(day: string): { reviewed: number; first: number } {
    const row = this.db.prepare(`SELECT COUNT(DISTINCT CASE WHEN is_initial=0 THEN problem_id END) AS reviewed,
      COUNT(DISTINCT CASE WHEN is_initial=1 THEN problem_id END) AS first
      FROM problem_review_effective_events WHERE learning_date=?`).get(day)!;
    return { reviewed: Number(row.reviewed), first: Number(row.first) };
  }
  private listItem(plan: ProblemReviewPlan, at: string, day: string, timeZone: string): ReviewPlanListItem {
    const content = this.db.prepare(`SELECT json_extract(v.snapshot_json,'$.title') AS title,
      json_extract(v.snapshot_json,'$.difficulty') AS difficulty,json_extract(v.snapshot_json,'$.tags') AS tags_json,
      json_extract(v.snapshot_json,'$.source') AS source,json_extract(v.snapshot_json,'$.sourceUrl') AS source_url
      FROM library_problem_heads h JOIN problem_versions v ON v.problem_id=h.problem_id AND v.version=h.version WHERE h.problem_id=?`).get(plan.problemId);
    const tags = content?.tags_json ? JSON.parse(String(content.tags_json)) : [];
    const listIds = (this.db.prepare('SELECT DISTINCT list_id FROM list_items WHERE problem_id=? ORDER BY list_id').all(plan.problemId) as Row[]).map(item => String(item.list_id));
    const effective = plan.dueAt ? plan.scheduledAt && plan.scheduledAt > plan.dueAt ? plan.scheduledAt : plan.dueAt : null;
    const effectiveDate = effective ? localDate(effective, timeZone) : null;
    const statuses: ReviewPlanListItem['statuses'] = [];
    if (plan.suspended) statuses.push('suspended');
    else if (!plan.card) statuses.push('unassessed');
    else if (effectiveDate! < day) statuses.push('overdue', 'due');
    else if (effectiveDate === day && (!plan.scheduledAt || plan.scheduledAt <= at)) statuses.push('due');
    else statuses.push('scheduled');
    if (plan.pendingAssessmentCount > 0) statuses.push('pending');
    return { ...plan, title: typeof content?.title === 'string' ? content.title : plan.problemId,
      difficulty: typeof content?.difficulty === 'string' ? content.difficulty : '未知', tags: Array.isArray(tags) ? tags.filter((tag: unknown) => typeof tag === 'string') : [],
      source: typeof content?.source === 'string' ? content.source : 'local', sourceUrl: typeof content?.source_url === 'string' ? content.source_url : null,
      listIds, statuses, effectiveDueAt: effective, effectiveDate };
  }
  getReviewPlanSnapshot(query: ReviewPlanQuery = {}, at?: string): ReviewPlanSnapshot {
    fields(query, ['view', 'search', 'listId', 'tag', 'status', 'date', 'month', 'sort', 'offset', 'limit']); const bounds = pageBounds(query), observed = reviewTimestamp(at);
    if (query.view && !['today', 'all', 'calendar'].includes(query.view)) throw new Error('复习视图无效。');
    if (query.sort && !['due', 'recent'].includes(query.sort)) throw new Error('复习排序无效。');
    if (query.status && !['unassessed', 'due', 'overdue', 'scheduled', 'suspended', 'pending'].includes(query.status)) throw new Error('复习状态筛选无效。');
    if (query.date) checkDate(query.date);
    const month = query.month ?? (query.date ?? localDate(observed, this.settings().timeZone)).slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('复习月份无效。');
    if (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 500)) throw new Error('搜索文字无效。');
    return this.transaction(() => {
      const settings = this.settings(), day = localDate(observed, settings.timeZone), end = archiveDateBoundary(day, settings.timeZone, true);
      const plans = this.listProblemReviews(), all = plans.map(plan => this.listItem(plan, observed, day, settings.timeZone));
      const done = new Set((this.db.prepare('SELECT problem_id FROM problem_review_day_assessments WHERE learning_date=?').all(day) as Row[]).map(row => String(row.problem_id)));
      const counts = this.completeCounts(day), remaining = settings.dailyReviewBudget === null ? null : Math.max(0, settings.dailyReviewBudget - counts.reviewed);
      const due = all.filter(item => !item.suspended && item.dueAt && item.dueAt < end && (!item.scheduledAt || item.scheduledAt < end) && !done.has(item.problemId));
      const eligible = due.filter(item => !item.scheduledAt || item.scheduledAt <= observed);
      eligible.sort((a, b) => a.effectiveDueAt!.localeCompare(b.effectiveDueAt!) || a.problemId.localeCompare(b.problemId));
      const recommended = remaining === null ? eligible : eligible.slice(0, remaining), recommendedIds = new Set(recommended.map(item => item.problemId));
      const summary = { date: day, timeZone: settings.timeZone, budget: settings.dailyReviewBudget, reviewedToday: counts.reviewed,
        firstAssessedToday: counts.first, remainingBudget: remaining, totalCount: all.length, dueCount: due.length,
        overdueCount: due.filter(item => item.effectiveDate! < day).length, deferredCount: due.length - eligible.length,
        postponedCount: all.filter(item => !item.suspended && item.dueAt && item.scheduledAt && item.scheduledAt>item.dueAt && item.scheduledAt>observed).length,
        suspendedCount: all.filter(item => item.suspended).length, unassessedCount: all.filter(item => !item.card).length,
        pendingAssessmentCount: Number(this.db.prepare("SELECT COUNT(DISTINCT problem_id) AS count FROM review_daily_ac_opportunities WHERE state IN ('pending','claimed','skipped')").get()!.count),
        plannedCount: recommended.length, extraDueCount: Math.max(0, eligible.length - recommended.length) };
      const dayLoad = (date: string): ReviewDayLoad => {
        const done = this.completeCounts(date);
        return { date, scheduledCount: all.filter(item => !item.suspended && item.effectiveDate === date).length,
          reviewedCount: done.reviewed, firstAssessmentCount: done.first,
          pendingCount: Number(this.db.prepare("SELECT COUNT(DISTINCT problem_id) AS count FROM review_daily_ac_opportunities WHERE learning_date=? AND state IN ('pending','claimed','skipped')").get(date)!.count),
          overdueCount: date === day ? summary.overdueCount : 0 };
      };
      const first = `${month}-01`, weekday = (new Date(`${first}T12:00:00.000Z`).getUTCDay() + 6) % 7;
      const calendar = Array.from({ length: 42 }, (_, index) => dayLoad(shiftDate(first, index - weekday)));
      const next7 = Array.from({ length: 7 }, (_, index) => dayLoad(shiftDate(day, index)));
      let filtered = all.filter(item => {
        if (query.search && !item.title.toLocaleLowerCase().includes(query.search.trim().toLocaleLowerCase())) return false;
        if (query.listId && !item.listIds.includes(query.listId)) return false;
        if (query.tag && !item.tags.includes(query.tag)) return false;
        if (query.status && !item.statuses.includes(query.status)) return false;
        if (query.date) return query.date === day ? due.some(entry => entry.problemId === item.problemId) : item.effectiveDate === query.date && !item.suspended;
        return (query.view ?? 'today') !== 'today' || recommendedIds.has(item.problemId);
      });
      filtered.sort(query.sort === 'recent' ? (a, b) => (b.lastReviewedAt ?? '').localeCompare(a.lastReviewedAt ?? '') || a.problemId.localeCompare(b.problemId)
        : (a, b) => (a.effectiveDueAt ?? '9999').localeCompare(b.effectiveDueAt ?? '9999') || a.problemId.localeCompare(b.problemId));
      const total = filtered.length; filtered = filtered.slice(bounds.offset, bounds.offset + bounds.limit);
      const revision = Number(this.db.prepare('SELECT revision FROM problem_review_meta WHERE id=1').get()!.revision);
      return { snapshotVersion: `${revision}:${reviewDigest(stableJson(settings))}:${observed}`, query: { ...query, month }, summary, next7, calendar,
        items: pageResult(filtered, total, bounds),
        listOptions: (this.db.prepare('SELECT id,title FROM study_lists ORDER BY title,id').all() as Row[]).map(row => ({ id: String(row.id), title: String(row.title) })),
        tagOptions: [...new Set(all.flatMap(item => item.tags))].sort() };
    });
  }
  getProblemReviewDetail(problemId: string, history: PageRequest = {}): ProblemReviewDetail {
    text(problemId, '题目身份'); const bounds = pageBounds(history);
    return this.transaction(() => {
      const plan = this.getProblemReview(problemId); if (!plan) throw new Error('复习计划不存在。');
      const settings = this.settings(), at = reviewTimestamp(), day = localDate(at, settings.timeZone);
      const total = Number(this.db.prepare('SELECT COUNT(*) AS count FROM problem_review_events WHERE plan_id=?').get(plan.id)!.count);
      const events = (this.db.prepare('SELECT * FROM problem_review_events WHERE plan_id=? ORDER BY observed_at DESC,sequence DESC LIMIT ? OFFSET ?').all(plan.id, bounds.limit, bounds.offset) as Row[]).map(row => this.event(row));
      const itemIds = (this.db.prepare('SELECT DISTINCT old_item_id FROM review_legacy_links WHERE plan_id=? ORDER BY old_item_id').all(plan.id) as Row[]).map(row => String(row.old_item_id));
      const report = this.db.prepare('SELECT report_json FROM problem_review_migrations WHERE strategy=?').get(REVIEW_MERGE_STRATEGY);
      const conflict = report ? JSON.parse(String(report.report_json)).conflicts.some((value: { problemId: string }) => value.problemId === problemId) : false;
      const legacyTotal = Number(this.db.prepare("SELECT COUNT(*) AS count FROM review_legacy_links WHERE plan_id=? AND old_event_id<>''").get(plan.id)!.count);
      const legacySources = (this.db.prepare(`SELECT e.*,i.target,i.language FROM review_legacy_links l
        JOIN review_events e ON e.id=l.old_event_id JOIN review_items i ON i.id=e.item_id
        WHERE l.plan_id=? AND l.old_event_id<>'' ORDER BY l.old_sequence DESC,e.id LIMIT ? OFFSET ?`).all(plan.id, bounds.limit, bounds.offset) as Row[]).map(row => ({
          itemId: String(row.item_id), eventId: String(row.id), target: String(row.target), language: String(row.language),
          kind: row.kind as 'review' | 'correction', rating: Number(row.rating) as ReviewRating, observedAt: String(row.reviewed_at), createdAt: String(row.created_at),
          correctsEventId: row.corrects_event_id as string | null, algorithmVersion: String(row.algorithm_version), attemptId: row.attempt_id as string | null,
        }));
      // The legacy identity CHECK/UNIQUE admits at most concept + Python + Java: compact snapshots,
      // not problem bodies or source code. Keep original due/parameters visible, not just their IDs.
      const legacyPlans = (this.db.prepare('SELECT * FROM review_items WHERE problem_id=? ORDER BY target,language,id').all(problemId) as Row[]).map(row => ({
        id: String(row.id), target: String(row.target), language: String(row.language), initialCard: JSON.parse(String(row.initial_card_json)),
        card: JSON.parse(String(row.card_json)), algorithmVersion: String(row.algorithm_version), parameters: JSON.parse(String(row.parameters_json)),
        dueAt: String(row.due_at), scheduledAt: row.scheduled_at as string | null, suspended: row.suspended === 1,
        createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      }));
      return { plan, item: this.listItem(plan, at, day, settings.timeZone), events: pageResult(events, total, bounds),
        legacySources: pageResult(legacySources, legacyTotal, bounds),
        legacyPlans,
        opportunities: this.reviewOpportunities({ problemId, limit: 100 }),
        migration: { strategy: itemIds.length ? REVIEW_MERGE_STRATEGY : null, itemIds, conflict,
          historicalObservations: Number(this.db.prepare("SELECT COUNT(*) AS count FROM problem_review_events WHERE plan_id=? AND kind='review' AND source='legacy'").get(plan.id)!.count) } };
    });
  }
  private draft(row: Row): ReviewAssessmentDraft {
    const occupied = row.submitted_at && !row.resolved_event_id && row.source!=='correction'
      ? this.dayEvent(String(row.problem_id), String(row.learning_date)) : null;
    const conflictEventId = occupied && !this.db.prepare('SELECT 1 FROM problem_review_requests WHERE request_id=?').get(String(row.request_id)) ? occupied : null;
    return { key: String(row.key), problemId: String(row.problem_id), source: row.source as ReviewAssessmentDraft['source'], opportunityId: row.opportunity_id as string | null,
      eventId: row.event_id as string | null, rating: row.rating as ReviewRating | null, requestId: String(row.request_id),
      learningDate: String(row.learning_date), timeZone: String(row.time_zone), observedAt: String(row.observed_at), submittedAt: row.submitted_at as string | null,
      revision: Number(row.revision), resolvedEventId: row.resolved_event_id as string | null, updatedAt: String(row.updated_at), conflictEventId };
  }
  getReviewAssessmentDraft(key: string): ReviewAssessmentDraft | null {
    text(key, '草稿身份', 1000); const row = this.db.prepare('SELECT * FROM review_assessment_drafts WHERE key=?').get(key) as Row | undefined;
    return row ? this.draft(row) : null;
  }
  saveReviewAssessmentDraft(input: ReviewAssessmentDraftInput): ReviewAssessmentDraft {
    fields(input, ['key', 'problemId', 'source', 'opportunityId', 'eventId', 'rating', 'requestId', 'expectedRevision', 'submitted']);
    text(input.key, '草稿身份', 1000); text(input.requestId, '请求身份'); text(input.problemId, '题目身份');
    if (input.rating !== null) rating(input.rating);
    if (input.submitted !== undefined && typeof input.submitted !== 'boolean') throw new Error('草稿发送状态无效。');
    if (input.submitted && input.rating === null) throw new Error('请选择评级后再提交。');
    return this.transaction(() => {
      const current = this.getReviewAssessmentDraft(input.key);
      if (current && input.expectedRevision !== current.revision) throw new Error('自评草稿已变化，请恢复最新版本。');
      if (current && (current.problemId !== input.problemId || current.source !== input.source || current.opportunityId !== (input.opportunityId ?? null)
        || current.eventId !== (input.eventId ?? null) || current.requestId !== input.requestId)) throw new Error('草稿的来源与请求身份不能改变。');
      if (current?.resolvedEventId) throw new Error('这次自评已经保存，请查看结果。');
      if (current?.submittedAt) {
        if (current.rating !== input.rating || input.submitted === false) throw new Error('已发送的自评不能改变评级，请查询原请求。');
        return current;
      }
      if (!this.db.prepare('SELECT 1 FROM problems WHERE id=?').get(input.problemId)) throw new Error('题目不存在。');
      const at = reviewTimestamp(), context = this.assessmentContext({ problemId: input.problemId, source: input.source,
        opportunityId: input.opportunityId, eventId: input.eventId, rating: input.rating ?? 3 }, at);
      const submittedAt = input.submitted ? at : null;
      this.db.prepare(`INSERT INTO review_assessment_drafts
        (key,problem_id,source,opportunity_id,event_id,rating,request_id,learning_date,time_zone,observed_at,submitted_at,revision,resolved_event_id,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1,NULL,?) ON CONFLICT(key) DO UPDATE SET
        rating=excluded.rating,learning_date=excluded.learning_date,time_zone=excluded.time_zone,observed_at=excluded.observed_at,
        submitted_at=excluded.submitted_at,revision=review_assessment_drafts.revision+1,updated_at=excluded.updated_at`)
        .run(input.key, input.problemId, input.source, input.opportunityId ?? null, input.eventId ?? null, input.rating, input.requestId,
          context.learningDate, context.timeZone, context.observedAt, submittedAt, at);
      return this.getReviewAssessmentDraft(input.key)!;
    });
  }
  deleteReviewAssessmentDraft(key: string, expectedRevision?: number): void {
    this.transaction(() => { const draft = this.getReviewAssessmentDraft(key); if (!draft) return;
      if (expectedRevision !== undefined && expectedRevision !== draft.revision) throw new Error('自评草稿已变化。');
      if (draft.submittedAt && !draft.resolvedEventId) {
        const knownResult = this.getProblemReviewRequest(draft.requestId);
        // A committed immutable day slot proves a new observation cannot later succeed, even if
        // another window won between preview and send. Preserve unknown retries only while their
        // write remains possible; correction retries are not governed by the one-per-day gate.
        const permanentConflict = draft.source!=='correction' && this.dayEvent(draft.problemId, draft.learningDate)!==null;
        if (!knownResult && !permanentConflict) throw new Error('自评结果尚未确认，请先查询或重试原请求。');
      }
      this.db.prepare('DELETE FROM review_assessment_drafts WHERE key=?').run(key);
    });
  }
  private session(row: Row): ReviewSession {
    const problems = JSON.parse(String(row.problem_ids_json)) as string[], position = Number(row.position);
    return { id: String(row.id), problemIds: problems, position, currentProblemId: row.status === 'active' ? problems[position] ?? null : null,
      status: row.status as ReviewSession['status'], skippedProblemIds: JSON.parse(String(row.skipped_json)), createdAt: String(row.created_at),
      updatedAt: String(row.updated_at), endedAt: row.ended_at as string | null };
  }
  private refreshSession(session: ReviewSession): ReviewSession {
    if (session.status !== 'active') return session;
    const at = reviewTimestamp(), timeZone = this.settings().timeZone, day = localDate(at, timeZone), end = archiveDateBoundary(day, timeZone, true);
    const source = this.db.prepare('SELECT queue_policy,scheduled_dates_json FROM review_sessions WHERE id=?').get(session.id) as Row;
    const scheduledAtStart = JSON.parse(String(source.scheduled_dates_json)) as Record<string, string | null>;
    let position = session.position;
    while (position < session.problemIds.length) {
      const plan = this.getProblemReview(session.problemIds[position]);
      const newlyPostponed = plan?.scheduledAt && plan.scheduledAt>at && plan.scheduledAt!==scheduledAtStart[plan.problemId];
      const recommendedEligible = plan?.dueAt && plan.dueAt<end && (!plan.scheduledAt || plan.scheduledAt<=at);
      if (plan?.card && !plan.suspended && !this.dayEvent(plan.problemId, day) && !newlyPostponed
        && (source.queue_policy==='selected' || recommendedEligible)) break;
      position++;
    }
    if (position !== session.position || position >= session.problemIds.length) {
      const at = reviewTimestamp(), ended = position >= session.problemIds.length;
      this.db.prepare('UPDATE review_sessions SET position=?,status=?,updated_at=?,ended_at=? WHERE id=?').run(position, ended ? 'ended' : 'active', at, ended ? at : null, session.id);
      return this.session(this.db.prepare('SELECT * FROM review_sessions WHERE id=?').get(session.id) as Row);
    }
    return session;
  }
  getReviewSession(id?: string): ReviewSession | null {
    return this.transaction(() => { const row = id ? this.db.prepare('SELECT * FROM review_sessions WHERE id=?').get(id) : this.db.prepare("SELECT * FROM review_sessions WHERE status='active' LIMIT 1").get();
      return row ? this.refreshSession(this.session(row as Row)) : null; });
  }
  startReviewSession(input: StartReviewSessionInput): ReviewSession {
    fields(input, ['requestId', 'problemIds']); text(input.requestId, '会话请求身份');
    const requested = input.problemIds ? ids(input.problemIds) : null, hash = inputHash({ ...input, problemIds: requested });
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM review_sessions WHERE request_id=?').get(input.requestId) as Row | undefined;
      if (prior) { if (prior.input_hash !== hash) throw new Error('会话请求身份与输入冲突。'); return this.refreshSession(this.session(prior)); }
      const active = this.getReviewSession(); if (active?.status === 'active') {
        if (!requested) return active;
        throw new Error('已有复习会话，请先继续或结束当前会话。');
      }
      const at = reviewTimestamp(), timeZone = this.settings().timeZone, day = localDate(at, timeZone);
      let problems = requested;
      if (!problems) {
        const snapshot = this.getReviewPlanSnapshot({ view: 'today', limit: 100 }, at);
        const all = this.listProblemReviews().map(plan => this.listItem(plan, at, day, timeZone));
        const eligible = all.filter(plan => plan.card && !plan.suspended && plan.statuses.includes('due') && !this.dayEvent(plan.problemId, day))
          .sort((a, b) => a.effectiveDueAt!.localeCompare(b.effectiveDueAt!) || a.problemId.localeCompare(b.problemId));
        problems = (snapshot.summary.remainingBudget === null ? eligible : eligible.slice(0, snapshot.summary.remainingBudget)).map(plan => plan.problemId);
      }
      for (const id of problems) { const plan = this.getProblemReview(id); if (!plan?.card || plan.suspended || this.dayEvent(id, day)) throw new Error('所选题目尚未评估、已暂停或今天已经自评。'); }
      if (!problems.length) throw new Error('当前没有可开始的复习题目。');
      const id = `session-${reviewDigest(input.requestId)}`;
      const scheduledAtStart = Object.fromEntries(problems.map(problemId => [problemId, this.getProblemReview(problemId)!.scheduledAt]));
      this.db.prepare(`INSERT INTO review_sessions
        (id,request_id,input_hash,problem_ids_json,position,status,skipped_json,created_at,updated_at,ended_at,queue_policy,scheduled_dates_json)
        VALUES (?,?,?,?,0,'active','[]',?,?,NULL,?,?)`)
        .run(id, input.requestId, hash, JSON.stringify(problems), at, at, requested ? 'selected' : 'recommended', JSON.stringify(scheduledAtStart));
      return this.getReviewSession(id)!;
    });
  }
  advanceReviewSession(input: AdvanceReviewSessionInput): ReviewSession {
    fields(input, ['sessionId', 'problemId', 'skipped']); text(input.sessionId, '会话身份'); text(input.problemId, '题目身份');
    if (input.skipped !== undefined && typeof input.skipped !== 'boolean') throw new Error('跳过状态无效。');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM review_sessions WHERE id=?').get(input.sessionId) as Row | undefined;
      if (!row) throw new Error('复习会话不存在。'); const session = this.session(row);
      if (session.status === 'ended') return session;
      const index = session.problemIds.indexOf(input.problemId);
      if (index < 0 || index > session.position) throw new Error('会话位置已变化，请重新读取当前题目。');
      if (index < session.position) return this.refreshSession(session);
      if (!input.skipped && !this.dayEvent(input.problemId, localDate(reviewTimestamp(), this.settings().timeZone))) throw new Error('请先自评，或明确跳过这道题。');
      const skipped = input.skipped ? [...new Set([...session.skippedProblemIds, input.problemId])] : session.skippedProblemIds;
      this.db.prepare('UPDATE review_sessions SET position=position+1,skipped_json=?,updated_at=? WHERE id=?').run(JSON.stringify(skipped), reviewTimestamp(), session.id);
      return this.refreshSession(this.session(this.db.prepare('SELECT * FROM review_sessions WHERE id=?').get(session.id) as Row));
    });
  }
  endReviewSession(id: string): ReviewSession {
    text(id, '会话身份'); return this.transaction(() => { const row = this.db.prepare('SELECT * FROM review_sessions WHERE id=?').get(id) as Row | undefined;
      if (!row) throw new Error('复习会话不存在。'); if (row.status !== 'ended') { const at = reviewTimestamp(); this.db.prepare("UPDATE review_sessions SET status='ended',ended_at=?,updated_at=? WHERE id=?").run(at, at, id); }
      return this.session(this.db.prepare('SELECT * FROM review_sessions WHERE id=?').get(id) as Row); });
  }
}
