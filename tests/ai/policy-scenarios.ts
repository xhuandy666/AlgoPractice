import type { AiRequestInput, AiResponse, AiTrustedContext } from '../../src/shared/ai.ts';
import { canonicalJson } from '../../src/ai/canonical.ts';
import { answer, context, input } from './helpers.ts';

export interface PolicyScenario { id: string; name: string; expected: 'accept' | 'reject'; humanReview: 'pending'; request: AiRequestInput; context: AiTrustedContext; response: AiResponse; raw?: string; }
export const policyScenarios: PolicyScenario[] = [];
function scenario(name: string, expected: PolicyScenario['expected'], modify: (scenario: PolicyScenario) => void = () => {}) {
  const request = input(), source = context(); const result: PolicyScenario = { id: `AI-POLICY-${String(policyScenarios.length + 1).padStart(2, '0')}`, name, expected, humanReview: 'pending', request, context: source, response: answer(request, source) }; modify(result); policyScenarios.push(result);
}
const correction = (row: PolicyScenario) => {
  row.response.inferences = [{ text: '返回了常量 0，未使用累加结果。', reason: '第 6 行与上方的累加操作不一致，可用 [1,2,3] 验证。' }];
  row.response.patch = { baseCodeHash: row.context.run!.codeHash, edits: [{ startLine: 6, endLine: 6, replacement: '        return total' }] };
};
scenario('Empty optional request accepts natural guidance', 'accept');
scenario('Main coach action can return a justified correction without a separate diagnosis action', 'accept', correction);
scenario('Explicit full solution request needs no level or unlock', 'accept', row => { row.request.question = '请给完整解法并解释。'; row.response.completeSolution = { explanation: '遍历数组累加，最后返回累加值。', code: 'class Solution:\n    def solve(self, nums):\n        return sum(nums)\n' }; });
scenario('Response cannot reintroduce a help level', 'reject', row => { row.response.level = 'L4'; });
scenario('Old response protocol is rejected for new requests', 'reject', row => { row.response.schemaVersion = 1; });
scenario('Response kind must match the request', 'reject', row => { row.response.kind = 'diagnosis'; });
scenario('Unknown fields cannot expand permissions', 'reject', row => { row.raw = canonicalJson({ ...row.response, tools: [{ name: 'execute' }] }); });
scenario('Markdown wrappers are not a JSON response', 'reject', row => { row.raw = '```json\n' + JSON.stringify(row.response) + '\n```'; });
scenario('Useful algorithm advice is allowed without levels', 'accept', row => { row.response.explanation = '可以用哈希表记录已经遇到的元素，先想清楚每次查找的目标。'; });
scenario('Code examples may be explained naturally', 'accept', row => { row.response.explanation = '这里已经累加完了，应返回累加值：\n```python\nreturn total\n```'; });
scenario('Patch must use the frozen code hash', 'reject', row => { correction(row); row.response.patch!.baseCodeHash = '0'.repeat(64); });
scenario('Patch requires evidence or a reasoned inference', 'reject', row => { correction(row); row.response.inferences = []; });
scenario('Overlapping edits are rejected', 'reject', row => { correction(row); row.response.patch!.edits = [{ startLine: 2, endLine: 3, replacement: '' }, { startLine: 3, endLine: 4, replacement: '' }]; });
scenario('Out-of-bounds edits are rejected', 'reject', row => { correction(row); row.response.patch!.edits = [{ startLine: 90, endLine: 90, replacement: '' }]; });
scenario('Two competing code proposals are rejected', 'reject', row => { correction(row); row.response.completeSolution = { explanation: '另一版本。', code: 'return 3' }; });
scenario('Evidence cannot cite a foreign Run', 'reject', row => { row.response.evidence = [{ runId: 'foreign-run', kind: 'test', quote: 'wrong_answer', caseIndex: 0 }]; });
scenario('Evidence is rejected without a supplied Run', 'reject', row => { row.context.run = null; row.response.evidence = [{ runId: 'run-a', kind: 'test', quote: 'wrong_answer', caseIndex: 0 }]; });
scenario('Invented compiler or test quotations are rejected', 'reject', row => { row.response.evidence = [{ runId: 'run-a', kind: 'test', quote: 'not present in actual result', caseIndex: 0 }]; });
scenario('Unverified expected values cannot support test facts', 'reject', row => { row.context.run!.trustworthyExpected = false; row.response.evidence = [{ runId: 'run-a', kind: 'test', quote: 'wrong_answer', caseIndex: 0 }]; });
scenario('Case without expected output cannot borrow another case confidence', 'reject', row => { delete row.context.run!.caseResults[0].expected; row.response.evidence = [{ runId: 'run-a', kind: 'test', quote: 'wrong_answer', caseIndex: 0 }]; });
scenario('Reasoned complexity is allowed in a natural explanation without a fabricated run', 'accept', row => { row.context.run = null; row.response.explanation = '每个元素只处理一次，因此时间复杂度是 O(n)。当前没有运行结果，可以再验证空数组和负数。'; });
scenario('Complexity can be a reasoned inference', 'accept', row => { row.response.inferences = [{ text: '时间复杂度可能为 O(n)。', reason: '当前结构看起来只遍历一次，需结合调用环境确认。' }]; });
scenario('Official AC cannot be invented', 'reject', row => { row.response.explanation = '代码已获得官方 AC。'; });
scenario('All tests passed cannot be claimed without evidence', 'reject', row => { row.response.explanation = '所有测试都已通过。'; row.context.run = null; });
scenario('Correctness cannot be guaranteed', 'reject', row => { row.response.explanation = '这段代码保证正确。'; });
scenario('Note summary stays an unapproved draft', 'accept', row => { row.request.kind = 'note-draft'; row.response = answer(row.request, row.context); });
scenario('Note request must return a draft', 'reject', row => { row.request.kind = row.response.kind = 'note-draft'; });
scenario('Hint response cannot silently create a note', 'reject', row => { row.response.noteDraft = { title: 'draft', markdown: 'draft', tags: [] }; });
scenario('Active strict mode rejects service context', 'reject', row => { row.context.mode = 'strict'; });
scenario('Ended strict attempt can receive retrospective help', 'accept', row => { row.context.mode = 'strict'; row.context.isActive = false; });
scenario('Malformed JSON is never shown raw', 'reject', row => { row.raw = '{broken'; });
scenario('Overlong response text is rejected', 'reject', row => { row.response.explanation = '甲'.repeat(8001); });
scenario('Response step count is bounded', 'reject', row => { row.response.nextSteps = Array(9).fill('检查一步。'); });
scenario('Explicit full walkthrough request is allowed', 'accept', row => { row.request.question = '按步骤详细解释'; row.response.explanation = '首先明确累加值代表哪些元素，然后遍历输入，最后返回最终累加值。'; });
