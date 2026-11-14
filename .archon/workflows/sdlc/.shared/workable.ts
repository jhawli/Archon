/**
 * What a lap of the loop could start right now, read from the board without a model.
 *
 * A scheduler calls this before it starts a lap. A lap that finds nothing to do still
 * costs a pick, a worktree and a database run, and a backlog that is one long chain of
 * dependencies leaves most parallel laps with nothing. This mirrors the pick rules that
 * are facts rather than judgement: an item with a live claim is taken, an item labelled
 * `needs-owner` waits for the owner, an issue waits for its `Depends on:` items, and the
 * issues the manager keeps for itself are not work. Anything it is unsure of counts as
 * workable, so the gate can only skip laps that would have picked nothing.
 *
 * Items carry text ids: `CONC-5` for a Jira ticket, `#5` for a GitHub issue or pull request.
 * The result names them as `{kind: 'ticket', key}` or `{kind: 'issue' | 'pull', number}`.
 */

import { CLAIM_PREFIX } from './claims.ts';

export interface BoardComment {
  readonly body: string;
  readonly createdAt: string;
  /** The comment's web URL; its `#issuecomment-<id>` names the comment to edit. */
  readonly url?: string;
}

export interface BoardItem {
  /** `CONC-5` for a Jira ticket, `#5` for a GitHub issue or pull request. */
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly comments: readonly BoardComment[];
  /** Waits for the owner: the `needs-owner` label, or the Jira flag. */
  readonly owner: boolean;
  /** Startable work. A ticket loaded only because a pull request names it is not. */
  readonly candidate: boolean;
}

export interface Board {
  readonly issues: readonly BoardItem[];
  readonly pulls: readonly BoardItem[];
  /** Ids that still block a `Depends on` line. */
  readonly open: ReadonlySet<string>;
}

/** How the board's text names other items: `#n` on GitHub, `CONC-n` with Jira. */
export interface Links {
  readonly references: (body: string) => string[];
  readonly dependencies: (body: string) => string[];
}

/** A Jira ticket by key, or a GitHub issue or pull request by number. */
export type ItemRef =
  | { readonly kind: 'ticket'; readonly key: string }
  | { readonly kind: 'issue' | 'pull'; readonly number: number };

export type LiveClaim = ItemRef & { readonly run: string };

export type EndedClaim = LiveClaim & { readonly url: string };

export interface Workability {
  readonly workable: ItemRef[];
  readonly claims: LiveClaim[];
  /** Claims whose run the scheduler knows has ended: dead now, and the caller releases them. */
  readonly ended: EndedClaim[];
  readonly waiting: (ItemRef & { readonly why: string })[];
}

/** The label an owner decision carries; the loop never works an item under it. */
export const OWNER_LABEL = 'needs-owner';

/** Issues the manager keeps for its own records. They hold questions and metrics, not work. */
export const MANAGER_TITLES = new Set(['Owner decisions needed', 'Loop metrics']);

/** `Depends on: #12, #14` lines, as pick reads them. */
export function dependencies(body: string): number[] {
  const found: number[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*[-*]?\s*\**depends on\**:?\**\s*(.*)$/i.exec(line);
    if (match === null) continue;
    for (const ref of match[1].matchAll(/#(\d+)/g)) found.push(Number(ref[1]));
  }
  return found;
}

/** Issues a pull request says it delivers (`Closes #n`, `Fixes #n`, `Resolves #n`). */
export function closes(body: string): number[] {
  return [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map(m => Number(m[1]));
}

/**
 * Issues a pull request is the work for: the ones it closes, and the ones it only references
 * (`Refs #n`, `Relates to #n`). A delivery links its issue with `Refs` until its final review
 * adds the closing keyword, and while it does, a lap holding the issue holds the pull request too.
 */
export function references(body: string): number[] {
  const refs = [...body.matchAll(/\b(?:refs?|relates? to|references?)\s+#(\d+)/gi)].map(m => Number(m[1]));
  return [...new Set([...closes(body), ...refs])];
}

/** Unexpired claim comments on an item, oldest first, with the run each names. */
export function liveClaimComments(
  comments: readonly BoardComment[],
  expiryHours: number,
  now: number
): { run: string; comment: BoardComment }[] {
  const found: { run: string; comment: BoardComment }[] = [];
  for (const comment of comments) {
    if (!comment.body.startsWith(CLAIM_PREFIX)) continue;
    const created = Date.parse(comment.createdAt);
    if (Number.isNaN(created) || now - created > expiryHours * 3_600_000) continue;
    found.push({ run: comment.body.slice(CLAIM_PREFIX.length).split(/\s/, 1)[0] ?? '', comment });
  }
  return found;
}

export const GITHUB_LINKS: Links = {
  references: body => references(body).map(n => `#${n}`),
  dependencies: body => dependencies(body).map(n => `#${n}`),
};

function ref(kind: 'issue' | 'pull', id: string): ItemRef {
  return id.startsWith('#') ? { kind, number: Number(id.slice(1)) } : { kind: 'ticket', key: id };
}

/**
 * The board as a lap would find it. `endedRuns` are runs the scheduler knows have
 * finished, failed or been cancelled: a run killed before its release step never frees
 * its item, so its claim is treated as dead here and returned in `ended` for release.
 * `links` reads how items name each other; GitHub's `#n` unless the board comes from Jira.
 */
export function workability(
  board: Board,
  expiryHours: number,
  now = Date.now(),
  endedRuns: ReadonlySet<string> = new Set(),
  links: Links = GITHUB_LINKS
): Workability {
  const claims: LiveClaim[] = [];
  const ended: EndedClaim[] = [];
  const claimed = new Map<string, string>();
  for (const [kind, items] of [
    ['issue', board.issues],
    ['pull', board.pulls],
  ] as const) {
    for (const item of items) {
      for (const { run, comment } of liveClaimComments(item.comments, expiryHours, now)) {
        if (endedRuns.has(run)) {
          if (comment.url) ended.push({ ...ref(kind, item.id), run, url: comment.url });
          continue;
        }
        if (claimed.has(`${kind}:${item.id}`)) continue;
        claims.push({ ...ref(kind, item.id), run });
        claimed.set(`${kind}:${item.id}`, run);
      }
    }
  }
  // An open pull request is the work for the items it closes or references: pick continues the
  // pull request instead of starting the item, and claims the item for it.
  const byId = new Map(board.issues.map(item => [item.id, item]));
  const deliveredBy = new Map<string, string>();
  for (const pull of board.pulls) for (const id of links.references(pull.body)) deliveredBy.set(id, pull.id);

  const workable: ItemRef[] = [];
  const waiting: Workability['waiting'] = [];
  for (const pull of board.pulls) {
    const linked = links.references(pull.body).filter(id => byId.has(id));
    const owner = pull.owner || linked.some(id => byId.get(id)?.owner === true);
    const holder = claimed.get(`pull:${pull.id}`) ?? linked.map(id => claimed.get(`issue:${id}`)).find(Boolean);
    if (owner) waiting.push({ ...ref('pull', pull.id), why: OWNER_LABEL });
    else if (holder) waiting.push({ ...ref('pull', pull.id), why: `claimed by run ${holder}` });
    else workable.push(ref('pull', pull.id));
  }
  for (const issue of board.issues) {
    const blockers = links.dependencies(issue.body).filter(id => board.open.has(id));
    const holder = claimed.get(`issue:${issue.id}`);
    let why: string | null = null;
    if (MANAGER_TITLES.has(issue.title.trim())) why = "the manager's own record";
    else if (issue.owner) why = OWNER_LABEL;
    else if (deliveredBy.has(issue.id)) why = `delivered by pull request ${deliveredBy.get(issue.id)}`;
    else if (holder) why = `claimed by run ${holder}`;
    else if (blockers.length > 0) why = `depends on ${blockers.join(', ')}`;
    else if (!issue.candidate) why = 'not startable';
    if (why === null) workable.push(ref('issue', issue.id));
    else waiting.push({ ...ref('issue', issue.id), why });
  }
  return { workable, claims, ended, waiting };
}
