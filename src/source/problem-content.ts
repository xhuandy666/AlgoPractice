import type { Adapter, DesignAdapter, DesignMethod, ProblemAdapter, ValueType, WireValue } from '../runner/types.ts';
import { designCaseKey, designSteps, isDesignAdapter, validateDesignAdapter } from '../runner/design.ts';
import { normalizeTyped, observedType, validateType, validateValue } from '../runner/values.ts';
import type { ProblemContent } from '../shared/library.ts';
import { nonempty, record, type ObjectValue } from './errors.ts';
import { htmlText, jsonValuePrefix, parseLosslessJSON } from './json.ts';
import type { Observation, ProblemReference, SourceProblemContent, SourceReference } from './types.ts';
import { LANGUAGES, languageFromOfficialSlug } from '../shared/languages.ts';

export function mapSourceType(value: unknown, depth = 0): ValueType | null {
  if (typeof value !== 'string' || depth > 8) return null;
  const type = value.trim(); const primitives: Record<string, ValueType> = { integer: 'int', long: 'int64', double: 'float', float: 'float', boolean: 'boolean', string: 'string', character: 'char', char: 'char', ListNode: 'listnode', TreeNode: 'treenode' };
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

// Reviewed comparison semantics. Metadata alone cannot reveal alternate valid answers or output order (or, for design
// problems, randomness such as getRandom).
const profiles: Record<string, ProblemAdapter> = {
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
  'lru-cache': { kind: 'design', className: 'LRUCache', constructorParams: ['int'], methods: [{ name: 'get', params: ['int'], returns: 'int' }, { name: 'put', params: ['int', 'int'], returns: 'void' }] },
  'min-stack': { kind: 'design', className: 'MinStack', constructorParams: [], methods: [{ name: 'push', params: ['int'], returns: 'void' }, { name: 'pop', params: [], returns: 'void' }, { name: 'top', params: [], returns: 'int' }, { name: 'getMin', params: [], returns: 'int' }] },
  'implement-trie-prefix-tree': { kind: 'design', className: 'Trie', constructorParams: [], methods: [{ name: 'insert', params: ['string'], returns: 'void' }, { name: 'search', params: ['string'], returns: 'boolean' }, { name: 'startsWith', params: ['string'], returns: 'boolean' }] },
  // The statement accepts answers within 1e-5.
  'find-median-from-data-stream': { kind: 'design', className: 'MedianFinder', constructorParams: [], methods: [{ name: 'addNum', params: ['int'], returns: 'void' }, { name: 'findMedian', params: [], returns: 'float' }], compare: { kind: 'float', absoluteTolerance: 1e-5, relativeTolerance: 1e-5 } },
};
function sourceAdapter(metadata: ObjectValue | null): ProblemAdapter | null {
  if (metadata && metadata.manual !== true && (metadata.classname !== undefined || metadata.systemdesign === true)) return designAdapter(metadata);
  if (!metadata || metadata.manual === true || !nonempty(metadata.name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(metadata.name) || !Array.isArray(metadata.params) || metadata.params.length > 20) return null;
  const params = metadata.params.map(p => mapSourceType(record(p)?.type));
  if (params.some(p => p === null)) return null;
  const returnType = record(metadata.return)?.type;
  if (returnType === 'void') {
    // In-place problems (move-zeroes, rotate-array, sort-colors…) return void and name the modified parameter in
    // output.paramindex; the runner observes it after the call. Only arrays/lists can be observed this way.
    const index = record(metadata.output)?.paramindex;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= params.length || typeof params[index] === 'string') return null;
    const adapter: Adapter = { method: metadata.name, params: params as ValueType[], returns: 'void', inPlaceArg: index };
    try { adapter.params.forEach(t => validateType(t)); } catch { return null; }
    return adapter;
  }
  const returns = mapSourceType(returnType); if (!returns) return null;
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
export function argumentKey(args: WireValue[], adapter: Adapter) { return JSON.stringify(args.map((value, index) => normalizeTyped(value, adapter.params[index]))); }
/** Statement example outputs keyed by argumentKey; parameterNames label the sample inputs ("nums = [...]"). */
export function statementOutputs(html: string, parameterNames: readonly unknown[], adapter: Adapter): Map<string, WireValue> {
  const marked = html.replace(/<(strong|b)\b[^>]*>\s*(Input|Output|Explanation|输入|输出|解释)\s*[:：]\s*<\/\1>/gi, (_all, _tag, label: string) => {
    const kind = /^(Input|输入)$/i.test(label) ? 'INPUT' : /^(Output|输出)$/i.test(label) ? 'OUTPUT' : 'STOP'; return `\n@@ALGOPRACTICE_${kind}@@\n`;
  }).replace(/<(strong|b)\b[^>]*>\s*(?:Example\s*\d+|示例\s*\d+|Constraints|提示)\s*[:：]?\s*<\/\1>/gi, '\n@@ALGOPRACTICE_STOP@@\n');
  const text = htmlText(marked); const outputs = new Map<string, WireValue>(); const conflicted = new Set<string>();
  const names = [...parameterNames];
  if (names.length !== adapter.params.length || names.some(n => !nonempty(n) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) return outputs;
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

// Design problems (LRUCache, MinStack, Trie…): the metadata names a class, its constructor and its methods, and every
// example lists the operations and their arguments as two arrays. The top-level name/params/return of such metadata
// describe LeetCode's own harness and are ignored.
export function designAdapter(metadata: ObjectValue): DesignAdapter | null {
  const className = metadata.classname;
  // "constructor" is inherited by every object; only an own key counts.
  if (!nonempty(className) || !Object.hasOwn(metadata, 'constructor') || !Array.isArray(metadata.methods)) return null;
  const types = (params: unknown): Array<ValueType | null> => Array.isArray(params) ? params.map(p => mapSourceType(record(p)?.type)) : [null];
  const constructorParams = types(record(metadata.constructor)?.params);
  if (constructorParams.some(type => type === null)) return null;
  const methods: DesignMethod[] = [];
  for (const value of metadata.methods) {
    const method = record(value); if (!method || !nonempty(method.name)) return null;
    const params = types(method.params), returnType = record(method.return)?.type;
    const returns = returnType === 'void' ? 'void' : mapSourceType(returnType);
    if (params.some(type => type === null) || !returns) return null;
    methods.push({ name: method.name, params: params as ValueType[], returns });
  }
  const adapter: DesignAdapter = { kind: 'design', className, constructorParams: constructorParams as ValueType[], methods };
  try { validateDesignAdapter(adapter); } catch { return null; }
  return adapter;
}
/** Typed [operations, arguments] (int64 as decimal strings), validated against the adapter. */
function typedDesignCase(operations: unknown, values: unknown, adapter: DesignAdapter): WireValue[] {
  if (!Array.isArray(operations) || !Array.isArray(values) || operations.length !== values.length) throw new Error('Design case shape');
  const methods = new Map(adapter.methods.map(method => [method.name, method]));
  const typed = values.map((call, index) => {
    const params = index === 0 ? adapter.constructorParams : typeof operations[index] === 'string' ? methods.get(operations[index])?.params : undefined;
    if (!params || !Array.isArray(call) || call.length !== params.length) throw new Error('Design case arguments');
    return call.map((value, i) => typedValue(value, params[i]));
  });
  const args: WireValue[] = [operations as WireValue[], typed]; designSteps(adapter, args); return args;
}
function twoValues(text: string): [unknown, unknown] | null {
  const first = jsonValuePrefix(text), rest = text.slice(first.consumed), second = jsonValuePrefix(rest);
  return rest.slice(second.consumed).trim() ? null : [first.value, second.value];
}
export function designSampleArguments(q: ObjectValue, adapter: DesignAdapter): WireValue[][] {
  let chunks: string[] = [];
  if (nonempty(q.jsonExampleTestcases)) {
    try { const parsed = JSON.parse(q.jsonExampleTestcases); if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) chunks = parsed; } catch { /* Use the raw sample format. */ }
  }
  if (!chunks.length && nonempty(q.exampleTestcases)) {
    const lines = q.exampleTestcases.trim().split(/\r?\n/); if (lines.length % 2 !== 0) return [];
    for (let i = 0; i < lines.length; i += 2) chunks.push(lines.slice(i, i + 2).join('\n'));
  }
  if (chunks.length > 100) return [];
  const result: WireValue[][] = [];
  for (const chunk of chunks) {
    try { const pair = twoValues(chunk); if (!pair) return []; result.push(typedDesignCase(pair[0], pair[1], adapter)); } catch { return []; }
  }
  return result;
}
/** Statement example outputs keyed by designCaseKey. Design statements often omit the colon after 输入/输出. */
export function designStatementOutputs(html: string, adapter: DesignAdapter): Map<string, WireValue> {
  const marked = html.replace(/<(strong|b)\b[^>]*>\s*(Input|Output|Explanation|输入|输出|解释)\s*[:：]?\s*<\/\1>/gi, (_all, _tag, label: string) => {
    const kind = /^(Input|输入)$/i.test(label) ? 'INPUT' : /^(Output|输出)$/i.test(label) ? 'OUTPUT' : 'STOP'; return `\n@@ALGOPRACTICE_${kind}@@\n`;
  }).replace(/<(strong|b)\b[^>]*>\s*(?:Example\s*\d+|示例\s*\d*|Constraints|提示)\s*[:：]?\s*<\/\1>/gi, '\n@@ALGOPRACTICE_STOP@@\n');
  const text = htmlText(marked); const outputs = new Map<string, WireValue>(); const conflicted = new Set<string>();
  for (const segment of text.split('@@ALGOPRACTICE_INPUT@@').slice(1)) {
    const at = segment.indexOf('@@ALGOPRACTICE_OUTPUT@@'); if (at < 0) continue;
    try {
      const pair = twoValues(segment.slice(0, at)); if (!pair) continue;
      const args = typedDesignCase(pair[0], pair[1], adapter), steps = designSteps(adapter, args);
      const outputText = segment.slice(at + '@@ALGOPRACTICE_OUTPUT@@'.length).split('@@ALGOPRACTICE_STOP@@')[0].trim();
      const parsed = jsonValuePrefix(outputText); if (outputText.slice(parsed.consumed).trim() || !Array.isArray(parsed.value) || parsed.value.length !== steps.length) continue;
      const expected = parsed.value.map((value, i) => { const returns = steps[i].returns; if (returns === 'void') { if (value !== null) throw new Error('Void step with a value'); return null; } return typedValue(value, returns); });
      const key = designCaseKey(args, adapter);
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
    const language = languageFromOfficialSlug(snippet.langSlug); if (language) starter[language] = snippet.code;
  }
  const tags = Array.isArray(q.topicTags) ? q.topicTags.map(t => record(t)?.translatedName ?? record(t)?.nameTranslated ?? record(t)?.name).filter(nonempty) : [];
  const plain = htmlText(description); const constraintText = plain.split(/(?:^|\n)\s*(?:Constraints|提示)\s*[:：]\s*/i)[1];
  const constraints = constraintText ? constraintText.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 30) : [];
  const content: ProblemContent = { id: reference.sourceKey, title: problem.translatedTitle ?? problem.title, difficulty: problem.difficulty, tags,
    sourceUrl: reference.canonicalUrl, description, descriptionFormat: 'html', constraints, mode: 'function', cases: [], starter, source: 'leetcode-cn', sourceId: problem.sourceId };
  if (!description) { content.supportReason = problem.premiumOnly ? '当前账号未取得会员题面，仅保留题目链接。' : '当前来源未提供题面，仅保留链接。'; return { content, reference, capability: 'link-only', warnings, observation, rawMetadata: metadata }; }
  const adapter = sourceAdapter(metadata);
  if (!adapter) { content.supportReason = '函数签名、返回类型或交互/设计题协议尚未可靠适配；可阅读题面与记录代码。'; return { content, reference, capability: 'statement-only', warnings, observation, rawMetadata: metadata }; }
  const design = isDesignAdapter(adapter) ? adapter : null;
  const args = design ? designSampleArguments(q, design) : sampleArguments(q, adapter as Adapter);
  if (!args.length || !LANGUAGES.some(language => starter[language]?.trim())) { content.supportReason = '缺少可验证的结构化输入样例或语言模板；当前只提供题面。'; return { content, reference, capability: 'statement-only', warnings, observation, rawMetadata: metadata }; }
  content.adapter = adapter; content.cases = args.map(args => ({ args }));
  const profile = Object.hasOwn(profiles, reference.slug) ? profiles[reference.slug] : undefined;
  const signature = (a: ProblemAdapter) => JSON.stringify(isDesignAdapter(a) ? { className: a.className, constructorParams: a.constructorParams, methods: a.methods } : { method: a.method, params: a.params, returns: a.returns });
  if (!profile || signature(profile) !== signature(adapter)) {
    content.supportReason = design ? '设计题可按操作序列执行，但随机结果或比较语义尚未核实；只展示每步输出，不判定通过。' : '签名和输入可执行，但多解、返回顺序或比较语义尚未核实；只展示输出，不判定通过。';
    return { content, reference, capability: 'execution-only', warnings, observation, rawMetadata: metadata };
  }
  const html = nonempty(q.content) ? q.content : description;
  const outputs = design ? designStatementOutputs(html, design) : statementOutputs(html, (metadata!.params as unknown[]).map(p => record(p)?.name), adapter as Adapter);
  const key = (values: WireValue[]) => design ? designCaseKey(values, design) : argumentKey(values, adapter as Adapter);
  const allMatch = args.every(values => outputs.has(key(values)));
  if (!allMatch) {
    content.supportReason = '公开输入与题面输出不能逐项可靠对应；只展示运行输出，不生成期望答案。';
    return { content, reference, capability: 'execution-only', warnings, observation, rawMetadata: metadata };
  }
  content.adapter = { ...adapter, ...(profile.compare ? { compare: profile.compare } : {}) } as ProblemAdapter;
  content.cases = args.map(values => ({ args: values, expected: outputs.get(key(values))! }));
  content.supportReason = '仅按当前题面公开样例与已核对的比较规则验证；不是官方完整测试或官方 AC。';
  return { content, reference, capability: 'sample-verified', warnings, observation, rawMetadata: metadata };
}
