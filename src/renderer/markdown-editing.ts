export type MarkdownCommand = 'h1' | 'h2' | 'h3' | 'bold' | 'italic' | 'bullet' | 'numbered' | 'inline-code' | 'code-block' | 'quote' | 'link';
export interface MarkdownEdit { value: string; start: number; end: number; }

/** Pure text edits keep native textarea selections, including multiline selections. */
export function applyMarkdownCommand(value: string, selectionStart: number, selectionEnd: number, command: MarkdownCommand): MarkdownEdit {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const selected = value.slice(start, end);
  const replace = (from: number, to: number, text: string, anchor: number, focus: number): MarkdownEdit => ({ value: value.slice(0, from) + text + value.slice(to), start: from + anchor, end: from + focus });
  if (command === 'bold' || command === 'italic' || command === 'inline-code') {
    const mark = command === 'bold' ? '**' : command === 'italic' ? '*' : '`';
    if (value.slice(start - mark.length, start) === mark && value.slice(end, end + mark.length) === mark) return replace(start - mark.length, end + mark.length, selected, 0, selected.length);
    const text = selected || (command === 'inline-code' ? '代码' : '文字');
    return replace(start, end, `${mark}${text}${mark}`, mark.length, mark.length + text.length);
  }
  if (command === 'link') {
    const text = selected || '链接文字'; const url = 'https://';
    return replace(start, end, `[${text}](${url})`, text.length + 3, text.length + 3 + url.length);
  }
  if (command === 'code-block') {
    const text = selected || '代码';
    const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
    const before = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
    const after = end < value.length && value[end] !== '\n' ? '\n' : '';
    const prefix = `${before}${fence}\n`;
    return replace(start, end, `${prefix}${text}\n${fence}${after}`, prefix.length, prefix.length + text.length);
  }
  const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const lastSelected = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const nextBreak = value.indexOf('\n', lastSelected);
  const to = nextBreak < 0 ? value.length : nextBreak;
  const lines = value.slice(from, to).split('\n');
  const prefix = command === 'quote' ? '> ' : command === 'bullet' ? '- ' : command === 'numbered' ? '1. ' : `${'#'.repeat(Number(command[1]))} `;
  const matches = command === 'numbered' ? (line: string) => /^\d+\. /.test(line) : (line: string) => line.startsWith(prefix);
  const remove = lines.every(matches);
  const formatted = lines.map((line, index) => {
    if (remove) return command === 'numbered' ? line.replace(/^\d+\. /, '') : line.slice(prefix.length);
    const clean = command.startsWith('h') ? line.replace(/^#{1,6} /, '') : command === 'bullet' || command === 'numbered' ? line.replace(/^(?:[-+*]|\d+\.) /, '') : line;
    return `${command === 'numbered' ? `${index + 1}. ` : prefix}${clean}`;
  }).join('\n');
  if (start === end) {
    const lineDelta = formatted.length - (to - from);
    const cursor = Math.max(0, start - from + lineDelta);
    return replace(from, to, formatted, cursor, cursor);
  }
  return replace(from, to, formatted, 0, formatted.length);
}

export function noteTitle(title: string, markdown: string, subject: string): string {
  const heading = markdown.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1];
  return (title.trim() || heading?.replace(/[*_`]/g, '').trim() || `${subject.trim() || '算法'} · 笔记`).slice(0, 300);
}
