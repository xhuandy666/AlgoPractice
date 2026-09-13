/** Read-only validation for records created before the adaptive coach. Never used for a new request. */
import type { AiPatch, AiRequestSnapshot, AiResponse } from '../shared/ai.ts';
import { canonicalJson, sha256 } from './canonical.ts';
import { AiServiceError } from './errors.ts';

const shape = (): never => { throw new AiServiceError('FORMAT_INVALID'); };
const policy = (): never => { throw new AiServiceError('POLICY_VIOLATION'); };
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
const containsCode = (value: string) => /```|~~~|<\/?(?:script|iframe|html|body)\b|(?:^|\n)\s*(?:class\s+\w+|def\s+\w+\s*\(|(?:public|private|protected)\s+(?:static\s+)?(?:class|void|int|boolean|String)|import\s+\w+|from\s+\w+\s+import|function\s+\w+|for\s*\(|while\s*\(|(?:for|while|if)\s+[^\n]+:\s*$|return\s+[^\n]+)/im.test(value);
export function patchCode(code: string, patch: AiPatch): string {
  if (sha256(code) !== patch.baseCodeHash) throw new AiServiceError('STALE_PATCH');
  const newline = code.includes('\r\n') ? '\r\n' : '\n'; const lines = code.split(/\r?\n/); let lastEnd = 0;
  for (const edit of patch.edits) {
    if (!Number.isInteger(edit.startLine) || !Number.isInteger(edit.endLine) || edit.startLine <= lastEnd || edit.endLine < edit.startLine || edit.startLine < 1 || edit.endLine > lines.length || typeof edit.replacement !== 'string' || edit.replacement.includes('\0')) return shape();
    lastEnd = edit.endLine;
  }
  for (const edit of [...patch.edits].reverse()) lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...(edit.replacement === '' ? [] : edit.replacement.split(/\r?\n/)));
  const result = lines.join(newline); if (Buffer.byteLength(result) > 512 * 1024) return shape(); return result;
}
export function validateLegacyResponse(raw: string, snapshot: AiRequestSnapshot): AiResponse {
  let decoded: unknown; try { decoded = JSON.parse(raw); } catch { return shape(); }
  const value = object(decoded, ['schemaVersion', 'kind', 'level', 'title', 'explanation', 'nextSteps', 'evidence', 'inferences', 'patch', 'completeSolution', 'noteDraft']);
  if (value.schemaVersion !== 1 || value.kind !== snapshot.kind || value.level !== snapshot.level) return policy();
  if (snapshot.level === 'L4' && !snapshot.unlockCompleteSolution) throw new AiServiceError('L4_LOCKED');
  if (snapshot.mode === 'strict' && snapshot.isActive) throw new AiServiceError('STRICT_MODE');
  if (!snapshot.level || !['L0','L1','L2','L3','L4'].includes(snapshot.level)) return policy();
  const level = Number(snapshot.level.slice(1)), maximum = [500, 800, 1200, 2000, 8000][level];
  const title = text(value.title, 120), explanation = text(value.explanation, maximum);
  const nextSteps = array(value.nextSteps, [2, 2, 3, 4, 8][level]).map(item => text(item, level < 4 ? 500 : 2000));
  const inferences = array(value.inferences, 8).map(item => { const inference = object(item, ['text', 'reason']); return { text: text(inference.text, 1000), reason: text(inference.reason, 1000) }; });
  const evidence = array(value.evidence, 8).map(item => {
    const reference = object(item, ['runId', 'kind', 'quote'], ['caseIndex']);
    const run = snapshot.run; if (!run || reference.runId !== run.id || run.codeHash !== snapshot.codeHash || run.problemVersion !== snapshot.problemVersion) return policy();
    const quote = text(reference.quote, 2000);
    if (reference.kind === 'test') {
      if (!run.trustworthyExpected || !Number.isInteger(reference.caseIndex)) return policy();
      const test = run.caseResults.find(test => test.index === reference.caseIndex); if (!test || !['passed', 'wrong_answer'].includes(test.status) || !canonicalJson(test).includes(quote)) return policy();
      return { runId: run.id, kind: 'test' as const, quote, caseIndex: test.index };
    }
    if (reference.caseIndex !== undefined) return shape();
    if (reference.kind === 'compiler') {
      if (run.status !== 'compile_error' || !run.diagnostics.some(diagnostic => diagnostic.source === 'user' && diagnostic.message.includes(quote))) return policy();
      return { runId: run.id, kind: 'compiler' as const, quote };
    }
    if (reference.kind === 'exception') {
      if (!['runtime_error', 'timeout', 'output_limit'].includes(run.status) || ![...run.diagnostics.filter(diagnostic => diagnostic.source === 'user').map(diagnostic => diagnostic.message), run.stdout, run.stderr].some(message => message.includes(quote))) return policy();
      return { runId: run.id, kind: 'exception' as const, quote };
    }
    return shape();
  });
  let patch: AiPatch | null = null;
  if (value.patch !== null) {
    if (level < 3 || snapshot.kind !== 'diagnosis') return policy();
    const candidate = object(value.patch, ['baseCodeHash', 'edits']);
    if (candidate.baseCodeHash !== snapshot.codeHash) return policy();
    const edits = array(candidate.edits, 20).map(item => { const edit = object(item, ['startLine', 'endLine', 'replacement']); if (!Number.isInteger(edit.startLine) || !Number.isInteger(edit.endLine)) return shape(); return { startLine: edit.startLine as number, endLine: edit.endLine as number, replacement: text(edit.replacement, 65536, true) }; });
    if (!edits.length || (!evidence.length && !inferences.length)) return policy();
    patch = { baseCodeHash: snapshot.codeHash, edits }; patchCode(snapshot.code, patch);
    if (level === 3) {
      const totalLines = snapshot.code.split(/\r?\n/).length;
      const changedLines = edits.reduce((count, edit) => count + Math.max(edit.endLine - edit.startLine + 1, edit.replacement ? edit.replacement.split(/\r?\n/).length : 0), 0);
      if (changedLines > Math.min(12, Math.max(1, Math.floor(totalLines / 3))) || edits.reduce((count, edit) => count + edit.endLine - edit.startLine + 1, 0) >= snapshot.code.split(/\r?\n/).filter(line => line.trim()).length || edits.some(edit => /```|~~~/.test(edit.replacement))) return policy();
    }
  }
  let completeSolution: AiResponse['completeSolution'] = null;
  if (value.completeSolution !== null) {
    if (level !== 4 || !snapshot.unlockCompleteSolution) return policy();
    const solution = object(value.completeSolution, ['explanation', 'code']); completeSolution = { explanation: text(solution.explanation, 8000), code: text(solution.code, 65536) };
  }
  let noteDraft: AiResponse['noteDraft'] = null;
  if (value.noteDraft !== null) {
    if (snapshot.kind !== 'note-draft') return policy();
    const note = object(value.noteDraft, ['title', 'markdown', 'tags']); noteDraft = { title: text(note.title, 160), markdown: text(note.markdown, level === 4 ? 20000 : 4000), tags: array(note.tags, 12).map(tag => text(tag, 60)) };
  } else if (snapshot.kind === 'note-draft') return policy();
  const prose = [title, explanation, ...nextSteps, ...inferences.flatMap(inference => [inference.text, inference.reason]), completeSolution?.explanation ?? '', ...(level < 4 && noteDraft ? [noteDraft.title, noteDraft.markdown, ...noteDraft.tags] : [])].join('\n');
  if (containsCode(prose)) return policy();
  const factualProse = [explanation, ...nextSteps].join('\n');
  if (/\bO\s*\([^)]+\)|(?:时间|空间)复杂度(?:为|是)/i.test(factualProse)) return policy();
  if (/(?:保证|一定|绝对|100%).{0,10}(?:正确|通过)|(?:已|全部|保证).{0,8}(?:通过隐藏|官方\s*AC)|(?:guaranteed|definitely).{0,20}(?:correct|pass)|(?:passed|pass all).{0,20}hidden tests/i.test(prose)) return policy();
  if (/(?:代码|解法|答案).{0,10}(?:完全正确|已经正确|一定正确)|所有(?:样例|测试)(?:都)?(?:已)?通过/i.test(factualProse) && !(snapshot.run?.status === 'passed' && snapshot.run.trustworthyExpected && evidence.some(item => item.kind === 'test'))) return policy();
  if (level === 0 && /(?:使用|采用|利用|建议).{0,12}(?:动态规划|二分查找|双指针|滑动窗口|哈希表|回溯|DFS|BFS|单调栈)/i.test(prose)) return policy();
  if (level < 3 && (prose.match(/首先|然后|接着|最后|first,|then,|finally,/gi)?.length ?? 0) >= 3) return policy();
  return { schemaVersion: 1, kind: snapshot.kind, level: snapshot.level, title, explanation, nextSteps, evidence, inferences, patch, completeSolution, noteDraft };
}
