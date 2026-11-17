/**
 * Jira ticket keys as the pack reads them. A ticket is `CONC-12`, a pull request stays `#12`:
 * two namespaces, so a ticket is never mistaken for a pull request with the same number.
 *
 * `project` is the key prefix from `.archon/tracker.json`; `trackerConfig` only accepts
 * `[A-Z][A-Z0-9]+`, so it is safe inside a regular expression.
 */
import type { TrackerConfig } from './jira.ts';

const KEY = /^[A-Z][A-Z0-9]+-[1-9]\d*$/;

export function isTicketKey(value: string): boolean {
  return KEY.test(value.trim());
}

/** The key in a ticket URL (`<site>/browse/CONC-12`), or null for anything else. */
export function ticketKeyOf(url: string, config: TrackerConfig): string | null {
  const match = /^(https:\/\/[^/]+)\/browse\/([A-Z][A-Z0-9]+-[1-9]\d*)\/?(?:[?#].*)?$/.exec(url.trim());
  if (match === null) return null;
  const [, site, key] = match;
  return site === config.site && key?.startsWith(`${config.project}-`) ? key : null;
}

export function ticketUrl(key: string, config: TrackerConfig): string {
  return `${config.site}/browse/${key}`;
}

function keysAfter(body: string, words: string, project: string): string[] {
  const found: string[] = [];
  const list = `((?:${project}-[1-9]\\d*\\b(?:\\s*,\\s*|\\s+and\\s+)?)+)`;
  for (const match of body.matchAll(new RegExp(`\\b(?:${words})\\s+${list}`, 'gi'))) {
    for (const key of (match[1] ?? '').matchAll(new RegExp(`\\b${project}-[1-9]\\d*\\b`, 'g'))) {
      found.push(key[0]);
    }
  }
  return found;
}

/** Tickets a pull request says it delivers (`Closes CONC-5`, `Fixes`, `Resolves`). */
export function closedKeys(body: string, project: string): string[] {
  return [...new Set(keysAfter(body, 'close[sd]?|fix(?:e[sd])?|resolve[sd]?', project))];
}

/** Tickets a pull request is the work for: the ones it closes, then the ones it only references. */
export function referencedKeys(body: string, project: string): string[] {
  return [
    ...new Set([
      ...closedKeys(body, project),
      ...keysAfter(body, 'refs?|relates? to|references?', project),
    ]),
  ];
}

/**
 * The tickets a pull request is the work for: the key its title opens with (AK6), and the ones
 * its body closes or references (a partial delivery says only `Refs`, so `closedKeys` alone
 * misses it). The one reading of it: the board, the launch gate, claim and release all go
 * through here or through `namesTicket`.
 */
export function prKeys(pr: { readonly title: string; readonly body: string }, project: string): string[] {
  const lead = new RegExp(`^\\[?(${project}-[1-9]\\d*)\\b`).exec(pr.title.trim())?.[1];
  return [...new Set([...(lead === undefined ? [] : [lead]), ...referencedKeys(pr.body, project)])];
}

/** Whether a pull request is the work for the ticket `key` (`prKeys`). */
export function namesTicket(pr: { readonly title: string; readonly body: string }, key: string, project: string): boolean {
  return prKeys(pr, project).includes(key);
}

export interface PrRow {
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly isCrossRepository?: boolean;
}

/**
 * The most recently updated pull request that is the work for the ticket, or ''. Title and body
 * are anyone's to write, so a pull request from another repository's fork never counts.
 */
export function ticketPr(rows: readonly PrRow[], key: string, project: string): string {
  const mine = rows.filter(
    pr => pr.isCrossRepository !== true && namesTicket({ title: pr.title ?? '', body: pr.body ?? '' }, key, project)
  );
  return mine.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.url ?? '';
}

/** `Depends on: CONC-3, CONC-7` lines, as pick reads them. A `#n` there is a pull request and ignored. */
export function dependencyKeys(body: string, project: string): string[] {
  const found: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*[-*]?\s*\**depends on\**:?\**\s*(.*)$/i.exec(line);
    if (match === null) continue;
    for (const key of (match[1] ?? '').matchAll(new RegExp(`\\b${project}-[1-9]\\d*\\b`, 'g'))) {
      found.push(key[0]);
    }
  }
  return found;
}
