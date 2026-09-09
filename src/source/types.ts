import type { ProblemContent } from '../shared/library.ts';
import type { ObjectValue } from './errors.ts';

export type SourceKind = 'study-plan' | 'public-list' | 'problem';
export interface SourceReference { provider: 'leetcode-cn'; kind: SourceKind; slug: string; canonicalUrl: string; sourceKey: string; }
export interface ProblemReference {
  sourceKey: string; slug: string; sourceId: string; frontendId: string; title: string;
  translatedTitle: string | null; difficulty: string; premiumOnly: boolean; canonicalUrl: string;
}
export interface Observation {
  fetchedAt: string; httpStatus: number; responseBytes: number; responseSha256: string; buildId: string | null;
  transport: 'public-html-embedded-data' | 'site-graphql'; authentication: 'none' | 'session-transport';
}
export interface SourcePlan {
  source: SourceReference; name: string; premiumOnly: boolean;
  sections: Array<{ slug: string; name: string; declaredCount: number; questions: ProblemReference[] }>;
  itemCount: number; uniqueItemCount: number; duplicateSourceKeys: string[];
  completeness: 'matches-embedded-section-counts' | 'matches-declared-total-and-pagination';
  pagination: 'all-members-embedded-in-one-response' | 'offset-pages-verified';
  observation: Observation; observations?: Observation[]; visibility?: 'public' | 'private'; sourceRevision?: string;
}
export interface SourceProblemMetadata {
  source: SourceReference; problem: ProblemReference;
  fields: { statement: boolean; translatedStatement: boolean; functionMetadata: boolean; sampleCases: boolean };
  functionSignature: { name: string | null; parameterTypes: string[]; returnType: string | null } | null;
  templates: Array<{ language: 'python3' | 'java'; characterCount: number; sha256: string }>;
  observation: Observation;
  limitation: 'metadata-only; no statement, sample text, or template body retained';
}
export interface SourceProblemContent {
  content: ProblemContent; reference: SourceReference; capability: 'link-only' | 'statement-only' | 'execution-only' | 'sample-verified';
  warnings: string[]; observation: Observation; rawMetadata: ObjectValue | null;
}
export interface SourceAdapter {
  fetchPlan(input: string | SourceReference, options?: FetchOptions): Promise<SourcePlan>;
  fetchProblem(input: string | SourceReference, options?: FetchOptions): Promise<SourceProblemMetadata>;
}
export interface FetchOptions { signal?: AbortSignal; }
export type ImportInput = { kind: 'url' | 'links' | 'csv' | 'json'; text: string; name?: string };
export interface ImportPreviewItem {
  key: string; problemId: string; sourceUrl?: string; title: string; difficulty: string; tags: string[];
  chapterId: string; order: number; premiumOnly?: boolean; content?: ProblemContent;
}
export interface ImportIssue { inputIndex?: number; code: string; message: string; }
export interface ImportDuplicate { inputIndex: number; key: string; reason: string; }
export interface ImportPreview {
  inputKind: ImportInput['kind']; source: 'leetcode-cn' | 'file' | 'links'; listTitle: string; sourceUrl?: string;
  chapters: Array<{ id: string; title: string; order: number }>; items: ImportPreviewItem[];
  duplicates: ImportDuplicate[]; errors: ImportIssue[]; warnings: string[]; complete: boolean;
}
export interface ParsedImport {
  inputKind: ImportInput['kind']; listTitle: string; warnings: string[]; errors: ImportIssue[];
  entries: Array<{ inputIndex: number; reference?: SourceReference; title?: string; difficulty?: string; tags: string[]; chapter: string; content?: ProblemContent }>;
}
