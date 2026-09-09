import type { Adapter, ValueType, WireValue } from '../runner/types.ts';
import { normalizeTyped, observedType, validateType, validateValue } from '../runner/values.ts';
import type { ProblemContent } from '../shared/library.ts';
import { nonempty, record, type ObjectValue } from './errors.ts';
import { htmlText, jsonValuePrefix, parseLosslessJSON } from './json.ts';
import type { Observation, ProblemReference, SourceProblemContent, SourceReference } from './types.ts';

export function mapSourceType(value: unknown, depth = 0): ValueType | null {
  if (typeof value !== 'string' || depth > 8) return null;
  const type = value.trim(); const primitives: Record<string, ValueType> = { integer: 'int', long: 'int64', double: 'float', float: 'float', boolean: 'boolean', string: 'string', ListNode: 'listnode', TreeNode: 'treenode' };
  if (Object.hasOwn(primitives, type)) return primitives[type];
  if (type.endsWith('[]')) { const child = mapSourceType(type.slice(0, -2), depth + 1); return child ? { array: child } : null; }
  const list = type.match(/^list<(.+)>$/); if (list) { const child = mapSourceType(list[1], depth + 1); return child ? { list: child } : null; }
  return null;
}
export function typedValue(value: unknown, type: ValueType): WireValue {
  let result: WireValue;
  if (typeof type !== 'string') {
    if (!Array.isArray(value)) throw new Error('Expected array/list');
    result = value.map(v => typedValue(v, 'array' in type ? type.array : type.list));
  } else if (type === 'int64' || type === 'bigint') {
    if (typeof value === 'number' && Number.isSafeInteger(value)) result = String(value); else result = value as WireValue;
  } else result = value as WireValue;
  validateValue(result, type); return result;
}

// Reviewed comparison semantics. Metadata alone cannot reveal alternate valid answers or output order.
const profiles: Record<string, Adapter> = {
  'two-sum': { method: 'twoSum', params: [{ array: 'int' }, 'int'], returns: { array: 'int' }, compare: { kind: 'multiset' } },
  'valid-parentheses': { method: 'isValid', params: ['string'], returns: 'boolean' },
  'contains-duplicate': { method: 'containsDuplicate', params: [{ array: 'int' }], returns: 'boolean' },
  'valid-anagram': { method: 'isAnagram', params: ['string', 'string'], returns: 'boolean' },
  'binary-search': { method: 'search', params: [{ array: 'int' }, 'int'], returns: 'int' },
  'search-insert-position': { method: 'searchInsert', params: [{ array: 'int' }, 'int'], returns: 'int' },
  'maximum-subarray': { method: 'maxSubArray', params: [{ array: 'int' }], returns: 'int' },
  'best-time-to-buy-and-sell-stock': { method: 'maxProfit', params: [{ array: 'int' }], returns: 'int' },
  'longest-substring-without-repeating-characters': { method: 'lengthOfLongestSubstring', params: ['string'], returns: 'int' },
  'longest-consecutive-sequence': { method: 'longestConsecutive', params: [{ array: 'int' }], returns: 'int' },
  'climbing-stairs': { method: 'climbStairs', params: ['int'], returns: 'int' },
  'invert-binary-tree': { method: 'invertTree', params: ['treenode'], returns: 'treenode' },
  'reverse-linked-list': { method: 'reverseList', params: ['listnode'], returns: 'listnode' },
};
function sourceAdapter(metadata: ObjectValue | null): Adapter | null {
  if (!metadata || metadata.manual === true || metadata.systemdesign === true || metadata.classname || !nonempty(metadata.name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(metadata.name) || !Array.isArray(metadata.params) || metadata.params.length > 20) return null;
  const params = metadata.params.map(p => mapSourceType(record(p)?.type)); const returns = mapSourceType(record(metadata.return)?.type);
  if (!returns || params.some(p => p === null)) return null;
  const adapter = { method: metadata.name, params: params as ValueType[], returns };
  try { adapter.params.forEach(t => validateType(t)); validateType(adapter.returns); } catch { return null; }
  return adapter;
}
function sampleArguments(q: ObjectValue, adapter: Adapter): WireValue[][] {
  if (adapter.params.length === 0) return [];
  let chunks: string[] = [];
  if (nonempty(q.jsonExampleTestcases)) {
    try { const parsed = JSON.parse(q.jsonExampleTestcases); if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) chunks = parsed; } catch { /* Use the separately supplied raw sample format. */ }
  }
  if (!chunks.length && nonempty(q.exampleTestcases)) {
    const lines = q.exampleTestcases.trim().split(/\r?\n/); if (lines.length % adapter.params.length !== 0) return [];
    for (let i = 0; i < lines.length; i += adapter.params.length) chunks.push(lines.slice(i, i + adapter.params.length).join('\n'));
  }
  if (chunks.length > 100) return [];
  const result: WireValue[][] = [];
  for (const chunk of chunks) {
    try {
      let remaining = chunk; const values: WireValue[] = [];
      for (const type of adapter.params) { const parsed = jsonValuePrefix(remaining); values.push(typedValue(parsed.value, type)); remaining = remaining.slice(parsed.consumed).trimStart(); }
      if (remaining.trim()) return []; result.push(values);
    } catch { return []; }
  }
  return result;
}
function argumentKey(args: WireValue[], adapter: Adapter) { return JSON.stringify(args.map((value, index) => normalizeTyped(value, adapter.params[index]))); }
function statementOutputs(html: string, metadata: ObjectValue, adapter: Adapter): Map<string, WireValue> {
  const marked = html.replace(/<(strong|b)\b[^>]*>\s*(Input|Output|Explanation|输入|输出|解释)\s*[:：]\s*<\/\1>/gi, (_all, _tag, label: string) => {
    const kind = /^(Input|输入)$/i.test(label) ? 'INPUT' : /^(Output|输出)$/i.test(label) ? 'OUTPUT' : 'STOP'; return `\n@@ALGOPRACTICE_${kind}@@\n`;
  }).replace(/<(strong|b)\b[^>]*>\s*(?:Example\s*\d+|示例\s*\d+|Constraints|提示)\s*[:：]?\s*<\/\1>/gi, '\n@@ALGOPRACTICE_STOP@@\n');
  const text = htmlText(marked); const outputs = new Map<string, WireValue>(); const conflicted = new Set<string>();
  const names = (metadata.params as unknown[]).map(p => record(p)?.name);
  if (names.some(n => !nonempty(n) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) return outputs;
  for (const segment of text.split('@@ALGOPRACTICE_INPUT@@').slice(1)) {
    const at = segment.indexOf('@@ALGOPRACTICE_OUTPUT@@'); if (at < 0) continue;
    let input = segment.slice(0, at).trim(); const values: WireValue[] = [];
    try {
      for (let i = 0; i < names.length; i++) {
        const assignment = new RegExp(`^${names[i]}\\s*=\\s*`).exec(input); if (!assignment) throw new Error('Sample input labels differ from metadata');
        const parsed = jsonValuePrefix(input.slice(assignment[0].length)); values.push(typedValue(parsed.value, adapter.params[i]));
        input = input.slice(assignment[0].length + parsed.consumed).trim(); if (i < names.length - 1) { if (!input.startsWith(',')) throw new Error('Missing sample separator'); input = input.slice(1).trim(); }
      }
      if (input) continue;
      const outputText = segment.slice(at + '@@ALGOPRACTICE_OUTPUT@@'.length).split('@@ALGOPRACTICE_STOP@@')[0].trim();
      const parsed = jsonValuePrefix(outputText); if (outputText.slice(parsed.consumed).trim()) continue;
      const expected = typedValue(parsed.value, observedType(adapter)); const key = argumentKey(values, adapter);
      if (outputs.has(key) && JSON.stringify(outputs.get(key)) !== JSON.stringify(expected)) { outputs.delete(key); conflicted.add(key); }
      if (!conflicted.has(key)) outputs.set(key, expected);
    } catch { /* Ambiguous examples stay execution-only. Never synthesize expected results. */ }
  }
  return outputs;
}

export function problemContent(q: ObjectValue, reference: SourceReference, problem: ProblemReference, observation: Observation): SourceProblemContent {
  const warnings: string[] = []; let metadata: ObjectValue | null = null;
  if (nonempty(q.metaData)) { try { metadata = record(parseLosslessJSON(q.metaData)); } catch { warnings.push('函数元数据不是完整 JSON，未创建运行适配。'); } }
  const description = nonempty(q.translatedContent) ? q.translatedContent : nonempty(q.content) ? q.content : '';
  const starter: ProblemContent['starter'] = {};
  for (const value of Array.isArray(q.codeSnippets) ? q.codeSnippets : []) { const snippet = record(value); if (!snippet || !nonempty(snippet.code) || Buffer.byteLength(snippet.code) > 1048576) continue;
    if (snippet.langSlug === 'python3') starter.python = snippet.code; else if (snippet.langSlug === 'java') starter.java = snippet.code;
  }
  const tags = Array.isArray(q.topicTags) ? q.topicTags.map(t => record(t)?.translatedName ?? record(t)?.nameTranslated ?? record(t)?.name).filter(nonempty) : [];
  const plain = htmlText(description); const constraintText = plain.split(/(?:^|\n)\s*(?:Constraints|提示)\s*[:：]\s*/i)[1];
  const constraints = constraintText ? constraintText.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 30) : [];
  const content: ProblemContent = { id: reference.sourceKey, title: problem.translatedTitle ?? problem.title, difficulty: problem.difficulty, tags,
    sourceUrl: reference.canonicalUrl, description, descriptionFormat: 'html', constraints, mode: 'function', cases: [], starter, source: 'leetcode-cn', sourceId: problem.sourceId };
  if (!description) { content.supportReason = problem.premiumOnly ? '当前账号未取得会员题面，仅保留题目链接。' : '当前来源未提供题面，仅保留链接。'; return { content, reference, capability: 'link-only', warnings, observation, rawMetadata: metadata }; }
  const adapter = sourceAdapter(metadata);
  if (!adapter) { content.supportReason = '函数签名、返回类型或交互/设计题协议尚未可靠适配；可阅读题面与记录代码。'; return { content, reference, capability: 'statement-only', warnings, observation, rawMetadata: metadata }; }
  const args = sampleArguments(q, adapter);
  if (!args.length || (!starter.python && !starter.java)) { content.supportReason = '缺少可验证的结构化输入样例或语言模板；当前只提供题面。'; return { content, reference, capability: 'statement-only', warnings, observation, rawMetadata: metadata }; }
  content.adapter = adapter; content.cases = args.map(args => ({ args }));
  const profile = profiles[reference.slug]; const signature = (a: Adapter) => JSON.stringify({ method: a.method, params: a.params, returns: a.returns });
  if (!profile || signature(profile) !== signature(adapter)) {
    content.supportReason = '签名和输入可执行，但多解、返回顺序或比较语义尚未核实；只展示输出，不判定通过。';
    return { content, reference, capability: 'execution-only', warnings, observation, rawMetadata: metadata };
  }
  const outputs = statementOutputs(nonempty(q.content) ? q.content : description, metadata!, adapter);
  const allMatch = args.every(values => outputs.has(argumentKey(values, adapter)));
  if (!allMatch) {
    content.supportReason = '公开输入与题面输出不能逐项可靠对应；只展示运行输出，不生成期望答案。';
    return { content, reference, capability: 'execution-only', warnings, observation, rawMetadata: metadata };
  }
  content.adapter = { ...adapter, ...(profile.compare ? { compare: profile.compare } : {}) };
  content.cases = args.map(values => ({ args: values, expected: outputs.get(argumentKey(values, adapter))! }));
  content.supportReason = '仅按当前题面公开样例与已核对的比较规则验证；不是官方完整测试或官方 AC。';
  return { content, reference, capability: 'sample-verified', warnings, observation, rawMetadata: metadata };
}
