import { AI_POLICY_VERSION, AI_PROMPT_VERSION, type AiConversationMemory, type AiProviderConfig, type AiRequestInput, type AiRequestSnapshot, type AiRunEvidence, type AiTrustedContext } from '../shared/ai.ts';
import { canonicalJson, identifier, normalizeProviderConfig, sha256, validateRequestInput } from './canonical.ts';
import { AiServiceError } from './errors.ts';
import { assertAnswerFormat, validateAcmTestConfig } from '../shared/answer-format.ts';
import { conversationMemoryPayload } from './conversation-memory.ts';
import { systemPrompt, coachScenarioGuidance } from './coach-skill.ts';
import { buildEvidenceCatalog } from './evidence-catalog.ts';

export function assertMode(context: Pick<AiTrustedContext, 'mode' | 'isActive'>): void {
  if (!['practice', 'strict', 'coached'].includes(context.mode) || typeof context.isActive !== 'boolean') throw new AiServiceError('INVALID_REQUEST');
  if (context.mode === 'strict' && context.isActive) throw new AiServiceError('STRICT_MODE');
}
export { RESPONSE_CONTRACT, systemPrompt } from './coach-skill.ts';
export function buildRequestSnapshot(rawInput: AiRequestInput, rawContext: AiTrustedContext, rawProvider: AiProviderConfig, memory?: AiConversationMemory): AiRequestSnapshot {
  const input = validateRequestInput(rawInput), provider = normalizeProviderConfig(rawProvider);
  // JSON cloning fixes the snapshot before the first provider await; callback owners may mutate their own objects later.
  const context = JSON.parse(canonicalJson(rawContext)) as AiTrustedContext;
  if (context.attemptId !== input.attemptId || !['python', 'java'].includes(context.language) || typeof context.code !== 'string' || Buffer.byteLength(context.code) > 512 * 1024 || !Number.isInteger(context.draftRevision) || context.draftRevision < 0) throw new AiServiceError('INVALID_REQUEST');
  identifier(context.problemId); identifier(context.problemVersion); identifier(context.draftScopeId); assertMode(context);
  if (context.answerFormat !== undefined) {
    try { assertAnswerFormat(context.answerFormat); } catch { throw new AiServiceError('INVALID_REQUEST'); }
    identifier(context.specVersion); identifier(context.testConfigDigest);
  }
  const testConfig = context.testConfig ? validateAcmTestConfig(context.testConfig) : null;
  if (!context.problem || typeof context.problem.title !== 'string' || typeof context.problem.description !== 'string' || !Array.isArray(context.problem.constraints) || !context.problem.constraints.every(value => typeof value === 'string') || !Array.isArray(context.notes) || !Array.isArray(context.conversation)) throw new AiServiceError('INVALID_REQUEST');
  const clippedFields: string[] = [];
  const clip = (value: string, maximum: number, name: string) => { if (typeof value !== 'string') throw new AiServiceError('INVALID_REQUEST'); if (value.length <= maximum) return value; clippedFields.push(name); return value.slice(0, maximum) + '\n[内容已裁剪]'; };
  const codeHash = sha256(context.code);
  let run: AiRunEvidence | null = context.run;
  if (run) {
    if (run.attemptId !== context.attemptId || run.problemVersion !== context.problemVersion || run.codeHash !== codeHash
      || (context.answerFormat !== undefined && (run.answerFormat !== context.answerFormat || run.specVersion !== context.specVersion || run.testConfigDigest !== context.testConfigDigest))
      || !Array.isArray(run.diagnostics) || !Array.isArray(run.caseResults) || typeof run.stdout !== 'string' || typeof run.stderr !== 'string') throw new AiServiceError('INVALID_REQUEST');
    identifier(run.id);
    const take = (value: unknown, name: string) => { const serialized = canonicalJson(value); if (serialized.length <= 700) return value; clippedFields.push(name); return '[结果过长，已省略]'; };
    run = { ...run, diagnostics: run.diagnostics.slice(0, 6).map((diagnostic, index) => ({ ...diagnostic, message: clip(diagnostic.message, 1000, `run.diagnostics.${index}`) })), caseResults: run.caseResults.slice(0, 8).map((test, index) => ({ ...test, ...(Object.hasOwn(test, 'actual') ? { actual: take(test.actual, `run.cases.${index}.actual`) as never } : {}), ...(Object.hasOwn(test, 'expected') ? { expected: take(test.expected, `run.cases.${index}.expected`) as never } : {}) })), stdout: clip(run.stdout, 1500, 'run.stdout'), stderr: clip(run.stderr, 1500, 'run.stderr') };
    if (context.run!.diagnostics.length > 6) clippedFields.push('run.diagnostics'); if (context.run!.caseResults.length > 8) clippedFields.push('run.caseResults');
  }
  let previousRun = context.previousRun ?? null;
  if (previousRun) {
    const old = previousRun.run;
    const changedConfiguration = old.answerFormat !== context.answerFormat || old.specVersion !== context.specVersion || old.testConfigDigest !== context.testConfigDigest;
    if (old.attemptId !== context.attemptId || old.problemVersion !== context.problemVersion || old.codeHash !== sha256(previousRun.code)
      || (old.codeHash === codeHash && !changedConfiguration) || input.runId !== old.id) throw new AiServiceError('INVALID_REQUEST');
    const clipped = buildRequestSnapshot({ ...input, runId: old.id, noteIds: [], conversationIds: [] }, { ...context,
      answerFormat: old.answerFormat, specVersion: old.specVersion, testConfigDigest: old.testConfigDigest, testConfig: null,
      code: previousRun.code, run: old, previousRun: null, official: null, notes: [], conversation: [] }, provider);
    previousRun = { code: clip(previousRun.code, 6000, 'previousRun.code'), run: clipped.run! };
    clippedFields.push(...clipped.clippedFields.filter(field => field.startsWith('run.')).map(field => `previousRun.${field}`));
  }
  if (input.runId && input.runId !== run?.id && input.runId !== previousRun?.run.id) throw new AiServiceError('INVALID_REQUEST');
  let official = context.official ?? null;
  if (official) {
    if (context.answerFormat === 'acm') throw new AiServiceError('INVALID_REQUEST');
    if (official.attemptId !== context.attemptId || official.problemVersion !== context.problemVersion || official.codeHash !== codeHash || !['accepted','wrong_answer','compile_error','runtime_error','timeout','memory_limit','output_limit','internal_error','unknown'].includes(official.status)) throw new AiServiceError('INVALID_REQUEST');
    identifier(official.id);
    official = { ...official, statusMessage: clip(official.statusMessage, 250, 'official.statusMessage') };
    for (const field of ['runtime','memory','compileError','runtimeError','input','actualOutput','expectedOutput'] as const) if (official[field] !== undefined) official[field] = clip(official[field]!, field === 'runtime' || field === 'memory' ? 100 : 2000, `official.${field}`);
    for (const field of ['passedCases','totalCases'] as const) if (official[field] !== undefined && (!Number.isSafeInteger(official[field]) || official[field]! < 0)) throw new AiServiceError('INVALID_REQUEST');
  }
  if (input.kind === 'official-review' && (!official || official.id !== input.officialSubmissionId
    || context.officialSubmissionId !== input.officialSubmissionId)) throw new AiServiceError('INVALID_REQUEST');
  const notes = (input.noteIds ?? []).map(id => { const note = context.notes.find(note => note.id === id); if (!note) throw new AiServiceError('INVALID_REQUEST'); return { id, version: identifier(note.version), title: clip(note.title, 150, `notes.${id}.title`), markdown: clip(note.markdown, 2500, `notes.${id}.markdown`) }; });
  const conversation = (input.conversationIds ?? []).map(id => { const message = context.conversation.find(message => message.id === id); if (!message || !['user', 'assistant'].includes(message.role)) throw new AiServiceError('INVALID_REQUEST'); return { id, role: message.role, content: clip(message.content, 1500, `conversation.${id}`) }; });
  // A derived view gives the model stable line references without changing the
  // source/hash used for patch application. Keep whole lines and count blanks.
  const sourceLines = context.code.split(/\r?\n/); const numberedLines: string[] = []; let numberedLength = 0;
  for (const [index, line] of sourceLines.entries()) {
    const reference = `${index + 1} | ${line}`;
    if (numberedLength + reference.length + (numberedLines.length ? 1 : 0) > 16000) break;
    numberedLines.push(reference); numberedLength += reference.length + (numberedLines.length > 1 ? 1 : 0);
  }
  const numberedComplete = numberedLines.length === sourceLines.length;
  if (!numberedComplete) clippedFields.push('codeWithLineNumbers');
  const codeWithLineNumbers = { format: 'one-based line references; numeric prefixes are not source code', complete: numberedComplete, text: numberedLines.join('\n') };
  const evidenceCatalog = buildEvidenceCatalog({ attemptId: context.attemptId, problemVersion: context.problemVersion, codeHash,
    answerFormat: context.answerFormat, specVersion: context.specVersion, testConfigDigest: context.testConfigDigest, run, official, clippedFields });
  const payload = { userRequest: input.question, kind: input.kind,
    learningContext: { attemptId: context.attemptId, problemId: context.problemId, problemVersion: context.problemVersion, language: context.language, mode: context.mode,
      answerFormat: context.answerFormat, specVersion: context.specVersion, testConfigDigest: context.testConfigDigest,
      expectedOutputSource: context.expectedOutputSource,
      ...(context.inputDescription !== undefined ? { inputDescription: clip(context.inputDescription, 2000, 'inputDescription') } : {}),
      ...(context.outputDescription !== undefined ? { outputDescription: clip(context.outputDescription, 2000, 'outputDescription') } : {}),
      ...(testConfig ? { testConfig: { ...testConfig, cases: testConfig.cases.slice(0, 8).map((test, index) => ({ stdin: clip(test.stdin, 2000, `testConfig.${index}.stdin`),
        ...(Object.hasOwn(test, 'expected') ? { expected: clip(test.expected!, 2000, `testConfig.${index}.expected`), expectedSource: context.expectedOutputSource ?? 'unspecified-not-official-judge' } : {}) })) } } : {}),
      problem: { title: clip(context.problem.title, 250, 'problem.title'), description: clip(context.problem.description, 8000, 'problem.description'), constraints: context.problem.constraints.slice(0, 20).map((constraint, index) => clip(constraint, 250, `problem.constraints.${index}`)) },
      codeHash, code: clip(context.code, 16000, 'code'), codeWithLineNumbers, ...(context.reasoning !== undefined ? { reasoning: clip(context.reasoning, 4000, 'reasoning') } : {}), run, official, evidenceCatalog,
      ...(input.officialSubmissionId ? { officialSubmissionId: input.officialSubmissionId } : {}), previousRun: previousRun ? { ...previousRun, relationToCurrentCode: 'historical-only' } : null, notes,
      // Explicit legacy selections remain identity-bound, but automatic memory is the
      // only conversation copy on the wire when supplied by the service.
      conversation: memory ? [] : conversation,
      ...(memory ? { conversationMemory: conversationMemoryPayload(memory) } : {}) }, clippedFields };
  if (context.problem.constraints.length > 20) clippedFields.push('problem.constraints');
  let sentMemory = memory ? structuredClone(memory) : undefined;
  const messages = [{ role: 'system' as const, content: `${systemPrompt(input)}\n${coachScenarioGuidance({ run, official, previousRun, answerFormat: context.answerFormat }, input.kind)}` }, { role: 'user' as const, content: canonicalJson(payload) }];
  // Reserve room for provider parameters and one bounded repair instruction. If five
  // unusually large answers cannot fit, drop whole oldest rounds with explicit IDs;
  // never silently truncate a question/explanation and call it a complete round.
  while (Buffer.byteLength(canonicalJson(messages)) > 120 * 1024 && sentMemory?.recentRounds.length) {
    const omitted = sentMemory.recentRounds.shift()!;
    sentMemory.status = 'degraded'; sentMemory.omittedRoundIds = [...(sentMemory.omittedRoundIds ?? []), omitted.requestId];
    payload.learningContext.conversationMemory = conversationMemoryPayload(sentMemory);
    messages[1].content = canonicalJson(payload);
  }
  if (sentMemory?.status === 'degraded') clippedFields.push('conversationMemory');
  if (Buffer.byteLength(canonicalJson(messages)) > 120 * 1024) throw new AiServiceError('INVALID_REQUEST');
  return { policyVersion: AI_POLICY_VERSION, promptVersion: AI_PROMPT_VERSION, attemptId: context.attemptId, problemId: context.problemId, problemVersion: context.problemVersion,
    language: context.language, mode: context.mode, isActive: context.isActive, draftScopeId: context.draftScopeId, draftRevision: context.draftRevision, codeHash, code: context.code,
    ...(context.answerFormat !== undefined ? { answerFormat: context.answerFormat, specVersion: context.specVersion, testConfigDigest: context.testConfigDigest } : {}),
    kind: input.kind, question: input.question, ...(input.officialSubmissionId ? { officialSubmissionId: input.officialSubmissionId } : {}),
    ...(sentMemory ? { conversationMemory: sentMemory } : {}), runId: input.runId ?? run?.id ?? null, run, official, previousRun, provider, messages,
    selectedNoteIds: notes.map(note => note.id), selectedConversationIds: conversation.map(message => message.id), clippedFields: [...clippedFields], evidenceCatalog };
}
export const requestHash = (snapshot: AiRequestSnapshot): string => sha256(canonicalJson(snapshot));
