import type { CaseResult, WireValue } from '../runner/types';
import type { ExampleVerdict } from '../source/statement-examples';
import { firstFailedCase, type CaseInputRow } from './case-input';
import { DesignSteps } from './DesignSteps';
import type { designStepRows } from './design-steps';
import { ExampleBadge } from './ExampleCheck';
import { formatValue, statusClass, statusText } from './ui';

/** The per-case list under a run's summary. The first failed case opens by itself with its input, so a wrong answer
 * can be read without unfolding anything or going back to the statement. Mount it keyed by the run, so the next run
 * folds everything again and opens its own first failure. */
export function CaseResults({ cases, inputOf, verdicts, exampleOf, designRowsOf }: {
  cases: readonly CaseResult[]; inputOf: (index: number) => CaseInputRow[] | null; verdicts: ReadonlyMap<number, ExampleVerdict>;
  exampleOf: (test: CaseResult) => WireValue | undefined; designRowsOf: (test: CaseResult) => ReturnType<typeof designStepRows> | null;
}) {
  const failed = firstFailedCase(cases);
  return <div className="case-list">{cases.map(test => {
    const rows = designRowsOf(test), input = inputOf(test.index), example = exampleOf(test);
    return <details className="case-detail" key={test.index} data-status={test.status} open={test.index === failed || undefined}>
      <summary><span>用例 {test.index + 1}</span><span className={statusClass(test.status)}>{statusText[test.status]}</span>{verdicts.has(test.index) ? <span className="case-preview"><ExampleBadge verdict={verdicts.get(test.index)!} /><code>{formatValue(test.actual).slice(0, 120)}</code></span> : <code>{formatValue(test.actual).slice(0, 120)}</code>}</summary>
      <dl>
        {input && <><dt>输入</dt><dd className="case-input">{input.map((row, position) => <pre key={position}>{row.name ? `${row.name} = ` : ''}{row.value}</pre>)}</dd></>}
        {rows && <><dt>逐步结果</dt><dd><DesignSteps rows={rows} referenceLabel={test.expected !== undefined ? '期望' : '示例'} /></dd></>}
        <dt>实际输出</dt><dd><pre>{formatValue(test.actual)}</pre></dd><dt>期望输出</dt><dd><pre>{formatValue(test.expected)}</pre></dd>
        {example !== undefined && <><dt>示例输出</dt><dd><pre>{formatValue(example)}</pre></dd></>}
        {test.stdout && <><dt>标准输出</dt><dd><pre>{test.stdout}</pre></dd></>}{test.stderr && <><dt>标准错误</dt><dd><pre>{test.stderr}</pre></dd></>}
      </dl>
    </details>;
  })}</div>;
}
