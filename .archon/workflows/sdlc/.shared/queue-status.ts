/**
 * What the merge queue does to the tickets its merges name (AK18h, Grill G5): one rollout after
 * the whole stack, then the loop's own rule (`finalStatus`) for every ticket a merged pull
 * request names, with this run's start as the anchor a claim gives the loop. A merge counts only
 * if GitHub reports it merged after the run started and naming the ticket (`confirmMerge`); one
 * it does not confirm leaves the ticket on Review (or its queue) with a question, as release.ts
 * does. A ticket on its queue or in progress moves only for a pull request that says it delivers it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirmMerge, finalStatus, type PrView, statusName } from './claims.ts';
import { type Jira, todoStatuses, type TrackerConfig } from './jira.ts';
import { askedBefore } from './questions.ts';
import { settleAndMove } from './subtickets.ts';
import { deliveredKeys, prKeys } from './tickets.ts';

export interface MergeRecord { readonly url: string; readonly mergedAt: string; readonly mergeCommit: string }

const mergesFile = (state: string): string => join(state, 'merges.json');
const startFile = (state: string): string => join(state, 'started.json');

/** The merges GitHub confirmed in this run, in order; only merge-action writes them. */
export function readMerges(state: string): MergeRecord[] {
  if (!existsSync(mergesFile(state))) return [];
  const raw = JSON.parse(readFileSync(mergesFile(state), 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${mergesFile(state)} is not a list`);
  return raw.filter((m): m is MergeRecord => typeof m === 'object' && m !== null && typeof (m as { url?: unknown }).url === 'string');
}

/** Appends one confirmed merge; a second record of the same pull request is not added. */
export function recordMerge(state: string, merge: MergeRecord): void {
  const merges = readMerges(state);
  if (merges.some(m => m.url === merge.url)) return;
  writeFileSync(mergesFile(state), `${JSON.stringify([...merges, merge], null, 2)}\n`);
}

/** The run's start, the anchor `confirmMerge` checks each merge against; kept from the first call. */
export function recordStart(state: string, at: number): void {
  if (!existsSync(startFile(state))) writeFileSync(startFile(state), `${JSON.stringify({ at })}\n`);
}

/** The recorded start in ms, or NaN without one (then no merge is confirmed: the safe side). */
export function readStart(state: string): number {
  if (!existsSync(startFile(state))) return Number.NaN;
  const at = (JSON.parse(readFileSync(startFile(state), 'utf8')) as { at?: unknown }).at;
  return typeof at === 'number' ? at : Number.NaN;
}

export interface QueueMove {
  readonly key: string;
  readonly pr: string;
  readonly status: string | null;
  readonly ask: string | null;
}

export function queueStatus(
  merges: readonly { readonly url: string }[],
  deployed: boolean,
  views: ReadonlyMap<string, PrView>,
  tickets: ReadonlyMap<string, string>,
  startedAt: number,
  config: TrackerConfig
): QueueMove[] {
  const moves: QueueMove[] = [];
  // Each move carries forward: a second pull request naming the same ticket sees it where the first
  // meant to leave it (`applyQueueMove` may still hold a slice with open tasks back).
  const now = new Map(tickets);
  for (const { url } of merges) {
    const view = views.get(url) ?? null;
    const delivered = view === null ? [] : deliveredKeys(view, config.project);
    for (const key of view === null ? [] : prKeys(view, config.project)) {
      const current = now.get(key);
      if (current === undefined) continue;
      const queued = todoStatuses(config.status).includes(current);
      // A ticket on its queue or in progress is not finished yet: moving it says it is delivered,
      // so it moves only for a pull request that says so (title, Closes, Fixes, Resolves). One
      // that only refers to it is part of the work and leaves it where it is.
      if ((queued || current === config.status.progress) && !delivered.includes(key)) {
        moves.push({ key, pr: url, status: null, ask: null });
        continue;
      }
      // The queue merges what a review approved: a merge it does not confirm waits on Review
      // (a ticket on its queue stays there, see `doubt`). `delivers` here only keeps
      // `finalStatus` from asking about a rest; which tasks are done is no merge's word
      // (`applyQueueMove` closes none).
      const lap = { pr: url, landed: 'merged', deployed: deployed ? 'true' : 'false', delivers: 'all', tasks: [], reviewed: 'approved', created: {} };
      const confirmed = confirmMerge(lap, view, key, startedAt, config.project);
      // A merge always names its pull request, so a queue is never the answer here.
      const decided = finalStatus(key, current, confirmed, config.status, config.status.todo);
      // A merge GitHub does not confirm: Review stays, a queue ticket stays too; both get the question.
      const doubt = confirmed.landed !== 'merged' && (decided.status !== null || queued);
      if (decided.status !== null) now.set(key, decided.status);
      moves.push({
        key,
        pr: url,
        status: decided.status,
        ask: doubt
          ? `Die Merge-Queue hat ${url} gemergt, GitHub bestätigt das für dieses Ticket nicht (nach Laufstart, Schlüssel im PR). Bitte prüfen.`
          : decided.ask,
      });
    }
  }
  return moves;
}

/**
 * Sets one ticket as `queueStatus` decided, with one comment per run and pull request and the
 * question once per run (this node may run again). A merge does not say which of a slice's
 * tasks are done, only a review does (VAULT-28): none is closed here, so a slice with open tasks
 * stays where it is, and the owner is asked.
 */
export async function applyQueueMove(
  jira: Jira,
  move: QueueMove,
  current: string,
  run: string,
  line: string
): Promise<{ status: string; asked: boolean; notes: string[] }> {
  const s = jira.config.status;
  const settled =
    move.status !== null && move.status !== current
      ? await settleAndMove(jira, move.key, current, move.status, { delivers: 'none', tasks: [] }, null)
      : { status: current, notes: [], left: [] };
  const leftAsk =
    settled.left.length > 0 && move.status !== null
      ? `Offene Tasks (${settled.left.join(', ')}): Die Merge-Queue hat ${move.pr} gemergt, schließt aber keine Tasks, das sagt nur ein Review. Jira lässt das Ticket so nicht auf ${statusName(move.status, s)}. Welche sind erledigt?`
      : null;
  const ask = move.ask !== null && leftAsk !== null ? `${move.ask}\n\n${leftAsk}` : (leftAsk ?? move.ask);
  const comments = await jira.comments(move.key);
  const head = `Merge-Queue: Lauf ${run}. PR: ${move.pr}.`;
  if (!comments.some(comment => comment.body.startsWith(head))) {
    await jira.comment(move.key, `${head} Status: ${statusName(settled.status, s)}.\n\n${line}`);
  }
  if (ask !== null && !askedBefore(comments, ask, line, jira.config)) await jira.ask(move.key, `${ask}\n\n${line}`);
  return { status: settled.status, asked: ask !== null, notes: settled.notes };
}
