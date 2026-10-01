import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { PROBLEM_FSRS_PARAMETERS, PROBLEM_FSRS_VERSION } from '../../src/learning/fsrs.ts';

function fixture(t: TestContext, at = '2026-10-01T12:00:00.000Z') {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
  const directory = mkdtempSync(join(tmpdir(), 'tilian-review-core-')), path = join(directory, 'practice.sqlite');
  let store = new PracticeStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.updateLearningSettings({ timeZone: 'UTC' });
  const add = (id: string, title = id) => store.upsertProblem({ id, title, source: 'leetcode-cn',
    sourceUrl: `https://leetcode.cn/problems/${id}/`, sourceId: '987', difficulty: '简单', tags: ['数组'],
    description: '私有题面只供测试', descriptionFormat: 'plain', constraints: [], mode: 'function', cases: [],
    starter: { python: 'class Solution:\n    pass', java: 'class Solution {}' } });
  const clock = (value: string) => t.mock.timers.setTime(Date.parse(value));
  const enroll = (id: string, title = id) => { add(id, title); return store.addProblemReview(id); };
  const assess = (id: string, requestId: string, rating: 1 | 2 | 3 | 4 = 1) => store.recordProblemReview({ problemId: id, requestId, rating });
  const ac = (id: string, requestId: string, officialId = requestId) => {
    const problem = store.getProblem(id)!;
    const attempt = store.startAttempt({ problemId: id, problemVersion: problem.version, language: 'python', problemSnapshot: problem.content as never });
    const draft = store.saveDraft({ problemId: id, language: 'python', code: problem.content.starter.python! });
    const record = store.beginOfficialSubmission({ requestId, attemptId: attempt.id, code: draft.code,
      expectedDraftRevision: draft.revision, slug: id, sourceId: '987' });
    store.updateOfficialSubmission(record.id, { status: 'judging', submissionId: officialId });
    store.updateOfficialSubmission(record.id, { status: 'completed', result: { status: 'accepted', statusMessage: 'Accepted', statusCode: 10 } });
    return store.getReviewOpportunityForSubmission(record.id)!;
  };
  const reopen = () => { store.close(); store = new PracticeStore(path); return store; };
  return { get store() { return store; }, directory, path, add, enroll, assess, clock, ac, reopen };
}

test('enrollment stays unassessed and v2 freezes full day-granularity FSRS configuration for all four grades', t => {
  const f = fixture(t, '2026-01-01T00:00:00.000Z');
  assert.equal(PROBLEM_FSRS_PARAMETERS.w?.length, 21);
  assert.equal(PROBLEM_FSRS_PARAMETERS.enable_fuzz, false);
  assert.equal(PROBLEM_FSRS_PARAMETERS.enable_short_term, false);
  assert.deepEqual(PROBLEM_FSRS_PARAMETERS.learning_steps, []);
  assert.deepEqual(PROBLEM_FSRS_PARAMETERS.relearning_steps, []);
  for (const grade of [1, 2, 3, 4] as const) {
    const initial = f.enroll(`grade-${grade}`);
    assert.equal(initial.card, null); assert.equal(initial.dueAt, null); assert.equal(initial.observationCount, 0);
    assert.equal(f.store.getReviewPlanSnapshot().items.items.some(item => item.problemId === initial.problemId), false, 'unassessed enrollment does not enter the due queue');
    f.clock(`2026-01-0${grade + 1}T12:00:00.000Z`);
    const result = f.assess(initial.problemId, `grade-${grade}`, grade);
    assert.equal(result.plan.algorithmVersion, PROBLEM_FSRS_VERSION);
    assert.ok(result.plan.card); assert.equal(result.plan.card.reps, 1);
    assert.ok(Date.parse(result.plan.dueAt!) - Date.parse(result.event.observedAt) >= 86400000, 'even Again does not schedule minute-scale relearning');
    assert.equal(result.event.isInitialAssessment, true);
    assert.equal(f.store.getReviewPlanSnapshot().summary.reviewedToday, 0, 'first assessment is not a review');
    const expected = fsrs(PROBLEM_FSRS_PARAMETERS).next(createEmptyCard(new Date(result.event.observedAt)), new Date(result.event.observedAt), grade).card;
    assert.deepEqual(result.plan.card, JSON.parse(JSON.stringify(expected)), 'first observation is the anchor, not enrollment');
  }
  f.store.integrityCheck();
});

test('snapshot, calendar, all due results and recommendation use one distinct-problem budget without changing true due dates', t => {
  const f = fixture(t, '2026-09-01T12:00:00.000Z');
  for (let i = 0; i < 5; i++) { f.enroll(`p${i}`); f.assess(`p${i}`, `initial-${i}`); }
  f.clock('2026-10-01T12:00:00.000Z');
  f.assess('p0', 'review-0'); f.assess('p1', 'review-1');
  f.enroll('new'); f.assess('new', 'first-today');
  const before = f.store.listProblemReviews().map(plan => [plan.problemId, plan.dueAt]);
  const recommended = f.store.getReviewPlanSnapshot(), allToday = f.store.getReviewPlanSnapshot({ view: 'calendar', date: '2026-10-01' });
  assert.equal(recommended.summary.reviewedToday, 2); assert.equal(recommended.summary.firstAssessedToday, 1);
  assert.equal(recommended.summary.remainingBudget, 1); assert.equal(recommended.summary.dueCount, 3);
  assert.equal(recommended.summary.plannedCount, 1); assert.equal(recommended.summary.extraDueCount, 2);
  assert.equal(recommended.items.total, 1); assert.equal(allToday.items.total, 3, 'explicit daily list includes beyond-budget due problems');
  assert.equal(allToday.next7[0].overdueCount, 3);
  assert.equal(allToday.next7[0].reviewedCount, 2); assert.equal(allToday.next7[0].firstAssessmentCount, 1);
  f.store.updateLearningSettings({ dailyReviewBudget: 0 });
  const zero = f.store.getReviewPlanSnapshot(); assert.equal(zero.items.total, 0); assert.equal(zero.summary.extraDueCount, 3);
  assert.notEqual(zero.snapshotVersion, recommended.snapshotVersion, 'same-timestamp settings changes still change snapshot identity');
  f.store.updateLearningSettings({ dailyReviewBudget: null });
  const unlimited = f.store.getReviewPlanSnapshot(); assert.equal(unlimited.summary.remainingBudget, null); assert.equal(unlimited.items.total, 3);
  assert.deepEqual(f.store.listProblemReviews().map(plan => [plan.problemId, plan.dueAt]), before);
  assert.throws(() => f.assess('p0', 'new-id-same-day', 3), /当天已有自评/);
  const original = f.store.getProblemReviewDetail('p0').events.items.find(event => event.requestId === 'review-0')!;
  f.store.correctProblemReview({ requestId: 'correct-today', eventId: original.id, rating: 4 });
  assert.equal(f.store.getReviewPlanSnapshot().summary.reviewedToday, 2, 'correction does not consume another slot');
});

test('batch enrollment and schedule CAS are atomic and never change card or FSRS due timestamps', t => {
  const f = fixture(t, '2026-09-01T12:00:00.000Z'); f.add('one'); f.add('two');
  assert.throws(() => f.store.addProblemReviews({ problemIds: ['one', 'missing', 'two'] }), /不存在/);
  assert.equal(f.store.listProblemReviews().length, 0);
  f.store.addProblemReviews({ problemIds: ['one', 'two'] }); f.assess('one', 'initial-one'); f.assess('two', 'initial-two');
  f.clock('2026-10-01T12:00:00.000Z');
  const before = f.store.listProblemReviews(), expectedRevisions = Object.fromEntries(before.map(plan => [plan.problemId, plan.revision]));
  const raw = new DatabaseSync(f.path);
  try {
    raw.exec("CREATE TRIGGER fail_second_plan BEFORE UPDATE ON problem_review_plans WHEN OLD.problem_id='two' BEGIN SELECT RAISE(ABORT, 'second plan failed'); END;");
    assert.throws(() => f.store.updateProblemReviews({ problemIds: ['one', 'two'], expectedRevisions, suspended: true }), /second plan failed/);
    assert.deepEqual(f.store.listProblemReviews(), before);
    raw.exec('DROP TRIGGER fail_second_plan');
    const updated = f.store.updateProblemReviews({ problemIds: ['one', 'two'], expectedRevisions, scheduledAt: '2026-10-10T12:00:00.000Z' });
    for (const plan of updated) { const old = before.find(value => value.problemId === plan.problemId)!;
      assert.deepEqual(plan.card, old.card); assert.equal(plan.dueAt, old.dueAt); assert.equal(plan.revision, old.revision + 1); }
    assert.equal(f.store.getReviewPlanSnapshot().summary.postponedCount, 2);
    assert.equal(f.store.getReviewPlanSnapshot().summary.deferredCount, 0, 'future postponement is distinct from later today');
    assert.throws(() => f.store.updateProblemReviews({ problemIds: ['one', 'two'], expectedRevisions, suspended: true }), /已变化/);
    assert.deepEqual(f.store.listProblemReviews(), updated);
  } finally { raw.close(); }
  f.store.integrityCheck();
});

test('backfilled first AC preview and replay reclassify the later manual observation and its original-day budget', t => {
  const f = fixture(t, '2026-10-01T12:00:00.000Z'); f.add('late');
  const opportunity = f.ac('late', 'day-one-ac', '701');
  f.clock('2026-10-02T12:00:00.000Z'); const manual = f.assess('late', 'day-two-manual', 3);
  assert.equal(manual.event.isInitialAssessment, true);
  f.clock('2026-10-03T12:00:00.000Z');
  const preview = f.store.previewProblemReview({ problemId: 'late', source: 'official', opportunityId: opportunity.id, rating: 2 });
  assert.equal(preview.isInitialAssessment, true); assert.equal(preview.observedAt, opportunity.acceptedAt);
  const result = f.store.submitReviewOpportunity({ requestId: 'backfill-day-one', opportunityId: opportunity.id, rating: 2 });
  assert.equal(result.plan.dueAt, preview.dueAt); assert.equal(result.event.isInitialAssessment, true);
  assert.equal(f.store.getProblemReviewDetail('late').events.items.find(event => event.id === manual.event.id)!.isInitialAssessment, false);
  const dayOne = f.store.getReviewPlanSnapshot({}, '2026-10-01T23:00:00.000Z').summary;
  const dayTwo = f.store.getReviewPlanSnapshot({}, '2026-10-02T23:00:00.000Z').summary;
  assert.equal(dayOne.firstAssessedToday, 1); assert.equal(dayOne.reviewedToday, 0);
  assert.equal(dayTwo.firstAssessedToday, 0); assert.equal(dayTwo.reviewedToday, 1); assert.equal(dayTwo.remainingBudget, 2);
  let expected = createEmptyCard(new Date(opportunity.acceptedAt)); const scheduler = fsrs(PROBLEM_FSRS_PARAMETERS);
  expected = scheduler.next(expected, new Date(opportunity.acceptedAt), Rating.Hard).card;
  expected = scheduler.next(expected, new Date(manual.event.observedAt), Rating.Good).card;
  assert.deepEqual(result.plan.card, JSON.parse(JSON.stringify(expected)));
  const firstCorrection = f.store.previewProblemReview({ problemId: 'late', source: 'correction', eventId: result.event.id, rating: 4 });
  const laterCorrection = f.store.previewProblemReview({ problemId: 'late', source: 'correction', eventId: manual.event.id, rating: 4 });
  assert.equal(firstCorrection.isInitialAssessment, true); assert.equal(laterCorrection.isInitialAssessment, false);
  f.store.updateLearningSettings({ timeZone: 'Asia/Shanghai' });
  const dashboard = f.store.getLearningDashboard('2026-10');
  assert.equal(dashboard.days.find(day => day.date === '2026-10-02')!.reviewCount, 1);
  assert.equal(dashboard.reviewEvents.find(event => event.id === manual.event.id)!.learningDate, '2026-10-02');
  assert.equal(f.store.getArchiveStatistics({ timeZone: 'America/Los_Angeles' }).days.find(day => day.date === '2026-10-02')!.reviewCount, 1);
  assert.equal(f.store.getArchiveStatistics().reviewedItems, 1);
});

test('one pending problem across several learning days counts once while each explicit opportunity stays pageable', t => {
  const f = fixture(t); f.add('pending'); f.ac('pending', 'pending-day-one', '801');
  f.clock('2026-10-02T12:00:00.000Z'); f.ac('pending', 'pending-day-two', '802');
  const snapshot = f.store.getReviewPlanSnapshot({ view: 'all', status: 'pending', limit: 1 });
  assert.equal(snapshot.summary.pendingAssessmentCount, 1); assert.equal(snapshot.items.total, 1);
  assert.equal(snapshot.items.items[0].pendingAssessmentCount, 2, 'detail keeps both delayed source-day tasks');
  assert.equal(snapshot.summary.firstAssessedToday, 0); assert.equal(snapshot.summary.reviewedToday, 0);
  const page = f.store.reviewOpportunities({ problemId: 'pending', limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.items.length, 1); assert.equal(page.hasMore, true);
  assert.equal(f.store.getProblemReview('pending')!.card, null);
});

test('submitted manual draft freezes source day, grade and request across midnight, changed time zone and process reopen', t => {
  const f = fixture(t, '2026-10-01T23:59:00.000Z'); f.enroll('draft');
  const input = { key: 'manual:draft', problemId: 'draft', source: 'manual' as const, rating: 2 as const, requestId: 'frozen-grade' };
  const draft = f.store.saveReviewAssessmentDraft({ ...input, submitted: true });
  assert.equal(draft.learningDate, '2026-10-01'); assert.equal(draft.timeZone, 'UTC');
  f.clock('2026-10-02T08:00:00.000Z'); f.store.updateLearningSettings({ timeZone: 'Asia/Shanghai' }); f.reopen();
  assert.deepEqual(f.store.getReviewAssessmentDraft(input.key), draft);
  assert.throws(() => f.store.saveReviewAssessmentDraft({ ...input, rating: 4, expectedRevision: draft.revision }), /不能改变评级/);
  assert.throws(() => f.store.deleteReviewAssessmentDraft(input.key, draft.revision), /尚未确认/);
  assert.equal(f.store.getProblemReviewRequest(input.requestId), null);
  const result = f.store.recordProblemReview({ problemId: 'draft', requestId: input.requestId, rating: 2 });
  assert.equal(result.event.learningDate, draft.learningDate); assert.equal(result.event.timeZone, draft.timeZone);
  assert.equal(result.event.observedAt, draft.observedAt);
  const retry = f.store.recordProblemReview({ problemId: 'draft', requestId: input.requestId, rating: 2 });
  assert.deepEqual(retry, result); assert.equal(result.plan.observationCount, 1);
  assert.equal(f.store.getReviewAssessmentDraft(input.key)!.resolvedEventId, result.event.id);
  assert.deepEqual(f.store.getProblemReviewRequest(input.requestId), result);
  assert.throws(() => f.store.recordProblemReview({ problemId: 'draft', requestId: input.requestId, rating: 3 }), /不同输入/);
  f.store.deleteReviewAssessmentDraft(input.key); assert.equal(f.store.getReviewAssessmentDraft(input.key), null);
});

test('editable draft does not reserve yesterday: its observation freezes only when first submitted', t => {
  const f = fixture(t, '2026-10-01T23:59:00.000Z'); f.enroll('editable');
  const input = { key: 'manual:editable', problemId: 'editable', source: 'manual' as const, rating: 1 as const, requestId: 'editable-grade' };
  const draft = f.store.saveReviewAssessmentDraft(input); assert.equal(draft.submittedAt, null);
  f.clock('2026-10-02T08:00:00.000Z');
  const submitted = f.store.saveReviewAssessmentDraft({ ...input, expectedRevision: draft.revision, submitted: true });
  assert.equal(submitted.learningDate, '2026-10-02'); assert.equal(submitted.observedAt, '2026-10-02T08:00:00.000Z');
  assert.equal(f.store.recordProblemReview({ problemId: input.problemId, requestId: input.requestId, rating: 1 }).event.learningDate, '2026-10-02');
});

test('submitted yesterday manual draft previews and retries its frozen day even after today has another assessment', t => {
  const f = fixture(t, '2026-10-01T23:59:00.000Z'); f.enroll('old-preview');
  const input = { key: 'manual:old-preview', problemId: 'old-preview', source: 'manual' as const, rating: 2 as const, requestId: 'old-preview-request', submitted: true };
  const draft = f.store.saveReviewAssessmentDraft(input);
  f.clock('2026-10-02T08:00:00.000Z'); const today = f.assess('old-preview', 'today-new-assessment', 3);
  const ordinary = f.store.previewProblemReview({ problemId: input.problemId, rating: 2 });
  assert.equal(ordinary.learningDate, '2026-10-02'); assert.equal(ordinary.conflictEventId, today.event.id);
  const recovered = f.store.previewProblemReview({ problemId: input.problemId, rating: 2, requestId: input.requestId });
  assert.equal(recovered.learningDate, draft.learningDate); assert.equal(recovered.observedAt, draft.observedAt);
  assert.equal(recovered.conflictEventId, null); assert.equal(recovered.isInitialAssessment, true);
  assert.throws(() => f.store.previewProblemReview({ problemId: input.problemId, rating: 4, requestId: input.requestId }), /不一致/);
  const saved = f.store.recordProblemReview({ problemId: input.problemId, requestId: input.requestId, rating: 2 });
  assert.equal(saved.plan.dueAt, recovered.dueAt); assert.equal(saved.event.learningDate, draft.learningDate);
  assert.equal(f.store.getProblemReviewDetail(input.problemId).events.items.find(event => event.id===today.event.id)!.isInitialAssessment, false);
  const afterSaved = f.store.previewProblemReview({ problemId: input.problemId, rating: 2, requestId: input.requestId });
  assert.equal(afterSaved.dueAt, saved.plan.dueAt); assert.equal(afterSaved.conflictEventId, null, 'previewing a committed original request does not schedule a duplicate');
});

test('a committed competing daily assessment makes a frozen draft definitively unwritable and closable, unlike an unknown result', t => {
  const f = fixture(t); f.enroll('competing');
  const input = { key: 'manual:competing', problemId: 'competing', source: 'manual' as const, rating: 3 as const, requestId: 'losing-request', submitted: true };
  const draft = f.store.saveReviewAssessmentDraft(input);
  assert.throws(() => f.store.deleteReviewAssessmentDraft(input.key, draft.revision), /尚未确认/);
  const winner = f.assess('competing', 'other-window-assessment', 2);
  assert.throws(() => f.store.recordProblemReview({ problemId: 'competing', requestId: input.requestId, rating: 3 }), /当天已有自评/);
  assert.equal(f.store.getProblemReviewRequest(input.requestId), null);
  assert.equal(f.store.getReviewAssessmentDraft(input.key)!.conflictEventId, winner.event.id);
  f.store.deleteReviewAssessmentDraft(input.key, draft.revision); assert.equal(f.store.getReviewAssessmentDraft(input.key), null);
  assert.equal(f.store.getProblemReview('competing')!.observationCount, 1);
  assert.equal(f.store.getProblemReviewDetail('competing').events.items[0].id, winner.event.id);
});

test('an assessment transaction failure preserves its submitted retry draft and leaves no journal, day slot, request or schedule change', t => {
  const f = fixture(t); f.enroll('atomic');
  const input = { key: 'manual:atomic', problemId: 'atomic', source: 'manual' as const, rating: 3 as const, requestId: 'atomic-grade', submitted: true };
  const draft = f.store.saveReviewAssessmentDraft(input), before = f.store.getProblemReview('atomic');
  const raw = new DatabaseSync(f.path);
  try {
    raw.exec("CREATE TRIGGER fail_rating_request BEFORE INSERT ON problem_review_requests BEGIN SELECT RAISE(ABORT, 'injected rating failure'); END;");
    assert.throws(() => f.store.recordProblemReview({ problemId: 'atomic', requestId: input.requestId, rating: 3 }), /injected rating failure/);
    for (const table of ['problem_review_events', 'problem_review_day_assessments', 'problem_review_requests']) assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
    assert.deepEqual(f.store.getProblemReview('atomic'), before); assert.deepEqual(f.store.getReviewAssessmentDraft(input.key), draft);
    raw.exec('DROP TRIGGER fail_rating_request');
    const result = f.store.recordProblemReview({ problemId: 'atomic', requestId: input.requestId, rating: 3 });
    assert.equal(result.plan.observationCount, 1); assert.equal(result.event.observedAt, draft.observedAt);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM problem_review_day_assessments').get()!.n, 1);
  } finally { raw.close(); }
  f.store.integrityCheck();
});

test('review sessions persist a frozen recommended queue, revalidate paused or assessed items and skip without creating ratings', t => {
  const f = fixture(t, '2026-09-01T12:00:00.000Z');
  for (const id of ['s0', 's1', 's2']) { f.enroll(id); f.assess(id, `initial-${id}`); }
  f.clock('2026-10-01T12:00:00.000Z'); f.store.updateLearningSettings({ dailyReviewBudget: 2 });
  const session = f.store.startReviewSession({ requestId: 'session-first' });
  assert.deepEqual(session.problemIds, ['s0', 's1']); assert.equal(session.currentProblemId, 's0');
  assert.equal(f.store.startReviewSession({ requestId: 'another-default' }).id, session.id);
  assert.throws(() => f.store.startReviewSession({ requestId: 'other-explicit', problemIds: ['s2'] }), /已有复习会话/);
  assert.throws(() => f.store.advanceReviewSession({ sessionId: session.id, problemId: 's1', skipped: true }), /位置已变化/);
  assert.throws(() => f.store.advanceReviewSession({ sessionId: session.id, problemId: 's0' }), /请先自评/);
  f.reopen(); assert.deepEqual(f.store.getReviewSession(), session);
  f.store.updateProblemReviews({ problemIds: ['s1'], suspended: true });
  const finished = f.store.advanceReviewSession({ sessionId: session.id, problemId: 's0', skipped: true });
  assert.equal(finished.status, 'ended'); assert.equal(finished.currentProblemId, null);
  assert.deepEqual(finished.skippedProblemIds, ['s0']);
  assert.equal(f.store.getProblemReview('s0')!.observationCount, 1); assert.equal(f.store.getReviewPlanSnapshot().summary.reviewedToday, 0);
  assert.deepEqual(f.store.advanceReviewSession({ sessionId: session.id, problemId: 's0', skipped: true }), finished);
  assert.deepEqual(f.store.startReviewSession({ requestId: 'session-first' }), finished, 'retrying start does not create a second session');
  f.store.updateLearningSettings({ dailyReviewBudget: 0 });
  const extra = f.store.startReviewSession({ requestId: 'explicit-beyond-budget', problemIds: ['s2'] });
  f.assess('s2', 'session-rating', 1);
  const done = f.store.getReviewSession(extra.id)!; assert.equal(done.status, 'ended');
  assert.equal(f.store.getReviewPlanSnapshot().summary.reviewedToday, 1);
});

test('explicit validation rejects source fabrication, unknown query fields and invalid dates without enrolling or writing', t => {
  const f = fixture(t); f.enroll('validation'); const before = f.store.getProblemReview('validation');
  assert.throws(() => f.store.recordProblemReview({ requestId: 'fake', problemId: 'validation', rating: 3, observedAt: '2026-01-01' } as never), /未知字段/);
  assert.throws(() => f.store.saveReviewAssessmentDraft({ key: 'fake', requestId: 'fake', problemId: 'validation', source: 'official', opportunityId: 'invented', rating: 3 }), /资格无效/);
  assert.throws(() => f.store.getReviewPlanSnapshot({ date: '2026-02-30' }), /日期无效/);
  assert.throws(() => f.store.getReviewPlanSnapshot({ month: '2026-13' }), /月份无效/);
  assert.throws(() => f.store.getReviewPlanSnapshot({ limit: 101 }), /limit/);
  assert.throws(() => f.store.getReviewPlanSnapshot({ view: 'invented' } as never), /视图无效/);
  assert.throws(() => f.store.addProblemReviews({ problemIds: ['validation', 'validation'] }), /不能重复/);
  assert.equal(f.store.getReviewAssessmentDraft('fake'), null); assert.deepEqual(f.store.getProblemReview('validation'), before);
});

test('recommended session resumes past newly postponed items while explicit selection permits preexisting future work but not later postponement', t => {
  const f = fixture(t, '2026-09-01T12:00:00.000Z');
  for (const id of ['q0', 'q1', 'q2']) { f.enroll(id); f.assess(id, `initial-${id}`); }
  f.clock('2026-10-01T12:00:00.000Z');
  const recommended = f.store.startReviewSession({ requestId: 'postponement-default' });
  f.store.updateProblemReviews({ problemIds: ['q1'], scheduledAt: '2026-11-01T12:00:00.000Z' });
  f.reopen(); assert.equal(f.store.getReviewSession(recommended.id)!.currentProblemId, 'q0');
  const next = f.store.advanceReviewSession({ sessionId: recommended.id, problemId: 'q0', skipped: true });
  assert.equal(next.currentProblemId, 'q2', 'later default-session item is revalidated before entering it');
  assert.equal(f.store.getProblemReview('q1')!.observationCount, 1);
  f.store.endReviewSession(recommended.id);
  const selected = f.store.startReviewSession({ requestId: 'future-selected', problemIds: ['q1', 'q0'] });
  assert.equal(selected.currentProblemId, 'q1', 'explicit user selection permits an already-postponed future problem');
  f.store.updateProblemReviews({ problemIds: ['q1'], scheduledAt: '2026-12-01T12:00:00.000Z' });
  const resumed = f.store.getReviewSession(selected.id)!;
  assert.equal(resumed.currentProblemId, 'q0', 'a new postponement after starting remains an explicit scheduling intent');
  assert.deepEqual(resumed.problemIds, ['q1', 'q0']); assert.equal(f.store.getReviewPlanSnapshot().summary.reviewedToday, 0);
});

test('large recommendation queues remain complete while page results stay bounded and carry no problem or code bodies', t => {
  const f = fixture(t, '2026-09-01T12:00:00.000Z');
  for (let i = 0; i < 120; i++) { const id = `page-${String(i).padStart(3, '0')}`; f.enroll(id, `分页题 ${i}`); f.assess(id, `page-initial-${i}`); }
  f.clock('2026-10-01T12:00:00.000Z'); f.store.updateLearningSettings({ dailyReviewBudget: null });
  const first = f.store.getReviewPlanSnapshot({ limit: 30 }), next = f.store.getReviewPlanSnapshot({ limit: 30, offset: 30 });
  assert.equal(first.items.total, 120); assert.equal(first.items.items.length, 30); assert.equal(first.items.hasMore, true);
  assert.equal(first.summary.plannedCount, 120); assert.equal(f.store.getTodayQueue().items.length, 120, 'legacy compatibility is not silently capped at transport page size');
  assert.equal(first.snapshotVersion, next.snapshotVersion);
  assert.equal(first.items.items.some(item => next.items.items.some(other => other.problemId === item.problemId)), false);
  assert.equal(JSON.stringify(first).includes('私有题面只供测试'), false); assert.equal(JSON.stringify(first).includes('class Solution'), false);
  assert.equal(f.store.startReviewSession({ requestId: 'all-120' }).problemIds.length, 120, 'session freezes the whole recommended queue, not its first display page');
  assert.equal(f.store.getReviewPlanSnapshot({ view: 'all', search: '%', limit: 30 }).items.total, 0, 'search wildcard stays literal');
});
