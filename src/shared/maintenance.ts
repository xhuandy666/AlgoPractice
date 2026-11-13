import type { Attachment, LearningSettings } from './learning';
import type { AiProviderConfig } from './ai';

export const AI_PROVIDER_SETTINGS_FILE = 'ai-provider.json';
export const REMINDER_SETTINGS_FILE = 'review-reminder-settings.json';
export const REMINDER_STATE_FILE = 'review-reminder-state.json';
export interface ReminderSettings { enabled: boolean; at: string; quietStart: string; quietEnd: string; }
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = { enabled: true, at: '20:00', quietStart: '22:00', quietEnd: '08:00' };
export interface ReminderStatus {
  settings: ReminderSettings; timeZone: string; localDay: string; dueCount: number;
  phase: 'stopped' | 'disabled' | 'idle' | 'scheduled' | 'quiet' | 'overdue' | 'delivered' | 'failed';
  lastDeliveredAt: string | null; lastError: string | null;
}
export interface ReviewNotification {
  id: string; title: string; body: string; dueCount: number;
  onClick(): void; onFailure(message: string): void;
}
export interface ReviewNotifier { notify(notification: ReviewNotification): void | Promise<void>; dismiss?(id: string): void; }

export type BackupKind = 'manual' | 'automatic' | 'before-restore';
export interface BackupFile { path: string; size: number; sha256: string; }
export interface BackupManifest {
  format: 'algopractice-backup'; formatVersion: 2; appVersion: string; databaseVersion: number;
  id: string; createdAt: string; kind: BackupKind; localDay: string | null; dataFingerprint: string; files: BackupFile[];
}
export interface BackupSettings { learning: LearningSettings; reminders: ReminderSettings; aiProvider: AiProviderConfig | null; }
export interface BackupSnapshot { schemaVersion: number; attachments: Attachment[]; mediaHashes: string[]; learningSettings: LearningSettings; }
export interface BackupSummary { path: string; manifest: BackupManifest; bytes: number; }
/** Result of a manual update check against the project's public GitHub releases. */
export interface UpdateCheck { current: string; latest: string; newer: boolean; url: string; name: string | null; publishedAt: string | null }
/** Copies of the automatic backups in a folder the user chose (e.g. one a cloud client syncs). */
export interface MirrorStatus { directory: string | null; busy: boolean; lastCopy: string | null; lastCopiedAt: string | null; lastError: string | null }
export interface RestoreResult { restored: true; preRestoreBackup: BackupSummary; manifest: BackupManifest; }
export interface RestoreLifecycle {
  hasActiveInterview(): boolean;
  /** Flush renderer drafts, reject new writes and await all run/AI/import/install callbacks. */
  enterMaintenance(): Promise<void>;
  closeDatabase(): void | Promise<void>;
  /** Recreate the store and all dependent services, then validate the opened database. */
  openDatabase(): void | Promise<void>;
  /** Clear only this application's AI credentials and source-site session. */
  clearCredentials(): Promise<void>;
  /** Unlock on failure; reload renderer and reminder settings on success. */
  leaveMaintenance(restored: boolean): void | Promise<void>;
}
export interface BackupServiceOptions {
  dataDirectory: string; appVersion: string;
  snapshotDatabase(destination: string): Promise<unknown>;
  inspectSnapshot(snapshot: string): BackupSnapshot | Promise<BackupSnapshot>;
  getReminderSettings(): ReminderSettings;
  getAiProvider?(): AiProviderConfig | null;
  lifecycle: RestoreLifecycle;
  now?(): Date;
}
