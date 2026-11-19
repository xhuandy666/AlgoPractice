import type { Adapter, ProblemAdapter, ValueType, WireValue } from '../runner/types.ts';
import { validateValue } from '../runner/values.ts';
import { parseLosslessJSON } from '../source/json.ts';

/** A self-test runs the current code on one input the learner wrote, to look at the output. It has no expected output,
 * is never judged, and is not recorded as a practice run: it cannot solve a problem or change learning statistics. */
export const SELF_TEST_INPUT_LIMIT = 64 * 1024;
/** The adapter a self-test can drive: an ordinary function problem. Design problems take an operation script instead. */
export function selfTestAdapter(mode: 'function' | 'acm' | undefined, adapter: ProblemAdapter | undefined): Adapter | null {
  return mode === 'function' && adapter && adapter.kind !== 'design' && adapter.params.length > 0 ? adapter : null;
}

const TYPE_NAMES = { int: '整数', int64: '整数', bigint: '整数', float: '数字', boolean: '布尔值', string: '字符串', char: '字符', listnode: '链表', treenode: '二叉树' } as const;
const TYPE_SAMPLES = { int: '1', int64: '1', bigint: '1', float: '1.5', boolean: 'true', string: '"ab"', char: '"a"', listnode: '[1,2]', treenode: '[1,null,2]' } as const;
const inner = (type: Exclude<ValueType, string>) => 'array' in type ? type.array : type.list;
const typeName = (type: ValueType): string => typeof type === 'string' ? TYPE_NAMES[type] : `${typeName(inner(type))}数组`;
const typeSample = (type: ValueType): string => { if (typeof type === 'string') return TYPE_SAMPLES[type]; const item = typeSample(inner(type)); return item === '1' ? '[1,2]' : `[${item}]`; };
/** How to write a value of this type, for input errors: the name and one example in the expected notation. */
export function valueTypeLabel(type: ValueType): string {
  const note = type === 'string' || type === 'char' ? '（带双引号）' : type === 'listnode' ? '（写成数组）' : type === 'treenode' ? '（层序数组，空结点写 null）' : '';
  return `${typeName(type)}${note}，如 ${typeSample(type)}`;
}
/** int64/bigint cross the IPC boundary as decimal strings; everything else is the parsed JSON value. */
function typed(value: unknown, type: ValueType): WireValue {
  if (typeof type !== 'string') { if (!Array.isArray(value)) throw new Error('not an array'); return value.map(item => typed(item, 'array' in type ? type.array : type.list)); }
  if ((type === 'int64' || type === 'bigint') && typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return value as WireValue;
}

/** Reads the notation LeetCode uses for test cases: one JSON value per line, one line per parameter, in the order of
 * the function signature. Blank lines are ignored. Errors name the line and say what that parameter expects. */
export function parseSelfTestInput(text: string, adapter: Adapter, names?: readonly string[] | null): WireValue[] {
  if (text.length > SELF_TEST_INPUT_LIMIT) throw new Error('自测输入过长，请控制在 64 KB 以内。');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const label = (index: number) => names?.[index] ? `第 ${index + 1} 行（${names[index]}）` : `第 ${index + 1} 行`;
  if (lines.length !== adapter.params.length) throw new Error(`需要 ${adapter.params.length} 行输入，每行一个参数${names ? `（${names.join('、')}）` : ''}，现在是 ${lines.length} 行。`);
  return lines.map((line, index) => {
    const type = adapter.params[index];
    let parsed: unknown;
    try { parsed = parseLosslessJSON(line); } catch { throw new Error(`${label(index)}不是有效的 JSON 值；需要${valueTypeLabel(type)}。`); }
    try { const value = typed(parsed, type); validateValue(value, type); return value; }
    catch { throw new Error(`${label(index)}与参数类型不符；需要${valueTypeLabel(type)}。`); }
  });
}
/** Checks arguments that arrived over IPC against the adapter before anything runs. */
export function validateSelfTestArguments(value: unknown, adapter: Adapter): WireValue[] {
  if (!Array.isArray(value) || value.length !== adapter.params.length) throw new Error('自测输入与题目参数不符。');
  if (JSON.stringify(value).length > SELF_TEST_INPUT_LIMIT * 2) throw new Error('自测输入过长，请控制在 64 KB 以内。');
  try { value.forEach((item, index) => validateValue(item as WireValue, adapter.params[index])); } catch { throw new Error('自测输入与题目参数不符。'); }
  return value as WireValue[];
}
/** The same notation back: used to prefill the editor with one of the problem's own cases. */
export function formatSelfTestInput(args: readonly WireValue[]): string { return args.map(value => JSON.stringify(value)).join('\n'); }
