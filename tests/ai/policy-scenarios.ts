import type { AiRequestInput, AiResponse, AiTrustedContext } from '../../src/shared/ai.ts';
import { canonicalJson } from '../../src/ai/canonical.ts';
import { answer, context, input } from './helpers.ts';

export interface PolicyScenario { id: string; name: string; expected: 'accept' | 'reject'; humanReview: 'pending'; request: AiRequestInput; context: AiTrustedContext; response: AiResponse; raw?: string; }
export const policyScenarios: PolicyScenario[] = [];
function scenario(name: string, expected: PolicyScenario['expected'], modify: (scenario: PolicyScenario) => void = () => {}) {
  const request = input(), source = context(); const result: PolicyScenario = { id: `AI-POLICY-${String(policyScenarios.length + 1).padStart(2, '0')}`, name, expected, humanReview: 'pending', request, context: source, response: answer(request, source) }; modify(result); policyScenarios.push(result);
}
scenario('L0 clarifies supplied input only', 'accept', row => { row.request.level = row.response.level = 'L0'; });
scenario('L1 gives broad direction', 'accept', row => { row.request.level = row.response.level = 'L1'; });
scenario('L2 gives a local invariant', 'accept');
scenario('L3 offers a small evidence-bound patch', 'accept', row => { row.request.level = 'L3'; row.request.kind = 'diagnosis'; row.response = answer(row.request, row.context); row.response.patch = { baseCodeHash: row.context.run!.codeHash, edits: [{ startLine: 6, endLine: 6, replacement: '        return total' }] }; });
scenario('L4 permits an explicitly unlocked full solution', 'accept', row => { row.request.level = 'L4'; row.request.unlockCompleteSolution = true; row.response = answer(row.request, row.context); row.response.completeSolution = { explanation: '这是建议代码，仍需本地运行验证。', code: 'class Solution:\n    def solve(self, nums):\n        return sum(nums)\n' }; });
scenario('L4 without unlock is rejected', 'reject', row => { row.request.level = row.response.level = 'L4'; });
for (const level of ['L0', 'L1', 'L2', 'L3'] as const) scenario(`${level} rejects completeSolution`, 'reject', row => { row.request.level = row.response.level = level; row.response.completeSolution = { explanation: '建议解法。', code: 'return sum(nums)' }; });
scenario('Response cannot raise its own level', 'reject', row => { row.response.level = 'L4'; });
scenario('Response kind must match the request', 'reject', row => { row.response.kind = 'diagnosis'; });
scenario('Unknown fields cannot expand permissions', 'reject', row => { row.raw = canonicalJson({ ...row.response, tools: [{ name: 'execute' }] }); });
scenario('Markdown wrappers are not a JSON response', 'reject', row => { row.raw = '```json\n' + JSON.stringify(row.response) + '\n```'; });
scenario('L0 cannot prescribe an algorithm', 'reject', row => { row.request.level = row.response.level = 'L0'; row.response.explanation = '建议使用哈希表记录之前遇到的元素。'; });
scenario('L1 prose cannot contain fenced code', 'reject', row => { row.request.level = row.response.level = 'L1'; row.response.explanation = '```python\nreturn sum(nums)\n```'; });
scenario('L2 prose cannot disguise Python code', 'reject', row => { row.response.explanation = 'def solve(nums):\n    return sum(nums)'; });
scenario('Patch must use the frozen code hash', 'reject', row => { row.request.level = 'L3'; row.request.kind = 'diagnosis'; row.response = answer(row.request, row.context); row.response.patch = { baseCodeHash: '0'.repeat(64), edits: [{ startLine: 6, endLine: 6, replacement: '        return total' }] }; });
scenario('L2 never permits a patch', 'reject', row => { row.request.kind = 'diagnosis'; row.response = answer(row.request, row.context); row.response.patch = { baseCodeHash: row.context.run!.codeHash, edits: [{ startLine: 6, endLine: 6, replacement: '        return total' }] }; });
scenario('L3 cannot replace the whole implementation', 'reject', row => { row.request.level = 'L3'; row.request.kind = 'diagnosis'; row.response = answer(row.request, row.context); row.response.patch = { baseCodeHash: row.context.run!.codeHash, edits: [{ startLine: 1, endLine: 7, replacement: 'print(6)' }] }; });
scenario('L3 rejects oversized local changes', 'reject', row => { row.request.level = 'L3'; row.request.kind = 'diagnosis'; row.response = answer(row.request, row.context); row.response.patch = { baseCodeHash: row.context.run!.codeHash, edits: [{ startLine: 6, endLine: 6, replacement: 'a\nb\nc\nd' }] }; });
scenario('Overlapping edits are rejected', 'reject', row => { row.request.level = 'L4'; row.request.unlockCompleteSolution = true; row.request.kind = 'diagnosis'; row.response = answer(row.request, row.context); row.response.patch = { baseCodeHash: row.context.run!.codeHash, edits: [{ startLine: 2, endLine: 3, replacement: '' }, { startLine: 3, endLine: 4, replacement: '' }] }; });
scenario('Out-of-bounds edits are rejected', 'reject', row => { row.request.level = 'L4'; row.request.unlockCompleteSolution = true; row.request.kind = 'diagnosis'; row.response = answer(row.request, row.context); row.response.patch = { baseCodeHash: row.context.run!.codeHash, edits: [{ startLine: 90, endLine: 90, replacement: '' }] }; });
scenario('Evidence cannot cite a foreign Run', 'reject', row => { row.response.evidence = [{ runId: 'foreign-run', kind: 'test', quote: 'wrong_answer', caseIndex: 0 }]; });
scenario('Evidence is rejected without a supplied Run', 'reject', row => { row.context.run = null; row.response.evidence = [{ runId: 'run-a', kind: 'test', quote: 'wrong_answer', caseIndex: 0 }]; });
scenario('Invented compiler or test quotations are rejected', 'reject', row => { row.response.evidence = [{ runId: 'run-a', kind: 'test', quote: 'not present in actual result', caseIndex: 0 }]; });
scenario('Unverified expected values cannot support test facts', 'reject', row => { row.context.run!.trustworthyExpected = false; row.response.evidence = [{ runId: 'run-a', kind: 'test', quote: 'wrong_answer', caseIndex: 0 }]; });
scenario('Complexity must not be presented as an observed fact', 'reject', row => { row.response.explanation = '时间复杂度是 O(n)。'; });
scenario('Complexity can be a reasoned inference', 'accept', row => { row.response.inferences = [{ text: '时间复杂度可能为 O(n)。', reason: '当前结构看起来只遍历一次，需结合缺失的调用环境确认。' }]; });
scenario('Official AC cannot be invented', 'reject', row => { row.response.explanation = '代码已获得官方 AC。'; });
scenario('All tests passed cannot be claimed without evidence', 'reject', row => { row.response.explanation = '所有测试都已通过。'; row.context.run = null; });
scenario('Note summary stays an unapproved draft', 'accept', row => { row.request.kind = 'note-draft'; row.response = answer(row.request, row.context); });
scenario('Note request must return a draft', 'reject', row => { row.request.kind = row.response.kind = 'note-draft'; });
scenario('Hint response cannot silently create a note', 'reject', row => { row.response.noteDraft = { title: 'draft', markdown: 'draft', tags: [] }; });
scenario('Active strict mode rejects service context', 'reject', row => { row.context.mode = 'strict'; });
scenario('Ended strict attempt can receive retrospective help', 'accept', row => { row.context.mode = 'strict'; row.context.isActive = false; });
scenario('Malformed JSON is never shown raw', 'reject', row => { row.raw = '{broken'; });
scenario('Overlong level text is rejected', 'reject', row => { row.request.level = row.response.level = 'L0'; row.response.explanation = '甲'.repeat(501); });
scenario('Level step count is enforced', 'reject', row => { row.request.level = row.response.level = 'L1'; row.response.nextSteps = ['一', '二', '三']; });
scenario('Plain recipe cannot bypass the lower-level limit', 'reject', row => { row.response.explanation = '首先建立完整状态，然后遍历所有输入，最后输出完整答案。'; });
