import type { Adapter, ProblemAdapter, WireValue } from '../runner/types.ts';
import { compare, containsValueType, normalizeTyped, observedType } from '../runner/values.ts';
import { compareDesign, designCaseKey, designSteps, isDesignAdapter } from '../runner/design.ts';
import type { ProblemContent } from '../shared/library.ts';
import { argumentKey, designStatementOutputs, statementOutputs } from './problem-content.ts';

// Most imported LeetCode problems have no trusted expected output, so a run can only end as "completed". The
// statement's own examples still tell the user something useful. This module recovers them from content that is
// already stored (statement HTML + starter templates), so existing libraries need no re-import. The result is a
// hint shown next to the run, never `expected`, never `passed`, and never AI evidence or experience.

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split a parameter list on top-level commas; generic, index and call brackets may contain commas. */
function splitParameters(list: string): string[] {
  const parts: string[] = []; let depth = 0, current = '';
  for (const char of list) {
    if ('<[({'.includes(char)) depth++;
    else if ('>])}'.includes(char)) depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

type Reader = { template: (starter: ProblemContent['starter']) => string | undefined; signature: (method: string) => RegExp; name: (parameter: string) => string };
const READERS: readonly Reader[] = [
  // def twoSum(self, nums: List[int], target: int) -> List[int]:
  { template: starter => starter.python, signature: method => new RegExp(`def\\s+${method}\\s*\\(\\s*self\\s*,?([^)]*)\\)`), name: parameter => parameter.split(/[:=]/)[0].trim() },
  // public int[] twoSum(int[] nums, int target) / List<List<Integer>> threeSum(int[] nums) / int f(int nums[])
  { template: starter => starter.java, signature: method => new RegExp(`\\b${method}\\s*\\(([^)]*)\\)`), name: parameter => (parameter.split('=')[0].trim().split(/\s+/).at(-1) ?? '').replace(/\[\]/g, '') },
  // func twoSum(nums []int, target int) []int / func f(a, b int)
  { template: starter => starter.go, signature: method => new RegExp(`func\\s+${method}\\s*\\(([^)]*)\\)`), name: parameter => parameter.trim().split(/\s+/)[0] },
  // vector<int> twoSum(vector<int>& nums, int target)
  { template: starter => starter.cpp, signature: method => new RegExp(`\\b${method}\\s*\\(([^)]*)\\)`), name: parameter => (parameter.split('=')[0].replace(/[&*]/g, ' ').trim().split(/\s+/).at(-1) ?? '').replace(/\[\]/g, '') },
];

/** Parameter names in declaration order from the first starter template that parses unambiguously, else null. */
export function templateParameterNames(starter: ProblemContent['starter'], method: string, count: number): string[] | null {
  if (!IDENTIFIER.test(method)) return null;
  for (const reader of READERS) {
    const template = reader.template(starter); if (!template) continue;
    const match = reader.signature(escapeRegExp(method)).exec(template); if (!match) continue;
    const names = splitParameters(match[1]).map(reader.name);
    if (names.length === count && names.every(name => IDENTIFIER.test(name)) && new Set(names).size === names.length) return names;
  }
  return null;
}

/** For each stored case, the statement's example output for exactly those arguments (undefined when the statement
 * has none or is ambiguous). Null when the problem cannot be read this way at all. */
export function statementExampleOutputs(content: ProblemContent): Array<WireValue | undefined> | null {
  const adapter = content.adapter;
  if (content.mode !== 'function' || !adapter || content.descriptionFormat !== 'html' || !content.description || !content.cases.length) return null;
  let outputs: Map<string, WireValue>, key: (args: WireValue[]) => string;
  if (isDesignAdapter(adapter)) { outputs = designStatementOutputs(content.description, adapter); key = args => designCaseKey(args, adapter); }
  else {
    const names = templateParameterNames(content.starter, adapter.method, adapter.params.length); if (!names) return null;
    outputs = statementOutputs(content.description, names, adapter); key = args => argumentKey(args, adapter);
  }
  if (!outputs.size) return null;
  const examples = content.cases.map(test => {
    if (!test.args) return undefined;
    try { return outputs.get(key(test.args)); } catch { return undefined; }
  });
  return examples.some(value => value !== undefined) ? examples : null;
}

export type ExampleVerdict = 'match' | 'unordered' | 'different';
const EXAMPLE_FLOAT = { kind: 'float' as const, absoluteTolerance: 1e-5, relativeTolerance: 1e-5 };
/** Exact after normalization (floats within 1e-5), with an order-insensitive second look for returned arrays.
 * Design problems compare value by value against the case's own operations (`args`) and never look at order. */
export function compareWithExample(actual: WireValue | undefined, example: WireValue, problemAdapter: ProblemAdapter, args?: WireValue[]): ExampleVerdict {
  if (actual === undefined) return 'different';
  if (isDesignAdapter(problemAdapter)) {
    try { return compareDesign(actual, example, designSteps(problemAdapter, args), problemAdapter.compare ?? EXAMPLE_FLOAT) ? 'match' : 'different'; } catch { return 'different'; }
  }
  const adapter: Adapter = problemAdapter;
  const type = observedType(adapter);
  let normalizedActual: WireValue, normalizedExample: WireValue;
  try { normalizedActual = normalizeTyped(actual, type); normalizedExample = normalizeTyped(example, type); } catch { return 'different'; }
  const rule = adapter.compare ?? (containsValueType(type, 'float') ? EXAMPLE_FLOAT : undefined);
  if (compare(normalizedActual, normalizedExample, rule)) return 'match';
  // In-place problems rearrange their argument, so the same elements in another order is exactly the failure to
  // report (an untouched array would otherwise look "unordered").
  if (adapter.inPlaceArg === undefined && Array.isArray(normalizedActual) && Array.isArray(normalizedExample) && compare(normalizedActual, normalizedExample, { kind: 'multiset' })) return 'unordered';
  return 'different';
}
