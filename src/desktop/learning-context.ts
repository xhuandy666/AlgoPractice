import { hashCode, testConfigDigest, type Draft, type PracticeStore, type StoredRun } from '../storage/practice-store';
import type { AiDiagnostic, AiOfficialEvidence, AiPatchApplication, AiRequestInput, AiRunEvidence, AiTrustedContext } from '../shared/ai';
import type { ProblemContent } from '../shared/library';
import type { RunResult } from '../runner/types';
import { defaultAcmTestConfig, resolvePracticeSpec, type AcmTestConfig } from '../shared/answer-format';

/** Evidence comes only from persisted snapshots; renderer-supplied format and trust claims are not accepted. */
export function runAiEvidence(row: StoredRun | undefined): AiRunEvidence | null {
  if (!row || row.status === 'queued' || row.status === 'interrupted') return null;
  const result = row.result as unknown as RunResult;
  const diagnostics: AiDiagnostic[] = (result.diagnostics ?? []).map(value => ({ message: value.message, source: value.source ?? 'runner',
    ...(value.line ? { line: value.line } : {}), ...(value.column ? { column: value.column } : {}) }));
  return { id: row.id, attemptId: row.attemptId, problemVersion: row.problemVersion, codeHash: row.codeHash,
    answerFormat: row.answerFormat, specVersion: row.specVersion, testConfigDigest: row.testConfigDigest,
    status: row.status, trustworthyExpected: (result.caseResults ?? []).some(test => test.expected !== undefined), diagnostics,
    caseResults: (result.caseResults ?? []).map(test => ({ index: test.index, status: test.status,
      ...(test.actual !== undefined ? { actual: test.actual } : {}), ...(test.expected !== undefined ? { expected: test.expected } : {}) })),
    stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function buildPracticeAiContext(store: PracticeStore, input: AiRequestInput): AiTrustedContext {
  const attempt = store.getAttempt(input.attemptId); if (!attempt) throw new Error('练习不存在。');
  const content = attempt.problemSnapshot as unknown as ProblemContent;
  const draft = store.getDraft(attempt.problemId, attempt.language, attempt.draftScopeId, attempt.answerFormat);
  const interview = store.getInterviewForAttempt(attempt.id), item = interview?.items.find(item => item.attemptId === attempt.id);
  // Finished archives must not borrow a later practice's mutable code or stdin, even when it reuses the same scope.
  const config: AcmTestConfig | null = attempt.answerFormat === 'acm'
    ? (attempt.endedAt ? attempt.finalTestConfig : draft?.testConfig) ?? defaultAcmTestConfig(content) : null;
  const spec = resolvePracticeSpec(content, attempt.problemVersion, attempt.answerFormat, config ?? undefined);
  const digest = config ? testConfigDigest(config)! : hashCode(JSON.stringify([spec.content.cases, spec.content.acmCompare ?? 'normalized']));
  const code = (item ? (interview!.endedAt ? item.final!.code : item.accepted.code)
    : attempt.endedAt ? attempt.finalCode : draft?.code) ?? spec.content.starter[attempt.language] ?? '';
  const codeHash = hashCode(code), allRuns = store.listRuns(attempt.id);
  const selected = input.runId ? allRuns.find(row => row.id === input.runId) : undefined;
  if (input.runId && !selected) throw new Error('运行快照不属于当前练习。');
  const matches = (row: StoredRun) => row.codeHash === codeHash && row.answerFormat === attempt.answerFormat
    && row.specVersion === attempt.specVersion && row.testConfigDigest === digest;
  const run = selected && matches(selected) ? selected : allRuns.filter(row => matches(row) && runAiEvidence(row)).at(-1);
  const historical = selected && !matches(selected) ? runAiEvidence(selected) : null;
  const submission = attempt.answerFormat === 'function' ? store.listOfficialSubmissions(attempt.id)
    .find(row => row.status === 'completed' && row.codeHash === codeHash && row.problemVersion === attempt.problemVersion && row.result) : undefined;
  const official: AiOfficialEvidence | null = submission?.result ? { id: submission.id, attemptId: attempt.id, problemVersion: attempt.problemVersion, codeHash,
    status: submission.result.status, statusMessage: submission.result.statusMessage,
    ...Object.fromEntries(['passedCases','totalCases','runtime','memory','compileError','runtimeError','input','expectedOutput','actualOutput']
      .filter(key => submission.result![key as keyof typeof submission.result] !== undefined).map(key => [key, submission.result![key as keyof typeof submission.result]])) } : null;
  const notes = (input.noteIds ?? []).map(noteId => {
    const note = store.getNote(noteId);
    if (!note?.confirmed || (note.kind === 'problem' && note.subjectId !== attempt.problemId)) throw new Error('所选笔记未确认或不属于当前题目。');
    return { id: note.id, version: String(note.confirmed.version), title: note.confirmed.title, markdown: note.confirmed.markdown };
  });
  const conversation = (input.conversationIds ?? []).flatMap(requestId => {
    const record = store.getAIRequest(requestId);
    if (!record || record.attemptId !== attempt.id || record.status !== 'completed' || !record.response) throw new Error('对话不属于当前练习或尚未完成。');
    return [{ id: requestId, role: 'assistant' as const, content: JSON.stringify({ question: record.snapshot.question, response: record.response }) }];
  });
  return { attemptId: attempt.id, problemId: attempt.problemId, problemVersion: attempt.problemVersion, language: attempt.language,
    mode: attempt.mode, isActive: attempt.isActive, draftScopeId: attempt.draftScopeId,
    draftRevision: item ? (interview!.endedAt ? item.final! : item.accepted).revision : attempt.endedAt ? attempt.finalDraftRevision ?? 0 : draft?.revision ?? 0,
    answerFormat: attempt.answerFormat, specVersion: attempt.specVersion, testConfigDigest: digest, testConfig: config,
    expectedOutputSource: spec.expectedOutputSource, inputDescription: spec.inputDescription, outputDescription: spec.outputDescription,
    code, ...(item ? { reasoning: (interview!.endedAt ? item.final! : item.accepted).reasoning } : {}),
    problem: { title: content.title, description: content.description, constraints: content.constraints ?? [] },
    run: runAiEvidence(run), official, previousRun: historical ? { code: selected!.code, run: historical } : null, notes, conversation };
}

/** Revalidate synchronously after the async preview; save only this exact workspace and preserve its tests. */
export function applyPracticeAiPatch(store: PracticeStore, patch: AiPatchApplication): Draft {
  const context = buildPracticeAiContext(store, { requestId: patch.requestId, attemptId: patch.attemptId, kind: 'diagnosis', question: '' });
  const draft = store.getDraft(patch.problemId, patch.language, patch.draftScopeId, context.answerFormat);
  if (!context.isActive || context.mode === 'strict' || context.problemId !== patch.problemId || context.language !== patch.language
    || context.problemVersion !== patch.problemVersion || context.draftScopeId !== patch.draftScopeId
    || context.answerFormat !== patch.answerFormat || context.specVersion !== patch.specVersion || context.testConfigDigest !== patch.testConfigDigest
    || !draft || draft.codeHash !== patch.baseCodeHash || draft.revision !== patch.expectedDraftRevision) throw new Error('代码、测试配置或练习已经变化，请重新请求修改建议。');
  return store.saveDraft({ problemId: patch.problemId, language: patch.language, scopeId: patch.draftScopeId, code: patch.code,
    expectedRevision: patch.expectedDraftRevision, answerFormat: context.answerFormat, specVersion: context.specVersion,
    ...(draft.testConfig ? { testConfig: draft.testConfig } : {}) });
}
