import { useEffect, useState } from 'react';
import type { BackupState, DesktopBridge, PreparedRestore } from '../shared/bridge';
import type { MirrorStatus, ReminderSettings } from '../shared/maintenance';
import { DEFAULT_REMINDER_SETTINGS } from '../shared/maintenance';
import { AiSettings } from './AiSettings';
import { EDITOR_FONT_SIZES, saveEditorPreferences, useEditorPreferences } from './editor-preferences';
import { saveDisplayPreferences, useDisplayPreferences, type ThemePreference } from './display-preferences';
import { HelpHint } from './HelpHint';
import { dateTime, errorText, PageIntro } from './ui';
import { useEditsFrozen, flushPendingSaves } from './pending-saves';
import { celebrate, saveRewardPreferences, useRewardPreferences, type RewardEffects } from './reward-bus';

const effectChoices: { value: RewardEffects; label: string; detail: string }[] = [
  { value: 'full', label: '完整', detail: '彩带、徽章与升级动画' },
  { value: 'calm', label: '简洁', detail: '仅显示提示条与经验' },
  { value: 'off', label: '关闭', detail: '不显示庆祝效果' },
];
function RewardSettings() {
  const preferences = useRewardPreferences();
  return <section className="settings-section learning-section reward-settings"><div className="heading-with-help"><h3>奖励与动效</h3><HelpHint label="奖励与动效说明">经验、等级和成就由本机练习记录推算，随学习备份一起恢复。动效与提示音仅对本设备生效；系统开启“减少动态效果”时自动改为简洁提示。</HelpHint></div>
    <div className="p3-form"><fieldset className="choice-cards"><legend>庆祝动效</legend>{effectChoices.map(choice => <label key={choice.value} data-checked={preferences.effects === choice.value}><input type="radio" name="reward-effects" value={choice.value} checked={preferences.effects === choice.value} onChange={() => saveRewardPreferences({ ...preferences, effects: choice.value })} /><span><strong>{choice.label}</strong><small>{choice.detail}</small></span></label>)}</fieldset>
      <label className="checkbox-field"><input type="checkbox" checked={preferences.sound} onChange={event => saveRewardPreferences({ ...preferences, sound: event.target.checked })} />播放提示音（本机合成，默认关闭）</label>
      <div className="compact-actions"><button type="button" className="button" disabled={preferences.effects === 'off'} onClick={() => celebrate({ kind: 'local-pass', first: true, combo: 2, cases: 3 })}>预览通过效果</button><button type="button" className="button" disabled={preferences.effects === 'off'} onClick={() => celebrate({ kind: 'level-up', level: 6, rankId: 'gold', rankName: '黄金', rankChanged: true })}>预览升级效果</button></div></div>
  </section>;
}
/** Device-local editor behavior; strict interviews always type without suggestions. */
const THEME_LABELS: Record<ThemePreference, string> = { light: '浅色', dark: '深色', system: '跟随系统' };
/** Appearance is per device, like the editor preferences: it changes how this window looks, not what is stored. */
function AppearanceSettings() {
  const display = useDisplayPreferences();
  return <section className="settings-section learning-section"><div className="heading-with-help"><h3>外观</h3><HelpHint label="外观设置说明">深色外观适合夜间或长时间练习。选择“跟随系统”后，会随系统的浅色 / 深色切换。专题标签会提示解法方向，默认不显示；题面底部的“相关专题”随时可以展开。仅对本设备生效。</HelpHint></div>
    <div className="p3-form"><label>界面主题<select aria-label="界面主题" value={display.theme} onChange={event => saveDisplayPreferences({ ...display, theme: event.target.value as ThemePreference })}>{(Object.keys(THEME_LABELS) as ThemePreference[]).map(theme => <option key={theme} value={theme}>{THEME_LABELS[theme]}</option>)}</select></label>
      <label className="checkbox-field"><input type="checkbox" checked={display.topicTags} onChange={event => saveDisplayPreferences({ ...display, topicTags: event.target.checked })} />在题库、复习计划和工作台顶部显示专题标签</label></div>
  </section>;
}
function EditorSettings() {
  const preferences = useEditorPreferences();
  return <section className="settings-section learning-section"><div className="heading-with-help"><h3>代码编辑器</h3><HelpHint label="代码编辑器设置说明">补全建议来自代码中出现过的词，不含库函数提示。默认不自动弹出，更接近面试时手写代码；需要时按 Ctrl+Space（macOS 为 Control+空格）唤出。改为自动弹出后，按 Tab 采用建议，回车照常换行。严格面试中补全完全关闭。仅对本设备生效。</HelpHint></div>
    <div className="p3-form"><label className="checkbox-field"><input type="checkbox" checked={preferences.suggestions} onChange={event => saveEditorPreferences({ ...preferences, suggestions: event.target.checked })} />输入时自动弹出补全建议</label>
      <label>代码字号<select aria-label="代码字号" value={preferences.fontSize} onChange={event => saveEditorPreferences({ ...preferences, fontSize: Number(event.target.value) })}>{EDITOR_FONT_SIZES.map(size => <option key={size} value={size}>{size} px{size === 14 ? '（默认）' : ''}</option>)}</select></label></div>
  </section>;
}
/** Copies of the automatic backups in a folder the user picks (e.g. a cloud-synced one). The folder is chosen only
 * through the system dialog in the main process; this view never sends a path. */
function BackupMirrorSettings({ api, mirror, disabled, action, onStatus }: { api: DesktopBridge | undefined; mirror: MirrorStatus | undefined; disabled: boolean;
  action: (name: string, operation: () => Promise<void>) => Promise<void>; onStatus: (status: MirrorStatus) => void }) {
  const choose = () => { void action('mirror', async () => { const status = await api!.chooseBackupMirror(); if (status) onStatus(status); }); };
  return <div className="backup-mirror">
    <div className="heading-with-help"><strong>备份副本</strong><HelpHint label="备份副本说明">每次自动备份后，将最新一份备份复制到所选文件夹（如云盘同步目录），本机磁盘损坏或丢失时可从中恢复。副本为完整备份，包含代码、笔记、练习记录和附件，不含 API Key 与登录会话；位于云盘目录时会随云盘同步上传。仅保留本机最近 7 份副本，不删除文件夹中的其他文件。</HelpHint></div>
    {mirror?.directory ? <>
      <p className="field-help">副本文件夹：<code>{mirror.directory}</code>{mirror.lastCopiedAt ? ` · 最近同步 ${dateTime(mirror.lastCopiedAt)}` : mirror.busy ? ' · 正在同步…' : ' · 等待第一次同步'}</p>
      {mirror.lastError && <p className="error-text" role="alert">副本同步失败：{mirror.lastError} 稍后会自动重试。</p>}
      <div className="compact-actions"><button className="button" disabled={disabled} onClick={() => { void action('mirror', async () => { onStatus(await api!.syncBackupMirror()); }); }}>立即同步</button><button className="text-button" disabled={disabled} onClick={choose}>更换文件夹</button><button className="text-button" disabled={disabled} onClick={() => { void action('mirror', async () => { onStatus(await api!.clearBackupMirror()); }); }}>停用副本</button></div>
    </> : <div className="compact-actions"><button className="button" disabled={disabled} onClick={choose}>选择副本文件夹</button></div>}
  </div>;
}
export function LearningSettingsPage({ api, onError }: { api: DesktopBridge | undefined; onError: (message: string) => void }) {
  const [budget, setBudget] = useState('3'); const [zone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [reminders, setReminders] = useState<ReminderSettings>(DEFAULT_REMINDER_SETTINGS); const [backups, setBackups] = useState<BackupState | null>(null);
  const [restore, setRestore] = useState<PreparedRestore | null>(null); const [busy, setBusy] = useState(''); const [message, setMessage] = useState(''); const frozen = useEditsFrozen();
  useEffect(() => { let alive = true; if (api) void Promise.all([api.learningSettings(), api.reminderState()]).then(([settings, reminder]) => { if (alive) { setBudget(settings.dailyReviewBudget === null ? '' : String(settings.dailyReviewBudget)); setZone(settings.timeZone); setReminders(reminder.settings); } }).catch(error => onError(errorText(error))); return () => { alive = false; }; }, [api]);
  useEffect(() => { if (!api) return; let alive = true; let timer: ReturnType<typeof setTimeout> | null = null; let loading = false; const refresh = async () => { if (loading) return; loading = true; try { const state = await api.backups(); if (!alive) return; setBackups(previous => ({ ...state, backups: state.busy && previous ? previous.backups : state.backups })); if (state.busy) timer = setTimeout(() => { void refresh(); }, 1000); } catch (error) { if (alive) onError(errorText(error)); } finally { loading = false; } }; const remove = api.onLibraryChanged(() => { void refresh(); }); void refresh(); return () => { alive = false; remove(); if (timer) clearTimeout(timer); }; }, [api]);
  async function action(name: string, operation: () => Promise<void>) { if (busy || frozen) return; setBusy(name); setMessage(''); try { await operation(); } catch (error) { onError(errorText(error)); } finally { setBusy(''); } }
  return <section className="learning-page scroll-page"><PageIntro tone="gray" icon="settings" title="学习设置" description="调整复习节奏、提醒时间、外观、编辑器与数据备份。" />
    <section className="settings-section learning-section"><div className="heading-with-help"><h3>每日复习</h3><HelpHint label="每日复习设置说明">预算用完后，到期项目仍会保留。留空不限数量；学习时区用于统计日期和提醒时间。</HelpHint></div><form className="p3-form" onSubmit={event => { event.preventDefault(); void action('learning', async () => { if (!api) return; const value = await api.saveLearningSettings({ dailyReviewBudget: budget.trim() ? Number(budget) : null, timeZone: zone }); setBudget(value.dailyReviewBudget === null ? '' : String(value.dailyReviewBudget)); setZone(value.timeZone); setMessage('复习预算和时区已保存。'); }); }}><div className="form-columns"><label className="p3-field">每日复习预算<input type="number" min={0} max={1000} value={budget} placeholder="留空表示不限制" disabled={Boolean(busy) || frozen} onChange={event => setBudget(event.target.value)} /></label><label className="p3-field">学习时区<input value={zone} placeholder="Asia/Shanghai" disabled={Boolean(busy) || frozen} onChange={event => setZone(event.target.value)} /></label></div><button className="button" disabled={!api || Boolean(busy) || frozen} type="submit">保存复习设置</button></form></section>
    <section className="settings-section learning-section"><div className="heading-with-help"><h3>系统复习提醒</h3><HelpHint label="复习提醒说明">完全退出应用后不发送提醒；下次打开会显示逾期状态。</HelpHint></div><form className="p3-form" onSubmit={event => { event.preventDefault(); void action('reminders', async () => { if (!api) return; const value = await api.saveReminderSettings(reminders); setReminders(value.settings); setMessage('复习提醒已保存。'); }); }}><label className="checkbox-field"><input type="checkbox" checked={reminders.enabled} disabled={Boolean(busy) || frozen} onChange={event => setReminders(value => ({ ...value, enabled: event.target.checked }))} />开启每日复习提醒</label><div className="form-columns"><label className="p3-field">提醒时间<input type="time" value={reminders.at} disabled={Boolean(busy) || frozen} onChange={event => setReminders(value => ({ ...value, at: event.target.value }))} /></label><label className="p3-field">安静时段开始<input type="time" value={reminders.quietStart} disabled={Boolean(busy) || frozen} onChange={event => setReminders(value => ({ ...value, quietStart: event.target.value }))} /></label><label className="p3-field">安静时段结束<input type="time" value={reminders.quietEnd} disabled={Boolean(busy) || frozen} onChange={event => setReminders(value => ({ ...value, quietEnd: event.target.value }))} /></label></div><button className="button" disabled={!api || Boolean(busy) || frozen} type="submit">保存提醒设置</button></form></section>
    <AppearanceSettings /><RewardSettings /><EditorSettings />
    <AiSettings api={api} onError={onError} />
    <section className="settings-section learning-section backup-settings"><div className="heading-with-help"><h3>备份与恢复</h3><HelpHint label="备份内容与保留规则">包含题目、练习、笔记、复习记录、附件和设置。数据变化后每日自动备份，保留最近 7 份；手动备份单独保留。</HelpHint></div><p className="field-help">备份不包含 API Key、站点登录会话、语言环境和日志。恢复后需重新配置密钥并登录。</p><div className="compact-actions"><button className="button" disabled={!api || Boolean(busy) || frozen || backups?.busy} onClick={() => { void action('backup', async () => { await flushPendingSaves(); const value = await api!.createBackup(); if (value) { setMessage(`备份已保存：${value.path}`); setBackups(await api!.backups()); } }); }}>{busy === 'backup' ? '正在生成备份…' : '创建手动备份'}</button><button className="button" disabled={!api || Boolean(busy) || frozen || backups?.busy} onClick={() => { void action('inspect', async () => { setRestore(await api!.previewRestore()); }); }}>选择备份并检查</button><button className="text-button" disabled={!api || Boolean(busy) || frozen} onClick={() => { void action('refresh', async () => { setBackups(await api!.backups()); }); }}>刷新备份列表</button></div>
      <BackupMirrorSettings api={api} mirror={backups?.mirror} disabled={!api || Boolean(busy) || frozen} action={action} onStatus={mirror => setBackups(previous => previous ? { ...previous, mirror } : previous)} />
    {backups?.lastError && <p className="error-text" role="alert">{backups.lastError}</p>}<div className="study-list">{backups?.backups.map(backup => <div className="study-row" key={backup.manifest.id}><div><h4>{backup.manifest.kind === 'automatic' ? '自动备份' : backup.manifest.kind === 'before-restore' ? '恢复前备份' : '手动备份'} · {dateTime(backup.manifest.createdAt)}</h4><p>{(backup.bytes / 1048576).toFixed(2)} MiB · 数据版本 {backup.manifest.databaseVersion}</p><p className="path-value">{backup.path}</p></div></div>)}</div>{backups?.busy && <p className="field-help" role="status">正在生成或检查备份，完成后列表会自动更新。</p>}{backups && !backups.busy && !backups.backups.length && <p className="field-help">应用备份目录中暂无已验证的备份。</p>}
    {restore && <div className="review-rating" role="alertdialog" aria-label="确认恢复备份"><h3>恢复 {dateTime(restore.manifest.createdAt)} 的备份？</h3><p>恢复前会保存草稿、停止运行与 AI 请求，并备份当前数据。</p><p>所选备份将替换当前学习数据，并清除 AI 密钥与站点会话。当前内容可从恢复前备份找回。</p><dl className="system-details"><dt>应用版本</dt><dd>{restore.manifest.appVersion}</dd><dt>数据版本</dt><dd>{restore.manifest.databaseVersion}</dd><dt>文件数</dt><dd>{restore.manifest.files.length}</dd><dt>大小</dt><dd>{(restore.bytes / 1048576).toFixed(2)} MiB</dd></dl><div className="compact-actions"><button className="button primary" disabled={Boolean(busy) || frozen} onClick={() => { void action('restore', async () => { await api!.restoreBackup(restore.id); setRestore(null); }); }}>{busy === 'restore' ? '正在恢复并重新打开…' : '确认替换并恢复'}</button><button className="text-button" disabled={Boolean(busy)} onClick={() => setRestore(null)}>取消</button></div></div>}
    </section>{message && <p className="success-text" role="status">{message}</p>}
  </section>;
}
