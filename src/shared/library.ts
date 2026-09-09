import type { Adapter, Language, TestCase } from '../runner/types';

export type ProblemSource = 'local' | 'leetcode-cn' | 'file';

/** Content capabilities are evidence, not a precomputed "runnable" promise. */
export interface ProblemContent {
  id: string;
  title: string;
  difficulty: string;
  tags: string[];
  sourceUrl?: string;
  sourceId?: string;
  description: string;
  descriptionFormat: 'plain' | 'html';
  constraints: string[];
  mode: 'function' | 'acm';
  acmCompare?: 'normalized' | 'exact';
  adapter?: Adapter;
  cases: TestCase[];
  starter: Partial<Record<Language, string>>;
  supportReason?: string;
  media?: { complete: boolean; missingUrls: string[] };
  source: ProblemSource;
}

export interface LibraryProblem {
  id: string;
  version: string;
  content: ProblemContent;
  createdAt: string;
  updatedAt: string;
}

export interface ListChapter {
  id: string;
  title: string;
  parentId?: string;
  position: number;
}

export interface StudyListItem {
  key: string;
  problemId: string;
  chapterId?: string;
  position: number;
}

export interface ListSnapshotInput {
  id: string;
  title: string;
  source: ProblemSource;
  sourceUrl?: string;
  chapters: ListChapter[];
  items: StudyListItem[];
  /** True only after all membership pages were read. Content fetch failures do not imply incomplete membership. */
  membershipComplete: boolean;
}

export interface StudyList extends Omit<ListSnapshotInput, 'membershipComplete'> {
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListRefreshPreview {
  id: string;
  listId: string;
  baseRevision: number;
  candidate: ListSnapshotInput;
  added: StudyListItem[];
  removed: StudyListItem[];
  moved: Array<{ before: StudyListItem; after: StudyListItem }>;
  canApply: boolean;
  reason?: string;
  appliedAt: string | null;
}

export type ImportItemStatus = 'pending' | 'running' | 'imported' | 'reused' | 'link_only' | 'restricted' | 'failed' | 'skipped';
export type ImportJobStatus = 'pending' | 'running' | 'paused' | 'cancelled' | 'completed' | 'completed_with_errors';

export interface ImportError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ImportItemSeed {
  key: string;
  problemId: string;
  title: string;
  sourceUrl?: string;
  chapterId?: string;
  position: number;
}

export interface ImportItem extends ImportItemSeed {
  status: ImportItemStatus;
  version: string | null;
  error: ImportError | null;
  attempts: number;
  updatedAt: string;
}

export interface CreateImportJobInput {
  id?: string;
  /** Stable request id. Same key with different input is rejected. */
  requestKey?: string;
  title: string;
  input: string;
  source: ProblemSource;
  sourceUrl?: string;
  list?: ListSnapshotInput;
  items: ImportItemSeed[];
}

export interface ImportJob {
  id: string;
  requestKey: string;
  title: string;
  input: string;
  source: ProblemSource;
  sourceUrl?: string;
  list?: ListSnapshotInput;
  status: ImportJobStatus;
  items: ImportItem[];
  counts: Record<ImportItemStatus, number>;
  total: number;
  error: ImportError | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportItemUpdate {
  status: ImportItemStatus;
  /** When present, content/version and item completion are committed together. */
  content?: ProblemContent;
  error?: ImportError | null;
}

export interface ImportJobUpdate {
  status: ImportJobStatus;
  /** Explicit retry resets only failed/restricted items. Successfully imported content is retained. */
  retryFailed?: boolean;
  error?: ImportError | null;
}
