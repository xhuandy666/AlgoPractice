import { randomUUID } from 'node:crypto';
import type { AiHelpState, AiLevel, AiProviderConfig, AiRepository, AiRequestCompletion, AiRequestInput, AiRequestRecord, AiRequestSeed, AiResponse, AiTrustedContext } from '../../src/shared/ai.ts';
import { canonicalJson, sha256 } from '../../src/ai/canonical.ts';

export const config = (): AiProviderConfig => ({ id: 'test-provider', baseUrl: 'https://provider.example.invalid/v1', model: 'fixture-model', temperature: 0.2, maxOutputTokens: 2048, timeoutMs: 10000, jsonMode: false, includeUsage: true });
export function context(): AiTrustedContext {
  const code = 'class Solution:\n    def solve(self, nums):\n        total = 0\n        for value in nums:\n            total += value\n        return 0\n';
  return { attemptId: 'attempt-a', problemId: 'problem-a', problemVersion: 'version-a', language: 'python', mode: 'practice', isActive: true, draftScopeId: 'practice', draftRevision: 1, code,
    problem: { title: '自建数组求和', description: '输入整数数组，返回所有元素之和。自建测试，非官方结果。', constraints: ['数组可为空'] },
    run: { id: 'run-a', attemptId: 'attempt-a', problemVersion: 'version-a', codeHash: sha256(code), status: 'wrong_answer', trustworthyExpected: true, diagnostics: [], caseResults: [{ index: 0, status: 'wrong_answer', actual: 0, expected: 6 }], stdout: '', stderr: '' },
    conversation: [{ id: 'message-a', role: 'user', content: '我不理解这个循环不变式。' }], notes: [{ id: 'note-a', version: 'note-version-a', title: '自己写的提示', markdown: '关注累积状态。' }] };
}
export const input = (level: AiLevel = 'L2'): AiRequestInput => ({ requestId: randomUUID(), attemptId: 'attempt-a', kind: 'hint', level, question: '给我当前等级的一条提示。', unlockCompleteSolution: level === 'L4' });
export function answer(request = input(), source = context()): AiResponse {
  const response: AiResponse = { schemaVersion: 1, kind: request.kind, level: request.level, title: '检查当前思路', explanation: request.level === 'L0' ? '输入是整数数组，目标是返回元素之和。' : '检查已处理元素与累积值之间的关系。', nextSteps: ['用一个短数组手动观察状态变化。'], evidence: [], inferences: [], patch: null, completeSolution: null, noteDraft: null };
  if (request.kind === 'diagnosis') { response.evidence = source.run ? [{ runId: source.run.id, kind: 'test', quote: canonicalJson(source.run.caseResults[0]), caseIndex: 0 }] : []; response.inferences = [{ text: '返回位置可能没有使用累积值。', reason: '这是基于当前代码的判断，需运行本地用例确认。' }]; }
  if (request.kind === 'note-draft') response.noteDraft = { title: '累积状态复盘草稿', markdown: '我应先说明累积值代表哪些已处理的元素。此内容待本人确认。', tags: ['数组'] };
  return response;
}
export function jsonCompletion(content: string, reportedUsage = true): Response {
  return new Response(JSON.stringify({ model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], ...(reportedUsage ? { usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } } : {}) }), { headers: { 'content-type': 'application/json' } });
}
export function sseText(content: string, reportedUsage = true): string {
  const middle = Math.floor(content.length / 2);
  const chunks = [content.slice(0, middle), content.slice(middle)].map(part => `data: ${JSON.stringify({ model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: part }, finish_reason: null }] })}\n\n`).join('');
  return chunks + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` + (reportedUsage ? `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n` : '') + 'data: [DONE]\n\n';
}
export const sseCompletion = (content: string, reportedUsage = true) => new Response(sseText(content, reportedUsage), { headers: { 'content-type': 'text/event-stream' } });
export class MemoryRepository implements AiRepository {
  records = new Map<string, AiRequestRecord>(); help = new Map<string, AiHelpState>(); used = new Set<string>();
  beginAIRequest(seed: AiRequestSeed): AiRequestRecord { const existing = this.records.get(seed.id); if (existing) { if (existing.requestHash !== seed.requestHash) throw new Error('conflict'); return structuredClone(existing); } const record: AiRequestRecord = { ...structuredClone(seed), status: 'pending', response: null, error: null, usage: null, cachedFromRequestId: null, createdAt: new Date().toISOString(), finishedAt: null }; this.records.set(seed.id, record); return structuredClone(record); }
  setAIRequestPhase(id: string, phase: 'streaming' | 'repairing'): AiRequestRecord { const record = this.records.get(id)!; if (!['pending', 'streaming', 'repairing'].includes(record.status)) throw new Error('terminal'); record.status = phase; return structuredClone(record); }
  finishAIRequest(id: string, completion: AiRequestCompletion): AiRequestRecord { const record = this.records.get(id)!; if (!['pending', 'streaming', 'repairing'].includes(record.status)) return structuredClone(record); Object.assign(record, structuredClone(completion), { finishedAt: new Date().toISOString() }); if (completion.status === 'completed') this.markAIHelpUsed(record.attemptId, id, record.snapshot.level); return structuredClone(record); }
  getAIRequest(id: string) { return this.records.has(id) ? structuredClone(this.records.get(id)!) : null; }
  findCompletedAIRequest(hash: string) { const record = [...this.records.values()].find(record => record.requestHash === hash && record.status === 'completed'); return record ? structuredClone(record) : null; }
  listAIRequests(attemptId: string) { return [...this.records.values()].filter(record => record.attemptId === attemptId).map(record => structuredClone(record)); }
  recoverInterruptedAIRequests() { let count = 0; for (const record of this.records.values()) if (['pending', 'streaming', 'repairing'].includes(record.status)) { this.finishAIRequest(record.id, { status: 'interrupted', response: null, error: { code: 'INTERRUPTED', message: 'fixture recovery', retryable: false }, usage: null, cachedFromRequestId: null }); count++; } return count; }
  getAIHelpState(attemptId: string) { return structuredClone(this.help.get(attemptId) ?? { automaticShownAt: null, dismissedAt: null }); }
  markAIHelpShown(attemptId: string) { const state = this.getAIHelpState(attemptId); if (state.automaticShownAt || state.dismissedAt) return false; state.automaticShownAt = new Date().toISOString(); this.help.set(attemptId, state); return true; }
  dismissAIHelp(attemptId: string) { const state = this.getAIHelpState(attemptId); state.dismissedAt = new Date().toISOString(); this.help.set(attemptId, state); }
  markAIHelpUsed(attemptId: string, requestId: string, level: AiLevel) { this.used.add(`${attemptId}:${requestId}:${level}`); }
}
export const mockVault = () => ({ secureStorageAvailable: async () => true, hasKey: async () => true, setKey: async (_provider: AiProviderConfig, _key: string) => ({ hasKey: true as const }), clearKey: async (_provider: AiProviderConfig) => {}, withKey: async <T>(_provider: AiProviderConfig, operation: (key: string) => Promise<T>) => operation('synthetic-unit-key-12345') });
