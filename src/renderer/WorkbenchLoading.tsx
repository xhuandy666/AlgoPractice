import { Mascot } from './Mascot';

export function WorkbenchLoading({ error, disabled, onRetry, onLibrary }: {
  error: string | null; disabled: boolean; onRetry: () => void; onLibrary: () => void;
}) {
  return <div className="empty-state"><Mascot mood="think" size={88} />
    <h2>{error ? '工作台读取失败' : '正在读取工作台'}</h2>
    <p role={error ? 'alert' : 'status'}>{error ?? '可先从题库中选择需要练习的题目。'}</p>
    {error && <button className="button primary" disabled={disabled} onClick={onRetry}>重新读取工作台</button>}
    <button className="text-button" onClick={onLibrary}>打开题库</button>
  </div>;
}
