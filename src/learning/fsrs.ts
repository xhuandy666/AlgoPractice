import { createEmptyCard, fsrs, FSRSVersion, type Card, type FSRSParameters, type Grade } from 'ts-fsrs';
import type { FsrsCardSnapshot, ReviewRating } from '../shared/learning.ts';

export const FSRS_VERSION = 'ts-fsrs@5.4.2/fsrs-6/algopractice-v1';
// Persist the complete parameters, including weights, rather than relying on future library defaults.
export const FSRS_PARAMETERS: FSRSParameters = {
  request_retention: 0.9, maximum_interval: 36500,
  w: [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
    1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542],
  enable_fuzz: false, enable_short_term: true, learning_steps: ['1m', '10m'], relearning_steps: ['10m'],
};
function serialize(card: Card): FsrsCardSnapshot {
  return { ...card, due: card.due.toISOString(), last_review: card.last_review?.toISOString() };
}
function checkLibrary(): void {
  if (FSRSVersion !== 'v5.4.2 using FSRS-6.0') throw new Error('Unsupported installed FSRS version; the pinned scheduling contract must be reviewed');
}
export function newReviewCard(at: string): FsrsCardSnapshot { checkLibrary(); return serialize(createEmptyCard(new Date(at))); }
export function advanceReviewCard(card: FsrsCardSnapshot, at: string, rating: ReviewRating,
  version: string, parameters: unknown): FsrsCardSnapshot {
  checkLibrary();
  if (version !== FSRS_VERSION || JSON.stringify(parameters) !== JSON.stringify(FSRS_PARAMETERS)) {
    throw new Error('Unsupported historical FSRS algorithm or parameters; review history was not changed');
  }
  const scheduler = fsrs(FSRS_PARAMETERS);
  return serialize(scheduler.next({ ...card, due: new Date(card.due), last_review: card.last_review ? new Date(card.last_review) : undefined },
    new Date(at), rating as Grade).card);
}

export function localDate(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
