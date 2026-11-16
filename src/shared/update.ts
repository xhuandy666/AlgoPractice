/** Main-process update state. Download paths and updater internals never cross the desktop bridge. */
export interface AppUpdateState {
  currentVersion: string;
  latestVersion: string | null;
  phase: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'up-to-date' | 'error';
  mode: 'native' | 'installer' | 'unsupported' | 'development';
  automatic: boolean;
  checkedAt: string | null;
  publishedAt: string | null;
  releaseUrl: string | null;
  progress: { percent: number; transferred: number; total: number } | null;
  error: string | null;
}
