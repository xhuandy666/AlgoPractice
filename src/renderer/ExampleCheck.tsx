import type { ExampleVerdict } from '../source/statement-examples';
import { HelpHint } from './HelpHint';
import './example-check.css';

export const exampleVerdictLabel: Record<ExampleVerdict, string> = { match: '示例一致', unordered: '顺序不同', different: '示例不同' };
const exampleVerdictTitle: Record<ExampleVerdict, string> = {
  match: '输出与题面给出的示例一致（仅供参考，不等于通过）。',
  unordered: '元素与题面示例相同但顺序不同；若题目允许按任意顺序返回，可视为一致。',
  different: '输出与题面示例不同；答案不唯一的题可能仍然正确。',
};

/** Per-case hint for runs without a trusted expected output. Not a pass: the run itself stays "运行完成". */
export function ExampleBadge({ verdict }: { verdict: ExampleVerdict }) {
  return <span className="example-check" data-verdict={verdict} title={exampleVerdictTitle[verdict]}>{exampleVerdictLabel[verdict]}</span>;
}

export function ExampleSummary({ matched, total }: { matched: number; total: number }) {
  return <span className="result-examples" data-complete={matched === total}>
    示例比对 {matched} / {total}
    <HelpHint label="示例比对说明">仅与题面给出的示例输出比较，结果仅供参考：答案不唯一或允许任意顺序的题，与示例不同也可能正确。是否通过以力扣官方提交为准。</HelpHint>
  </span>;
}
