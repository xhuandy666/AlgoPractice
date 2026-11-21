import type { DesktopBridge } from '../shared/bridge.ts';
import type { PracticeMemory } from './practice-memory.ts';

/** Where the home page sends a returning learner in one step: back to the problem they have not solved yet, or on to
 * the first problem they have not opened in the study list they were working through. */
export interface ResumeChoice { kind: 'continue' | 'next'; problemId: string; title: string; list?: { id: string; title: string } }
export interface ResumeResult { choice: ResumeChoice | null; missing: { problem?: boolean; list?: boolean } }

/** `lists` are the study lists that exist now; a remembered list that is gone is reported as missing and never queried. */
export async function resolveResume(api: Pick<DesktopBridge, 'problemPage'>, memory: PracticeMemory, lists: readonly { id: string; title: string }[]): Promise<ResumeResult> {
  const missing: ResumeResult['missing'] = {};
  const list = memory.listId ? lists.find(item => item.id === memory.listId) : undefined;
  if (memory.listId && !list) missing.list = true;
  if (memory.problemId) {
    const item = (await api.problemPage({ ids: [memory.problemId], limit: 1 })).items[0];
    if (!item) missing.problem = true;
    else if (!item.practice?.solved) return { choice: { kind: 'continue', problemId: item.id, title: item.content.title, ...(list ? { list: { id: list.id, title: list.title } } : {}) }, missing };
  }
  if (list) {
    const next = (await api.problemPage({ listId: list.id, practice: 'unpracticed', limit: 1 })).items[0];
    if (next) return { choice: { kind: 'next', problemId: next.id, title: next.content.title, list: { id: list.id, title: list.title } }, missing };
  }
  return { choice: null, missing };
}
