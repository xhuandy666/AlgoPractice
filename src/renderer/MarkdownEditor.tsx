import { useId, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { applyMarkdownCommand, type MarkdownCommand } from './markdown-editing';
import './note-composer.css';

const tools: { command: MarkdownCommand; label: string; text: string; shortcut?: string }[] = [
  { command: 'h1', label: '一级标题', text: 'H1' }, { command: 'h2', label: '二级标题', text: 'H2' }, { command: 'h3', label: '三级标题', text: 'H3' },
  { command: 'bold', label: '加粗', text: 'B', shortcut: '⌘/Ctrl B' }, { command: 'italic', label: '斜体', text: 'I', shortcut: '⌘/Ctrl I' },
  { command: 'bullet', label: '无序列表', text: '• 列表' }, { command: 'numbered', label: '有序列表', text: '1. 列表' },
  { command: 'inline-code', label: '行内代码', text: '< >' }, { command: 'code-block', label: '代码块', text: '{ }' },
  { command: 'quote', label: '引用', text: '❝' }, { command: 'link', label: '链接', text: '链接', shortcut: '⌘/Ctrl K' },
];

export function MarkdownEditor({ value, onChange, disabled = false, onOpenLink, onAttachment, rows = 14 }: {
  value: string; onChange: (value: string) => void; disabled?: boolean; rows?: number;
  onOpenLink?: (url: string) => void; onAttachment?: (hash: string) => void;
}) {
  const id = useId(); const textarea = useRef<HTMLTextAreaElement>(null); const composing = useRef(false);
  const [preview, setPreview] = useState(false);
  function format(command: MarkdownCommand) {
    const element = textarea.current; if (!element || disabled || composing.current) return;
    const edit = applyMarkdownCommand(value, element.selectionStart, element.selectionEnd, command);
    onChange(edit.value);
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(edit.start, edit.end); });
  }
  return <div className="markdown-editor">
    <div className="markdown-editor-top"><label htmlFor={id}>笔记正文</label><div className="markdown-view-switch" role="group" aria-label="正文视图"><button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>编辑</button><button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>预览</button></div></div>
    <div className="markdown-format-toolbar" role="toolbar" aria-label="Markdown 格式">{tools.map(tool => <button key={tool.command} type="button" className={`markdown-tool markdown-tool-${tool.command}`} aria-label={tool.label} title={`${tool.label}${tool.shortcut ? ` (${tool.shortcut})` : ''}`} disabled={disabled || preview} onMouseDown={event => event.preventDefault()} onClick={() => format(tool.command)}>{tool.text}</button>)}</div>
    {preview ? <div className="markdown-editor-preview" aria-label="笔记预览">{value.trim() ? <Markdown text={value} onOpenLink={onOpenLink} onAttachment={onAttachment} /> : <p className="local-status">写下思路、易错点或解法，预览会显示在这里。</p>}</div> : <textarea ref={textarea} id={id} className="note-body markdown-editor-body" aria-label="Markdown 正文" value={value} rows={rows} spellCheck={false} disabled={disabled} placeholder="记录这道题的思路、易错点，或下次想起的关键一步…" onChange={event => onChange(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const command = ({ b: 'bold', i: 'italic', k: 'link' } as Record<string, MarkdownCommand>)[event.key.toLowerCase()];
      if (command) { event.preventDefault(); format(command); }
    }} />}
    <div className="markdown-editor-hint"><span>支持 Markdown</span><span>{value.length.toLocaleString()} 字符</span></div>
  </div>;
}
