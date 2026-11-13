import type { DesignAdapter, DesignMethod, ProblemAdapter, WireValue } from './types.ts';
import { compare, containsValueType, normalizeTyped, validateType, validateValue } from './values.ts';

// LeetCode "design" problems (LRUCache, MinStack, Trie…) construct a class and call its methods in order. Drivers
// generate straight-line code per case, so the bounds below also bound the generated source.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const DESIGN_LIMITS = { methods: 50, params: 20, operations: 1000 } as const;

export function isDesignAdapter(adapter: ProblemAdapter | null | undefined): adapter is DesignAdapter {
  return typeof adapter === 'object' && adapter !== null && (adapter as { kind?: unknown }).kind === 'design';
}
/** Go exports methods with a leading capital (obj.GetMin for getMin). */
export const goMethodName = (name: string) => name[0].toUpperCase() + name.slice(1);

/** Throws unless the adapter is well formed. Names are spliced into generated Python/Java/Go/C++ source, so they must
 * be plain identifiers; methods are unique (also as Go names) and never named like the class. */
export function validateDesignAdapter(adapter: DesignAdapter): void {
  if (!adapter || adapter.kind !== 'design' || typeof adapter.className !== 'string' || !IDENTIFIER.test(adapter.className)) throw new Error('Design adapter requires a valid class name');
  if (!Array.isArray(adapter.constructorParams) || adapter.constructorParams.length > DESIGN_LIMITS.params) throw new Error('Invalid design constructor parameters');
  adapter.constructorParams.forEach(type => validateType(type));
  if (!Array.isArray(adapter.methods) || !adapter.methods.length || adapter.methods.length > DESIGN_LIMITS.methods) throw new Error('Design adapter requires 1-50 methods');
  const names = new Set<string>();
  for (const method of adapter.methods) {
    if (!method || typeof method.name !== 'string' || !IDENTIFIER.test(method.name) || method.name === adapter.className || names.has(goMethodName(method.name))) throw new Error('Invalid or duplicate design method name');
    names.add(goMethodName(method.name));
    if (!Array.isArray(method.params) || method.params.length > DESIGN_LIMITS.params) throw new Error('Invalid design method parameters');
    method.params.forEach(type => validateType(type)); if (method.returns !== 'void') validateType(method.returns);
  }
  if (adapter.compare !== undefined) {
    if (adapter.compare.kind !== 'float') throw new Error('Design adapters only take a float tolerance');
    for (const n of [adapter.compare.absoluteTolerance, adapter.compare.relativeTolerance]) if (n !== undefined && (!Number.isFinite(n) || n < 0)) throw new Error('Tolerance must be finite and nonnegative');
  }
}

/** One operation of a case; step 0 is the constructor and returns nothing. */
export interface DesignStep extends DesignMethod { args: WireValue[]; }
/** The typed steps of one case. Throws on any mismatch with the adapter, so drivers only ever see valid calls. */
export function designSteps(adapter: DesignAdapter, args: WireValue[] | undefined): DesignStep[] {
  if (!Array.isArray(args) || args.length !== 2) throw new Error('A design case takes [operations, arguments]');
  const [operations, values] = args;
  if (!Array.isArray(operations) || !Array.isArray(values) || operations.length !== values.length) throw new Error('Design operations and arguments must be arrays of the same length');
  if (!operations.length || operations.length > DESIGN_LIMITS.operations) throw new Error(`Design cases take 1-${DESIGN_LIMITS.operations} operations`);
  // A Map, never an object: operation names come from data and must not reach inherited keys such as "constructor".
  const methods = new Map(adapter.methods.map(method => [method.name, method]));
  return operations.map((operation, index) => {
    const call = values[index];
    if (typeof operation !== 'string' || !Array.isArray(call)) throw new Error('Invalid design operation');
    const method: DesignMethod | undefined = index === 0
      ? operation === adapter.className ? { name: operation, params: adapter.constructorParams, returns: 'void' } : undefined
      : methods.get(operation);
    if (!method) throw new Error(index === 0 ? 'The first operation must construct the class' : `Unknown design method: ${operation}`);
    if (call.length !== method.params.length) throw new Error(`Argument count mismatch for ${operation}`);
    call.forEach((value, i) => validateValue(value, method.params[i]));
    return { ...method, args: call };
  });
}
/** A driver's output (or an expected output) lists one value per operation, null where nothing is returned. */
export function validateDesignOutput(value: WireValue, steps: readonly DesignStep[]): void {
  if (!Array.isArray(value) || value.length !== steps.length) throw new Error('Design output must list one value per operation');
  steps.forEach((step, i) => {
    if (step.returns === 'void') { if (value[i] !== null) throw new Error(`${step.name} returns nothing`); }
    else validateValue(value[i], step.returns);
  });
}
/** Element by element after normalization; the float tolerance applies only to float-returning methods. */
export function compareDesign(actual: WireValue, expected: WireValue, steps: readonly DesignStep[], rule?: DesignAdapter['compare']): boolean {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== steps.length || expected.length !== steps.length) return false;
  return steps.every((step, i) => {
    if (step.returns === 'void') return actual[i] === null && expected[i] === null;
    const a = normalizeTyped(actual[i], step.returns), e = normalizeTyped(expected[i], step.returns);
    return compare(a, e, rule && containsValueType(step.returns, 'float') ? rule : undefined);
  });
}
/** Identity of a case's input, used to pair cases with statement examples. */
export function designCaseKey(args: WireValue[], adapter: DesignAdapter): string {
  const steps = designSteps(adapter, args);
  return JSON.stringify([steps.map(step => step.name), steps.map(step => step.args.map((value, i) => normalizeTyped(value, step.params[i])))]);
}
