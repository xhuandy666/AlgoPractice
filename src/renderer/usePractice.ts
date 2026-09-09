import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge, RunArchive, WorkspaceData } from '../shared/bridge';
import type { Language } from '../runner/types';
import { previewProblems } from '../shared/presentation';
import { errorText } from './ui';
import { editsFrozen, flushPendingSaves, registerPendingSave, setEditsFrozen } from './pending-saves';

export interface PracticeTarget { id: string; language: Language; scope: string; }
export function usePractice(api: DesktopBridge | undefined, onError: (error: string) => void) {
  const [target, setTarget] = useState<PracticeTarget>({ id: 'array-total', language: 'python', scope: 'practice' });
  const key = `${target.id}:${target.language}:${target.scope}`;
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [code, setCode] = useState('');
  const [ready, setReady] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [saving, setSaving] = useState('正在读取草稿');
  const dirty = useRef(false); const queue = useRef(Promise.resolve()); const navigating = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null); const maxWait = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef({ target, code: '' }); const currentKey = useRef(key); currentKey.current = key;
  const reportError = useRef(onError); reportError.current = onError;

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    if (maxWait.current) { clearTimeout(maxWait.current); maxWait.current = null; }
    if (!dirty.current) return queue.current;
    const snapshot = { ...current.current, target: { ...current.current.target } }; dirty.current = false;
    const operation = queue.current.catch(() => {}).then(async () => {
      if (!api) throw new Error('浏览器预览不保存草稿，请打开桌面应用。');
      await api.saveDraft(snapshot.target.id, snapshot.target.language, snapshot.code, snapshot.target.scope);
      if (current.current.code === snapshot.code && `${snapshot.target.id}:${snapshot.target.language}:${snapshot.target.scope}` === currentKey.current) setSaving('已保存到本机');
    });
    queue.current = operation;
    try { await operation; } catch (error) { dirty.current = true; setSaving('保存失败'); reportError.current(errorText(error)); throw error; }
  }, [api]);

  useEffect(() => registerPendingSave('code-draft', flush), [flush]);

  useEffect(() => {
    let alive = true; setReady(false);
    (async () => {
      try {
        const state: WorkspaceData = api ? await api.workspace(target.id, target.language, target.scope) : { problem: previewProblems.find(p => p.id === target.id) || previewProblems[0], latestVersion: 'preview', draft: null, attempt: null, history: [] };
        if (!alive) return;
        const next = state.draft?.code ?? state.problem.content.starter[target.language] ?? '';
        current.current = { target, code: next }; dirty.current = false;
        setWorkspace(state); setCode(next); setSaving(api ? state.draft ? '已恢复本机草稿' : '尚未修改' : '浏览器仅预览'); setReady(true);
      } catch (error) { if (alive) reportError.current(errorText(error)); }
    })();
    return () => { alive = false; };
  }, [api, key]);
  useEffect(() => api?.onClosing(() => {
    navigating.current = true; setSwitching(true); setEditsFrozen(true);
    void (async () => { try { await flushPendingSaves(); while (dirty.current) await flush(); api.closeReady(); }
      catch { /* Keep the window and unsaved text available for retry. */ }
      finally { navigating.current = false; setSwitching(false); setEditsFrozen(false); } })();
  }), [api, flush]);

  const edit = (value: string) => {
    if (navigating.current || editsFrozen()) return;
    setCode(value); current.current = { target, code: value }; dirty.current = true; setSaving('正在保存');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush().catch(() => {}); }, 250);
    if (!maxWait.current) maxWait.current = setTimeout(() => { void flush().catch(() => {}); }, 2000);
  };
  const guarded = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (navigating.current || editsFrozen()) return; navigating.current = true; setSwitching(true);
    try { await flush(); while (dirty.current) await flush(); return await action(); }
    catch (error) { reportError.current(errorText(error)); return undefined; }
    finally { navigating.current = false; setSwitching(false); }
  };
  const open = (next: PracticeTarget, start = true) => guarded(async () => {
    if (api && start) await api.startPractice(next.id, next.language, next.scope);
    if (next.id === target.id && next.language === target.language && next.scope === target.scope) {
      if (api) setWorkspace(await api.workspace(next.id, next.language, next.scope));
    } else setTarget(next);
    return true;
  });
  const refresh = async (expectedKey = key) => { if (api) { const state = await api.workspace(target.id, target.language, target.scope); if (currentKey.current === expectedKey) setWorkspace(state); } };
  const finish = () => guarded(async () => {
    if (!api || !workspace?.attempt) return null;
    const ended = await api.finishPractice(workspace.attempt.id, current.current.code);
    await refresh(); return ended;
  });
  const snapshot = () => ({ ...current.current, target: { ...current.current.target } });
  const acceptDraft = (nextCode: string, expectedKey: string) => { if (currentKey.current !== expectedKey) return; current.current = { ...current.current, code: nextCode }; dirty.current = false; setCode(nextCode); setSaving('已保存到本机'); };
  const acceptRun = (run: RunArchive, expectedKey: string) => { if (currentKey.current === expectedKey) setWorkspace(state => state ? { ...state, history: [run, ...state.history.filter(previous => previous.id !== run.id)] } : state); };
  return { key, target, workspace, code, ready, switching, saving, edit, flush, open, refresh, finish, snapshot, acceptDraft, acceptRun, currentKey };
}
