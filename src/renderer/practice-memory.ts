import { isLanguage, type Language } from '../shared/languages.ts';

/** What the learner last worked on, kept per device so a new launch starts where the previous one stopped:
 * the language they chose to write in, the last ordinary practice problem, and the study list they were working through.
 * It only chooses defaults; drafts, attempts and history stay in the database. */
export interface PracticeMemory { language: Language; problemId?: string; listId?: string; listTitle?: string }
/** The built-in sample every installation can open, used when nothing is remembered or the remembered problem is gone. */
export const SAMPLE_PROBLEM_ID = 'array-total';
const KEY = 'algopractice.practice-memory.v1';
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined;

export function parsePracticeMemory(stored: string | null): PracticeMemory {
  try {
    const value = JSON.parse(stored ?? 'null') as Partial<PracticeMemory> | null;
    if (!value || typeof value !== 'object') return { language: 'python' };
    const problemId = text(value.problemId), listId = text(value.listId), listTitle = text(value.listTitle);
    return { language: isLanguage(value.language) ? value.language : 'python', ...(problemId ? { problemId } : {}),
      ...(listId ? { listId, ...(listTitle ? { listTitle } : {}) } : {}) };
  } catch { return { language: 'python' }; }
}
/** After an ordinary practice opened. A study list replaces the remembered one; opening a problem from anywhere else
 * (search, an archive, quick switch) keeps it, because one detour does not end the list being worked through. */
export function withOpenedProblem(memory: PracticeMemory, problemId: string, list?: { id: string; title: string } | null): PracticeMemory {
  const listId = list?.id ?? memory.listId, listTitle = list ? list.title : memory.listTitle;
  return { language: memory.language, problemId, ...(listId ? { listId, ...(listTitle ? { listTitle } : {}) } : {}) };
}
/** Drops what no longer exists: the problem, the list, or both. */
export function withoutMissing(memory: PracticeMemory, missing: { problem?: boolean; list?: boolean }): PracticeMemory {
  return { language: memory.language, ...(memory.problemId && !missing.problem ? { problemId: memory.problemId } : {}),
    ...(memory.listId && !missing.list ? { listId: memory.listId, ...(memory.listTitle ? { listTitle: memory.listTitle } : {}) } : {}) };
}

let current: PracticeMemory | null = null;
export function readPracticeMemory(): PracticeMemory {
  if (current) return current;
  try { current = parsePracticeMemory(localStorage.getItem(KEY)); } catch { current = { language: 'python' }; }
  return current;
}
export function savePracticeMemory(next: PracticeMemory) {
  current = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Stays in memory for this window. */ }
}
