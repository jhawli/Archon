/**
 * Work-item claims: how several runs of one loop share a backlog without two of them
 * working the same item.
 *
 * A claim is a comment on the work item, a Jira ticket, whose body starts with
 * `Loop claim: run <id>`. A pull request is never claimed itself: the loop continues it
 * through the ticket it names. Among the live claims on one ticket the lowest comment id
 * holds it. Jira's ids are unique but not always in `created` order under concurrent
 * writes, which does not matter: every run orders by the same number. That is the whole
 * protocol: no lock service, no scheduler, and a race between two runs that claimed in the
 * same second still has exactly one winner, because each reads the item back after its own
 * claim landed.
 *
 * A claim is live until its run edits it to `Loop claim released` (or `withdrawn`), or
 * until it is older than the expiry: a run that died without releasing must not hold an
 * item forever.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Jira, requireTracker, type Ticket, type TicketComment, todoStatuses, type TrackerConfig } from './jira.ts';
import { tasksDone } from './subtickets.ts';
import { namesTicket, ticketKeyOf } from './tickets.ts';

type JsonObject = Record<string, unknown>;

export const CLAIM_PREFIX = 'Loop claim: run ';

export interface WorkItem {
  readonly kind: 'ticket';
  readonly key: string;
}

/** The part of the Jira client the claim protocol uses; tests pass a fake. */
export type ClaimClient = Pick<Jira, 'comments' | 'comment' | 'editComment'>;

/** A comment on a ticket, as the claim protocol reads it. */
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

/** A ticket URL of this tracker. Work items live in Jira only: no GitHub URL is one. */
export function workItem(url: string, config: TrackerConfig = requireTracker()): WorkItem {
  const key = ticketKeyOf(url, config);
  if (key === null) throw new Error(`not a work item URL: '${url}' (work items are ${config.project} tickets)`);
  return { kind: 'ticket', key };
}

/**
 * Why claim must not take this lap's target, or null: pick names a ticket as the target, also
 * for `continue` (the ticket the pull request names). Anything else is not claimed, and a pull
 * request that names no ticket is not the loop's work.
 */
export function targetRefusal(target: string, pr: string, config: TrackerConfig): string | null {
  if (ticketKeyOf(target, config) !== null) return null;
  const what = target !== '' ? `'${target}'` : pr !== '' ? `the pull request ${pr} alone` : 'an empty target';
  return `${what} is not a ${config.project} ticket: the loop claims tickets only and continues a pull request through the ticket it names`;
}

/** Every comment on the ticket, lowest id first. */
export async function comments(item: WorkItem, jira: ClaimClient): Promise<ItemComment[]> {
  const rows: TicketComment[] = await jira.comments(item.key);
  return rows.map(({ id, body, createdAt }) => ({ id, body, createdAt }));
}

/** Live claims on the item, oldest (lowest id) first. */
export async function liveClaims(
  item: WorkItem,
  expiryHours: number,
  now: number,
  jira: ClaimClient
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

/** A holding run moves its ticket to progress this soon after its claim: 5 s to settle, a few reads, one move. */
const CLAIM_TO_START_MS = 10 * 60_000;

/**
 * The claims on a ticket in progress that no run stands behind any more, newest first, or
 * none: a claim is dead once the scheduler names its run as ended or it is past the expiry,
 * and one claim that may still be worked on keeps them all. Released and withdrawn claims are
 * not claims (their text was edited).
 *
 * `startedAt` is when the ticket went to progress. Only a ticket a claiming run put there
 * is the loop's to take back: the newest claim must sit just before that moment. A stale
 * claim on a ticket a session started hours later proves nothing about who works on it.
 */
export function deadClaims(
  rows: readonly ItemComment[],
  expiryHours: number,
  now: number,
  ended: ReadonlySet<string>,
  startedAt: number
): Claim[] {
  const claims = rows
    .filter(row => row.body.startsWith(CLAIM_PREFIX))
    .map(row => ({
      id: row.id,
      run: row.body.slice(CLAIM_PREFIX.length).split(/\s/, 1)[0] ?? '',
      createdAt: row.createdAt,
    }));
  const dead = (claim: Claim): boolean =>
    ended.has(claim.run) || Number.isNaN(claim.createdAt) || now - claim.createdAt > expiryHours * 3_600_000;
  if (claims.length === 0 || !claims.every(dead)) return [];
  const newest = [...claims].sort((left, right) => right.id - left.id);
  const lead = startedAt - (newest[0]?.createdAt ?? Number.NaN);
  // NaN (no start time, no claim time) fails both comparisons: nothing is taken back.
  return lead >= -5000 && lead <= CLAIM_TO_START_MS ? newest : [];
}

export async function postComment(item: WorkItem, body: string, jira: ClaimClient): Promise<number> {
  return jira.comment(item.key, body);
}

export async function editComment(item: WorkItem, id: number, body: string, jira: ClaimClient): Promise<void> {
  await jira.editComment(item.key, id, body);
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
  /** The task numbers the review says this change fully delivers (`Tasks done: 1, 2`, VAULT-28). */
  readonly tasks: readonly number[];
  /** Markers the review filed tickets for (`write-review` output). */
  readonly created: Readonly<Record<string, string>>;
}

export const restMarker = (key: string): string => `rest-${key.toLowerCase()}`;

/**
 * The ticket's status after a lap (AK18). Null leaves it as it is. `todo` is the ticket's own
 * queue (`todoFor`): a lap without a pull request gives a bug back to its queue, a slice to
 * its own. A delivery goes to Staging whatever the slice's tasks; the lap settles them first
 * (VAULT-28, no waiting for parts any more).
 */
export function finalStatus(
  key: string,
  current: string,
  lap: LapResult,
  s: TrackerConfig['status'],
  todo: string
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
  return { status: todo, ask: null };
}

/*
 * Lap facts travel as files, not as `with:` bindings: the engine refuses to bind the output
 * of a failed node (`if_skipped` covers skipped ones only), and a failed rollout fails the
 * deploy block. Bound to `$deploy.output`, release would fail on exactly the lap whose
 * ticket most needs Review and a question.
 *
 * So the script nodes that know a fact (subject, land, the outbox writer) record it in the
 * run's own state directory, `$STATE_DIR/tracker/<run>` (`runState`), and release reads it
 * there. Agents read $STATE_DIR but never write it: the sandbox and the path fence give
 * them $ARTIFACTS_DIR alone, so these records are the scripts' own. The deploy block writes
 * `deployment.md` into $ARTIFACTS_DIR, where agents can write too; land, the last node
 * before deploy and after every agent, deletes any it finds. A merge also has to be one
 * GitHub reports (`confirmMerge`).
 */

type LapFacts = Partial<Record<'pr' | 'landed' | 'delivers' | 'tasks', string>>;

const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;
const deploymentFile = (artifacts: string): string => join(artifacts, 'deployment.md');

/** This run's state directory for tracker records, created on first use. */
export function runState(stateDir = process.env.STATE_DIR ?? '', run = process.env.WORKFLOW_ID ?? ''): string {
  if (stateDir === '') throw new Error('STATE_DIR is not set; the engine supplies it to every exec node.');
  if (!RUN_ID.test(run)) throw new Error(`WORKFLOW_ID ${JSON.stringify(run)} is not a run id`);
  const dir = join(stateDir, 'tracker', run);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove run state directories older than `maxAgeMs`; a lap that picked nothing never reaches release. */
export function pruneRunStates(stateDir: string, maxAgeMs: number, now = Date.now()): string[] {
  const root = join(stateDir, 'tracker');
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!RUN_ID.test(name) || !statSync(dir).isDirectory()) continue;
    if (now - statSync(dir).mtimeMs <= maxAgeMs) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function readObject(path: string): JsonObject {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${path} is not an object`);
  return raw as JsonObject;
}

function strings(raw: JsonObject): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) if (typeof value === 'string') found[name] = value;
  return found;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Replace this run's lap record with what the calling node knows. */
export function recordLap(state: string, facts: LapFacts): void {
  writeJson(join(state, 'lap.json'), facts);
}

/** Removes a `deployment.md` an agent may have left: only the deploy block after the caller writes one. */
export function clearDeployment(artifacts: string): void {
  rmSync(deploymentFile(artifacts), { force: true });
}

/** land's record: after it no agent runs, so it also clears a `deployment.md` an agent may have left. */
export function recordLanding(state: string, artifacts: string, facts: LapFacts): void {
  clearDeployment(artifacts);
  recordLap(state, facts);
}

/** When this run's claim on its ticket was posted (claim records it once it holds the ticket). */
export function recordClaim(state: string, at: number): void {
  writeJson(join(state, 'claim.json'), { at });
}

/** The recorded claim time in ms, or NaN when this run recorded none. */
export function readClaimedAt(state: string): number {
  const at = readObject(join(state, 'claim.json')).at;
  return typeof at === 'number' ? at : Number.NaN;
}

/** Tickets this run filed, by marker (the outbox writer records each as soon as Jira made it). */
export function readCreated(state: string): Record<string, string> {
  return strings(readObject(join(state, 'created.json')));
}

/** `part` is the marker a later part of a rest carries (`rest-conc-40-2`), kept in the same write. */
export function recordCreated(state: string, marker: string, key: string, part?: string): void {
  writeJson(join(state, 'created.json'), { ...readCreated(state), [marker]: key, ...(part === undefined ? {} : { [part]: key }) });
}

/** Filed tickets that also got their link, status and sprint; one that is only in `created` is half set up. */
export function readFinished(state: string): Record<string, string> {
  return strings(readObject(join(state, 'finished.json')));
}

export function recordFinished(state: string, marker: string, key: string): void {
  writeJson(join(state, 'finished.json'), { ...readFinished(state), [marker]: key });
}

/** `true` when the deploy block confirmed the rollout, `false` when it did not, '' without a rollout. */
export function deployedFact(artifacts: string): string {
  const path = deploymentFile(artifacts);
  if (!existsSync(path)) return '';
  return /^- deployed: True$/m.test(readFileSync(path, 'utf8')) ? 'true' : 'false';
}

/** What this lap did: the run's records and the deploy block's `deployment.md`. */
export function readLap(state: string, artifacts: string, pickedPr: string): LapResult {
  const facts: LapFacts = strings(readObject(join(state, 'lap.json')));
  const recorded = (facts.pr ?? '').trim();
  return {
    pr: PR_URL.test(recorded) ? recorded : pickedPr,
    landed: facts.landed ?? '',
    deployed: deployedFact(artifacts),
    delivers: facts.delivers ?? '',
    tasks: tasksDone(facts.tasks ?? ''),
    created: readCreated(state),
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
  const named = view !== null && namesTicket(view, key, project);
  const confirmed = view?.state === 'MERGED' && mergedAt >= claimedAt && named;
  return confirmed ? lap : { ...lap, landed: '' };
}

/**
 * A question for the owner when the lap's pull request does not name its ticket, or null. The
 * ticket goes to Review, and the board finds a ticket there only through a pull request that
 * names it: without the key neither would come back to the loop. GitHub showing no pull
 * request asks nothing here; `confirmMerge` already doubts a merge it cannot see.
 */
export function unnamedPrAsk(lap: LapResult, view: PrView | null, key: string, project: string): string | null {
  if (lap.pr === '' || view === null || namesTicket(view, key, project)) return null;
  return `Der PR ${lap.pr} nennt ${key} weder am Titelanfang noch als Refs oder Closes, so findet die Schleife weder PR noch Ticket wieder. Bitte den Schlüssel an den Anfang des PR-Titels setzen.`;
}

// --- The ticket as the agents read it ---

/** The lifecycle's names (VAULT-28): the agents and the comments speak the board's language. */
const STATUS_NAMES: Record<keyof TrackerConfig['status'], string> = {
  todo: 'Startklar',
  todoBug: 'Gemeldet',
  progress: 'Entwicklung',
  review: 'Review',
  staging: 'Staging',
  live: 'Live',
  canceled: 'Verworfen',
  taskDone: 'Erledigt',
  taskDropped: 'Entfällt',
};

/** Where a claim moves the ticket: from either queue to progress. A ticket further along stays (null). */
export function claimStart(status: string, s: TrackerConfig['status']): string | null {
  return todoStatuses(s).includes(status) ? s.progress : null;
}

export function statusName(id: string, s: TrackerConfig['status']): string {
  const name = (Object.keys(STATUS_NAMES) as (keyof TrackerConfig['status'])[]).find(k => s[k] === id);
  return name === undefined ? `status ${id}` : STATUS_NAMES[name];
}

/** A task's state as the agents read it: done, dropped, or still open. */
function taskState(id: string, s: TrackerConfig['status']): string {
  if (id === s.taskDone) return STATUS_NAMES.taskDone;
  if (id === s.taskDropped) return STATUS_NAMES.taskDropped;
  return 'offen';
}

/** Who wrote a comment, as the agents read it: the owner's words approve a judge change. */
export function authorName(account: string, config: TrackerConfig): string {
  if (account === config.assignee) return 'Archon';
  if (account === config.owner) return 'Julian';
  return account === '' ? 'unbekannt' : account;
}

/** `$ARTIFACTS_DIR/tracker/item.md`: the ticket and its comments, for agents that hold no token. */
export function itemMarkdown(ticket: Ticket, rows: readonly TicketComment[], config: TrackerConfig): string {
  const s = config.status;
  const lines = [
    `# ${ticket.key} ${ticket.title}`,
    '',
    `URL: ${ticket.url}`,
    `Status: ${statusName(ticket.status, s)}`,
    `Labels: ${ticket.labels.length > 0 ? ticket.labels.join(', ') : 'keine'}`,
    '',
  ];
  if (ticket.body !== '') lines.push(ticket.body, '');
  // The slice's tasks, in order: the review names the numbers it fully delivers (VAULT-28).
  if (ticket.tasks.length > 0) {
    lines.push('Tasks:', ...ticket.tasks.map(task => `- ${task.title} (${taskState(task.status, s)})`), '');
  }
  for (const row of rows) {
    lines.push(`## Kommentar ${row.id} (${row.created}, ${authorName(row.author, config)})`, '', row.body, '');
  }
  return lines.join('\n');
}
