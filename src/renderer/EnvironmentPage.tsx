import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { Language } from '../runner/types';
import type { DesktopBridge, EnvironmentInfo, RuntimeProgress } from '../shared/bridge';
import { errorText } from './ui';
import { getPerformanceState, performanceReport, startPerformanceRecording, stopPerformanceRecording, subscribePerformance } from './performance-monitor';
import { RuntimeArtifactDetails, RuntimeInstallProgress } from './RuntimePreparation';
import { runtimeBytes, runtimeSourceLabels } from './runtime-presentation';

type Installations = Partial<Record<Language, { progress: RuntimeProgress | null }>>;
type LanguageMessages = Partial<Record<Language, string>>;

export function EnvironmentPage({ api, onChanged, onError }: {
  api: DesktopBridge | undefined; onChanged: () => void; onError: (message: string) => void;
}) {
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);
  const [actions, setActions] = useState<LanguageMessages>({});
  const [errors, setErrors] = useState<LanguageMessages>({});
  const [installations, setInstallations] = useState<Installations>({});
  const [starting, setStarting] = useState<Partial<Record<Language, boolean>>>({});
  const [cancelling, setCancelling] = useState<Partial<Record<Language, boolean>>>({});
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [preferenceError, setPreferenceError] = useState('');
  const [reminderBusy, setReminderBusy] = useState(false);
  const performanceState = useSyncExternalStore(subscribePerformance, getPerformanceState);
  const [performanceNotice, setPerformanceNotice] = useState('');
  const preferenceId = useId();
  const mounted = useRef(false);
  const currentInstallations = useRef<Installations>({});
  const actionLocks = useRef(new Set<Language>());
  const snapshotGeneration = useRef(0);
  const callbacks = useRef({ onChanged, onError });
  callbacks.current = { onChanged, onError };

  const refreshEnvironment = useCallback(async (notifyChanged = false) => {
    if (!api) return;
    const generation = ++snapshotGeneration.current;
    const snapshot = await api.environment();
    if (!mounted.current || generation !== snapshotGeneration.current) return;
    const next = snapshot.installations ?? (snapshot.installation ? { [snapshot.installation.language]: { progress: snapshot.installation.progress } } : {});
    const finished = (['python', 'java'] as const).some(language => currentInstallations.current[language] && !next[language]);
    currentInstallations.current = next;
    setEnvironment(snapshot);
    setInstallations(next);
    setCancelling(previous => ({ python: Boolean(next.python && previous.python), java: Boolean(next.java && previous.java) }));
    if (notifyChanged || finished) callbacks.current.onChanged();
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
      // A snapshot already in flight must not erase a newer progress event.
      snapshotGeneration.current++;
      const next = { ...currentInstallations.current, [progress.language]: { progress } };
      currentInstallations.current = next;
      setInstallations(next);
      if (progress.phase === 'ready') void refresh();
    });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => { mounted.current = false; snapshotGeneration.current++; clearInterval(timer); stopProgress(); };
  }, [api, refreshEnvironment]);

  async function environmentAction(language: Language, label: string, action: () => Promise<unknown>, installation = false) {
    if (actionLocks.current.has(language)) return;
    actionLocks.current.add(language);
    setActions(previous => ({ ...previous, [language]: label }));
    setErrors(previous => ({ ...previous, [language]: '' }));
    if (installation) setStarting(previous => ({ ...previous, [language]: true }));
    try { await action(); }
    catch (error) {
      if (mounted.current) setErrors(previous => ({ ...previous, [language]: errorText(error) }));
    } finally {
      actionLocks.current.delete(language);
      if (mounted.current) {
        setActions(previous => ({ ...previous, [language]: '' }));
        setStarting(previous => ({ ...previous, [language]: false }));
        try { await refreshEnvironment(true); }
        catch (error) { if (mounted.current) setErrors(previous => ({ ...previous, [language]: errorText(error) })); }
      }
    }
  }

  async function cancelInstallation(language: Language) {
    if (!api || cancelling[language]) return;
    setCancelling(previous => ({ ...previous, [language]: true }));
    try { await api.cancelInstall(language); await refreshEnvironment(); }
    catch (error) {
      if (mounted.current) {
        setCancelling(previous => ({ ...previous, [language]: false }));
        setErrors(previous => ({ ...previous, [language]: errorText(error) }));
      }
    }
  }

  async function saveAutoInstall(enabled: boolean) {
    if (!api || preferenceBusy) return;
    setPreferenceBusy(true); setPreferenceError('');
    try { await api.setAutoInstallRuntimes(enabled); await refreshEnvironment(true); }
    catch (error) { if (mounted.current) setPreferenceError(errorText(error)); }
    finally { if (mounted.current) setPreferenceBusy(false); }
  }

  async function reminderAction(action: () => Promise<void>) {
    if (reminderBusy) return;
    setReminderBusy(true);
    try { await action(); await refreshEnvironment(); }
    catch (error) { if (mounted.current) callbacks.current.onError(errorText(error)); }
    finally { if (mounted.current) setReminderBusy(false); }
  }

  const notices = (environment?.runtimeNotices ?? []).filter(notice => notice.trim());

  return <section className="settings-page">
    <h2>把练习环境准备好。</h2>
    <p className="lede">优先使用已安装的兼容环境；没有时，只准备你需要的语言。安装到题炼独立目录，不修改系统 PATH。</p>
    <div className="runtime-preference-card">
      <label className="runtime-auto-install" htmlFor={preferenceId}>
        <input id={preferenceId} type="checkbox" checked={environment?.autoInstallRuntimes ?? false} disabled={!api || !environment || preferenceBusy} onChange={event => void saveAutoInstall(event.target.checked)} />
        <span>允许按需自动安装语言环境<small>默认关闭。开启后，仅在你主动运行且当前语言缺失时下载；打开应用、题目或切换语言不会下载。</small></span>
      </label>
      {preferenceError && <p className="runtime-inline-error" role="alert">{preferenceError}</p>}
    </div>
    <div className="runtime-settings-grid">{(['python', 'java'] as const).map(language => {
      const label = language === 'python' ? 'Python' : 'Java';
      const state = environment?.runtimeStates?.[language];
      const installation = installations[language] ?? (starting[language] ? { progress: null } : null);
      const busy = Boolean(actions[language] || installation);
      const status = installation ? '正在安装' : actions[language] || (!state ? '正在检查' : {
        ready: '已就绪', missing: '尚未准备', incompatible: '版本不兼容', error: '检测异常',
      }[state.status]);
      return <section className="runtime-environment-card" key={language} aria-labelledby={`runtime-heading-${language}`}>
        <div className="runtime-environment-heading">
          <h3 id={`runtime-heading-${language}`}>{label}{state?.version ? ` ${state.version}` : language === 'python' ? ' · CPython 3.14.x' : ' · OpenJDK 25'}</h3>
          <span className="runtime-state-label" data-state={state?.status} role="status" aria-live="polite">{label} · {status}</span>
        </div>
        <p className="runtime-environment-message">{state?.message || environment?.[language] || '正在有界地检查本机兼容环境，不会自动下载。'}</p>
        {state?.path && <code className="runtime-environment-path">{state.path}</code>}
        <div className="runtime-environment-meta">
          {state?.source && <span>当前来源：{runtimeSourceLabels[state.source]}</span>}
          {state?.managedInstalled && <span>托管环境实际占用：{runtimeBytes(state.installedBytes)}</span>}
          <span>用途：{language === 'python' ? 'Python 解释执行与标准库' : 'Java 编译与执行（含 javac）'}，不同题目共享</span>
        </div>
        {installation && <RuntimeInstallProgress language={language} progress={installation.progress} cancelling={Boolean(cancelling[language])} onCancel={() => void cancelInstallation(language)} />}
        {errors[language] && <p className="runtime-inline-error" role="alert">{errors[language]}</p>}
        <div className="button-row">
          <button className="button" disabled={!api || busy || !state?.artifact} onClick={() => void environmentAction(language, '正在准备安装', () => api!.installRuntime(language), true)}>{state?.managedInstalled ? '修复托管环境' : '安装托管环境'}</button>
          <button className="text-button" disabled={!api || busy} onClick={() => void environmentAction(language, '正在选择环境', () => api!.setRuntime(language))}>使用已有环境</button>
          <button className="text-button" disabled={!api || busy} onClick={() => void environmentAction(language, '正在重新检测', async () => { await api!.runtimePreflight(language); })}>重新检测</button>
        </div>
        <details className="runtime-more-options">
          <summary>{label} 下载信息与更多操作</summary>
          {state ? <RuntimeArtifactDetails artifact={state.artifact} /> : <p className="field-help">正在获取当前平台的环境信息…</p>}
          <div className="button-row">
            <button className="text-button" disabled={!api || busy || !state?.artifact} onClick={() => void environmentAction(language, '正在读取离线包', () => api!.installRuntime(language, true), true)}>导入匹配的离线包</button>
            {state?.source === 'selected' && <button className="text-button" disabled={!api || busy} onClick={() => void environmentAction(language, '正在恢复自动发现', () => api!.resetRuntime(language))}>清除手动选择，重新发现</button>}
          </div>
          <p className="runtime-policy-help">下载后先校验大小与 SHA-256，再验证解释 / 编译能力。未测量的安装占用不会用压缩包大小代替。网络不可用时可导入清单匹配的原始归档。</p>
          {state?.managedInstalled && <div className="runtime-removal">
            <button className="text-button" disabled={!api || busy} onClick={() => void environmentAction(language, '正在卸载托管环境', () => api!.uninstallRuntime(language))}>卸载 {label} 托管环境…</button>
            <p className="field-help">操作前需要确认；使用中无法卸载。只移除应用管理的环境，不删除本机外部环境、离线源文件、代码或学习记录。</p>
          </div>}
        </details>
      </section>;
    })}</div>
    {notices.length > 0 && <div className="note-row" role="status">{notices.map((notice, index) => <p key={`${index}:${notice}`}>{notice}</p>)}</div>}
    <div className="note-row"><strong>环境与代码分开管理</strong><p>准备一种语言不妨碍使用另一种已就绪的语言。安装完成后可离线运行本地测试；学习备份不携带大型环境，换电脑后会重新检测。本地执行不会自动上传代码，也不是安全沙箱。</p></div>
    <section className="reminder-section">
      <h3>后台提醒验证</h3>
      <p>创建一条 10 秒后的测试提醒，然后关闭窗口。应用留在菜单栏 / 托盘；完全退出后暂停提醒，下次启动保留逾期状态。</p>
      <div className="button-row">
        <button className="button" disabled={!api || reminderBusy} onClick={() => void reminderAction(() => api!.notifyAfter(10))}>创建测试提醒</button>
        <button className="button" disabled={!api || reminderBusy || !environment?.reminder} onClick={() => void reminderAction(() => api!.clearReminder())}>清除测试提醒</button>
        <button className="text-button" disabled={!api} onClick={() => refreshEnvironment(true).catch(error => onError(errorText(error)))}>刷新状态</button>
      </div>
      <p className="field-help" role="status">{environment?.reminder ? `测试提醒：${new Date(environment.reminder.dueAt).toLocaleString('zh-CN')}${environment.reminder.deliveredAt ? ' · 已请求系统投递' : new Date(environment.reminder.dueAt).getTime() <= Date.now() ? ' · 已逾期' : ' · 等待到期'}` : '尚未安排测试提醒。'}系统是否显示通知受通知权限与专注模式影响。</p>
    </section>
    <details className="reminder-section">
      <summary>性能诊断</summary>
      <p>遇到卡顿时开始记录，再切换页面或输入代码。90 秒后自动停止，只记录前台帧耗时和页面类型，不包含题目、代码或 Key。</p>
      <div className="button-row">
        <button className="button" onClick={() => { setPerformanceNotice(''); if (performanceState.recording) stopPerformanceRecording(); else startPerformanceRecording(); }}>{performanceState.recording ? '停止记录' : '开始记录'}</button>
        <button className="text-button" disabled={!api || !performanceState.hasReport || performanceState.recording} onClick={() => { void api!.copyCode(performanceReport()).then(() => setPerformanceNotice('诊断报告已复制')).catch(error => onError(errorText(error))); }}>复制诊断报告</button>
      </div>
      <p className="field-help" role="status">{performanceState.recording ? '正在记录，切换页面后会继续。' : performanceNotice || (performanceState.hasReport ? '记录已停止，可以复制报告用于排查。' : '默认关闭，记录仅保留在本次应用会话中。')}</p>
    </details>
    <dl className="system-details">
      <dt>当前环境</dt><dd>{environment ? `${environment.platform} / ${environment.arch}` : '桌面环境未连接'}</dd>
      <dt>应用组件</dt><dd>{environment ? `Electron ${environment.electron} · Node ${environment.node} · SQLite ${environment.sqlite}` : '—'}</dd>
      <dt>数据目录</dt><dd>{environment?.dataDirectory || '—'}</dd>
    </dl>
  </section>;
}
