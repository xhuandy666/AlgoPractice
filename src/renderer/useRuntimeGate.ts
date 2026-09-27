import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge, RunPreparation, RuntimeProgress } from '../shared/bridge';
import type { AnswerFormat } from '../shared/answer-format';
import type { Language } from '../runner/types';
import { errorText } from './ui';

interface Input { problemId: string; language: Language; code: string; scope: string; version: string; answerFormat?: AnswerFormat; fingerprint: string; }
interface Pending { input: Input; prepared: RunPreparation; execute(token: string): Promise<void>; valid: boolean; }
export function useRuntimeGate(api: DesktopBridge | undefined, fingerprint: () => string, onError: (message: string) => void) {
  const [pending, setPending] = useState<Pending | null>(null);
  const current = useRef<Pending | null>(null), getFingerprint = useRef(fingerprint); getFingerprint.current = fingerprint;
  const [progress, setProgress] = useState<Partial<Record<Language, RuntimeProgress>>>({});
  const [installing, setInstalling] = useState<Partial<Record<Language, boolean>>>({});
  const installTasks = useRef(new Map<Language, Promise<void>>());
  const isInstalling = (language: Language) => installTasks.current.has(language);
  const [checking, setChecking] = useState(false), checkingRef = useRef(false);
  const [error, setError] = useState(''); const generation = useRef(0);
  const valid = (entry: Pending) => current.current === entry && entry.valid && getFingerprint.current() === entry.input.fingerprint;
  const invalidate = () => {
    generation.current++;
    const entry = current.current;
    if (entry) { entry.valid = false; void api?.cancelPreparedRun(entry.prepared.token).catch(() => {}); setPending({ ...entry }); }
  };
  useEffect(() => api?.onRuntimeProgress(value => setProgress(previous => ({ ...previous, [value.language]: value }))), [api]);
  useEffect(() => {
    const closing = api?.onClosing(invalidate), maintenance = api?.onMaintenance(invalidate);
    return () => { closing?.(); maintenance?.(); const entry = current.current; if (entry) void api?.cancelPreparedRun(entry.prepared.token).catch(() => {}); };
  }, [api]);
  async function continueReady(entry: Pending) {
    if (!valid(entry)) { entry.valid = false; if (current.current === entry) setPending({ ...entry }); await api?.cancelPreparedRun(entry.prepared.token); return; }
    current.current = null; setPending(null);
    try { await entry.execute(entry.prepared.token); } catch (failure) { onError(errorText(failure)); }
  }
  async function install(offline = false, entry = current.current) {
    if (!api || !entry) return;
    const language = entry.input.language;
    // Two clicks must share one continuation, not just one backend download.
    if (installTasks.current.has(language)) return installTasks.current.get(language);
    const task = (async () => {
    setError(''); setProgress(previous => ({ ...previous, [language]: undefined })); setInstalling(previous => ({ ...previous, [language]: true }));
    try {
      if (await api.installRuntime(language, offline) === false) { invalidate(); return; }
      entry.prepared.runtime = await api.runtimePreflight(language);
      if (entry.prepared.runtime.status !== 'ready') throw new Error(entry.prepared.runtime.message);
      await continueReady(entry);
    } catch (failure) { if (current.current === entry) setError(errorText(failure)); }
    finally { setInstalling(previous => ({ ...previous, [language]: false })); if (current.current === entry) setPending({ ...entry }); }
    })().finally(() => installTasks.current.delete(language));
    installTasks.current.set(language, task); return task;
  }
  async function request(input: Input, execute: Pending['execute']) {
    // An active installation owns its original continuation. Do not replace it
    // with a new token that the existing task cannot safely resume.
    if (!api || checkingRef.current || isInstalling(input.language)) return;
    invalidate(); const revision = generation.current; checkingRef.current = true; setChecking(true); setError('');
    try {
      const prepared = await api.prepareRun(input.problemId, input.language, input.code, input.scope, input.version, input.answerFormat);
      if (revision !== generation.current || getFingerprint.current() !== input.fingerprint) { await api.cancelPreparedRun(prepared.token); return; }
      const entry: Pending = { input, prepared, execute, valid: true }; current.current = entry; setPending(entry);
      if (prepared.runtime.status === 'ready') await continueReady(entry);
      else if (prepared.autoInstall && prepared.runtime.status === 'missing' && prepared.runtime.source !== 'selected') void install(false, entry);
    } catch (failure) { onError(errorText(failure)); }
    finally { checkingRef.current = false; setChecking(false); }
  }
  async function select() {
    const entry = current.current; if (!api || !entry) return;
    try { if (await api.setRuntime(entry.input.language) === false) { invalidate(); return; } entry.prepared.runtime = await api.runtimePreflight(entry.input.language); if (entry.prepared.runtime.status === 'ready') await continueReady(entry); else if (current.current === entry) setPending({ ...entry }); }
    catch (failure) { setError(errorText(failure)); }
  }
  const dismiss = () => { invalidate(); current.current = null; setPending(null); setError(''); };
  const cancel = async () => { const entry = current.current; invalidate(); if (api && entry) { try { await api.cancelInstall(entry.input.language); } catch (failure) { setError(errorText(failure)); } } };
  const setAutoInstall = async (enabled: boolean) => { if (!api) return; try { await api.setAutoInstallRuntimes(enabled); const entry = current.current; if (entry) { entry.prepared.autoInstall = enabled; setPending({ ...entry }); } } catch (failure) { setError(errorText(failure)); } };
  return { pending, checking, progress, installing, isInstalling, error, request, install, select, dismiss, cancel, setAutoInstall, invalidate,
    intentCurrent: pending ? valid(current.current ?? pending) : false };
}
