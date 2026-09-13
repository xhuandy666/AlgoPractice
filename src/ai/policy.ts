import { AI_POLICY_VERSION, type AiPatch, type AiRequestSnapshot, type AiResponse } from '../shared/ai.ts';
import { canonicalJson, sha256 } from './canonical.ts';
import { AiServiceError } from './errors.ts';
import { validateLegacyResponse } from './legacy-policy.ts';

const REPAIR_HINTS = Object.freeze({
  shape: 'Return one valid JSON object with exactly the required fields and bounded field types. Do not wrap JSON in Markdown or add fields.',
  schemaKind: 'Use schemaVersion:2 and the original requested kind. Do not add level or unlock fields.',
  localRun: 'Use evidence only from the supplied current-code local run. If no matching run is supplied, return evidence:[]; discuss code-based possibilities as inferences without inventing a run.',
  officialRun: 'Use official evidence only from the supplied matching official submission. If none is supplied, omit official evidence; do not invent an official submission.',
  testCase: 'Local test evidence needs the supplied caseIndex, a passed/wrong_answer status, and a supplied trustworthy expected value. Otherwise omit that evidence.',
  quote: 'Evidence quote must exactly match supplied diagnostic text or serialized case/official data. Do not invent or paraphrase a quote; omit any evidence that cannot be quoted exactly.',
  evidenceKind: 'Evidence kind must match the supplied run status: compiler for user compile errors, exception for supplied runtime/timeout/output-limit diagnostics, test for verified local cases, official for the matching official result.',
  patchHash: 'Copy the exact current codeHash into patch.baseCodeHash. Never guess or use a historical code hash.',
  patchClipped: 'The current code or its numbered reference view is incomplete. Return patch:null and give bounded prose guidance instead of guessing line ranges.',
  patchGrounding: 'A patch must include at least one nonempty edit and supporting supplied evidence or a reasoned code-based inference. If unsupported, return patch:null.',
  patchRange: 'Patch edits must use valid one-based inclusive nonoverlapping source line ranges and remain within the current source. Preserve enclosing blocks and indentation; otherwise return patch:null.',
  patchKind: 'A note-draft request cannot include patch or completeSolution. Keep code proposals null for this action.',
  codeConflict: 'Return at most one code proposal: patch or completeSolution, never both.',
  noteKind: 'Only kind=note-draft may return a noteDraft, and that action requires a non-null draft. Keep noteDraft:null for all other actions.',
  guarantee: 'Remove absolute guarantees of correctness or passing. Explain supported observations or reasoned uncertainty without promising a result.',
  officialSuccess: 'No matching accepted official result supports that claim. Do not claim official AC or hidden-test success; limit the explanation to supplied local facts and code-based reasoning.',
  localSuccess: 'No matching trustworthy passed local run supports an all-tests-passed claim. Do not say all tests passed; state only the supplied case results or a proposed check.',
} as const);
type RepairHintKey = keyof typeof REPAIR_HINTS;
/** Internal, fixed guidance for one repair attempt. Never copied into public AiError. */
export class AiValidationError extends AiServiceError {
  readonly repairHint: typeof REPAIR_HINTS[RepairHintKey];
  constructor(reason: RepairHintKey, code: 'FORMAT_INVALID' | 'POLICY_VIOLATION' = 'POLICY_VIOLATION') {
    super(code);
    if (!Object.hasOwn(REPAIR_HINTS, reason)) throw new AiServiceError('FORMAT_INVALID');
    this.name = 'AiValidationError'; this.repairHint = REPAIR_HINTS[reason];
    Object.defineProperty(this, 'repairHint', { value: this.repairHint, writable: false, configurable: false });
  }
}
export function validationRepairHint(error: unknown): string {
  return error instanceof AiValidationError && Object.values(REPAIR_HINTS).includes(error.repairHint) ? error.repairHint : REPAIR_HINTS.shape;
}
const shape = (): never => { throw new AiValidationError('shape', 'FORMAT_INVALID'); };
const policy = (reason: RepairHintKey): never => { throw new AiValidationError(reason); };
function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return shape();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !Object.hasOwn(result, key))) return shape();
  return result;
}
function text(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return shape(); return value;
}
function array(value: unknown, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) return shape(); return value; }
export function patchCode(code: string, patch: AiPatch): string {
  if (sha256(code) !== patch.baseCodeHash) throw new AiServiceError('STALE_PATCH');
  const newline = code.includes('\r\n') ? '\r\n' : '\n'; const lines = code.split(/\r?\n/); let lastEnd = 0;
  for (const edit of patch.edits) {
    if (!Number.isInteger(edit.startLine) || !Number.isInteger(edit.endLine) || edit.startLine <= lastEnd || edit.endLine < edit.startLine || edit.startLine < 1 || edit.endLine > lines.length || typeof edit.replacement !== 'string' || edit.replacement.includes('\0')) throw new AiValidationError('patchRange', 'FORMAT_INVALID');
    lastEnd = edit.endLine;
  }
  for (const edit of [...patch.edits].reverse()) lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...(edit.replacement === '' ? [] : edit.replacement.split(/\r?\n/)));
  const result = lines.join(newline); if (Buffer.byteLength(result) > 512 * 1024) return shape(); return result;
}
export function validateResponse(raw: string, snapshot: AiRequestSnapshot): AiResponse {
  // Preserve the old immutable response/hash contract for records already saved on disk.
  if (snapshot.policyVersion === 'algopractice-ai-policy-v1') return validateLegacyResponse(raw, snapshot);
  if (snapshot.policyVersion !== AI_POLICY_VERSION || snapshot.level !== undefined || snapshot.unlockCompleteSolution !== undefined) return policy('schemaKind');
  let decoded: unknown; try { decoded = JSON.parse(raw); } catch { return shape(); }
  const value = object(decoded, ['schemaVersion', 'kind', 'title', 'explanation', 'nextSteps', 'evidence', 'inferences', 'patch', 'completeSolution', 'noteDraft']);
  if (value.schemaVersion !== 2 || value.kind !== snapshot.kind) return policy('schemaKind');
  if (snapshot.mode === 'strict' && snapshot.isActive) throw new AiServiceError('STRICT_MODE');
  const title = text(value.title, 120), explanation = text(value.explanation, 8000);
  const nextSteps = array(value.nextSteps, 8).map(item => text(item, 2000));
  const inferences = array(value.inferences, 8).map(item => { const inference = object(item, ['text', 'reason']); return { text: text(inference.text, 2000), reason: text(inference.reason, 2000) }; });
  const evidence = array(value.evidence, 8).map(item => {
    const reference = object(item, ['runId', 'kind', 'quote'], ['caseIndex']);
    const quote = text(reference.quote, 2000);
    if (reference.kind === 'official') {
      const official = snapshot.official;
      if (!official || reference.runId !== official.id || official.codeHash !== snapshot.codeHash || official.problemVersion !== snapshot.problemVersion || reference.caseIndex !== undefined) return policy('officialRun');
      const officialText = [official.statusMessage, official.compileError, official.runtimeError, official.input, official.actualOutput, official.expectedOutput].filter((entry): entry is string => typeof entry === 'string');
      if (!canonicalJson(official).includes(quote) && !officialText.some(entry => entry.includes(quote))) return policy('quote');
      return { runId: official.id, kind: 'official' as const, quote };
    }
    const run = snapshot.run;
    if (!run || reference.runId !== run.id || run.codeHash !== snapshot.codeHash || run.problemVersion !== snapshot.problemVersion) return policy('localRun');
    if (reference.kind === 'test') {
      if (!run.trustworthyExpected || !Number.isInteger(reference.caseIndex)) return policy('testCase');
      const test = run.caseResults.find(test => test.index === reference.caseIndex);
      if (!test || !['passed', 'wrong_answer'].includes(test.status) || !Object.hasOwn(test, 'expected')) return policy('testCase');
      if (!canonicalJson(test).includes(quote)) return policy('quote');
      return { runId: run.id, kind: 'test' as const, quote, caseIndex: test.index };
    }
    if (reference.caseIndex !== undefined) return shape();
    if (reference.kind === 'compiler') {
      if (run.status !== 'compile_error') return policy('evidenceKind');
      if (!run.diagnostics.some(diagnostic => diagnostic.source === 'user' && diagnostic.message.includes(quote))) return policy('quote');
      return { runId: run.id, kind: 'compiler' as const, quote };
    }
    if (reference.kind === 'exception') {
      if (!['runtime_error', 'timeout', 'output_limit'].includes(run.status)) return policy('evidenceKind');
      if (![...run.diagnostics.filter(diagnostic => diagnostic.source === 'user').map(diagnostic => diagnostic.message), run.stdout, run.stderr].some(message => message.includes(quote))) return policy('quote');
      return { runId: run.id, kind: 'exception' as const, quote };
    }
    return shape();
  });
  let patch: AiPatch | null = null;
  if (value.patch !== null) {
    if (snapshot.kind === 'note-draft') return policy('patchKind');
    if (snapshot.clippedFields.includes('code') || snapshot.clippedFields.includes('codeWithLineNumbers')) return policy('patchClipped');
    const candidate = object(value.patch, ['baseCodeHash', 'edits']);
    if (candidate.baseCodeHash !== snapshot.codeHash) return policy('patchHash');
    const edits = array(candidate.edits, 20).map(item => { const edit = object(item, ['startLine', 'endLine', 'replacement']); if (!Number.isInteger(edit.startLine) || !Number.isInteger(edit.endLine)) return shape(); return { startLine: edit.startLine as number, endLine: edit.endLine as number, replacement: text(edit.replacement, 65536, true) }; });
    if (!edits.length || (!evidence.length && !inferences.length)) return policy('patchGrounding');
    patch = { baseCodeHash: snapshot.codeHash, edits }; patchCode(snapshot.code, patch);
  }
  let completeSolution: AiResponse['completeSolution'] = null;
  if (value.completeSolution !== null) {
    if (patch) return policy('codeConflict');
    if (snapshot.kind === 'note-draft') return policy('patchKind');
    const solution = object(value.completeSolution, ['explanation', 'code']); completeSolution = { explanation: text(solution.explanation, 8000), code: text(solution.code, 65536) };
  }
  let noteDraft: AiResponse['noteDraft'] = null;
  if (value.noteDraft !== null) {
    if (snapshot.kind !== 'note-draft') return policy('noteKind');
    const note = object(value.noteDraft, ['title', 'markdown', 'tags']); noteDraft = { title: text(note.title, 160), markdown: text(note.markdown, 20000), tags: array(note.tags, 12).map(tag => text(tag, 60)) };
  } else if (snapshot.kind === 'note-draft') return policy('noteKind');
  const prose = [title, explanation, ...nextSteps, ...inferences.flatMap(inference => [inference.text, inference.reason]), completeSolution?.explanation ?? '', noteDraft?.markdown ?? ''].join('\n');
  const factualProse = [explanation, ...nextSteps].join('\n');
  if (/(?:保证|一定|绝对|100%).{0,10}(?:正确|通过)|(?:guaranteed|definitely).{0,20}(?:correct|pass)|(?:代码|解法|答案).{0,10}(?:完全正确|一定正确)/i.test(prose)) return policy('guarantee');
  const officialAccepted = snapshot.official?.status === 'accepted' && evidence.some(item => item.kind === 'official' && /accepted|通过|Accepted/.test(item.quote));
  if (/(?:已|全部|保证).{0,12}(?:通过隐藏|官方\s*AC)|(?:passed|pass all).{0,20}hidden tests|(?:官方|力扣).{0,10}(?:全部通过|已通过|接受了|判定通过)/i.test(factualProse) && !officialAccepted) return policy('officialSuccess');
  const localPassed = snapshot.run?.status === 'passed' && snapshot.run.trustworthyExpected && snapshot.run.caseResults.length > 0 && snapshot.run.caseResults.every(test => test.status === 'passed' && Object.hasOwn(test, 'expected')) && evidence.some(item => item.kind === 'test');
  if (/所有(?:样例|测试)(?:都)?(?:已)?通过/i.test(factualProse) && !localPassed && !officialAccepted) return policy('localSuccess');
  return { schemaVersion: 2, kind: snapshot.kind, title, explanation, nextSteps, evidence, inferences, patch, completeSolution, noteDraft };
}
