import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/java/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import type { Diagnostic, Language } from '../runner/types';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
// Monaco's theme API accepts hex; resolve the same CSS tokens through a canvas.
function tokenHex(token: string) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  ctx.fillRect(0, 0, 1, 1);
  return '#' + [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('');
}
export function defineEditorTheme() {
    monaco.editor.defineTheme('algopractice', {
      base: 'vs', inherit: true,
      rules: [
        { token: 'comment', foreground: tokenHex('--color-muted').slice(1) },
        { token: 'keyword', foreground: tokenHex('--color-code-keyword').slice(1) },
        { token: 'string', foreground: tokenHex('--color-code-string').slice(1) },
        { token: 'number', foreground: tokenHex('--color-code-number').slice(1) },
      ],
      colors: {
        'editor.background': tokenHex('--color-surface'), 'editor.foreground': tokenHex('--color-ink'),
        'editorLineNumber.foreground': tokenHex('--color-muted'), 'editor.lineHighlightBackground': tokenHex('--color-paper-2'),
        'editor.selectionBackground': tokenHex('--color-accent-soft'), 'editorCursor.foreground': tokenHex('--color-accent'),
      },
    });
}

export function Editor({ code, language, readOnly = false, diagnostics = [], reveal, onChange, onRun }: { code: string; language: Language; readOnly?: boolean; diagnostics?: Diagnostic[]; reveal?: { line: number; column: number; serial: number } | null; onChange: (value: string) => void; onRun: () => void }) {
  const updatingFromProps = useRef(false);
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const callbacks = useRef({ onChange, onRun }); callbacks.current = { onChange, onRun };
  useEffect(() => {
    defineEditorTheme();
    const model = monaco.editor.createModel(code, language);
    const editor = monaco.editor.create(host.current!, {
      model, theme: 'algopractice', automaticLayout: true, minimap: { enabled: false },
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
      fontSize: 14, lineHeight: 26, padding: { top: 20, bottom: 20 },
      scrollBeyondLastLine: false, wordWrap: 'on', tabSize: 4, insertSpaces: true,
      renderLineHighlight: 'line', overviewRulerLanes: 0, hideCursorInOverviewRuler: true,
      lineNumbersMinChars: 3, glyphMargin: false, folding: false,
      ariaLabel: '解题代码', accessibilitySupport: 'auto',
      quickSuggestions: false, fixedOverflowWidgets: true,
    });
    instance.current = editor;
    const listener = editor.onDidChangeModelContent(() => { if (!updatingFromProps.current) callbacks.current.onChange(editor.getValue()); });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => callbacks.current.onRun());
    return () => { listener.dispose(); editor.dispose(); model.dispose(); instance.current = null; };
  }, []);
  useEffect(() => {
    const editor = instance.current;
    if (editor && editor.getValue() !== code) { updatingFromProps.current = true; try { editor.setValue(code); } finally { updatingFromProps.current = false; } }
    if (editor?.getModel()) monaco.editor.setModelLanguage(editor.getModel()!, language);
  }, [code, language]);
  useEffect(() => { instance.current?.updateOptions({ readOnly }); }, [readOnly]);
  useEffect(() => {
    const model = instance.current?.getModel(); if (!model) return;
    const markers: monaco.editor.IMarkerData[] = diagnostics.filter(diagnostic => diagnostic.source === 'user' && diagnostic.line && diagnostic.line <= model.getLineCount()).map(diagnostic => ({
      severity: monaco.MarkerSeverity.Error, message: diagnostic.message, source: '本地运行',
      startLineNumber: diagnostic.line!, endLineNumber: Math.min(diagnostic.endLine ?? diagnostic.line!, model.getLineCount()),
      startColumn: Math.max(1, Math.min(diagnostic.column ?? 1, model.getLineMaxColumn(diagnostic.line!))),
      endColumn: Math.max(2, Math.min(diagnostic.endColumn ?? (diagnostic.column ?? 1) + 1, model.getLineMaxColumn(diagnostic.endLine ?? diagnostic.line!))),
    }));
    monaco.editor.setModelMarkers(model, 'algopractice-run', markers);
  }, [diagnostics, code]);
  useEffect(() => { if (reveal && instance.current) { instance.current.revealLineInCenter(reveal.line); instance.current.setPosition({ lineNumber: reveal.line, column: reveal.column }); instance.current.focus(); } }, [reveal]);
  return <div className="editor-host" ref={host} aria-label="代码编辑器" />;
}
