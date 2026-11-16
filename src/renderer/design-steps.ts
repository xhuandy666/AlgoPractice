import type { DesignAdapter, WireValue } from '../runner/types';
import { compareDesign, designSteps } from '../runner/design';

/** One row per operation of a design case, as the statement writes it: "LRUCache(2)", "put(1, 1)", "get(1)". */
export interface DesignStepRow { index: number; call: string; returns: boolean; actual?: WireValue; reference?: WireValue; differs: boolean }

/** Rows for a design case, pairing each call with its observed value and, when known, the value to compare with
 * (the trusted expected output or a statement example). Null when the case does not fit the adapter. */
export function designStepRows(adapter: DesignAdapter, args: WireValue[] | undefined, actual: WireValue | undefined, reference: WireValue | undefined): DesignStepRow[] | null {
  let steps;
  try { steps = designSteps(adapter, args); } catch { return null; }
  const observed = Array.isArray(actual) && actual.length === steps.length ? actual : null;
  const wanted = Array.isArray(reference) && reference.length === steps.length ? reference : null;
  const rule = adapter.compare ?? { kind: 'float' as const, absoluteTolerance: 1e-5, relativeTolerance: 1e-5 };
  return steps.map((step, index) => {
    const returns = step.returns !== 'void';
    let differs = false;
    if (returns && observed && wanted) {
      try { differs = !compareDesign([observed[index]], [wanted[index]], [step], rule); } catch { differs = true; }
    }
    return { index, call: `${step.name}(${step.args.map(value => JSON.stringify(value)).join(', ')})`, returns,
      ...(observed ? { actual: observed[index] } : {}), ...(wanted ? { reference: wanted[index] } : {}), differs };
  });
}
