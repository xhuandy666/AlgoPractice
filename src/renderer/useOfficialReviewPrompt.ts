import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import type { ReviewOpportunity } from '../shared/review-plan';
import { dateKey } from './learning-calendar';
import { OfficialReviewPromptGuard, revalidateReviewPrompt, type ReviewPromptTicket } from './official-review-prompt';
import { errorText } from './ui';

interface SceneInput { page: string; workspaceKey: string; problemId: string; submitCleaningUp: boolean; blocked: boolean; }
/** Only this run's live event starts a chain. Loading historical records never calls receive(). */
export function useOfficialReviewPrompt(api: DesktopBridge | undefined, scene: SceneInput, onError: (message: string) => void) {
  const [opportunity, setOpportunity] = useState<ReviewOpportunity | null>(null);
  const [resolvedId, setResolvedId] = useState<string | null>(null);
  const guard = useRef(new OfficialReviewPromptGuard());
  const sceneRef = useRef(scene); sceneRef.current = scene;
  const errorRef = useRef(onError); errorRef.current = onError;
  const zone = useRef<string | null>(null);
  const pending = useRef<ReviewPromptTicket | null>(null);
  const resolving = useRef(false);
  const mounted = useRef(false);
  const libraryRevision = useRef(0);
  const promptRef = useRef(opportunity); promptRef.current = opportunity;
  const syncScene = useCallback(() => {
    const current = sceneRef.current;
    guard.current.update({ workspaceKey: `${current.page}:${current.workspaceKey}`, problemId: current.problemId,
      learningDate: zone.current ? dateKey(new Date().toISOString(), zone.current) : '',
      foreground: document.visibilityState === 'visible' && document.hasFocus(),
      blocked: current.page !== 'workbench' || current.blocked || !zone.current || Boolean(document.querySelector('dialog[open], [aria-modal="true"]')) });
  }, []);
  const invalidate = useCallback(() => { guard.current.invalidate(); pending.current = null; }, []);
  const dismiss = useCallback(() => { pending.current = null; setOpportunity(null); }, []);
  const resolve = useCallback(async () => {
    const ticket = pending.current;
    if (!api || !ticket || resolving.current || promptRef.current) return;
    syncScene();
    if (!guard.current.current(ticket)) { pending.current = null; return; }
    // The live event can precede submit()'s finally block. This is the only permitted wait.
    if (sceneRef.current.submitCleaningUp) return;
    resolving.current = true;
    try {
      const value = await api.reviewOpportunityForSubmission(ticket.submissionRecordId);
      syncScene();
      if (!mounted.current || pending.current !== ticket || !guard.current.current(ticket) || !value ||
        value.state !== 'pending' || value.learningDate !== ticket.learningDate || value.problemId !== ticket.problemId) return;
      const claimed = await api.claimReviewOpportunity(value.id);
      syncScene();
      if (!mounted.current || pending.current !== ticket || !guard.current.current(ticket) || claimed?.state !== 'claimed') return;
      const fresh = await revalidateReviewPrompt(claimed,
        () => api.reviewOpportunityForSubmission(ticket.submissionRecordId),
        () => { syncScene(); return mounted.current && pending.current === ticket && guard.current.current(ticket); },
        () => libraryRevision.current);
      if (!fresh) return;
      pending.current = null; promptRef.current = fresh; setOpportunity(fresh);
    } catch (error) { if (mounted.current && guard.current.current(ticket)) errorRef.current(errorText(error)); }
    finally { if (pending.current === ticket) pending.current = null; resolving.current = false; }
  }, [api, syncScene]);
  useEffect(() => {
    mounted.current = true;
    if (!api) return () => { mounted.current = false; invalidate(); };
    let alive = true;
    const loadSettings = () => { void api.learningSettings().then(settings => {
      if (!alive) return;
      if (zone.current && zone.current !== settings.timeZone) invalidate();
      zone.current = settings.timeZone; syncScene();
    }).catch(error => { if (alive) errorRef.current(errorText(error)); }); };
    loadSettings();
    const remove = api.onOfficialEvent(record => {
      syncScene(); const ticket = guard.current.receive(record);
      if (!ticket || pending.current || promptRef.current) return;
      pending.current = ticket; void resolve();
    });
    const changed = api.onLibraryChanged(() => {
      libraryRevision.current++;
      loadSettings();
      const showing = promptRef.current;
      if (showing) void api.problemReviewDetail(showing.problemId).then(detail => {
        if (!alive || promptRef.current?.id !== showing.id) return;
        const fresh = detail.opportunities.items.find(item => item.id === showing.id);
        if (fresh?.state === 'assessed') { promptRef.current = null; setOpportunity(null); setResolvedId(fresh.id); }
      }).catch(error => { if (alive) errorRef.current(errorText(error)); });
    });
    const stopChain = () => { invalidate(); syncScene(); };
    const closing = api.onClosing(stopChain), maintenance = api.onMaintenance(stopChain);
    window.addEventListener('blur', stopChain); document.addEventListener('visibilitychange', stopChain);
    // Date changes consume a waiting chain; the timer never looks for new opportunities.
    const timer = setInterval(syncScene, 30000);
    return () => { alive = false; mounted.current = false; invalidate(); remove(); changed(); closing(); maintenance();
      clearInterval(timer); window.removeEventListener('blur', stopChain); document.removeEventListener('visibilitychange', stopChain); };
  }, [api, invalidate, resolve, syncScene]);
  useEffect(() => { syncScene(); void resolve(); }, [scene.page, scene.workspaceKey, scene.problemId, scene.blocked, scene.submitCleaningUp, resolve, syncScene]);
  return { opportunity, resolvedId, dismiss, invalidate };
}
