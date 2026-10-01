import { useId, useState } from 'react';
import type { AcmTestCase, AcmTestConfig } from '../shared/answer-format';
import { HelpHint } from './HelpHint';
import './acm-input.css';

export interface AcmInputPanelProps {
  config: AcmTestConfig;
  onChange: (config: AcmTestConfig) => void;
  disabled: boolean;
  inputDescription: string;
  outputDescription: string;
}

export function AcmInputPanel({ config, onChange, disabled, inputDescription, outputDescription }: AcmInputPanelProps) {
  const id = useId();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const currentIndex = Math.min(selectedIndex, config.cases.length - 1);
  const current = config.cases[currentIndex];
  const hasExpected = current && Object.hasOwn(current, 'expected');
  function updateCase(next: AcmTestCase) {
    if (disabled) return;
    onChange({ ...config, cases: config.cases.map((test, index) => index === currentIndex ? next : test) });
  }
  function addCase() {
    if (disabled || config.cases.length >= 50) return;
    setSelectedIndex(config.cases.length);
    onChange({ ...config, cases: [...config.cases, { stdin: '' }] });
  }
  function removeCase() {
    if (disabled || config.cases.length <= 1) return;
    setSelectedIndex(Math.max(0, currentIndex - 1));
    onChange({ ...config, cases: config.cases.filter((_, index) => index !== currentIndex) });
  }
  return <section className="acm-input-panel" aria-labelledby={`${id}-title`}>
    <div className="acm-input-heading"><div className="heading-with-help"><h3 id={`${id}-title`}>标准输入与测试</h3><HelpHint label="标准输入与测试说明">{inputDescription} {outputDescription} 输入输出总量最多 1 MiB。</HelpHint></div><span>{config.cases.length} / 50 组用例</span></div>
    <div className="acm-case-controls">
      <div className="acm-case-picker" role="group" aria-label="选择 ACM 用例">{config.cases.map((_, index) => <button
        key={index} className="text-button" aria-pressed={currentIndex === index} onClick={() => setSelectedIndex(index)}>用例 {index + 1}</button>)}</div>
      <button className="text-button" disabled={disabled || config.cases.length >= 50} onClick={addCase}>新增用例</button>
    </div>
    {current && <fieldset className="acm-case-fields" disabled={disabled}>
      <legend className="acm-case-legend">用例 {currentIndex + 1}</legend>
      <div className="acm-io-fields">
        <div className="acm-io-column">
          <label htmlFor={`${id}-stdin`}>标准输入 stdin</label>
          <textarea id={`${id}-stdin`} value={current.stdin} rows={4} spellCheck={false} autoCapitalize="off" autoComplete="off" onChange={event => updateCase({ ...current, stdin: event.target.value })} />
        </div>
        {hasExpected && <div className="acm-io-column">
          <label htmlFor={`${id}-expected`}>期望输出 stdout</label>
          <textarea id={`${id}-expected`} value={current.expected ?? ''} rows={4} spellCheck={false} autoCapitalize="off" autoComplete="off" onChange={event => updateCase({ ...current, expected: event.target.value })} />
        </div>}
      </div>
      <label className="acm-expected-toggle" htmlFor={`${id}-compare-output`}>
        <input id={`${id}-compare-output`} type="checkbox" checked={Boolean(hasExpected)} onChange={event => updateCase({ stdin: current.stdin, ...(event.target.checked ? { expected: '' } : {}) })} />
        <span>比较期望输出<small>{hasExpected ? '留空表示程序不输出内容' : '仅展示输出，不判定通过'}</small></span>
      </label>
      <div className="acm-case-footer"><button className="text-button" disabled={disabled || config.cases.length <= 1} onClick={removeCase}>删除当前用例</button></div>
    </fieldset>}
    <div className="acm-compare-setting">
      <label htmlFor={`${id}-compare-mode`}>输出比较规则</label>
      <select id={`${id}-compare-mode`} aria-describedby={`${id}-compare-help`} disabled={disabled} value={config.compare} onChange={event => { if (!disabled) onChange({ ...config, compare: event.target.value as AcmTestConfig['compare'] }); }}>
        <option value="normalized">忽略行尾空白</option><option value="exact">严格比较</option>
      </select>
      <HelpHint id={`${id}-compare-help`} label="输出比较规则说明">{config.compare === 'normalized' ? '统一换行，忽略行尾空格、Tab 和末尾换行；其他内容仍参与比较。' : '空格、Tab 和换行都必须一致。'}不支持浮点容差、无序或多解判定；本地通过不等于官方 AC。</HelpHint>
    </div>
  </section>;
}
