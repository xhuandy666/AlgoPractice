import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import { dateKey } from './learning-calendar';
import { celebrate, onRewardActivity } from './reward-bus';
import { firstTimeChanges, markProfile, profileChanges, rewardProfile, type RewardMarks, type RewardProfile } from './rewards';

type Announce = 'all' | 'milestones' | 'none';
const stronger = (a: Announce, b: Announce): Announce => a === 'all' || b === 'all' ? 'all' : a === 'milestones' || b === 'milestones' ? 'milestones' : 'none';

const MARKS_KEY = 'algo-reward-marks-v1';
let marks: RewardMarks | null = null;
function readMarks(): RewardMarks {
  if (marks) return marks;
  try {
    const value = JSON.parse(localStorage.getItem(MARKS_KEY) ?? 'null') as Partial<RewardMarks> | null;
    marks = { level: Number.isInteger(value?.level) ? value!.level! : 0, achievements: Array.isArray(value?.achievements) ? value.achievements.filter(id => typeof id === 'string') : [] };
  } catch { marks = { level: 0, achievements: [] }; }
  return marks;
}
function saveMarks(next: RewardMarks) {
  marks = next;
  try { localStorage.setItem(MARKS_KEY, JSON.stringify(next)); } catch { /* Marks stay in memory for this window. */ }
}

/** Reads durable statistics and turns forward progress into celebrations.
 * Passive refreshes only announce milestones, so focus minutes do not spam experience popups. */
export function useRewardProfile(api: DesktopBridge | undefined) {
  const [profile, setProfile] = useState<RewardProfile | null>(null);
  const previous = useRef<RewardProfile | null>(null), generation = useRef(0), pending = useRef<Announce>('none'), inFlight = useRef<Announce>('none');
  const refresh = useCallback(async (announce: Announce) => {
    if (!api) return;
    const current = ++generation.current;
    inFlight.current = stronger(inFlight.current, announce);
    const [statistics, settings] = await Promise.all([api.learningStatistics(), api.learningSettings()]);
    if (current !== generation.current) return;
    const effective = inFlight.current; inFlight.current = 'none';
    const next = rewardProfile(statistics, dateKey(new Date().toISOString(), settings.timeZone));
    const before = previous.current; previous.current = next; setProfile(next);
    const seen = readMarks(); saveMarks(markProfile(seen, next));
    if (!before || effective === 'none') return;
    for (const change of firstTimeChanges(profileChanges(before, next), seen)) {
      if (change.kind === 'xp') { if (effective === 'all') celebrate(change); }
      else if (change.kind === 'level-up') celebrate({ kind: 'level-up', level: change.level, rankId: change.rank.id, rankName: change.rank.name, rankChanged: change.rankChanged });
      else if (change.kind === 'achievement') celebrate({ kind: 'achievement', title: change.achievement.title, description: change.achievement.description, icon: change.achievement.icon });
      else celebrate(change);
    }
  }, [api]);
  useEffect(() => {
    if (!api) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (announce: Announce, delay: number) => {
      pending.current = stronger(pending.current, announce);
      clearTimeout(timer);
      timer = setTimeout(() => { const value = pending.current; pending.current = 'none'; void refresh(value).catch(() => {}); }, delay);
    };
    void refresh('none').catch(() => {});
    const removeActivity = onRewardActivity(() => schedule('all', 280));
    const removeLibrary = api.onLibraryChanged(() => schedule('milestones', 900));
    const interval = setInterval(() => { if (document.visibilityState === 'visible') schedule('milestones', 0); }, 60000);
    return () => { generation.current++; inFlight.current = 'none'; clearTimeout(timer); clearInterval(interval); removeActivity(); removeLibrary(); };
  }, [api, refresh]);
  return profile;
}
