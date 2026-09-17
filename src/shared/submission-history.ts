import type { Language, TerminalStatus } from '../storage/practice-store';
import type { PageRequest } from './learning';
import type { OfficialSubmissionStatus, OfficialVerdict } from './official';

export type SubmissionHistorySource = 'local' | 'official';
export interface SubmissionHistoryFilter extends PageRequest { problemId: string; language: Language; }
/** Lists omit code and judge payloads; opening a record fetches its immutable code separately. */
export interface SubmissionHistoryItem {
  id: string; source: SubmissionHistorySource; attemptId: string; problemId: string; problemVersion: string;
  language: Language; createdAt: string; finishedAt: string | null; codeHash: string;
  status: TerminalStatus | OfficialSubmissionStatus; verdict: OfficialVerdict | null;
  remark: string; remarkRevision: number;
}
export interface SubmissionHistoryDetail extends SubmissionHistoryItem { code: string; }
export interface SaveSubmissionRemarkInput {
  source: SubmissionHistorySource; id: string; remark: string; expectedRevision: number;
}
export interface SubmissionRemark {
  source: SubmissionHistorySource; id: string; remark: string; remarkRevision: number;
}
export const SUBMISSION_REMARK_LIMIT = 240;
