/** Self-test inputs the learner typed, kept per device for the problems worked on most recently, so an edge case
 * written yesterday is still there today. Results are never stored. */
const KEY = 'algopractice.self-test-inputs.v1';
export const SELF_TEST_STORED_PROBLEMS = 60, SELF_TEST_STORED_TEXT = 8000;
type Entry = [problemId: string, text: string];

export function parseSelfTestInputs(stored: string | null): Entry[] {
  try {
    const value = JSON.parse(stored ?? '[]') as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is Entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string'
      && entry[1].length <= SELF_TEST_STORED_TEXT).slice(0, SELF_TEST_STORED_PROBLEMS);
  } catch { return []; }
}
/** Most recent first. Blank text, or text too long to keep, forgets the problem's entry. */
export function withSelfTestInput(entries: readonly Entry[], problemId: string, text: string): Entry[] {
  const others = entries.filter(entry => entry[0] !== problemId);
  return (text.trim() && text.length <= SELF_TEST_STORED_TEXT ? [[problemId, text] as Entry, ...others] : others).slice(0, SELF_TEST_STORED_PROBLEMS);
}
let current: Entry[] | null = null;
const entries = () => { if (!current) { try { current = parseSelfTestInputs(localStorage.getItem(KEY)); } catch { current = []; } } return current; };
export function readSelfTestInput(problemId: string): string | undefined { return entries().find(entry => entry[0] === problemId)?.[1]; }
export function saveSelfTestInput(problemId: string, text: string) {
  current = withSelfTestInput(entries(), problemId, text);
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* Stays in memory for this window. */ }
}
