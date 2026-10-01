import type { DatabaseSync } from 'node:sqlite';
import type { LearningSettings, ReviewRating } from '../shared/learning.ts';
import type { ProblemReviewMigrationReport } from '../shared/review-plan.ts';
import { advanceReviewCard, FSRS_PARAMETERS, FSRS_VERSION, localDate, PROBLEM_FSRS_PARAMETERS, PROBLEM_FSRS_VERSION } from './fsrs.ts';
import { ProblemReviewRepository, REVIEW_MERGE_STRATEGY, reviewDigest, reviewIdentity, reviewTimestamp } from './problem-review-repository.ts';

type Row = Record<string, string | number | null>;

/** Called after MIGRATE_V9 inside the existing Store upgrade transaction, never against a separate live connection. */
export function migrateProblemReviewData(db: DatabaseSync, timeZone: string, at?: string): ProblemReviewMigrationReport {
  const completedAt = reviewTimestamp(at); new Intl.DateTimeFormat('en', { timeZone }).format();
  const previous = db.prepare('SELECT report_json FROM problem_review_migrations WHERE strategy=?').get(REVIEW_MERGE_STRATEGY);
  if (previous) return JSON.parse(String(previous.report_json));
  const items = db.prepare('SELECT * FROM review_items ORDER BY problem_id,created_at,id').all() as Row[];
  const events = db.prepare('SELECT rowid AS legacy_sequence,* FROM review_events ORDER BY rowid').all() as Row[];
  const byItem = new Map(items.map(item => [String(item.id), item]));
  const original = new Map(events.filter(event => event.kind === 'review').map(event => [String(event.id), event]));
  const corrections = new Map<string, Row>();
  // Validate every old source before creating a projection. Do not silently swallow an unsupported card.
  for (const item of items) {
    if (item.algorithm_version !== FSRS_VERSION || String(item.parameters_json) !== JSON.stringify(FSRS_PARAMETERS)) throw new Error('不支持旧复习算法或参数，迁移已停止。');
    reviewTimestamp(String(item.created_at)); reviewTimestamp(String(item.due_at));
    if (item.scheduled_at) reviewTimestamp(String(item.scheduled_at));
    const initial = JSON.parse(String(item.initial_card_json));
    // The pinned adapter verifies both library identity and the stored profile, without mutating history.
    advanceReviewCard(initial, String(item.created_at), 3, FSRS_VERSION, JSON.parse(String(item.parameters_json)));
  }
  for (const event of events) {
    const item = byItem.get(String(event.item_id));
    if (!item || event.algorithm_version !== FSRS_VERSION) throw new Error('旧复习事件缺少可信卡片或版本。');
    if (reviewTimestamp(String(event.reviewed_at)) < String(item.created_at)) throw new Error('旧评分早于卡片创建，无法可靠迁移。');
    if (event.kind === 'correction') {
      const source = original.get(String(event.corrects_event_id));
      if (!source || source.item_id !== event.item_id || source.reviewed_at !== event.reviewed_at) throw new Error('旧评分更正来源不一致。');
      corrections.set(String(source.id), event);
    }
  }
  const settings = (): LearningSettings => ({ dailyReviewBudget: 3, dailyPracticeGoal: 3, timeZone, updatedAt: completedAt });
  const repository = new ProblemReviewRepository(db, operation => operation(), settings);
  const report: ProblemReviewMigrationReport = { strategy: REVIEW_MERGE_STRATEGY, migratedPlans: 0, legacyItems: items.length,
    legacyEvents: events.length, observations: 0, historicalAcDays: 0, conflicts: [] };
  const byProblem = new Map<string, Row[]>();
  for (const item of items) { const key = String(item.problem_id), list = byProblem.get(key) ?? []; list.push(item); byProblem.set(key, list); }
  let sequence = 0;
  for (const [problemId, oldItems] of byProblem) {
    const planId = reviewIdentity(problemId), anchor = oldItems.map(item => String(item.created_at)).sort()[0];
    const active = oldItems.filter(item => item.suspended === 0), suspended = active.length === 0;
    const scheduled = (active.length ? active : oldItems).map(item => item.scheduled_at as string | null).filter((at): at is string => at !== null).sort().at(-1) ?? null;
    db.prepare(`INSERT INTO problem_review_plans
      (id,problem_id,legacy_anchor,initial_anchor,card_json,algorithm_version,parameters_json,due_at,scheduled_at,suspended,revision,created_at,updated_at)
      VALUES (?,?,?,NULL,NULL,?,?,NULL,?,?,1,?,?)`)
      .run(planId, problemId, anchor, PROBLEM_FSRS_VERSION, JSON.stringify(PROBLEM_FSRS_PARAMETERS), scheduled, Number(suspended), anchor, completedAt);
    const conflict = new Set(oldItems.map(item => Number(item.suspended))).size > 1 || new Set(oldItems.map(item => item.scheduled_at)).size > 1;
    if (conflict) report.conflicts.push({ problemId, itemIds: oldItems.map(item => String(item.id)), suspended, scheduledAt: scheduled });
    for (const item of oldItems) db.prepare('INSERT INTO review_legacy_links VALUES (?,\'\',?,NULL,NULL,?)').run(item.id, planId, REVIEW_MERGE_STRATEGY);
    const groups = new Map<string, Row[]>();
    for (const event of original.values()) {
      if (byItem.get(String(event.item_id))!.problem_id !== problemId) continue;
      const key = event.attempt_id ? `attempt:${event.attempt_id}` : `event:${event.id}`;
      const group = groups.get(key) ?? []; group.push(event); groups.set(key, group);
    }
    const observations = [...groups.values()].map(group => {
      const sourceIds = group.map(event => String(event.id)).sort();
      return { group, id: `legacy-${reviewDigest(sourceIds.join('\0'))}`, stableKey: sourceIds[0],
        observedAt: group.map(event => String(event.reviewed_at)).sort()[0],
        grade: Math.min(...group.map(event => Number(corrections.get(String(event.id))?.rating ?? event.rating))) as ReviewRating,
        createdAt: group.map(event => String(event.created_at)).sort()[0] };
    }).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.stableKey.localeCompare(b.stableKey));
    const slots = new Map<string, { eventId: string; source: Row }>();
    for (const observation of observations) {
      const day = localDate(observation.observedAt, timeZone), source = observation.group[0];
      db.prepare(`INSERT INTO problem_review_events
        (id,request_id,sequence,plan_id,problem_id,kind,source,rating,observed_at,learning_date,time_zone,created_at,corrects_event_id,algorithm_version,attempt_id,opportunity_id,stable_key,source_deleted)
        VALUES (?,?,?,?,?,'review','legacy',?,?,?,?,?,NULL,?,?,NULL,?,?)`)
        .run(observation.id, `migration:${observation.id}`, ++sequence, planId, problemId, observation.grade, observation.observedAt, day, timeZone, observation.createdAt,
          PROBLEM_FSRS_VERSION, source.attempt_id, observation.stableKey, 0);
      for (const event of observation.group) {
        const related = events.filter(candidate => candidate.id === event.id || candidate.corrects_event_id === event.id);
        for (const candidate of related) db.prepare('INSERT INTO review_legacy_links VALUES (?,?,?,?,?,?)')
          .run(candidate.item_id, candidate.id, planId, observation.id, candidate.legacy_sequence, REVIEW_MERGE_STRATEGY);
      }
      slots.set(day, { eventId: observation.id, source }); report.observations++;
    }
    for (const [day, slot] of slots) db.prepare('INSERT INTO problem_review_day_assessments VALUES (?,?,?,?,1)').run(problemId, day, timeZone, slot.eventId);
    repository.replayProblemReview(problemId); report.migratedPlans++;
  }
  for (const request of db.prepare('SELECT * FROM review_requests ORDER BY request_id').all() as Row[]) {
    const mapped = db.prepare('SELECT event_id FROM review_legacy_links WHERE old_event_id=? LIMIT 1').get(request.event_id as string);
    if (!mapped?.event_id) throw new Error('旧自评请求缺少完整历史映射。');
    db.prepare('INSERT INTO problem_review_requests VALUES (?,?,?)').run(request.request_id, request.input_hash, mapped.event_id);
  }
  // Static history only creates consumed baseline opportunities; it does not enroll unrelated old ACs.
  for (const row of db.prepare("SELECT id FROM official_submissions WHERE status='completed' AND json_extract(result_json,'$.status')='accepted' ORDER BY finished_at,rowid").all()) {
    repository.registerReviewAccepted(String(row.id), true, timeZone);
  }
  report.historicalAcDays = Number(db.prepare('SELECT COUNT(*) AS count FROM review_daily_ac_opportunities WHERE historical_baseline=1').get()!.count);
  db.prepare('INSERT INTO problem_review_migrations VALUES (?,?,?,?)').run(REVIEW_MERGE_STRATEGY, timeZone, completedAt, JSON.stringify(report));
  return report;
}
