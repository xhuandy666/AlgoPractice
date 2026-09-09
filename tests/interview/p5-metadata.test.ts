import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PracticeStore, hashCode } from '../../src/storage/practice-store.ts';
import { InterviewService } from '../../src/interview/service.ts';
import { buildPool } from '../../src/interview/sampling.ts';
import { defaultInterviewRules, type InterviewRules, type InterviewPool, type InterviewSession } from '../../src/shared/interview.ts';
import type { ProblemContent } from '../../src/shared/library.ts';
const body = 'FULL_INTERVIEW_CANDIDATE_BODY '.repeat(300);
function problem(index: number): ProblemContent {
  return { id: `p${String(index).padStart(4, '0')}`, title: `题目 ${index}`, difficulty: ['简单', '中等', '困难'][index % 3], tags: [index % 2 ? '数组' : '二分'],
    source: 'local', description: body, descriptionFormat: 'plain', constraints: [body], mode: 'acm', cases: [{ stdin: '1', expected: '1' }],
    starter: index % 7 === 0 ? { python: '\n\t\u3000' } : index % 5 === 0 ? { java: 'class Main {}' } : { python: 'print(input())' } };
}
const rules = (patch: Partial<InterviewRules> = {}): InterviewRules => ({ ...defaultInterviewRules, counts: { easy: 2, medium: 2, hard: 2 }, seed: 'p5-repeatable', excludeRecentDays: 0, ...patch });
function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'Algo P5 interview metadata ')), path = join(directory, 'practice.sqlite');
  const store = new PracticeStore(path); t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); }); return store;
}
const decision = (pool: InterviewPool) => ({ ...pool, candidates: pool.candidates.map(c => ({ id: c.problem.id, version: c.problem.version, difficulty: c.difficulty, weight: c.weight })) });

test('P5 interview metadata preview includes all pages and preserves full-pool decisions, exclusions, weights and recent filtering', t => {
  const store = fixture(t); for (let index = 0; index < 205; index++) store.upsertProblem(problem(index));
  const practiced = store.getProblem('p0001')!; store.startAttempt({ problemId: practiced.id, problemVersion: practiced.version, language: 'java' });
  const at = new Date().toISOString(), wall = Date.parse(at), service = new InterviewService({ store: () => store, clock: { wall: () => wall, monotonic: () => 0 } });
  const company = service.commitCompany(service.previewCompany({ kind: 'json', name: 'frequency', text: JSON.stringify(Array.from({ length: 205 }, (_, i) => ({ company: 'Acme', problemId: problem(i).id, frequency: i % 13, window: 'same', frequencyMeaning: 'mentions' }))) }).id);
  const inputs = [rules(), rules({ language: 'java', counts: { easy: 1, medium: 1, hard: 1 } }),
    rules({ excludeRecentDays: 14, tags: ['数组'] }), rules({ company: 'Acme', datasetId: company.id, sampling: 'frequency' }), rules({ tags: ['missing'] })];
  const expected = inputs.map(input => buildPool(store.listProblems(), store.listAttempts(), input, input.datasetId ? company : null, at));
  const offsets: number[] = [], originalPage = store.listProblemPage.bind(store);
  store.listProblemPage = filter => { offsets.push(filter?.offset ?? 0); return originalPage(filter); };
  store.listProblems = () => { throw new Error('No full problem list during preview'); };
  store.listAttempts = () => { throw new Error('No full attempt list during preview'); };
  store.getProblem = () => { throw new Error('No problem detail before selection'); };
  for (let index = 0; index < inputs.length; index++) {
    const actual = service.preview(inputs[index]).pool; assert.deepEqual(decision(actual), decision(expected[index]));
    assert.equal(actual.candidates.length + actual.exclusions.length, 205); assert.doesNotMatch(JSON.stringify(actual), /FULL_INTERVIEW_CANDIDATE_BODY/);
  }
  assert.deepEqual(offsets, inputs.flatMap(() => [0, 100, 200]));
  store.listProblemPage = () => { throw new Error('Company preview only needs complete identities'); };
  const preview = service.previewCompany({ kind: 'json', name: 'late ids', text: JSON.stringify([{ company: 'Acme', problemId: 'p0204' }, { company: 'Acme', problemId: 'unknown' }]) });
  assert.deepEqual(preview.preview.missingProblemIds, ['unknown']);
});

test('P5 selected interview bodies use preview versions across updates before and during beforeStart', async t => {
  const store = fixture(t); for (let index = 1; index <= 12; index++) store.upsertProblem(problem(index));
  const originals = new Map(store.listProblems().map(p => [p.id, p])); let selected: string[] = [];
  const service = new InterviewService({ store: () => store, beforeStart: async () => {
    for (const id of selected) store.upsertProblem({ ...originals.get(id)!.content, description: 'Updated while starting', starter: { python: 'print(999)' } });
    await Promise.resolve();
  } });
  const preview = service.preview(rules({ mode: 'coached', counts: { easy: 1, medium: 1, hard: 1 } })); selected = preview.pool.selectedIds;
  for (const id of selected) store.upsertProblem({ ...originals.get(id)!.content, description: 'Updated after preview', starter: { python: 'print(888)' } });
  const versionReads: Array<[string, string]> = [], get = store.getProblem.bind(store);
  store.getProblem = (id, version) => { if (version) versionReads.push([id, version]); return get(id, version); };
  const view = await service.start(preview.id, 'fixed-version-start');
  assert.equal(view.session.items.length, 3); assert.equal(versionReads.length, selected.length); assert.deepEqual(new Set(versionReads.map(([id]) => id)), new Set(selected));
  for (const item of view.session.items) {
    const original = originals.get(item.problem.id)!; assert.equal(item.problem.version, original.version); assert.deepEqual(item.problem.content, original.content);
    assert.equal(item.accepted.code, original.content.starter.python); assert.notEqual(get(item.problem.id)!.version, original.version);
  }
  const snapshot = structuredClone(view.session.pool); service.finish(view.session.id);
  assert.deepEqual(service.view(view.session.id).session.pool, snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), /FULL_INTERVIEW_CANDIDATE_BODY/);
});

test('P5 reopens and resumes persisted P4 pools containing complete candidate snapshots', async t => {
  const store = fixture(t); for (let index = 1; index <= 3; index++) store.upsertProblem(problem(index));
  const full = store.listProblems(), pool = buildPool(full, [], rules({ mode: 'coached', counts: { easy: 1, medium: 1, hard: 1 } }), null);
  const startedAt = new Date().toISOString(), sessionId = randomUUID();
  const session: InterviewSession = { id: sessionId, requestId: 'p4-original-request', pool, initialMode: 'coached', mode: 'coached', startedAt,
    deadlineAt: new Date(Date.parse(startedAt) + 3600_000).toISOString(), lastObservedAt: startedAt, endedAt: null, endReason: null, clockAnomalies: [], modeChanges: [], help: [],
    items: pool.selectedIds.map(id => { const p = full.find(p => p.id === id)!, code = p.content.starter.python!;
      return { problem: p, attemptId: randomUUID(), scopeId: `interview:${sessionId}`, accepted: { code, codeHash: hashCode(code), revision: 1, savedAt: startedAt, reasoning: '' }, final: null }; }) };
  store.createInterview(session);
  store.close();
  const reopened = new PracticeStore(store.dbPath);
  try {
    const service = new InterviewService({ store: () => reopened }); const resumed = await service.start('old-preview-not-in-memory', session.requestId);
    assert.deepEqual(resumed.session.pool, pool); assert.match(JSON.stringify(resumed.session.pool), /FULL_INTERVIEW_CANDIDATE_BODY/);
    service.finish(sessionId); assert.deepEqual(service.view(sessionId).session.pool, pool);
  } finally { reopened.close(); }
});
