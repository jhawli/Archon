/**
 * What the merge queue does to the tickets its merges name (AK18h, Grill G5): one rollout after
 * the whole stack, then the loop's own rule (`finalStatus`) for every ticket a merged pull
 * request names, with this run's start as the anchor a claim gives the loop. A merge counts only
 * if GitHub reports it merged after the run started and naming the ticket (`confirmMerge`); one
 * it does not confirm leaves the ticket on Review with a question, as release.ts does.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirmMerge, finalStatus, type PrView } from './claims.ts';
import type { TrackerConfig } from './jira.ts';
import { prKeys } from './tickets.ts';

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
  // Each move carries forward: a second pull request naming the same ticket sees it where the first left it.
  const now = new Map(tickets);
  for (const { url } of merges) {
    const view = views.get(url) ?? null;
    for (const key of view === null ? [] : prKeys(view, config.project)) {
      const current = now.get(key);
      if (current === undefined) continue;
      const lap = { pr: url, landed: 'merged', deployed: deployed ? 'true' : 'false', delivers: '', created: {} };
      const confirmed = confirmMerge(lap, view, key, startedAt, config.project);
      // A merge always names its pull request, so a queue is never the answer here.
      const decided = finalStatus(key, current, confirmed, config.status, config.status.todo);
      const doubt = confirmed.landed !== 'merged' && decided.status !== null;
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
