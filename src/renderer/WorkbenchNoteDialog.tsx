import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import type { ConfirmNoteInput, Note, NoteListItem, SaveNoteInput } from '../shared/learning';
import { MarkdownEditor } from './MarkdownEditor';
import { noteTitle } from './markdown-editing';
import { editsFrozen, registerPendingSave, useEditsFrozen } from './pending-saves';
import { dateTime, errorText } from './ui';

type Draft = { noteId?: string; title: string; markdown: string; tags: string[]; attachmentHashes: string[]; version: number; state: 'draft' | 'confirmed' };
type PendingWrite = { revision: number } & ({ kind: 'save'; input: SaveNoteInput } | { kind: 'confirm'; input: ConfirmNoteInput });
const emptyDraft = (): Draft => ({ title: '', markdown: '', tags: [], attachmentHashes: [], version: 0, state: 'draft' });
const fromNote = (note: Note): Draft => ({ noteId: note.id, title: note.current.title, markdown: note.current.markdown, tags: note.current.tags, attachmentHashes: note.current.attachmentHashes, version: note.latestVersion, state: note.current.state });

export function WorkbenchNoteDialog({ api, problem, initialNoteId, onClose, onError }: {
  api: DesktopBridge | undefined; problem: { id: string; title: string }; initialNoteId?: string; onClose: () => void; onError: (message: string) => void;
}) {
  const headingId = useId(); const dialog = useRef<HTMLDialogElement>(null); const titleInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft); const current = useRef(draft);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notes, setNotes] = useState<NoteListItem[]>([]); const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(''); const [failure, setFailure] = useState(''); const [busy, setBusy] = useState(false);
  const dirty = useRef(0); const saved = useRef(0); const mounted = useRef(true); const operation = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null); const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxWait = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<PendingWrite | null>(null); const frozen = useEditsFrozen();
  const report = useRef(onError); report.current = onError;

  const clearTimers = useCallback(() => { if (timer.current) clearTimeout(timer.current); if (maxWait.current) clearTimeout(maxWait.current); timer.current = maxWait.current = null; }, []);
  const persist = useCallback(async (confirm = false) => {
    clearTimers();
    if (inFlight.current) await inFlight.current;
    if (!api) { if (dirty.current !== saved.current) throw new Error('请在桌面应用中保存笔记。'); return; }
    const task = (async () => {
      while (pending.current || dirty.current !== saved.current || (confirm && current.current.state !== 'confirmed')) {
        const value = current.current;
        if (!value.noteId && !value.title.trim() && !value.markdown.trim() && !value.attachmentHashes.length && !pending.current) {
          saved.current = dirty.current; if (mounted.current) setStatus(''); break;
        }
        pending.current ??= confirm && dirty.current === saved.current && value.noteId
          ? { revision: dirty.current, kind: 'confirm', input: { requestId: crypto.randomUUID(), noteId: value.noteId, version: value.version, expectedVersion: value.version } }
          : { revision: dirty.current, kind: 'save', input: {
          requestId: crypto.randomUUID(), ...(value.noteId ? { noteId: value.noteId, expectedVersion: value.version } : {}),
          kind: 'problem', subjectId: problem.id, title: noteTitle(value.title, value.markdown, problem.title), markdown: value.markdown,
          tags: value.tags, attachmentHashes: value.attachmentHashes, origin: 'user', state: 'draft',
        } };
        const submission = pending.current;
        if (mounted.current) setStatus(submission.kind === 'confirm' || submission.input.state === 'confirmed' ? '正在保存笔记…' : '正在保存草稿…');
        try {
          const note = await (submission.kind === 'confirm' ? api.confirmNote(submission.input) : api.saveNote(submission.input));
          saved.current = submission.revision; pending.current = null;
          current.current = { ...current.current, noteId: note.id, version: note.latestVersion, state: dirty.current === submission.revision ? note.current.state : 'draft' };
          if (mounted.current) {
            setDraft(current.current); setFailure(''); setStatus(dirty.current === saved.current ? note.current.state === 'confirmed' ? '笔记已保存' : '草稿已保存' : '有未保存修改');
            setNotes(rows => [note, ...rows.filter(row => row.id !== note.id)]);
          }
        } catch (error) {
          if (errorText(error).includes('NOTE_WRITE_REJECTED:')) pending.current = null;
          if (mounted.current) { setStatus('保存失败'); setFailure('内容仍保留在此处，请重试保存。'); }
          throw error;
        }
      }
    })();
    inFlight.current = task;
    try { await task; } finally { if (inFlight.current === task) inFlight.current = null; }
  }, [api, problem.id, problem.title, clearTimers]);

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current; element?.showModal();
    const remove = registerPendingSave(`题目笔记 ${problem.id}`, () => persist());
    return () => { mounted.current = false; remove(); clearTimers(); element?.close(); previousFocus?.focus({ preventScroll: true }); };
  }, [persist, clearTimers, problem.id]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!api) return;
      // The first user draft in descending update order is the one to resume.
      const rows: NoteListItem[] = []; let offset = 0; let candidate: NoteListItem | undefined;
      do {
        const page = await api.notePage({ kind: 'problem', subjectId: problem.id, offset, limit: 100 });
        rows.push(...page.items); candidate = initialNoteId ? undefined : page.items.find(note => note.current.origin === 'user' && note.current.state === 'draft');
        if (initialNoteId || candidate || !page.hasMore) break; offset += page.items.length;
      } while (alive);
      const detail = initialNoteId || candidate ? await api.note(initialNoteId || candidate!.id) : null;
      if (initialNoteId && !detail) throw new Error('这篇笔记已不存在。');
      if (detail && (detail.kind !== 'problem' || detail.subjectId !== problem.id)) throw new Error('这篇笔记不属于当前题目。');
      if (!alive) return;
      setNotes(rows);
      if (detail) { const value = fromNote(detail); current.current = value; setDraft(value); setStatus(detail.current.state === 'confirmed' ? '已保存的笔记' : '已恢复草稿'); }
    })().catch(error => { if (alive) { setLoadFailed(true); setStatus('读取失败'); setFailure('未能读取本题笔记，关闭后可重新打开。'); report.current(errorText(error)); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, problem.id, initialNoteId]);
  useLayoutEffect(() => { if (!loading) titleInput.current?.focus({ preventScroll: true }); }, [loading]);

  function edit(patch: Partial<Pick<Draft, 'title' | 'markdown'>>) {
    if (operation.current || loading || loadFailed || editsFrozen()) return;
    current.current = { ...current.current, ...patch, state: 'draft' }; setDraft(current.current); dirty.current++; setStatus('有未保存修改');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void persist().catch(error => report.current(errorText(error))); }, 700);
    if (!maxWait.current) maxWait.current = setTimeout(() => { void persist().catch(error => report.current(errorText(error))); }, 2000);
  }
  async function action(task: () => Promise<void>) {
    if (operation.current || editsFrozen()) return;
    operation.current = true; setBusy(true);
    try { await task(); } catch (error) { report.current(errorText(error)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  function close() { void action(async () => { await persist(); onClose(); }); }
  async function select(noteId?: string) {
    await persist();
    const detail = noteId ? await api?.note(noteId) : null;
    if (noteId && !detail) throw new Error('这篇笔记已不存在，请重新打开笔记窗口。');
    if (detail && (detail.kind !== 'problem' || detail.subjectId !== problem.id)) throw new Error('这篇笔记不属于当前题目。');
    const value = detail ? fromNote(detail) : emptyDraft();
    current.current = value; setDraft(value); dirty.current = saved.current = 0; pending.current = null;
    setFailure(''); setStatus(detail ? detail.current.state === 'confirmed' ? '已保存的笔记' : '已恢复草稿' : '');
  }
  const disabled = loading || loadFailed || busy || frozen || !api;
  const hasContent = Boolean(draft.title.trim() || draft.markdown.trim() || draft.attachmentHashes.length);
  return <dialog ref={dialog} className="workbench-note-dialog" aria-labelledby={headingId} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="workbench-note-header"><div><span className="workbench-note-eyebrow">题目笔记</span><h2 id={headingId}>记笔记</h2><p className="workbench-note-subject">{problem.title}</p></div><button type="button" className="workbench-note-close" aria-label="关闭笔记" disabled={busy || frozen} onClick={close}>×</button></div>
    <div className="workbench-note-content">
      {notes.length > 0 && <details className="workbench-note-library"><summary>本题笔记 <span>{notes.length}</span></summary><div className="workbench-note-picker"><label>打开笔记<select aria-label="本题笔记" value={draft.noteId || ''} disabled={disabled} onChange={event => { const id = event.target.value; void action(() => select(id || undefined)); }}><option value="">新笔记</option>{notes.map(note => <option key={note.id} value={note.id}>{note.current.title} · {note.current.state === 'confirmed' ? '已保存' : '草稿'} · {dateTime(note.updatedAt)}</option>)}</select></label><button type="button" className="text-button" disabled={disabled} onClick={() => { void action(() => select()); }}>新笔记</button></div></details>}
      <label className="workbench-note-title">标题 <span>可选</span><input ref={titleInput} autoFocus aria-label="笔记标题（可选）" value={draft.title} maxLength={300} disabled={disabled} placeholder="留空时根据正文或题目命名" onChange={event => edit({ title: event.target.value })} /></label>
      <MarkdownEditor value={draft.markdown} disabled={disabled} onChange={markdown => edit({ markdown })} onOpenLink={url => { void api?.openWebLink(url).catch(error => report.current(errorText(error))); }} onAttachment={hash => { void api?.exportAttachment(hash).catch(error => report.current(errorText(error))); }} />
    </div>
    <div className="workbench-note-footer"><div className="workbench-note-save-state" role="status"><span className={failure ? 'error-text' : 'local-status'}>{loading ? '正在读取笔记…' : status || '自动保存草稿'}</span>{failure && <span className="error-text">{failure}</span>}</div><div className="compact-actions">{failure && !loadFailed && <button className="text-button" disabled={disabled} onClick={() => { void action(() => persist()); }}>重试保存</button>}<button className="button" disabled={busy || frozen} onClick={close}>关闭</button><button className="button primary" disabled={disabled || !hasContent} onClick={() => { void action(async () => { await persist(true); onClose(); }); }}>保存笔记</button></div></div>
  </dialog>;
}
