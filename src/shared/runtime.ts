/** Presentation-safe runtime metadata. Probing and installation stay in the main process. */
export interface RuntimeArtifactInfo {
  version: string;
  source: string;
  downloadBytes: number;
  expandedBytes: number | null;
  peakBytes: number | null;
}

export interface RuntimeState {
  status: 'ready' | 'missing' | 'incompatible' | 'error';
  source: 'selected' | 'managed' | 'discovered' | null;
  path: string | null;
  version: string | null;
  message: string;
  managedInstalled: boolean;
  installedBytes: number | null;
  artifact: RuntimeArtifactInfo | null;
}
