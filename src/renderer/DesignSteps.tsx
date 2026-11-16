import type { DesignStepRow } from './design-steps';
import { formatValue } from './ui';
import './design-steps.css';

const SHOWN = 200;

/** Step-by-step view of a design case: each call with what it returned, and the first value that differs from the
 * expected output (or the statement example, which is only a hint). */
export function DesignSteps({ rows, referenceLabel }: { rows: DesignStepRow[]; referenceLabel: '期望' | '示例' }) {
  const first = rows.find(row => row.differs);
  return <div className="design-steps">
    {first && <p className="design-steps-first">第 {first.index + 1} 步 <code>{first.call}</code>：实际 {formatValue(first.actual)}，{referenceLabel} {formatValue(first.reference)}</p>}
    <ol>
      {rows.slice(0, SHOWN).map(row => <li key={row.index} data-differs={row.differs || undefined}>
        <code>{row.call}</code>
        {row.returns && row.actual !== undefined && <span className="design-step-value">→ {formatValue(row.actual)}</span>}
        {row.differs && <span className="design-step-reference">{referenceLabel} {formatValue(row.reference)}</span>}
      </li>)}
    </ol>
    {rows.length > SHOWN && <p className="field-help">其余 {rows.length - SHOWN} 步未展开。</p>}
  </div>;
}
