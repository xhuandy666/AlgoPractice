import type { Language } from '../runner/types';
import type { LibraryProblem } from './library';
import type { ProblemListItem } from './learning';
import type { Attempt, Draft, StoredRun } from '../storage/practice-store';
export interface CompanyEntry { company: string; normalizedCompany: string; problemId: string; url: string | null; sourceUrl: string | null; dataDate: string | null; window: string | null; frequency: number | null; rawFrequency: string | null; frequencyMeaning: string | null; }
export interface CompanyDataset { id: string; name: string; fileHash: string; importedAt: string; entries: CompanyEntry[]; }
export interface CompanyPreview { dataset: CompanyDataset; errors: string[]; duplicates: number; missingProblemIds: string[]; }
export interface InterviewRules { mode: 'strict' | 'coached'; language: Language; durationMinutes: number; counts: { easy: number; medium: number; hard: number }; tags: string[]; company: string | null; datasetId: string | null; excludeRecentDays: number; sampling: 'uniform' | 'frequency'; seed: string; }
export interface InterviewCandidate { problem: LibraryProblem | ProblemListItem; difficulty: 'easy' | 'medium' | 'hard'; weight: number; }
export interface InterviewPool { algorithmVersion: string; rules: InterviewRules; evaluatedAt: string; candidates: InterviewCandidate[]; selectedIds: string[]; dataset: CompanyDataset | null; exclusions: { problemId: string; reason: string }[]; shortages: string[]; }
export interface InterviewAnswer { code: string; codeHash: string; revision: number; savedAt: string; reasoning: string; }
export interface InterviewItem { problem: LibraryProblem; attemptId: string; scopeId: string; accepted: InterviewAnswer; final: InterviewAnswer | null; }
export interface InterviewHelp { at: string; kind: string; reference: string | null; }
export interface InterviewSession { id: string; requestId: string; pool: InterviewPool; mode: 'strict' | 'coached'; initialMode: 'strict' | 'coached'; startedAt: string; deadlineAt: string; lastObservedAt: string; endedAt: string | null; endReason: 'manual' | 'deadline' | 'clock-anomaly' | null; clockAnomalies: string[]; modeChanges: { at: string; from: 'strict'; to: 'coached' }[]; help: InterviewHelp[]; items: InterviewItem[]; }
export interface InterviewItemView { item: InterviewItem; attempt: Attempt; draft: Draft | null; runs: StoredRun[]; aiHelp: {requestId: string; level: string; status: string; createdAt: string; finishedAt: string | null; duringSession: boolean}[]; recap: Draft | null; recapReasoning: string | null; }
export interface InterviewView { session: InterviewSession; items: InterviewItemView[]; remainingMs: number; }
export interface InterviewSaveResult { counted: boolean; answer: InterviewAnswer; recap: Draft | null; }
export const defaultInterviewRules: InterviewRules = { mode: 'strict', language: 'python', durationMinutes: 45, counts: { easy: 0, medium: 1, hard: 0 }, tags: [], company: null, datasetId: null, excludeRecentDays: 14, sampling: 'uniform', seed: '' };
