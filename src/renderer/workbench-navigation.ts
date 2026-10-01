import type { Page } from '../shared/bridge';

export function sidebarAfterNavigation(current: Page, next: Page, collapsed: boolean): boolean {
  if (current === next) return collapsed;
  if (next === 'workbench') return true;
  return current === 'workbench' ? false : collapsed;
}

export function practiceShortcutDirection(event: {
  key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean;
  defaultPrevented: boolean; repeat: boolean; isComposing: boolean;
}, fromEditable: boolean, dialogOpen: boolean): 'previous' | 'next' | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || fromEditable || dialogOpen ||
    !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  return event.key === 'ArrowLeft' ? 'previous' : event.key === 'ArrowRight' ? 'next' : null;
}
