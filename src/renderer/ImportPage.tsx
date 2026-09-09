import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge, PreparedImport } from '../shared/bridge';
import type { ImportJob } from '../shared/library';
import type { ImportInput } from '../source/index';
import { capability, difficultyLabel } from '../shared/presentation';
import { dateTime, errorText } from './ui';

const jobLabel: Record<ImportJob['status'], string> = { pending: '等待开始', running: '正在导入', paused: '已暂停', cancelled: '已取消', completed: '导入完成', completed_with_errors: '完成 · 部分条目待重试' };
const itemLabel = { pending: '未处理', running: '正在读取', imported: '已缓存', reused: '已复用', link_only: '仅链接', restricted: '访问受限', failed: '失败', skipped: '已跳过' };
export function ImportPage({ api, jobs, initialUrl, onChanged, onOpenLibrary, onError }: { api: DesktopBridge | undefined; jobs: ImportJob[]; initialUrl?: string; onChanged: () => Promise<void>; onOpenLibrary: () => void; onError: (error: string) => void }) {
  const [input, setInput] = useState<ImportInput>({ kind: 'url', text: initialUrl || 'https://leetcode.cn/studyplan/top-100-liked/' });
  const [prepared, setPrepared] = useState<PreparedImport | null>(null); const [busy, setBusy] = useState('');
  const [hasSession, setHasSession] = useState(false); const [notice, setNotice] = useState(''); const editRevision = useRef(0);
  const [selectedJob, setSelectedJob] = useState('');
  const job = jobs.find(item => item.id === selectedJob) ?? jobs[0];
  const updateInput = (next: ImportInput) => { editRevision.current++; setInput(next); setPrepared(null); setNotice(''); };
  useEffect(() => { if (initialUrl) updateInput({ kind: 'url', text: initialUrl }); }, [initialUrl]);
  useEffect(() => { let alive = true; api?.sourceSession().then(state => { if (alive) setHasSession(state.hasSession); }).catch(error => onError(errorText(error))); return () => { alive = false; }; }, [api]);
  const operation = async (name: string, action: () => Promise<void>) => { setBusy(name); setNotice(''); try { await action(); } catch (error) { onError(errorText(error)); } finally { setBusy(''); } };
  async function readPreview() {
    if (!api) return; const revision = editRevision.current;
    await operation('preview', async () => { const next = await api.previewImport(input); if (revision === editRevision.current) setPrepared(next); else setNotice('输入已改变，请重新读取预览。'); });
  }
  return <section className="import-page scroll-page">
    <div className="page-intro"><div><h2>把题单带到本机</h2><p>先预览章节与顺序，再逐题准备内容。重复题目会复用，失败条目可以单独重试。</p></div><button className="button" disabled={!api || !!busy} onClick={() => operation('login', () => api!.loginSource())}>打开力扣登录</button></div>
    <div className="session-line"><span>{hasSession ? '本应用中存在站点会话；能否访问以实际读取为准。' : '公开内容可直接读取；私有收藏需要在独立窗口登录。'}</span><button className="text-button" disabled={!api || !!busy} onClick={() => operation('session', async () => setHasSession((await api!.sourceSession()).hasSession))}>刷新登录状态</button>{hasSession && <button disabled={!api || !!busy} onClick={() => operation('logout', async () => { await api!.logoutSource(); setHasSession(false); })}>清除本应用登录态</button>}</div>
    <form onSubmit={event => { event.preventDefault(); void readPreview(); }} className="import-form">
      <div className="input-mode"><label>导入方式<select value={input.kind} onChange={event => updateInput({ kind: event.target.value as ImportInput['kind'], text: '' })}><option value="url">题单 / 单题链接</option><option value="links">批量链接</option><option value="csv">CSV</option><option value="json">JSON</option></select></label><button type="button" className="button" disabled={!api || !!busy} onClick={() => operation('file', async () => { const selected = await api!.selectImportFile(); if (selected) updateInput(selected); })}>选择本地文件</button>{input.name && <span className="field-help">{input.name}</span>}</div>
      <label htmlFor="import-input">{input.kind === 'url' ? '力扣国服题单或题目链接' : input.kind === 'links' ? '每行一个力扣国服链接' : `${input.kind.toUpperCase()} 文件内容`}</label>
      <textarea id="import-input" rows={input.kind === 'url' ? 2 : 7} spellCheck={false} required value={input.text} placeholder={input.kind === 'url' || input.kind === 'links' ? 'https://leetcode.cn/studyplan/top-100-liked/' : '选择文件，或粘贴内容后读取预览'} onChange={event => updateInput({ ...input, text: event.target.value })} />
      <div className="source-presets"><button type="button" onClick={() => updateInput({ kind: 'url', text: 'https://leetcode.cn/studyplan/top-100-liked/' })}>Hot 100</button><button type="button" onClick={() => updateInput({ kind: 'url', text: 'https://leetcode.cn/studyplan/top-interview-150/' })}>面试经典 150</button><span>收藏题单 · 单题 · 批量链接 · CSV / JSON</span></div>
      <button className="button primary" disabled={!api || !!busy || !input.text.trim()}>{busy === 'preview' ? '正在读取预览…' : '读取预览'}</button>
    </form>
    {notice && <p role="status" className="field-help">{notice}</p>}
    {prepared && <section className="import-preview" aria-label="导入预览"><div className="section-heading"><div><h3>{prepared.preview.listTitle}</h3><p>{prepared.preview.items.length} 个有效条目 · {prepared.preview.chapters.length} 个章节 · {prepared.preview.duplicates.length} 个重复输入</p></div><button className="button primary" disabled={!api || !!busy || !prepared.preview.complete || (prepared.preview.items.length === 0 && !prepared.membership) || Boolean(prepared.membership && !prepared.membership.canApply)} onClick={() => operation('start', async () => { const result = await api!.startImport(prepared.id, crypto.randomUUID()); setSelectedJob(result.id); setPrepared(null); await onChanged(); })}>确认导入</button></div>
      {prepared.membership && <div className="membership-diff"><span>新增 {prepared.membership.added.length}</span><span>移出 {prepared.membership.removed.length}</span><span>顺序 / 章节变化 {prepared.membership.moved.length}</span><p>{prepared.membership.baseRevision ? '这是现有题单的更新。移出只解除成员关系，已有代码与档案会保留。' : '导入后建立本地题单，条目顺序与预览一致。'}</p>{!prepared.membership.canApply && <p className="error-text">{prepared.membership.reason}</p>}</div>}
      {prepared.preview.errors.length > 0 && <div role="alert" className="inline-errors">{prepared.preview.errors.map((error, index) => <p key={index}>{error.inputIndex === undefined ? '' : `第 ${error.inputIndex + 1} 项：`}{error.message}</p>)}<p>请修正这些条目后重新预览，本次未开始导入。</p></div>}
      {prepared.preview.warnings.map((warning, index) => <p key={index} className="field-help">{warning}</p>)}
      <div className="preview-chapters">{prepared.preview.chapters.map(chapter => <details key={chapter.id} open={prepared.preview.chapters.length === 1}><summary>{chapter.title} <span>{prepared.preview.items.filter(item => item.chapterId === chapter.id).length} 题</span></summary><ol>{prepared.preview.items.filter(item => item.chapterId === chapter.id).map(item => <li key={item.key}><span>{item.title}</span><span>{difficultyLabel(item.difficulty)}</span><span>{item.content ? capability(item.content).label : item.premiumOnly ? '需要验证访问权限' : '等待补全题面'}</span></li>)}</ol></details>)}</div>
    </section>}
    <section className="import-tasks" aria-label="导入任务"><div className="section-heading"><div><h3>导入任务</h3><p>应用关闭或网络中断后，已保存的进度可以继续。</p></div>{jobs.length > 0 && <label><span className="sr-only">选择导入任务</span><select aria-label="选择导入任务" value={job?.id || ''} onChange={event => setSelectedJob(event.target.value)}>{jobs.map(item => <option key={item.id} value={item.id}>{item.title} · {dateTime(item.createdAt)}</option>)}</select></label>}</div>
      {job ? <><div className="job-summary"><div><h3>{job.title}</h3><p role="status">{jobLabel[job.status]}</p></div><div className="button-row">{job.status === 'running' ? <button className="button" disabled={!api || !!busy} onClick={() => operation('pause', async () => { await api!.pauseImport(job.id); await onChanged(); })}>暂停并保存进度</button> : job.status !== 'completed' && <button className="button primary" disabled={!api || !!busy} onClick={() => operation('resume', async () => { await api!.resumeImport(job.id, true); await onChanged(); })}>继续 / 重试失败项</button>}<button className="text-button" onClick={onOpenLibrary}>查看题库</button></div></div>
        <progress max={Math.max(1, job.total)} value={job.total - job.counts.pending - job.counts.running} aria-label="导入进度" />
        <div className="import-counts"><span>已缓存 {job.counts.imported}</span><span>复用 {job.counts.reused}</span><span>仅链接 {job.counts.link_only}</span><span>受限 {job.counts.restricted}</span><span>失败 {job.counts.failed}</span><span>未处理 {job.counts.pending + job.counts.running}</span>{job.counts.skipped > 0 && <span>已跳过 {job.counts.skipped}</span>}</div>
        {job.error && <p role="status" className="error-text">{job.error.message}</p>}
        <details className="job-items" open={job.status === 'paused' || job.status === 'completed_with_errors'}><summary>逐项结果与失败原因</summary><ol>{job.items.map(item => <li key={item.key}><span>{item.title}</span><span className={item.status === 'failed' || item.status === 'restricted' ? 'error-text' : 'muted'}>{itemLabel[item.status]}</span>{item.error && <p>{item.error.message}</p>}</li>)}</ol></details>
      </> : <div className="empty-state"><p>还没有导入任务。读取上方链接，先看看题单内容。</p></div>}
    </section>
    <details className="format-help"><summary>文件格式与内容说明</summary><p>CSV 可提供 url、title 等列；JSON 可提供题目、模板、显式函数适配与用例。带期望结果的样例才参与本地比较。</p><p>示例文件和完整字段说明随项目提供。登录态只保存在本应用的独立站点会话中；账号登录请直接在力扣网页完成。</p></details>
  </section>;
}
