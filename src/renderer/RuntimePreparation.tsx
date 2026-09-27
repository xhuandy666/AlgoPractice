import { useId } from 'react';
import type { Language } from '../runner/types';
import type { RuntimeProgress } from '../shared/bridge';
import type { RuntimeArtifactInfo, RuntimeState } from '../shared/runtime';
import { runtimeBytes, runtimePhaseLabels, runtimeTransferPercent } from './runtime-presentation';
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
    {committing && <p className="field-help">正在原子切换环境，需完成或回滚到安全状态后才能结束。</p>}
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
    : !state ? `正在检查 ${label} 环境` : state.status === 'missing' ? `先为 ${label} 准备运行环境` : `${label} 环境需要处理`;
  return <section className="runtime-preparation" aria-labelledby={headingId}>
    <div className="runtime-preparation-heading">
      <h3 id={headingId}>{title}</h3>
      <button className="text-button" onClick={onDismiss}>{installing ? '取消待运行请求' : ready ? '收起' : '暂不安装'}</button>
    </div>
    <p className="runtime-preparation-description" role="status" aria-live="polite">
      {ready ? intentCurrent ? '环境准备完成。执行前仍会核对当前草稿与测试输入。' : '草稿或工作区已经变化，请重新点击运行；不会执行之前等待的代码。'
        : installing ? '可以继续读题、编辑和保存。修改代码或切换工作区后，本次等待的代码不会自动运行。'
          : state?.message || '只检查本机环境，此操作不会下载文件。'}
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
        <label className="runtime-auto-install" htmlFor={preferenceId}>
          <input id={preferenceId} type="checkbox" checked={autoInstall} disabled={disabled} onChange={event => onAutoInstallChange(event.target.checked)} />
          <span>允许今后按需自动安装语言环境<small>仅在主动运行且环境缺失时下载，可在环境管理中关闭。</small></span>
        </label>
      </details>
      <p className="field-help">安装到题炼数据目录，不修改系统 PATH。安装完成后可离线运行；本地执行不会自动上传代码，也不是安全沙箱。</p>
    </>}
  </section>;
}
