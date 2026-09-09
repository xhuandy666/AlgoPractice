import { createHash } from 'node:crypto';
import { capability } from '../shared/capability';
import type { LibraryProblem } from '../shared/library';
import type { ProblemListItem } from '../shared/learning';
import type { Attempt } from '../storage/practice-store';
import type { CompanyDataset, InterviewRules, InterviewPool, InterviewCandidate } from '../shared/interview';
import { normalizeCompany } from './company';
export const SAMPLING_VERSION = 'sha256-stratified-without-replacement-v1';
export function validateRules(value: InterviewRules): InterviewRules {
  if (!value || !['strict','coached'].includes(value.mode) || !['python','java'].includes(value.language) || !Number.isInteger(value.durationMinutes) || value.durationMinutes < 1 || value.durationMinutes > 240 || !Number.isInteger(value.excludeRecentDays) || value.excludeRecentDays < 0 || value.excludeRecentDays > 365 || !['uniform','frequency'].includes(value.sampling) || typeof value.seed !== 'string' || !value.seed.trim() || value.seed.length > 200 || !Array.isArray(value.tags) || value.tags.length > 30 || value.tags.some(t => typeof t !== 'string' || t.length > 100) || !value.counts) throw new Error('面试配置无效。');
  const counts = { easy: value.counts.easy, medium: value.counts.medium, hard: value.counts.hard };
  if (Object.values(counts).some(n => !Number.isInteger(n) || n < 0 || n > 10) || Object.values(counts).reduce((a,b) => a+b,0) < 1 || Object.values(counts).reduce((a,b) => a+b,0) > 10) throw new Error('每场请选择 1–10 道题。');
  for (const v of [value.company, value.datasetId]) if (v !== null && (typeof v !== 'string' || !v.trim() || v.length > 1000)) throw new Error('企业或数据集配置无效。');
  if (value.company && !value.datasetId || value.sampling === 'frequency' && (!value.company || !value.datasetId)) throw new Error('企业筛选和频率抽样需要指定企业数据集。');
  return { mode: value.mode, language: value.language, durationMinutes: value.durationMinutes, counts, tags: [...new Set(value.tags)].sort(), company: value.company ? normalizeCompany(value.company) : null, datasetId: value.datasetId, excludeRecentDays: value.excludeRecentDays, sampling: value.sampling, seed: value.seed };
}
function difficulty(value: string): InterviewCandidate['difficulty'] | null { return ({ Easy:'easy', Medium:'medium', Hard:'hard', easy:'easy', medium:'medium', hard:'hard', 简单:'easy', 中等:'medium', 困难:'hard' } as Record<string, InterviewCandidate['difficulty']>)[value] ?? null; }
function candidateSupport(problem: LibraryProblem | ProblemListItem, language: InterviewRules['language']) {
  if (!('capabilities' in problem)) return capability(problem.content, language);
  if (problem.capability.canRun && problem.capabilities[language]) return problem.capability;
  return { canRun: false, reason: problem.content.supportReason || '题面、函数签名、语言模板或用例尚未准备完整。' };
}
function uniform(seed: string, id: string): number { const bytes = createHash('sha256').update(JSON.stringify([SAMPLING_VERSION, seed, id])).digest(); return (bytes.readUIntBE(0,6) + 1) / (2 ** 48 + 1); }
export function selectCandidates(candidates: InterviewCandidate[], rules: InterviewRules): string[] {
  const selected: string[] = [];
  for (const tier of ['easy','medium','hard'] as const) { const ranked = candidates.filter(c => c.difficulty === tier).map(c => ({ id: c.problem.id, rank: Math.log(-Math.log(uniform(rules.seed,c.problem.id))) - Math.log(c.weight) })).sort((a,b) => a.rank-b.rank || a.id.localeCompare(b.id,'en')); selected.push(...ranked.slice(0,rules.counts[tier]).map(c => c.id)); }
  return selected;
}
export function buildPool(problems: Array<LibraryProblem | ProblemListItem>, attempts: Array<Pick<Attempt, 'problemId' | 'startedAt'>>, input: InterviewRules, dataset: CompanyDataset | null, at = new Date().toISOString()): InterviewPool {
  const rules = validateRules(input), exclusions: InterviewPool['exclusions'] = [], shortages: string[] = [], candidates: InterviewCandidate[] = [];
  if (rules.datasetId && dataset?.id !== rules.datasetId) throw new Error('企业数据集不存在。');
  const entries = dataset?.entries.filter(e => !rules.company || e.normalizedCompany === rules.company) ?? [];
  if (rules.sampling === 'frequency') {
    if (!entries.length || entries.some(e => e.frequency === null || !e.window || !e.frequencyMeaning) || new Set(entries.map(e => e.window)).size !== 1 || new Set(entries.map(e => e.frequencyMeaning)).size !== 1) shortages.push('频率口径或统计窗口未知/不一致。请选择均匀抽样，或更换同口径数据集。');
    const grouped = new Map<string, Set<number>>(); for (const e of entries) { const values = grouped.get(e.problemId) ?? new Set<number>(); if (e.frequency !== null) values.add(e.frequency); grouped.set(e.problemId,values); } if ([...grouped.values()].some(v => v.size > 1)) shortages.push('同题存在冲突频率，需修正数据后再加权。');
  }
  const recent = new Set(attempts.filter(a => rules.excludeRecentDays > 0 && Date.parse(a.startedAt) >= Date.parse(at)-rules.excludeRecentDays*86400000).map(a => a.problemId));
  for (const problem of [...new Map(problems.map(p => [p.id,p])).values()].sort((a,b) => a.id.localeCompare(b.id,'en'))) {
    const tier = difficulty(problem.content.difficulty), support = candidateSupport(problem,rules.language), association = entries.filter(e => e.problemId === problem.id);
    const reason = !support.canRun ? support.reason : !tier || !rules.counts[tier] ? '不符合难度配额' : rules.tags.length && !rules.tags.some(t => problem.content.tags.includes(t)) ? '不符合主题' : rules.company && !association.length ? '不属于所选企业' : recent.has(problem.id) ? '近期已经练习' : null;
    const weight = rules.sampling === 'uniform' ? 1 : association[0]?.frequency ?? 0;
    if (reason || weight <= 0) exclusions.push({ problemId: problem.id, reason: reason || '频率为零或未知，无抽样权重' }); else candidates.push({ problem, difficulty: tier!, weight });
  }
  for (const tier of ['easy','medium','hard'] as const) { const available = candidates.filter(c => c.difficulty === tier).length; if (available < rules.counts[tier]) shortages.push(`${{easy:'简单',medium:'中等',hard:'困难'}[tier]}题需要 ${rules.counts[tier]} 道，可用 ${available} 道，缺 ${rules.counts[tier]-available} 道。`); }
  return { algorithmVersion: SAMPLING_VERSION, rules, evaluatedAt: at, candidates, dataset, selectedIds: shortages.length ? [] : selectCandidates(candidates,rules), exclusions, shortages };
}
