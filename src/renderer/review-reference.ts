import type { DesktopBridge } from '../shared/bridge.ts';
import type { AnswerFormat } from '../shared/answer-format.ts';
import { LANGUAGES, type Language } from '../shared/languages.ts';
import type { SubmissionHistoryItem, SubmissionHistorySource } from '../shared/submission-history.ts';

/** What a learner checks a recalled approach against during a review: their own latest passing code and their notes on
 * the problem. Recalling and comparing takes minutes; rewriting from scratch stays available in the editor. */
export interface ReviewReferenceCode { source: SubmissionHistorySource; language: Language; answerFormat: AnswerFormat; createdAt: string; code: string }
export interface ReviewReferenceNote { id: string; title: string; markdown: string; updatedAt: string }
export interface ReviewReference { code: ReviewReferenceCode | null; notes: ReviewReferenceNote[] }

/** 3: official Accepted, 2: a local pass in the function format, 1: a local pass of an ACM program, 0: not a solution. */
export function referenceRank(item: Pick<SubmissionHistoryItem, 'source' | 'status' | 'verdict' | 'answerFormat'>): number {
  if (item.source === 'official') return item.verdict === 'accepted' ? 3 : 0;
  return item.status === 'passed' ? item.answerFormat === 'function' ? 2 : 1 : 0;
}
/** From one language's records (newest first): the newest record of the best kind, or null when nothing passed. */
export function pickReferenceRecord<T extends Pick<SubmissionHistoryItem, 'source' | 'status' | 'verdict' | 'answerFormat'>>(items: readonly T[]): T | null {
  let best: T | null = null, rank = 0;
  for (const item of items) { const value = referenceRank(item); if (value > rank) { best = item; rank = value; } }
  return best;
}

type Reader = Pick<DesktopBridge, 'submissionHistory' | 'submissionHistoryDetail' | 'notePage' | 'note'>;
/** An older page can hold the only pass, or an official AC that outranks a recent local pass. Once the newest official
 * AC is found, older pages cannot improve it. Ties keep the newer record from the earlier page. */
async function readReferenceRecord(api: Reader, problemId: string, language: Language): Promise<SubmissionHistoryItem | null> {
  let offset = 0, best: SubmissionHistoryItem | null = null;
  while (true) {
    const page = await api.submissionHistory({ problemId, language, limit: 50, offset });
    const candidate = pickReferenceRecord(page.items);
    if (candidate && (!best || referenceRank(candidate) > referenceRank(best))) best = candidate;
    if ((best && referenceRank(best) === 3) || !page.hasMore) return best;
    if (!page.items.length) throw new Error('历史记录分页不完整，请关闭后重试。');
    offset += page.items.length;
  }
}
/** The language being written now comes first; another language's solution is still better than none. */
export async function loadReviewReference(api: Reader, problemId: string, language: Language): Promise<ReviewReference> {
  let code: ReviewReferenceCode | null = null;
  for (const candidate of [language, ...LANGUAGES.filter(item => item !== language)]) {
    const record = await readReferenceRecord(api, problemId, candidate);
    if (!record) continue;
    const detail = await api.submissionHistoryDetail(record.source, record.id);
    code = { source: detail.source, language: detail.language, answerFormat: detail.answerFormat, createdAt: detail.finishedAt ?? detail.createdAt, code: detail.code };
    break;
  }
  const notes: ReviewReferenceNote[] = [];
  for (const item of (await api.notePage({ kind: 'problem', subjectId: problemId, limit: 5 })).items) {
    const note = await api.note(item.id);
    if (note?.current.markdown.trim()) notes.push({ id: note.id, title: note.current.title, markdown: note.current.markdown, updatedAt: note.updatedAt });
  }
  return { code, notes };
}
