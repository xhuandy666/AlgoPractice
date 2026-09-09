import { useSyncExternalStore } from 'react';

const saves = new Map<string, () => Promise<unknown>>();
const listeners = new Set<() => void>();
const freezes = new Set<string>();
let frozen = false;
export function registerPendingSave(name: string, save: () => Promise<unknown>) {
  saves.set(name, save);
  return () => { if (saves.get(name) === save) saves.delete(name); };
}
export async function flushPendingSaves() {
  for (const save of [...saves.values()]) await save();
}
export function setEditsFrozen(value: boolean, owner = 'closing') {
  if (value) freezes.add(owner); else freezes.delete(owner);
  frozen = freezes.size > 0; for (const listener of listeners) listener();
}
export function editsFrozen() { return frozen; }
export function useEditsFrozen() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => frozen);
}
