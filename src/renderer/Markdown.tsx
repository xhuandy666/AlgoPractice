import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

const attachment = /^algopractice:\/\/app\/attachment\/([a-f0-9]{64})$/;
export function Markdown({ text, onOpenLink, onAttachment }: { text: string; onOpenLink?: (url: string) => void; onAttachment?: (hash: string) => void }) {
  const html = useMemo(() => {
    const source = marked.parse(text, { async: false, gfm: true });
    const safe = DOMPurify.sanitize(source, {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 's', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'blockquote', 'img', 'a'],
      ALLOWED_ATTR: ['src', 'href', 'alt', 'title', 'colspan', 'rowspan'], ALLOW_DATA_ATTR: false,
      ALLOWED_URI_REGEXP: /^(?:https?:\/\/|algopractice:\/\/app\/attachment\/[a-f0-9]{64}$)/,
    });
    const document = new DOMParser().parseFromString(safe, 'text/html');
    document.querySelectorAll('img').forEach(image => {
      if (!attachment.test(image.getAttribute('src') || '')) {
        const label = document.createElement('span'); label.textContent = image.alt ? `[外部图片：${image.alt}]` : '[外部图片未加载]'; image.replaceWith(label);
      }
    });
    document.querySelectorAll('a').forEach(link => {
      const href = link.getAttribute('href') || '';
      if (!/^https?:\/\//.test(href) && !attachment.test(href)) link.removeAttribute('href');
      link.removeAttribute('target');
    });
    return document.body.innerHTML;
  }, [text]);
  return <div className="markdown-content" onClick={event => {
    const link = (event.target as Element).closest('a'); if (!link) return;
    event.preventDefault(); const href = link.getAttribute('href') || ''; const match = href.match(attachment);
    if (match) onAttachment?.(match[1]); else if (/^https?:\/\//.test(href)) onOpenLink?.(href);
  }} dangerouslySetInnerHTML={{ __html: html }} />;
}
