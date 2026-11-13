import type { DesktopBridge } from '../shared/bridge';
import { formatDuration, usePracticeTimer } from './practice-timer';
import { Icon } from './ui';

/** Leaf component: the one-second tick re-renders only this chip, never the workbench around it. */
export function PracticeTimer({ api, attemptId, counting }: { api: Pick<DesktopBridge, 'attemptActiveTime'> | undefined; attemptId: string | null; counting: boolean }) {
  const elapsed = usePracticeTimer(api, attemptId, counting);
  if (elapsed === null) return null;
  return <span className="practice-timer" role="timer" aria-label={`本次练习有效用时 ${formatDuration(elapsed)}`} title="本次练习的有效用时：窗口在前台、最近 5 分钟内有操作时才计时，与学习统计一致。"><Icon name="timer" size={14} />{formatDuration(elapsed)}</span>;
}
