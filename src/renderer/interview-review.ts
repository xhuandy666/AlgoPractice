import type { InterviewView } from '../shared/interview';

/** Problems of an interview whose frozen answer has no local all-pass result: never run, still waiting, not
 * judged (no expected output) or failed. These are the ones worth a rewrite review. A local pass is not an official
 * Accepted, but it is the strongest evidence the session itself has, so only those problems are left out. */
export function unpassedInterviewProblems(view: InterviewView): { id: string; title: string }[] {
  return view.items.filter(row => {
    const answer = row.item.final ?? row.item.accepted;
    return row.runs.filter(run => run.codeHash === answer.codeHash && run.status !== 'queued').at(-1)?.status !== 'passed';
  }).map(row => ({ id: row.item.problem.id, title: row.item.problem.content.title }));
}

/** Adds the problems one by one (each add is idempotent) and stops at the first failure, reporting how many made it. */
export async function addInterviewReviews(add: (problemId: string) => Promise<unknown>, problemIds: readonly string[]): Promise<{ added: number; error?: unknown }> {
  let added = 0;
  for (const id of problemIds) {
    try { await add(id); added++; } catch (error) { return { added, error }; }
  }
  return { added };
}
