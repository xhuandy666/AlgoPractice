import { useEffect, useId, useRef, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import { HOT100 } from '../shared/builtin-lists';
import type { ImportJob, StudyList } from '../shared/library';
import { errorText } from './ui';
import './hot100-card.css';

const statusLabel: Record<ImportJob['status'], string> = {
  pending: '等待继续', running: '正在缓存题面', paused: '已暂停', cancelled: '已取消',
  completed: '导入任务已完成', completed_with_errors: '部分内容待重试',
};

export function Hot100Card({ api, lists, jobs, onChanged, onView, viewLabel = '查看 Hot100 题单' }: {
  api: DesktopBridge | undefined; lists: StudyList[]; jobs: ImportJob[];
  onChanged: () => Promise<void>; onView: (listId: string) => void; viewLabel?: string;
}) {
  const headingId = useId(); const descriptionId = useId();
  const [busy, setBusy] = useState<'import' | 'pause' | 'resume' | 'refresh' | null>(null);
  const [error, setError] = useState(''); const [created, setCreated] = useState(false);
  const [localJob, setLocalJob] = useState<ImportJob | null>(null);
  const inFlight = useRef(false); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const list = lists.find(item => item.id === HOT100.id);
  const savedJob = jobs.filter(item => item.list?.id === HOT100.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const job = localJob && (!savedJob || localJob.updatedAt > savedJob.updatedAt) ? localJob : savedJob ?? localJob;
  const exists = Boolean(list || job || created);
  const message = busy === 'import' ? '正在联网读取官方题单，随后缓存题面…'
    : job ? statusLabel[job.status] : exists ? '题单已在本机保存' : '';

  async function operation(action: NonNullable<typeof busy>) {
    if (!api || inFlight.current) return;
    inFlight.current = true; setBusy(action); setError('');
    try {
      if (action === 'import') {
        const result = await api.importHot100();
        if (alive.current) { setCreated(true); setLocalJob(result.job); }
      } else if (action === 'pause' && job) await api.pauseImport(job.id);
      else if (action === 'resume' && job) {
        const result = await api.resumeImport(job.id, true);
        if (alive.current) setLocalJob(result);
      }
      await onChanged();
    } catch (reason) {
      if (alive.current) setError(errorText(reason));
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  }

  return <section className="hot100-card" aria-labelledby={headingId}>
    <div className="hot100-card-main">
      <div className="hot100-card-heading"><span className="hot100-card-kicker">常用题单</span><h3 id={headingId}>{HOT100.title}</h3></div>
      <p id={descriptionId} className="hot100-card-description">首次导入需联网；已缓存题面可离线使用。</p>
      {message && <p className="hot100-card-status" role="status" aria-live="polite" aria-atomic="true">{message}{list ? ` · 本机题单 ${list.items.length} 道题` : ''}</p>}
      {job && <div className="hot100-card-progress">
        <progress max={Math.max(1, job.total)} value={Math.max(0, job.total - job.counts.pending - job.counts.running)} aria-label="Hot100 最近导入任务进度" />
        <p>最近任务 {job.total} 项：已缓存 {job.counts.imported + job.counts.reused} · 待处理 {job.counts.pending + job.counts.running} · 失败 {job.counts.failed} · 受限 {job.counts.restricted}{job.counts.link_only > 0 ? ` · 仅链接 ${job.counts.link_only}` : ''}{job.counts.skipped > 0 ? ` · 已跳过 ${job.counts.skipped}` : ''}</p>
      </div>}
      {(error || job?.error) && <p className="hot100-card-error" role="alert">{error || job?.error?.message} <span>题单和进度已保留，可检查网络或登录状态后重试。</span></p>}
    </div>
    <div className="hot100-card-actions">
      {!exists ? <button className="button primary" aria-describedby={descriptionId} disabled={!api || !!busy} onClick={() => void operation('import')}>{busy === 'import' ? '正在准备 Hot100…' : error ? '重试导入 Hot100' : '一键导入 Hot100'}</button>
        : <><button className="button" disabled={!list} title={!list ? '本机题单目录同步后可查看' : undefined} onClick={() => onView(HOT100.id)}>{viewLabel}</button>
          {job?.status === 'running' ? <button className="text-button" disabled={!api || !!busy} onClick={() => void operation('pause')}>{busy === 'pause' ? '正在暂停…' : '暂停导入'}</button>
            : job && job.status !== 'completed' ? <button className="button primary" disabled={!api || !!busy} onClick={() => void operation('resume')}>{busy === 'resume' ? '正在继续…' : job.status === 'completed_with_errors' ? '重试未完成项' : '继续导入 / 重试'}</button> : null}
          {error && <button className="text-button" disabled={!api || !!busy} onClick={() => void operation('refresh')}>{busy === 'refresh' ? '正在刷新…' : '刷新本机状态'}</button>}
        </>}
    </div>
  </section>;
}
