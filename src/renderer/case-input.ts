import type { ProblemAdapter, TestCase, WireValue } from '../runner/types.ts';
import type { ProblemContent } from '../shared/library.ts';
import { templateParameterNames } from '../source/statement-examples.ts';

/** One line of a case's input: a named function argument, or (without a name) the whole stdin of an ACM case. */
export interface CaseInputRow { name?: string; value: string }
/** Inputs are shown to explain a result, not to be copied back in full; longer text ends with an ellipsis. */
export const CASE_INPUT_DISPLAY_LIMIT = 2000;
const clipped = (value: string) => value.length > CASE_INPUT_DISPLAY_LIMIT ? `${value.slice(0, CASE_INPUT_DISPLAY_LIMIT)}…` : value;

/** The case to open after a run: the first one that failed for any reason. Passed and unjudged cases stay folded. */
export function firstFailedCase(cases: readonly { index: number; status: string }[]): number | null {
  return cases.find(test => test.status !== 'passed' && test.status !== 'completed')?.index ?? null;
}

/** What was passed to the solution for one case, in the notation the statement uses (`nums = [2,7,11,15]`).
 * Design problems return null: their step table already lists every call with its arguments. */
export function caseInputRows(source: { mode: ProblemContent['mode']; adapter?: ProblemAdapter; starter?: ProblemContent['starter']; cases: readonly TestCase[] }, index: number): CaseInputRow[] | null {
  const test = source.cases[index]; if (!test) return null;
  if (source.mode === 'acm') return typeof test.stdin === 'string' ? [{ value: clipped(test.stdin) }] : null;
  const adapter = source.adapter; if (!adapter || adapter.kind === 'design' || !Array.isArray(test.args) || test.args.length !== adapter.params.length) return null;
  const names = source.starter ? templateParameterNames(source.starter, adapter.method, adapter.params.length) : null;
  return test.args.map((value: WireValue, position) => ({ name: names?.[position] ?? `参数 ${position + 1}`, value: clipped(JSON.stringify(value)) }));
}
