/**
 * Work-item claims: how several runs of one loop share a backlog without two of them
 * working the same item.
 *
 * A claim is a comment on the work item (a Jira ticket or GitHub issue, or a pull request
 * when no ticket is involved) whose body starts with `Loop claim: run <id>`. Among the live
 * claims on one item the lowest comment id holds it. GitHub numbers comments in the order it
 * stores them; Jira's ids are unique but not always in `created` order under concurrent
 * writes, which does not matter: every run orders by the same number. That is the whole
 * protocol: no lock service, no scheduler, and a race between two runs that claimed in the
 * same second still has exactly one winner, because each reads the item back after its own
 * claim landed.
 *
 * A claim is live until its run edits it to `Loop claim released` (or `withdrawn`), or
 * until it is older than the expiry: a run that died without releasing must not hold an
 * item forever.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Jira, type Ticket, type TicketComment, type TrackerConfig, trackerConfig } from './jira.ts';
import { referencedKeys, ticketKeyOf } from './tickets.ts';

type JsonObject = Record<string, unknown>;

export const CLAIM_PREFIX = 'Loop claim: run ';

export type WorkItem =
  | { readonly kind: 'ticket'; readonly key: string }
  | { readonly kind: 'github'; readonly repository: string; readonly number: number };

/** The part of the Jira client the claim protocol uses; tests pass a fake. */
export type ClaimClient = Pick<Jira, 'comments' | 'comment' | 'editComment'>;

/** A comment on either tracker, as the claim protocol reads it. */
export interface ItemComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: number;
}

export interface Claim {
  readonly id: number;
  readonly run: string;
  readonly createdAt: number;
}

/** A Jira ticket URL, or a GitHub issue or pull request URL. With Jira, GitHub issues are refused. */
export function workItem(url: string, config: TrackerConfig | null = trackerConfig()): WorkItem {
  if (config !== null) {
    const key = ticketKeyOf(url, config);
    if (key !== null) return { kind: 'ticket', key };
  }
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)\/?$/.exec(
    url.trim()
  );
  if (match === null) throw new Error(`not a work item URL: '${url}'`);
  if (config !== null && match[2] === 'issues') {
    throw new Error(`Jira tracks this repository's work items, not ${url}`);
  }
  return { kind: 'github', repository: match[1], number: Number(match[3]) };
}

export function runGh(args: string[]): unknown {
  const result = Bun.spawnSync(['gh', 'api', '--hostname', 'github.com', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`gh api ${args[0] ?? ''} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  const output = result.stdout.toString().trim();
  return output === '' ? null : (JSON.parse(output) as unknown);
}

function clientFor(key: string, jira: ClaimClient | undefined): ClaimClient {
  if (jira === undefined) throw new Error(`${key}: a ticket needs a Jira client`);
  return jira;
}

/** Every comment on the item, lowest id first. */
export async function comments(item: WorkItem, jira?: ClaimClient): Promise<ItemComment[]> {
  if (item.kind === 'ticket') {
    const rows: TicketComment[] = await clientFor(item.key, jira).comments(item.key);
    return rows.map(({ id, body, createdAt }) => ({ id, body, createdAt }));
  }
  const pages = runGh([
    `repos/${item.repository}/issues/${item.number}/comments?per_page=100`,
    '--paginate',
    '--slurp',
  ]);
  if (!Array.isArray(pages)) throw new Error('comment listing is malformed');
  return (pages as unknown[])
    .flatMap((page): unknown[] => (Array.isArray(page) ? (page as unknown[]) : [page]))
    .filter((value): value is JsonObject => value !== null && typeof value === 'object')
    .filter(row => typeof row.id === 'number')
    .map(row => ({
      id: row.id as number,
      body: typeof row.body === 'string' ? row.body : '',
      createdAt: Date.parse(String(row.created_at)),
    }))
    .sort((left, right) => left.id - right.id);
}

/** Live claims on the item, oldest (lowest id) first. */
export async function liveClaims(
  item: WorkItem,
  expiryHours: number,
  now = Date.now(),
  jira?: ClaimClient
): Promise<Claim[]> {
  const claims: Claim[] = [];
  for (const comment of await comments(item, jira)) {
    if (!comment.body.startsWith(CLAIM_PREFIX)) continue;
    if (Number.isNaN(comment.createdAt) || now - comment.createdAt > expiryHours * 3_600_000) continue;
    const run = comment.body.slice(CLAIM_PREFIX.length).split(/\s/, 1)[0] ?? '';
    claims.push({ id: comment.id, run, createdAt: comment.createdAt });
  }
  return claims.sort((left, right) => left.id - right.id);
}

export async function postComment(item: WorkItem, body: string, jira?: ClaimClient): Promise<number> {
  if (item.kind === 'ticket') return clientFor(item.key, jira).comment(item.key, body);
  const created = runGh([
    `repos/${item.repository}/issues/${item.number}/comments`,
    '--method',
    'POST',
    '-f',
    `body=${body}`,
  ]) as JsonObject | null;
  if (created === null || typeof created.id !== 'number') throw new Error('the claim comment was not created');
  return created.id;
}

export async function editComment(item: WorkItem, id: number, body: string, jira?: ClaimClient): Promise<void> {
  if (item.kind === 'ticket') {
    await clientFor(item.key, jira).editComment(item.key, id, body);
    return;
  }
  runGh([`repos/${item.repository}/issues/comments/${id}`, '--method', 'PATCH', '-f', `body=${body}`]);
}

export function expiryHours(value: string): number {
  const hours = Number(value.trim() === '' ? '6' : value);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error(`claim expiry must be a positive number of hours, got '${value}'`);
  return hours;
}

// --- The lap's result on a ticket (AK18) ---

export interface LapResult {
  readonly pr: string;
  readonly landed: string;
  readonly deployed: string;
  readonly delivers: string;
  /** Markers the review filed tickets for (`write-review` output). */
  readonly created: Readonly<Record<string, string>>;
}

export const restMarker = (key: string): string => `rest-${key.toLowerCase()}`;

/** The ticket's status after a lap (AK18). Null leaves it as it is. */
export function finalStatus(
  key: string,
  current: string,
  lap: LapResult,
  s: TrackerConfig['status']
): { status: string | null; ask: string | null } {
  if (current !== s.progress && current !== s.review) return { status: null, ask: null };
  if (lap.landed === 'merged') {
    if (lap.deployed !== 'true') {
      return {
        status: s.review,
        ask: 'Gemergt, aber der Staging-Rollout ist nicht bestätigt. Bitte Staging prüfen und das Ticket dann auf Staging setzen.',
      };
    }
    if (lap.delivers === 'part' && lap.created[restMarker(key)] === undefined) {
      return {
        status: s.staging,
        ask: 'Nur zum Teil geliefert, aber der Review hat kein Rest-Ticket angelegt. Was fehlt noch?',
      };
    }
    return { status: s.staging, ask: null };
  }
  if (lap.pr !== '') return { status: s.review, ask: null };
  return { status: s.todo, ask: null };
}

/*
 * Lap facts travel as files, not as `with:` bindings: the engine refuses to bind the output
 * of a failed node (`if_skipped` covers skipped ones only), and a failed rollout fails the
 * deploy block. Bound to `$deploy.output`, release would fail on exactly the lap whose
 * ticket most needs Review and a question. So subject and land record what they know in
 * `$ARTIFACTS_DIR/tracker/lap.json`, the deploy block's own `deployment.md` says whether the
 * rollout was confirmed, and release reads both, whatever happened in between.
 *
 * Agents can write under $ARTIFACTS_DIR too (their outbox lives there), so none of this is
 * taken on trust. Each writer replaces the record instead of merging into it. land, the
 * last node before deploy and after every agent, also deletes any `deployment.md` it finds,
 * so the only one release can read was written by the deploy block. And `merged` counts
 * only when GitHub says so (`confirmMerge`).
 */

type LapFacts = Partial<Record<'pr' | 'landed' | 'delivers', string>>;

const lapFile = (dir: string): string => join(dir, 'tracker', 'lap.json');
const deploymentFile = (dir: string): string => join(dir, 'deployment.md');
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

function readFacts(dir: string): LapFacts {
  const path = lapFile(dir);
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${path} is not an object`);
  const facts: LapFacts = {};
  for (const name of ['pr', 'landed', 'delivers'] as const) {
    const value = (raw as JsonObject)[name];
    if (typeof value === 'string') facts[name] = value;
  }
  return facts;
}

/** Replace this run's lap record with what the calling node knows. */
export function recordLap(dir: string, facts: LapFacts): void {
  mkdirSync(join(dir, 'tracker'), { recursive: true });
  writeFileSync(lapFile(dir), `${JSON.stringify(facts, null, 2)}\n`);
}

/** land's record: after it no agent runs, so it also clears a `deployment.md` an agent may have left. */
export function recordLanding(dir: string, facts: LapFacts): void {
  rmSync(deploymentFile(dir), { force: true });
  recordLap(dir, facts);
}

function deployedFact(dir: string): string {
  const path = deploymentFile(dir);
  if (!existsSync(path)) return '';
  return /^- deployed: True$/m.test(readFileSync(path, 'utf8')) ? 'true' : 'false';
}

/** What this lap did, from the record and the deploy block's `deployment.md`. */
export function readLap(dir: string, pickedPr: string, created: Readonly<Record<string, string>> = {}): LapResult {
  const facts = readFacts(dir);
  const recorded = (facts.pr ?? '').trim();
  return {
    pr: PR_URL.test(recorded) ? recorded : pickedPr,
    landed: facts.landed ?? '',
    deployed: deployedFact(dir),
    delivers: facts.delivers ?? '',
    created,
  };
}

/** The pull request as GitHub reports it (`gh pr view --json state,mergedAt,title,body`). */
export interface PrView {
  readonly state: string;
  readonly mergedAt: string | null;
  readonly title: string;
  readonly body: string;
}

/**
 * `merged` stands only if GitHub agrees: the pull request is merged, after this run claimed
 * the ticket, and it names the ticket in its title or as `Refs`/`Closes`. Anything else is
 * read as not merged, which leaves the ticket on Review for a person to look at.
 */
export function confirmMerge(lap: LapResult, view: PrView | null, key: string, claimedAt: number, project: string): LapResult {
  if (lap.landed !== 'merged') return lap;
  const mergedAt = Date.parse(view?.mergedAt ?? '');
  const named =
    view !== null &&
    (new RegExp(`^\\[?${key}\\b`).test(view.title.trim()) || referencedKeys(view.body, project).includes(key));
  const confirmed = view?.state === 'MERGED' && mergedAt >= claimedAt && named;
  return confirmed ? lap : { ...lap, landed: '' };
}

// --- The ticket as the agents read it ---

const STATUS_NAMES: Record<keyof TrackerConfig['status'], string> = {
  todo: 'To Do',
  progress: 'In Progress',
  review: 'Review',
  staging: 'Staging',
  live: 'Live',
  canceled: 'Canceled',
};

export function statusName(id: string, s: TrackerConfig['status']): string {
  const name = (Object.keys(STATUS_NAMES) as (keyof TrackerConfig['status'])[]).find(k => s[k] === id);
  return name === undefined ? `status ${id}` : STATUS_NAMES[name];
}

/** `$ARTIFACTS_DIR/tracker/item.md`: the ticket and its comments, for agents that hold no token. */
export function itemMarkdown(ticket: Ticket, rows: readonly TicketComment[], s: TrackerConfig['status']): string {
  const lines = [
    `# ${ticket.key} ${ticket.title}`,
    '',
    `URL: ${ticket.url}`,
    `Status: ${statusName(ticket.status, s)}`,
    `Labels: ${ticket.labels.length > 0 ? ticket.labels.join(', ') : 'keine'}`,
    '',
  ];
  if (ticket.body !== '') lines.push(ticket.body, '');
  for (const row of rows) lines.push(`## Kommentar ${row.id} (${row.created})`, '', row.body, '');
  return lines.join('\n');
}
