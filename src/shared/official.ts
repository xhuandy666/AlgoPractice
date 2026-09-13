import type { Language } from '../storage/practice-store';

export type OfficialSubmissionStatus = 'submitting' | 'judging' | 'paused' | 'completed' | 'unknown' | 'error';
export type OfficialVerdict = 'accepted' | 'wrong_answer' | 'compile_error' | 'runtime_error' | 'timeout' | 'memory_limit' | 'output_limit' | 'internal_error' | 'unknown';
export interface OfficialError {
  code: 'authentication' | 'verification' | 'rate_limit' | 'network' | 'protocol' | 'rejected' | 'interrupted' | 'timeout';
  message: string;
}
/** Only fields actually supplied by the official judge are retained. Missing counts are not zero. */
export interface OfficialJudgeResult {
  status: OfficialVerdict;
  statusCode?: number;
  statusMessage: string;
  passedCases?: number;
  totalCases?: number;
  runtime?: string;
  memory?: string;
  compileError?: string;
  runtimeError?: string;
  input?: string;
  expectedOutput?: string;
  actualOutput?: string;
}
export interface OfficialSubmitInput {
  requestId: string;
  attemptId: string;
  code: string;
  expectedDraftRevision?: number;
}
export interface OfficialSubmission {
  id: string;
  attemptId: string;
  problemId: string;
  problemVersion: string;
  language: Language;
  code: string;
  codeHash: string;
  draftRevision: number;
  slug: string;
  sourceId: string;
  submissionId: string | null;
  status: OfficialSubmissionStatus;
  result: OfficialJudgeResult | null;
  error: OfficialError | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  resultUrl: string | null;
}
export interface BeginOfficialSubmissionInput extends OfficialSubmitInput { slug: string; sourceId: string; }
export interface OfficialSubmissionUpdate {
  status: OfficialSubmissionStatus;
  submissionId?: string;
  result?: OfficialJudgeResult;
  error?: OfficialError;
}
