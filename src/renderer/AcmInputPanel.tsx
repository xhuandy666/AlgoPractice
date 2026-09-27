import { useId, useState } from 'react';
import type { AcmTestCase, AcmTestConfig } from '../shared/answer-format';
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
    <div className="acm-input-heading"><h3 id={`${id}-title`}>标准输入与测试</h3><span>{config.cases.length} / 50 组用例</span></div>
    <p className="acm-input-description">{inputDescription}</p>
    <div className="acm-case-controls">
      <div className="acm-case-picker" role="group" aria-label="选择 ACM 用例">{config.cases.map((_, index) => <button
        key={index} className="text-button" aria-pressed={currentIndex === index} onClick={() => setSelectedIndex(index)}>用例 {index + 1}</button>)}</div>
      <button className="text-button" disabled={disabled || config.cases.length >= 50} onClick={addCase}>新增用例</button>
    </div>
    {current && <fieldset className="acm-case-fields" disabled={disabled}>
      <legend className="acm-case-legend">用例 {currentIndex + 1}</legend>
      <div className="acm-io-fields">
        <div className="acm-io-column">
          <label htmlFor={`${id}-stdin`}>标准输入 stdin <span>可留空；每次运行后关闭输入流（EOF）</span></label>
          <textarea id={`${id}-stdin`} value={current.stdin} rows={4} spellCheck={false} autoCapitalize="off" autoComplete="off" onChange={event => updateCase({ ...current, stdin: event.target.value })} />
        </div>
        {hasExpected && <div className="acm-io-column">
          <label htmlFor={`${id}-expected`}>期望输出 stdout <span>可为空；由你提供，不代表官方判题</span></label>
          <textarea id={`${id}-expected`} value={current.expected ?? ''} rows={4} spellCheck={false} autoCapitalize="off" autoComplete="off" onChange={event => updateCase({ ...current, expected: event.target.value })} />
        </div>}
      </div>
      <label className="acm-expected-toggle" htmlFor={`${id}-compare-output`}>
        <input id={`${id}-compare-output`} type="checkbox" checked={Boolean(hasExpected)} onChange={event => updateCase({ stdin: current.stdin, ...(event.target.checked ? { expected: '' } : {}) })} />
        <span>比较期望输出<small>{hasExpected ? '已启用比较。期望输出为空表示程序应不输出内容。' : '未启用时只展示程序输出，不判定通过或答案错误。'}</small></span>
      </label>
      <div className="acm-case-footer"><p>{outputDescription}</p><button className="text-button" disabled={disabled || config.cases.length <= 1} onClick={removeCase}>删除当前用例</button></div>
    </fieldset>}
    <div className="acm-compare-setting">
      <label htmlFor={`${id}-compare-mode`}>输出比较规则</label>
      <select id={`${id}-compare-mode`} aria-describedby={`${id}-compare-help`} disabled={disabled} value={config.compare} onChange={event => { if (!disabled) onChange({ ...config, compare: event.target.value as AcmTestConfig['compare'] }); }}>
        <option value="normalized">忽略行尾空白</option><option value="exact">严格比较</option>
      </select>
      <p id={`${id}-compare-help`}>{config.compare === 'normalized' ? '统一 CRLF 为 LF，移除每行末尾的空格 / Tab 和输出末尾的换行；其他空白与内容仍参与比较。' : '按完整文本比较，空格、Tab 和换行都必须一致。'}不包含浮点容差、无序输出或多解判定。</p>
    </div>
    <p className="acm-input-note">修改输入、期望输出或比较规则后，旧结果不再代表当前测试。输入输出总量最多 1 MiB。</p>
  </section>;
}
