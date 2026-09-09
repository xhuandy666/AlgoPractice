import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge, EnvironmentInfo, RuntimeProgress } from '../shared/bridge';
import { errorText } from './ui';

const phaseLabels: Record<RuntimeProgress['phase'], string> = {
  download: '正在下载', copy: '正在读取离线包', verify: '正在校验', extract: '正在解压',
  validate: '正在验证运行时', commit: '正在启用', ready: '已安装',
};

export function EnvironmentPage({ api, onChanged, onError }: {
  api: DesktopBridge | undefined; onChanged: () => void; onError: (message: string) => void;
}) {
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [installation, setInstallation] = useState<EnvironmentInfo['installation']>(null);
  const [startingLanguage, setStartingLanguage] = useState<RuntimeProgress['language'] | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const mounted = useRef(false);
  const currentInstallation = useRef<EnvironmentInfo['installation']>(null);
  const callbacks = useRef({ onChanged, onError });
  callbacks.current = { onChanged, onError };

  const refreshEnvironment = useCallback(async (notifyChanged = false) => {
    if (!api) return;
    const snapshot = await api.environment();
    const nextInstallation = snapshot.installation ?? null;
    const installationFinished = Boolean(currentInstallation.current) && !nextInstallation;
    if (mounted.current) {
      currentInstallation.current = nextInstallation;
      setEnvironment(snapshot);
      setInstallation(nextInstallation);
      if (!nextInstallation) setCancelling(false);
    }
    if (notifyChanged || installationFinished) callbacks.current.onChanged();
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    if (!api) return () => { mounted.current = false; };
    let refreshing = false;
    let reportedError = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try { await refreshEnvironment(); reportedError = false; }
      catch (error) {
        if (mounted.current && !reportedError) callbacks.current.onError(errorText(error));
        reportedError = true;
      } finally { refreshing = false; }
    };
    const stopProgress = api.onRuntimeProgress(progress => {
      if (!mounted.current) return;
      const next = { language: progress.language, progress };
      currentInstallation.current = next;
      setInstallation(next);
      if (progress.phase === 'ready') void refresh();
    });
    void refresh();
    // Poll only this page's environment; App is notified after a real change.
    const timer = setInterval(() => { void refresh(); }, 1000);
    return () => { mounted.current = false; clearInterval(timer); stopProgress(); };
  }, [api, refreshEnvironment]);

  async function environmentAction(action: () => Promise<void>, starting?: RuntimeProgress['language']) {
    setBusyAction(true);
    if (starting) setStartingLanguage(starting);
    try { await action(); }
    catch (error) { callbacks.current.onError(errorText(error)); }
    finally {
      if (mounted.current) { setBusyAction(false); setStartingLanguage(null); }
      try { await refreshEnvironment(true); }
      catch (error) { callbacks.current.onError(errorText(error)); }
    }
  }

  async function cancelInstallation() {
    if (!api || cancelling) return;
    setCancelling(true);
    try { await api.cancelInstall(); await refreshEnvironment(); }
    catch (error) { setCancelling(false); callbacks.current.onError(errorText(error)); }
  }

  const activeInstallation = installation ?? (startingLanguage ? { language: startingLanguage, progress: null } : null);
  const busyEnvironment = busyAction || Boolean(activeInstallation);
  const progress = activeInstallation?.progress;
  const percentage = progress && progress.totalBytes > 0 && Number.isFinite(progress.receivedBytes / progress.totalBytes)
    ? `${Math.min(100, Math.max(0, Math.round(progress.receivedBytes / progress.totalBytes * 100)))}%` : '';
  const notices = (environment?.runtimeNotices ?? []).filter(notice => notice.trim());

  return <section className="settings-page">
    <h2>把练习环境准备好。</h2>
    <p className="lede">Python 与 Java 使用应用管理的独立目录，也可以选择已有的解释器或 JDK。不会修改系统 PATH。</p>
    <div className="environment-rows">{(['python', 'java'] as const).map(lang => <div className="environment-row" key={lang}>
      <div><h3>{lang === 'python' ? 'Python 3.14' : 'Java 25'}</h3><p>{environment?.[lang] || '尚未配置运行时'}</p></div>
      <div className="button-row">
        <button className="button" disabled={!api || busyEnvironment} onClick={() => environmentAction(() => api!.installRuntime(lang), lang)}>
          {activeInstallation?.language === lang ? '正在安装…' : busyAction ? '正在处理…' : '安装托管运行时'}
        </button>
        <button className="text-button" disabled={!api || busyEnvironment} onClick={() => environmentAction(() => api!.installRuntime(lang, true))}>安装离线包</button>
        <button className="text-button" disabled={!api || busyEnvironment} onClick={() => environmentAction(() => api!.setRuntime(lang))}>选择本机路径</button>
      </div>
    </div>)}</div>
    {notices.length > 0 && <div className="note-row" role="status">{notices.map((notice, index) => <p key={`${index}:${notice}`}>{notice}</p>)}</div>}
    <div className="note-row">
      {activeInstallation && <p role="status">
        {activeInstallation.language === 'python' ? 'Python' : 'Java'} · {progress ? phaseLabels[progress.phase] : '正在准备安装…'} {percentage}
        <button className="text-button" disabled={!api || cancelling} onClick={() => void cancelInstallation()}>{cancelling ? '正在取消…' : '取消安装'}</button>
      </p>}
      <strong>托管运行时安装</strong>
      <p>点击安装后下载固定版本，并校验 SHA-256。首次下载通常需要数分钟；完成后无需联网即可运行本地样例。</p>
    </div>
    <section className="reminder-section">
      <h3>后台提醒验证</h3>
      <p>创建一条 10 秒后的测试提醒，然后关闭窗口。应用留在菜单栏 / 托盘；完全退出后暂停提醒，下次启动保留逾期状态。</p>
      <div className="button-row">
        <button className="button" disabled={!api || busyEnvironment} onClick={() => environmentAction(() => api!.notifyAfter(10))}>创建测试提醒</button>
        <button className="button" disabled={!api || busyEnvironment || !environment?.reminder} onClick={() => environmentAction(() => api!.clearReminder())}>清除测试提醒</button>
        <button className="text-button" onClick={() => refreshEnvironment(true).catch(error => onError(errorText(error)))}>刷新状态</button>
      </div>
      <p className="field-help" role="status">{environment?.reminder ? `测试提醒：${new Date(environment.reminder.dueAt).toLocaleString('zh-CN')}${environment.reminder.deliveredAt ? ' · 已请求系统投递' : new Date(environment.reminder.dueAt).getTime() <= Date.now() ? ' · 已逾期' : ' · 等待到期'}` : '尚未安排测试提醒。'}系统是否显示通知受通知权限与专注模式影响。</p>
    </section>
    <dl className="system-details">
      <dt>当前环境</dt><dd>{environment ? `${environment.platform} / ${environment.arch}` : '桌面环境未连接'}</dd>
      <dt>应用组件</dt><dd>{environment ? `Electron ${environment.electron} · Node ${environment.node} · SQLite ${environment.sqlite}` : '—'}</dd>
      <dt>数据目录</dt><dd>{environment?.dataDirectory || '—'}</dd>
    </dl>
  </section>;
}
