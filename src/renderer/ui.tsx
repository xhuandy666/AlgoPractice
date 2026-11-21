import { useMemo, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import type { ProblemContent } from '../shared/library';
import type { RunArchive } from '../shared/bridge';

export const statusText: Record<RunArchive['result']['status'], string> = {
  passed: '本地测试通过', completed: '运行完成 · 未判定', wrong_answer: '答案不符', compile_error: '编译错误',
  runtime_error: '运行异常', timeout: '运行超时', cancelled: '已取消', output_limit: '输出超过上限',
  environment_error: '运行环境异常', invalid_request: '执行参数不支持', internal_error: '运行器异常', interrupted: '应用中断',
};
export const statusClass = (status: RunArchive['result']['status']) => status === 'passed' ? 'success-text' : ['completed', 'cancelled', 'interrupted'].includes(status) ? 'muted' : 'error-text';
export function errorText(error: unknown) { return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error); }
/** A command shortcut as the current platform prints it: ⌘K on macOS, Ctrl+K elsewhere. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform ?? '');
export const shortcut = (key: string) => IS_MAC ? `⌘${key}` : `Ctrl+${key}`;
export const formatValue = (value: unknown) => value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value);
export const dateTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const iconPaths = {
  home: 'M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1H15v-6.5H9V21H4.5a1 1 0 0 1-1-1z',
  calendar: 'M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM4 10h16M8.5 3v4m7-4v4M9 14.5l2 2 4-4',
  library: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zm0 15A1.5 1.5 0 0 0 6.5 21H19v-3M9 7.5h6',
  code: 'm8.5 7-5 5 5 5m7-10 5 5-5 5M13.5 4.5l-3 15',
  timer: 'M12 21a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zm0-11v3.8l2.4 2.2M9.5 2.5h5M18.6 5.4l1.4 1.4',
  source: 'M12 3.5v11m0 0-4-4m4 4 4-4M4.5 15.5v3A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-3',
  note: 'M4.5 19.5h4l10-10a2.83 2.83 0 0 0-4-4l-10 10zm9-12.5 3.5 3.5',
  archive: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5m0-5v5h5M12 7.5V12l3 2',
  settings: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 4.5v5M9 14.5v5',
  environment: 'M7.5 7.5h9v9h-9zM10.5 10.5h3v3h-3zM10 3.5v4m4-4v4m-4 9v4m4-4v4M3.5 10h4m-4 4h4m9-4h4m-4 4h4',
  play: 'm8 5 11 7-11 7z', stop: 'M6 6h12v12H6z',
  search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  tag: 'M3 4v7.2l9.3 9.3a1.7 1.7 0 0 0 2.4 0l5.8-5.8a1.7 1.7 0 0 0 0-2.4L11.2 3H4a1 1 0 0 0-1 1M7.5 7.5h.01',
  sidebar: 'M4 4h16v16H4zM9 4v16',
  flame: 'M12 21.5c-3.9 0-6.9-2.7-6.9-6.5 0-2.6 1.3-4.4 2.9-6 .3 1.6 1.1 2.6 2.1 3.1-.4-3.5 1.4-6.6 4.4-8.6-.2 2.6.8 4.3 2.3 5.9 1.3 1.4 2.1 3 2.1 5.6 0 3.8-3 6.5-6.9 6.5zm0 0c-1.7 0-2.9-1.2-2.9-2.8 0-1.8 1.5-2.7 2.9-4.4 1.4 1.7 2.9 2.6 2.9 4.4 0 1.6-1.2 2.8-2.9 2.8z',
  star: 'm12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  trophy: 'M8 4h8v5.5a4 4 0 0 1-8 0zM8 6H4.5v1A3.5 3.5 0 0 0 8 10.5M16 6h3.5v1a3.5 3.5 0 0 1-3.5 3.5M12 13.5V17m-4 3.5h8m-6.5 0 .5-3.5h4l.5 3.5',
  bolt: 'M13 2.5 4.5 13.5H11L10 21.5l8.5-11H12z',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-4.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0-4.5h.01',
  sparkle: 'M12 3.5c.6 4.2 2.3 5.9 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5 4.2-.6 5.9-2.3 6.5-6.5zM19 15.5c.3 1.9 1 2.6 2.5 3-1.5.4-2.2 1.1-2.5 3-.3-1.9-1-2.6-2.5-3 1.5-.4 2.2-1.1 2.5-3z',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  crown: 'M4 19h16M5 15.5 3.5 7l5 3.5L12 4.5l3.5 6 5-3.5-1.5 8.5z',
} as const;
export type IconName = keyof typeof iconPaths;
export function Icon({ name, size = 20, strokeWidth = 2.2 }: { name: IconName; size?: number; strokeWidth?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"><path d={iconPaths[name]} /></svg>;
}
export type PageTone = 'blue' | 'red' | 'gold' | 'teal' | 'sky' | 'gray';
export function PageIntro({ tone, icon, title, help, description, children }: { tone: PageTone; icon: IconName; title: string; help?: ReactNode; description: string; children?: ReactNode }) {
  return <div className="page-intro page-banner" data-tone={tone}>
    <span className="page-banner-icon" aria-hidden="true"><Icon name={icon} size={30} /></span>
    <div><div className="page-banner-title"><h2>{title}</h2>{help}</div><p>{description}</p></div>
    {children}
  </div>;
}
export function Statement({ content }: { content: ProblemContent }) {
  const html = useMemo(() => {
    if (content.descriptionFormat !== 'html') return '';
    const safe = DOMPurify.sanitize(content.description, {
      ALLOWED_TAGS: ['p', 'div', 'span', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sub', 'sup', 'hr', 'blockquote', 'img', 'a'],
      ALLOWED_ATTR: ['src', 'alt', 'title', 'colspan', 'rowspan'], ALLOW_DATA_ATTR: false,
      ALLOWED_URI_REGEXP: /^algopractice:\/\/app\/media\/[a-f0-9]{64}$/,
    });
    const document = new DOMParser().parseFromString(safe, 'text/html');
    document.querySelectorAll('img').forEach(img => {
      if (!/^algopractice:\/\/app\/media\/[a-f0-9]{64}$/.test(img.getAttribute('src') || '')) {
        const placeholder = document.createElement('p'); placeholder.className = 'media-placeholder'; placeholder.textContent = img.getAttribute('alt') ? `图示未缓存：${img.getAttribute('alt')}` : '此处图示未缓存，请打开原站查看。'; img.replaceWith(placeholder);
      }
    });
    return document.body.innerHTML;
  }, [content.description, content.descriptionFormat]);
  return <div className="statement-content">
    {content.description ? content.descriptionFormat === 'html' ? <div className="statement-html" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="problem-description">{content.description}</p> : <p className="muted">当前仅保存了题目链接，可在导入页继续准备题面。</p>}
    {content.descriptionFormat === 'plain' && content.cases.length > 0 && <><h3>示例</h3><dl className="example"><dt>输入</dt><dd><code>{formatValue(content.mode === 'acm' ? content.cases[0].stdin : content.cases[0].args)}</code></dd><dt>期望输出</dt><dd><code>{formatValue(content.cases[0].expected)}</code></dd></dl></>}
    {content.constraints.length > 0 && <><h3>边界条件</h3><ul className="constraints">{content.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></>}
    {content.media?.complete === false && <p className="field-help">有 {content.media.missingUrls.length} 张图示尚未缓存，完整题面需要在原站查看。</p>}
  </div>;
}
