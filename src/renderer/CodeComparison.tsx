import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api';
import type { Language } from '../runner/types';
import { defineEditorTheme } from './Editor';
import { LANGUAGE_DETAILS } from '../shared/languages';

export function CodeComparison({ before, after, language, label = '代码版本比较' }: { before: string; after: string; language: Language; label?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    defineEditorTheme();
    const original = monaco.editor.createModel(before, LANGUAGE_DETAILS[language].monacoLanguage);
    const modified = monaco.editor.createModel(after, LANGUAGE_DETAILS[language].monacoLanguage);
    const editor = monaco.editor.createDiffEditor(host.current!, {
      theme: 'algopractice', automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: false,
      minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: 'on',
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
      fontSize: 14, lineHeight: 24, ariaLabel: label, renderOverviewRuler: false,
      diffWordWrap: 'on', accessibilityVerbose: true,
    });
    editor.setModel({ original, modified });
    return () => { editor.dispose(); original.dispose(); modified.dispose(); };
  }, [before, after, language, label]);
  return <div className="code-comparison" ref={host} aria-label={label} />;
}
