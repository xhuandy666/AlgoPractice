import { useEffect, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import type { ProblemListItem } from '../shared/learning';
import { errorText } from './ui';
export function ProblemPicker({ api, value, disabled, onChange, onError }: { api?: DesktopBridge; value: string; disabled: boolean; onChange: (id: string) => void; onError: (error: string) => void }) {
  const [search, setSearch] = useState(''); const [rows, setRows] = useState<ProblemListItem[]>([]); const [selected, setSelected] = useState<ProblemListItem | null>(null); const [total, setTotal] = useState(0);
  useEffect(() => { let alive = true; const timer = setTimeout(() => { if (api) void api.problemPage({ search, limit: 30 }).then(result => { if (alive) { setRows(result.items); setTotal(result.total); } }).catch(error => { if (alive) onError(errorText(error)); }); }, 150); return () => { alive = false; clearTimeout(timer); }; }, [api, search]);
  useEffect(() => { let alive = true; if (api && value) void api.problemPage({ ids: [value], limit: 1 }).then(result => { if (alive) setSelected(result.items[0] ?? null); }).catch(error => { if (alive) onError(errorText(error)); }); return () => { alive = false; }; }, [api, value]);
  const options = [...new Map([...(selected ? [selected] : []), ...rows].map(row => [row.id, row])).values()];
  return <div className="p3-field"><label>搜索关联题目<input type="search" aria-label="搜索关联题目" disabled={disabled} value={search} placeholder="题名、编号或标签" onChange={event => setSearch(event.target.value)} /></label><label>关联题目<select aria-label="关联题目" disabled={disabled} value={value} onChange={event => onChange(event.target.value)}>{value && !options.some(row => row.id === value) && <option value={value}>{value}</option>}{options.map(row => <option key={row.id} value={row.id}>{row.content.title}</option>)}</select></label>{!disabled && total > 30 && <span className="field-help">匹配 {total} 道题，显示前 30 道；输入更多文字可缩小范围。</span>}</div>;
}
