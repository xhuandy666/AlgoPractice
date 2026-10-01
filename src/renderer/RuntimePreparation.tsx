import { useId } from 'react';
import type { Language } from '../runner/types';
import type { RuntimeProgress } from '../shared/bridge';
import type { RuntimeArtifactInfo, RuntimeState } from '../shared/runtime';
import { runtimeBytes, runtimePhaseLabels, runtimeTransferPercent } from './runtime-presentation';
import { HelpHint } from './HelpHint';
import './runtime-preparation.css';

export interface RuntimePreparationProps {
  language: Language;
  state: RuntimeState | null;
  progress?: RuntimeProgress | null;
  installing?: boolean;
  autoInstall: boolean;
  intentCurrent: boolean;
  busy?: boolean;
  cancelling?: boolean;
  error?: string | null;
  onInstall: () => void;
  onSelect: () => void;
  onOffline: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  onAutoInstallChange: (enabled: boolean) => void;
}

export function RuntimeArtifactDetails({ artifact }: { artifact: RuntimeArtifactInfo | null }) {
  if (!artifact) return <p className="field-help">当前平台没有可用的托管下载包。仍可选择符合兼容要求的本机环境。</p>;
  return <dl className="runtime-artifact-details">
    <div><dt>托管版本</dt><dd>{artifact.version}</dd></div>
    <div><dt>下载来源</dt><dd>{artifact.source}</dd></div>
    <div><dt>下载大小</dt><dd>{runtimeBytes(artifact.downloadBytes)}</dd></div>
    <div><dt>预计安装占用</dt><dd>{runtimeBytes(artifact.expandedBytes)}</dd></div>
    <div><dt>安装峰值空间</dt><dd>{runtimeBytes(artifact.peakBytes)}</dd></div>
  </dl>;
}

export function RuntimeInstallProgress({ language, progress, cancelling, onCancel }: {
  language: Language; progress: RuntimeProgress | null; cancelling: boolean; onCancel: () => void;
}) {
  const label = language === 'python' ? 'Python' : 'Java';
  const phase = progress?.phase;
  const percentage = runtimeTransferPercent(progress);
  const committing = phase === 'commit';
  const ready = phase === 'ready';
  return <div className="runtime-install-progress">
    <div className="runtime-progress-heading">
      <p role="status" aria-live="polite" aria-atomic="true">
        <strong>{label} · {progress ? runtimePhaseLabels[progress.phase] : '正在准备安装'}</strong>
        {cancelling && <span> · 正在取消并安全收尾</span>}
      </p>
      {!ready && <button className="text-button" disabled={cancelling || committing} onClick={onCancel}>
        {committing ? '安全收尾中' : cancelling ? '正在取消…' : '取消安装'}
      </button>}
    </div>
    {!ready && <progress className="runtime-progress-bar" aria-label={`${label} ${progress ? runtimePhaseLabels[progress.phase] : '准备进度'}`} max={100} value={percentage} />}
    {percentage !== undefined && progress && <p className="runtime-transfer-count" aria-hidden="true">{runtimeBytes(progress.receivedBytes)} / {runtimeBytes(progress.totalBytes)} · {phase === 'copy' ? '读取' : '下载'} {percentage}%</p>}
    {committing && <p className="field-help">正在完成安装，暂时无法取消。</p>}
  </div>;
}

/** This component never starts a run. The workbench owns and revalidates the pending intent. */
export function RuntimePreparation(props: RuntimePreparationProps) {
  const { language, state, progress = null, installing = false, autoInstall, intentCurrent, busy = false, cancelling = false, error,
    onInstall, onSelect, onOffline, onCancel, onDismiss, onAutoInstallChange } = props;
  const headingId = useId();
  const preferenceId = useId();
  const label = language === 'python' ? 'Python' : 'Java';
  const ready = state?.status === 'ready' && !installing;
  const disabled = busy || installing;
  const title = installing ? `正在准备 ${label} 环境` : ready ? `${label} 已就绪`
    : !state ? `正在检查 ${label} 环境` : state.status === 'missing' ? `${label} 运行环境未就绪` : `${label} 环境需要处理`;
  return <section className="runtime-preparation" aria-labelledby={headingId}>
    <div className="runtime-preparation-heading">
      <div className="heading-with-help"><h3 id={headingId}>{title}</h3><HelpHint label="环境安装说明">安装到题炼独立目录，不修改系统 PATH。安装后可离线运行；也可选择本机兼容环境或导入匹配的离线包。</HelpHint></div>
      <button className="text-button" onClick={onDismiss}>{installing ? '取消待运行请求' : ready ? '收起' : '暂不安装'}</button>
    </div>
    <p className="runtime-preparation-description" role="status" aria-live="polite">
      {ready ? intentCurrent ? '环境准备完成' : '草稿或工作区已变化，请重新点击运行。'
        : installing ? '修改代码或切换工作区后，本次等待的代码不会自动运行。'
          : state?.message || '正在检查本机环境…'}
    </p>
    {error && <p className="runtime-inline-error" role="alert">{error}</p>}
    {installing && <RuntimeInstallProgress language={language} progress={progress} cancelling={cancelling} onCancel={onCancel} />}
    {!installing && !ready && state && <>
      <RuntimeArtifactDetails artifact={state.artifact} />
      <div className="runtime-preparation-actions">
        <button className="button primary" disabled={disabled || !state.artifact} onClick={onInstall}>{error ? '重试安装' : intentCurrent ? '安装并运行' : '安装环境'}</button>
        <button className="button" disabled={disabled} onClick={onSelect}>使用已有环境</button>
      </div>
      <details className="runtime-more-options">
        <summary>更多安装选项</summary>
        <button className="text-button" disabled={disabled || !state.artifact} onClick={onOffline}>导入匹配的离线包</button>
        <div className="control-with-help"><label className="runtime-auto-install" htmlFor={preferenceId}>
          <input id={preferenceId} type="checkbox" checked={autoInstall} disabled={disabled} onChange={event => onAutoInstallChange(event.target.checked)} />
          <span>运行时自动安装缺失的语言环境</span>
        </label><HelpHint label="自动安装偏好说明">仅在主动运行且环境缺失时下载，可在运行环境设置中关闭。</HelpHint></div>
      </details>
      <p className="field-help">本地运行不会上传代码，但不是安全沙箱。请只运行可信代码。</p>
    </>}
  </section>;
}
