/**
 * What a lap of the loop could start right now, read from the board without a model.
 *
 * A scheduler calls this before it starts a lap. A lap that finds nothing to do still
 * costs a pick, a worktree and a database run, and a backlog that is one long chain of
 * dependencies leaves most parallel laps with nothing. This mirrors the pick rules that
 * are facts rather than judgement: an item with a live claim is taken, a flagged ticket (or
 * one labelled `needs-owner`) waits for the owner, and a ticket waits for its `Depends on:`
 * tickets. Anything it is unsure of counts as workable, so the gate can only skip laps that
 * would have picked nothing.
 *
 * Work items are Jira tickets (`CONC-5`); pull requests stay on GitHub (`#5`). The result
 * names them as `{kind: 'ticket', key}` or `{kind: 'pull', number}`.
 */

import { CLAIM_PREFIX } from './claims.ts';

export interface BoardComment {
  readonly body: string;
  readonly createdAt: string;
  /** The comment's web URL; its `#issuecomment-<id>` names the comment to edit. */
  readonly url?: string;
}

export interface BoardItem {
  /** `CONC-5` for a Jira ticket, `#5` for a GitHub pull request. */
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
  /** The tickets (Jira work items). */
  readonly issues: readonly BoardItem[];
  readonly pulls: readonly BoardItem[];
  /** Ids that still block a `Depends on` line. */
  readonly open: ReadonlySet<string>;
}

/** How the board's text names tickets (`CONC-n`, `tracker-board.ts` `jiraLinks`). */
export interface Links {
  readonly references: (body: string) => string[];
  readonly dependencies: (body: string) => string[];
}

/** A Jira ticket by key, or a GitHub pull request by number. */
export type ItemRef =
  | { readonly kind: 'ticket'; readonly key: string }
  | { readonly kind: 'pull'; readonly number: number };

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

function ticketRef(id: string): ItemRef {
  return { kind: 'ticket', key: id };
}

function pullRef(id: string): ItemRef {
  return { kind: 'pull', number: Number(id.replace(/^#/, '')) };
}

/**
 * The board as a lap would find it. `endedRuns` are runs the scheduler knows have
 * finished, failed or been cancelled: a run killed before its release step never frees
 * its item, so its claim is treated as dead here and returned in `ended` for release.
 * `links` reads how tickets and pull requests name tickets.
 */
export function workability(
  board: Board,
  expiryHours: number,
  now: number,
  endedRuns: ReadonlySet<string>,
  links: Links
): Workability {
  const claims: LiveClaim[] = [];
  const ended: EndedClaim[] = [];
  const claimed = new Map<string, string>();
  for (const [kind, items, ref] of [
    ['ticket', board.issues, ticketRef],
    ['pull', board.pulls, pullRef],
  ] as const) {
    for (const item of items) {
      for (const { run, comment } of liveClaimComments(item.comments, expiryHours, now)) {
        if (endedRuns.has(run)) {
          if (comment.url) ended.push({ ...ref(item.id), run, url: comment.url });
          continue;
        }
        if (claimed.has(`${kind}:${item.id}`)) continue;
        claims.push({ ...ref(item.id), run });
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
    const holder = claimed.get(`pull:${pull.id}`) ?? linked.map(id => claimed.get(`ticket:${id}`)).find(Boolean);
    if (owner) waiting.push({ ...pullRef(pull.id), why: OWNER_LABEL });
    else if (holder) waiting.push({ ...pullRef(pull.id), why: `claimed by run ${holder}` });
    else workable.push(pullRef(pull.id));
  }
  for (const ticket of board.issues) {
    const blockers = links.dependencies(ticket.body).filter(id => board.open.has(id));
    const holder = claimed.get(`ticket:${ticket.id}`);
    let why: string | null = null;
    if (ticket.owner) why = OWNER_LABEL;
    else if (deliveredBy.has(ticket.id)) why = `delivered by pull request ${deliveredBy.get(ticket.id)}`;
    else if (holder) why = `claimed by run ${holder}`;
    else if (blockers.length > 0) why = `depends on ${blockers.join(', ')}`;
    else if (!ticket.candidate) why = 'not startable';
    if (why === null) workable.push(ticketRef(ticket.id));
    else waiting.push({ ...ticketRef(ticket.id), why });
  }
  return { workable, claims, ended, waiting };
}
