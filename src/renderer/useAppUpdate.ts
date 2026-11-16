import { useSyncExternalStore } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import type { AppUpdateState } from '../shared/update';
import { errorText } from './ui';

type UpdateAction = 'check' | 'download' | 'install' | 'automatic';
interface UpdateSnapshot {
  state: AppUpdateState | null;
  loading: boolean;
  action: UpdateAction | null;
  preferenceBusy: boolean;
  error: string | null;
  failedAction: UpdateAction | null;
  supported: boolean;
}

/** One subscription per bridge. Preferences have their own lock so the user can stop an in-flight download. */
function createUpdateStore(api: DesktopBridge | undefined) {
  const supported = Boolean(api && typeof api.updateState === 'function' && typeof api.onAppUpdate === 'function');
  let snapshot: UpdateSnapshot = { state: null, loading: supported, action: null, preferenceBusy: false, error: null, failedAction: null, supported };
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined, epoch = 0, revision = 0, locked = false, preferenceLocked = false, commandGeneration = 0;
  const publish = (change: Partial<UpdateSnapshot>) => {
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  };
  const receive = (state: AppUpdateState) => {
    revision++;
    publish({ state, loading: false, error: null, ...(state.phase === 'error' ? {} : { failedAction: null }) });
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (listeners.size === 1 && supported && api) {
      const currentEpoch = ++epoch, currentRevision = revision;
      stop = api.onAppUpdate(state => { if (epoch === currentEpoch) receive(state); });
      // Subscribe first: an in-flight initial snapshot must not erase a later progress/completion event.
      void api.updateState().then(state => {
        if (epoch === currentEpoch && revision === currentRevision) receive(state);
      }).catch(error => {
        if (epoch === currentEpoch && revision === currentRevision) publish({ loading: false, error: errorText(error), failedAction: 'check' });
      });
    }
    return () => {
      listeners.delete(listener);
      if (!listeners.size) { epoch++; stop?.(); stop = undefined; }
    };
  };
  async function act(action: Exclude<UpdateAction, 'automatic'>) {
    if (!api || !supported || locked || preferenceLocked || (!snapshot.error && ['checking', 'downloading', 'installing'].includes(snapshot.state?.phase ?? ''))) return;
    const method = action === 'check' ? api.checkForAppUpdate : action === 'download' ? api.downloadAppUpdate
      : api.installAppUpdate;
    if (typeof method !== 'function') return;
    locked = true;
    const currentEpoch = epoch, currentRevision = revision, command = ++commandGeneration;
    publish({ action, error: null, failedAction: null });
    try {
      const state = action === 'check' ? await api.checkForAppUpdate()
          : action === 'download' ? await api.downloadAppUpdate() : await api.installAppUpdate();
      if (state && command === commandGeneration && epoch === currentEpoch && revision === currentRevision) receive(state);
    } catch (error) {
      const phase = snapshot.state?.phase ?? '';
      const newerSuccess = revision !== currentRevision && (action === 'check' && ['available', 'downloading', 'downloaded', 'up-to-date'].includes(phase)
        || action === 'download' && ['downloaded', 'installing'].includes(phase));
      if (command === commandGeneration && epoch === currentEpoch && !newerSuccess) publish({ error: errorText(error), failedAction: action });
    } finally {
      if (command === commandGeneration) { locked = false; publish({ action: null }); }
    }
  }
  async function setAutomatic(enabled: boolean) {
    if (!api || !supported || typeof api.setAutomaticUpdates !== 'function' || preferenceLocked
      || snapshot.action === 'install' || snapshot.state?.phase === 'installing') return;
    preferenceLocked = true;
    // Disabling cancels the backend task. Its old reply/finally must neither restore progress nor release a new lock.
    if (!enabled) { commandGeneration++; revision++; locked = false; }
    const currentEpoch = epoch, currentRevision = revision;
    publish({ preferenceBusy: true, error: null, failedAction: null, ...(!enabled ? { action: null } : {}) });
    try {
      const state = await api.setAutomaticUpdates(enabled);
      if (epoch === currentEpoch && revision === currentRevision) receive(state);
    } catch (error) {
      const newerSuccess = revision !== currentRevision && snapshot.state?.automatic === enabled;
      if (epoch === currentEpoch && !newerSuccess) publish({ error: errorText(error), failedAction: 'automatic' });
    } finally {
      preferenceLocked = false;
      publish({ preferenceBusy: false });
    }
  }
  const retry = () => act(snapshot.failedAction === 'install' ? 'install'
    : snapshot.failedAction === 'download' ? 'download'
      : snapshot.failedAction ? 'check'
        : snapshot.state?.latestVersion && ['native', 'installer'].includes(snapshot.state.mode) ? 'download' : 'check');
  return { subscribe, getSnapshot: () => snapshot, check: () => act('check'), download: () => act('download'), install: () => act('install'),
    setAutomatic, retry };
}

const stores = new WeakMap<DesktopBridge, ReturnType<typeof createUpdateStore>>();
const preview = createUpdateStore(undefined);
export function useAppUpdate(api: DesktopBridge | undefined) {
  let store = api ? stores.get(api) : preview;
  if (!store) { store = createUpdateStore(api); stores.set(api!, store); }
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { ...snapshot, check: store.check, download: store.download, install: store.install, setAutomatic: store.setAutomatic, retry: store.retry };
}
