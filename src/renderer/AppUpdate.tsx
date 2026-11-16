import { useId, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import type { AppUpdateState } from '../shared/update';
import { useAppUpdate } from './useAppUpdate';
import { HelpHint } from './HelpHint';
import { dateTime, errorText } from './ui';
import { runtimeBytes } from './runtime-presentation';
import './app-update.css';

const version = (value: string) => value.startsWith('v') ? value : `v${value}`;
function statusText(state: AppUpdateState): string {
  const latest = state.latestVersion ? version(state.latestVersion) : '新版本';
  switch (state.phase) {
    case 'checking': return '正在检查新版本…';
    case 'available': return `发现 ${latest}，当前为 ${version(state.currentVersion)}。`;
    case 'downloading': return `正在后台下载 ${latest}，可以继续练习。`;
    case 'downloaded': return `${latest} 已下载完成${state.mode === 'installer' ? '。打开安装包将保存并退出题炼，请在安装包中完成更新。' : '，可在方便时重启并更新。'}`;
    case 'installing': return state.mode === 'installer' ? '正在打开安装包…' : '正在准备重启并更新…';
    case 'up-to-date': return `已是最新版本 ${version(state.currentVersion)}。`;
    case 'error': return '更新未完成，可稍后重试。';
    default: return `当前版本 ${version(state.currentVersion)}。`;
  }
}

export function AppUpdateSection({ api }: { api: DesktopBridge | undefined }) {
  const update = useAppUpdate(api), preferenceId = useId();
  const [linkError, setLinkError] = useState('');
  const state = update.state;
  const updating = Boolean(update.action || update.preferenceBusy || (!update.error && state && ['checking', 'downloading', 'installing'].includes(state.phase)));
  const canDownload = state && ['native', 'installer'].includes(state.mode);
  const progress = state?.progress;
  const percent = progress && Number.isFinite(progress.percent) ? Math.min(100, Math.max(0, Math.round(progress.percent))) : undefined;
  const error = update.error || state?.error || linkError;
  return <section className="update-section app-update-section" aria-label="版本与更新">
    <div className="heading-with-help"><h3>版本与更新</h3><HelpHint label="应用更新说明">通过 GitHub 获取正式版本，不上传学习数据。开启自动更新后会在后台检查并下载；安装或重启始终由你决定。</HelpHint></div>
    {!update.supported ? <p className="field-help">当前为源码或界面预览模式，不会自动检查或下载更新。安装正式发行版后可在这里管理更新。</p> : <>
      <label className="runtime-auto-install app-update-preference" htmlFor={preferenceId}>
        <input id={preferenceId} type="checkbox" checked={state?.automatic ?? false} disabled={!state || update.preferenceBusy || !canDownload || update.action === 'install' || state.phase === 'installing'}
          onChange={event => { void update.setAutomatic(event.target.checked); }} />
        <span>自动检查并下载新版本</span>
      </label>
      {state?.mode === 'development' ? <p className="field-help">源码运行模式不会自动检查或下载更新。可手动查看新版本，安装正式发行版后使用自动更新。</p>
        : state?.mode === 'unsupported' ? <p className="field-help">当前安装方式不支持应用内下载，可前往下载页面获取新版本。</p>
          : <p className="field-help">下载在后台进行，完成后会提示你。应用不会自动重启。</p>}
      <p className="app-update-status" role="status">{update.error ? '更新未完成，可稍后重试。' : state ? statusText(state) : update.loading ? '正在读取更新设置…' : '暂时无法读取更新设置。'}</p>
      {state?.phase === 'downloading' && !update.error && <div className="app-update-progress">
        <progress aria-label="应用更新下载进度" max={100} value={percent} />
        {progress && <p className="field-help">{runtimeBytes(progress.transferred)} / {runtimeBytes(progress.total)}{percent === undefined ? '' : ` · ${percent}%`}</p>}
      </div>}
      {error && <p className="runtime-inline-error" role="alert">{error}</p>}
      <div className="button-row">
        <button className="button" disabled={updating || update.loading} onClick={() => { void update.check(); }}>{state?.phase === 'checking' || update.action === 'check' ? '正在检查…' : '检查更新'}</button>
        {state?.phase === 'available' && canDownload && <button className="button primary" disabled={updating} onClick={() => { void update.download(); }}>下载新版本</button>}
        {state?.phase === 'downloaded' && canDownload && <button className="button primary" disabled={updating} onClick={() => { void update.install(); }}>{state.mode === 'installer' ? '打开安装包' : '重启并更新'}</button>}
        {error && <button className="button" disabled={updating} onClick={() => { setLinkError(''); void update.retry(); }}>重试更新</button>}
        {state?.releaseUrl && <button className="text-button" onClick={() => { setLinkError(''); void api?.openWebLink(state.releaseUrl!).catch(error => setLinkError(errorText(error))); }}>查看版本说明与下载页面</button>}
      </div>
      {state?.checkedAt && <p className="field-help">最近检查：{dateTime(state.checkedAt)}{state.publishedAt ? ` · 新版发布：${dateTime(state.publishedAt)}` : ''}</p>}
    </>}
  </section>;
}

/** A quiet notice in the normal app shell. It never opens a dialog, focuses a control, or installs by itself. */
export function AppUpdateNotice({ api, disabled = false }: { api: DesktopBridge | undefined; disabled?: boolean }) {
  const update = useAppUpdate(api);
  const [dismissed, setDismissed] = useState('');
  const state = update.state, key = state ? `${state.currentVersion}:${state.latestVersion}` : '';
  if (!state || !['native', 'installer'].includes(state.mode) || dismissed === key || (!['downloaded', 'installing'].includes(state.phase) && update.failedAction !== 'install')) return null;
  const busy = Boolean(disabled || update.action || update.preferenceBusy || (!update.error && state.phase === 'installing'));
  const error = update.error || state.error;
  return <section className="preview-banner app-update-notice" aria-label="新版本已准备好">
    <div className="app-update-notice-copy"><p role="status">{statusText(state)}</p>{error && <p className="runtime-inline-error" role="alert">{error}</p>}</div>
    <div className="app-update-notice-actions">
      <button className="button primary" disabled={busy} onClick={() => { void update.install(); }}>{state.mode === 'installer' ? '打开安装包' : '重启并更新'}</button>
      <button className="text-button" disabled={Boolean(update.action)} onClick={() => setDismissed(key)}>稍后</button>
    </div>
  </section>;
}
