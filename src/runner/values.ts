import type { Adapter, ValueType, WireValue } from './types.ts';

export function observedType(adapter:Adapter):ValueType {
  if(adapter.inPlaceArg!==undefined){
    const type=adapter.params[adapter.inPlaceArg];
    if(!type || (adapter.returns==='void'&&typeof type==='string'))throw new Error('void requires an observed array/list parameter');
    return type;
  }
  if(adapter.returns==='void')throw new Error('void requires inPlaceArg');
  return adapter.returns;
}

export function validateType(type: ValueType, depth = 0): void {
  if (depth > 8) throw new Error('Type nesting exceeds 8');
  if (typeof type === 'string') { if (!['int','int64','bigint','float','boolean','string','listnode','treenode'].includes(type)) throw new Error('Unsupported value type'); return; }
  if (!type || typeof type !== 'object' || Object.keys(type).length !== 1) throw new Error('Invalid value type');
  if ('array' in type) validateType(type.array, depth + 1); else if ('list' in type) validateType(type.list, depth + 1); else throw new Error('Unsupported collection type');
}
export function validateValue(value: WireValue, type: ValueType): void {
  if (typeof type !== 'string') { if (!Array.isArray(value)) throw new Error('Expected array/list'); for (const v of value) validateValue(v, 'array' in type ? type.array : type.list); return; }
  if (type === 'int64' || type === 'bigint') {
    if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)$/.test(value)) throw new Error(`${type} must use a decimal string, not JS Number`);
    if (type === 'int64' && (BigInt(value) < -(2n ** 63n) || BigInt(value) > 2n ** 63n - 1n)) throw new Error('int64 out of range'); return;
  }
  if (type === 'listnode' || type === 'treenode') {
    if (value === null) return;
    if (!Array.isArray(value) || value.length > 10000) throw new Error('Node input must be an array of at most 10000 nodes');
    for (const v of value) { if (v === null && type === 'treenode') continue; validateValue(v, 'int'); }
    if (type === 'treenode') {
      if(value[0] === null && value.some(v => v !== null)) throw new Error('Tree has values after a null root');
      let slots=value.length && value[0]!==null?2:0;
      for(let i=1;i<value.length;i++){if(slots===0){if(value[i]!==null)throw new Error('Unreachable tree value');}else{slots--;if(value[i]!==null)slots+=2;}}
    } return;
  }
  if (type === 'int' && !(typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)) throw new Error('Expected int32');
  if (type === 'float' && !(typeof value === 'number' && Number.isFinite(value))) throw new Error('Expected finite float');
  if (type === 'boolean' && typeof value !== 'boolean') throw new Error('Expected boolean');
  if (type === 'string' && typeof value !== 'string') throw new Error('Expected string');
}
export function normalizeTyped(value: WireValue, type: ValueType): WireValue {
  if(typeof type !== 'string')return (value as WireValue[]).map(v=>normalizeTyped(v,'array' in type?type.array:type.list));
  if(type==='int64'||type==='bigint')return BigInt(value as string).toString();
  if(type==='listnode')return value??[];
  if(type==='treenode') { const values=[...((value??[]) as WireValue[])];while(values.length&&values.at(-1)===null)values.pop();return values; }
  return value;
}
function key(v: WireValue): string { return JSON.stringify(v); }
function exact(a: WireValue, b: WireValue): boolean { return key(a) === key(b); }
export function compare(actual: WireValue, expected: WireValue, rule: Adapter['compare']): boolean {
  if (!rule || rule.kind === 'exact') return exact(actual, expected);
  if (rule.kind === 'multiset') {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
    return exact(actual.map(key).sort(), expected.map(key).sort());
  }
  const abs = rule.absoluteTolerance ?? 1e-9, rel = rule.relativeTolerance ?? 1e-9;
  if (Array.isArray(actual) && Array.isArray(expected)) return actual.length === expected.length && actual.every((a,i) => compare(a, expected[i], rule));
  return typeof actual === 'number' && typeof expected === 'number' && Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= Math.max(abs, rel * Math.max(Math.abs(actual), Math.abs(expected)));
}
