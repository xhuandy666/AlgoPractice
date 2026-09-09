import { useMemo } from 'react';
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
export const formatValue = (value: unknown) => value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value);
export const dateTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export type IconName = 'code' | 'source' | 'settings' | 'play' | 'stop' | 'search' | 'library' | 'archive';
export function Icon({ name }: { name: IconName }) {
  const paths = { code: 'm8 6-5 6 5 6m8-12 5 6-5 6m-3-15-2 18', source: 'M4 4h6l2 3h8v13H4zm0 5h16', settings: 'M4 7h16M4 17h16M8 4v6m8 4v6', play: 'm8 5 11 7-11 7z', stop: 'M6 6h12v12H6z', search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', library: 'M4 4h5v16H4zM12 4h3v16h-3zM17 5l3-1 3 15-3 1z', archive: 'M4 8h16v12H4zM3 4h18v4H3zm6 9h6' };
  return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
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
    {content.description ? content.descriptionFormat === 'html' ? <div className="statement-html" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="problem-description">{content.description}</p> : <p className="muted">当前只保存了题目链接。可回到导入页继续准备题面。</p>}
    {content.descriptionFormat === 'plain' && content.cases.length > 0 && <><h3>示例</h3><dl className="example"><dt>输入</dt><dd><code>{formatValue(content.mode === 'acm' ? content.cases[0].stdin : content.cases[0].args)}</code></dd><dt>期望输出</dt><dd><code>{formatValue(content.cases[0].expected)}</code></dd></dl></>}
    {content.constraints.length > 0 && <><h3>边界条件</h3><ul className="constraints">{content.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></>}
    {content.media?.complete === false && <p className="field-help">有 {content.media.missingUrls.length} 张图示尚未缓存，完整题面需要在原站查看。</p>}
  </div>;
}
