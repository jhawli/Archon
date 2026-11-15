/**
 * What agents ask to write to the tracker, and the board they read before they ask.
 *
 * Agents hold no token. tracker-read writes this lap's board to $ARTIFACTS_DIR/tracker/board.md
 * for pick, and the keys pick may write to into the run's state directory, where agents
 * cannot write. An agent leaves its writes as a JSON list in
 * $ARTIFACTS_DIR/tracker/outbox/<writer>.json; tracker-write checks the whole list against
 * the rules below before it writes anything, then applies it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorName, readCreated, readFinished, recordCreated, recordFinished, statusName } from './claims.ts';
import { note } from './io.ts';
import { adf, type Jira, plain, type Ticket, type TicketComment, type TrackerConfig } from './jira.ts';
import { namesTicket, referencedKeys } from './tickets.ts';

export type Op =
  | { readonly op: 'comment'; readonly key: string; readonly text: string }
  | { readonly op: 'ask'; readonly key: string; readonly text: string }
  | { readonly op: 'cancel'; readonly key: string; readonly text: string }
  /** Lift a flag that was only bookkeeping; the text says why. Pick only. */
  | { readonly op: 'unflag'; readonly key: string; readonly text: string }
  | { readonly op: 'create'; readonly marker: string; readonly title: string; readonly text: string };

export type Writer = 'pick' | 'build' | 'review';

export const WRITERS: readonly Writer[] = ['pick', 'build', 'review'];

export const outboxFile = (artifacts: string, writer: Writer): string =>
  join(artifacts, 'tracker', 'outbox', `${writer}.json`);

/**
 * Remove these writers' outbox files. The script right before an agent runs this for the
 * writers still to come, so a file an earlier agent left in their name never passes as
 * theirs: tracker-read clears all three before pick, claim clears build and review before
 * the builder, handoff clears review before the reviewer.
 */
export function clearOutbox(artifacts: string, writers: readonly Writer[]): void {
  for (const writer of writers) rmSync(outboxFile(artifacts, writer), { force: true });
}

const MAX_TEXT = 30_000;
const MAX_OPS = 20;

/**
 * Comment openings the loop's own scripts write and read back as facts: a claim decides who
 * holds a ticket, a result counts toward pick's attempts. The outbox writes as the loop's
 * account, so an agent's comment starting like one would read as the real thing. `Loop review:`
 * is the reviewer's own record and comes only from the review outbox.
 */
function reserved(text: string, writer: Writer): boolean {
  const shown = plain(adf(text));
  if (/^Loop (claim|result):/.test(shown)) return true;
  return shown.startsWith('Loop review:') && writer !== 'review';
}

/** The outbox file's list, or undefined when the agent left none (no file, or a blank one). */
export function readOutbox(path: string): unknown {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  return text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
}

/**
 * The checked writes. `target` is the lap's ticket key (null when the lap works a pull
 * request alone); build and review write only to it. `onBoard` are the keys pick may write
 * to (`writableKeys` of this lap's snapshot). `done` entries were already written by an earlier
 * try of this same list (`outboxProgress`); they passed the board check then and are not asked
 * again, since the write itself may have taken the ticket off the board (a cancel).
 */
export function checkOutbox(
  raw: unknown,
  writer: Writer,
  target: string | null,
  project: string,
  onBoard: ReadonlySet<string>,
  done = 0
): Op[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${writer} outbox must be a JSON list`);
  if (raw.length > MAX_OPS) throw new Error(`${writer} outbox has more than ${MAX_OPS} writes`);
  const keyOk = new RegExp(`^${project}-[1-9]\\d*$`);
  return (raw as unknown[]).map((entry, i): Op => {
    const where = `${writer} outbox entry ${i}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`${where}: not an object`);
    const e = entry as Record<string, unknown>;
    const text = typeof e.text === 'string' ? e.text.trim() : '';
    if (text === '' || text.length > MAX_TEXT) throw new Error(`${where}: text is empty or longer than ${MAX_TEXT}`);
    if (e.op === 'create') {
      if (writer === 'pick') throw new Error(`${where}: pick does not create tickets`);
      if (typeof e.marker !== 'string' || !/^[a-z0-9-]{3,60}$/.test(e.marker)) {
        throw new Error(`${where}: marker must be 3-60 of a-z, 0-9, -`);
      }
      // A rest ticket tells release that a partial delivery is accounted for; only the reviewer decides that.
      if (e.marker.startsWith('rest-') && writer !== 'review') throw new Error(`${where}: only review files rest tickets`);
      if (typeof e.title !== 'string' || e.title.trim() === '' || e.title.length > 200) {
        throw new Error(`${where}: title is empty or longer than 200`);
      }
      return { op: 'create', marker: e.marker, title: e.title.trim(), text };
    }
    if (e.op !== 'comment' && e.op !== 'ask' && e.op !== 'cancel' && e.op !== 'unflag') {
      throw new Error(`${where}: unknown op ${JSON.stringify(e.op)}`);
    }
    if (typeof e.key !== 'string' || !keyOk.test(e.key)) throw new Error(`${where}: key must be a ${project} ticket`);
    if ((e.op === 'cancel' || e.op === 'unflag') && writer !== 'pick') throw new Error(`${where}: ${writer} may not ${e.op}`);
    if (writer !== 'pick' && e.key !== target) throw new Error(`${where}: ${writer} writes only to ${target ?? 'its target'}`);
    if (writer === 'pick' && i >= done && !onBoard.has(e.key)) throw new Error(`${where}: ${e.key} is not on this lap's board`);
    if (reserved(text, writer)) throw new Error(`${where}: the text opens like a loop record, which is reserved`);
    return { op: e.op, key: e.key, text };
  });
}

/**
 * The tickets pick may write to (decision 11): the loop's own, either startable (open
 * sprint, To Do) or waiting on review. Never a ticket of the owner's, and never one In
 * Progress: sessions work as the loop's account too, and another lap's ticket is In Progress.
 */
export function writableKeys(tickets: readonly Ticket[], config: TrackerConfig): Set<string> {
  const s = config.status;
  return new Set(
    tickets
      .filter(t => t.assignee === config.assignee)
      .filter(t => (t.inOpenSprint && t.status === s.todo) || t.status === s.review)
      .map(t => t.key)
  );
}

/**
 * The search that confirms, at write time, which of the snapshot's keys pick may still write
 * to: the same rule as `writableKeys`, asked of Jira rather than of a file. Null for no keys.
 */
export function writableJql(keys: readonly string[], config: TrackerConfig): string | null {
  const valid = keys.filter(key => new RegExp(`^${config.project}-[1-9]\\d*$`).test(key));
  if (valid.length === 0) return null;
  const s = config.status;
  return (
    `key in (${valid.join(',')}) AND assignee = "${config.assignee}" AND ` +
    `(status = ${s.review} OR (status = ${s.todo} AND sprint in openSprints()))`
  );
}

/** The keys tracker-read recorded as pick's to write to (`keys.json` in the run's state directory). */
export function snapshotKeys(state: string): string[] {
  const path = join(state, 'keys.json');
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(raw) || !raw.every(key => typeof key === 'string')) throw new Error(`${path} is not a list of keys`);
  return raw;
}

/**
 * Which of the lap's snapshot keys are the loop's to touch right now: on the snapshot and
 * still so in Jira. The one rule for everything pick decides, its outbox writes and the
 * ticket it names as the lap's target alike (decision 11).
 */
export async function writableNow(jira: Jira, state: string, only?: string): Promise<Set<string>> {
  const keys = snapshotKeys(state).filter(key => only === undefined || key === only);
  const jql = writableJql(keys, jira.config);
  if (jql === null) return new Set();
  return new Set((await jira.search(jql, ['status'])).map(row => String(row.key)));
}

const progressFile = (state: string, writer: Writer): string => join(state, `progress-${writer}.json`);
const listDigest = (raw: unknown): string => createHash('sha256').update(JSON.stringify(raw)).digest('hex');

/** `done` entries are written; with `half`, the next one's change is made and only its comment is missing. */
function readProgress(state: string, writer: Writer, raw: unknown): { done: number; half: boolean } {
  const path = progressFile(state, writer);
  if (!existsSync(path)) return { done: 0, half: false };
  const kept = JSON.parse(readFileSync(path, 'utf8')) as { digest?: unknown; done?: unknown; half?: unknown };
  if (kept.digest !== listDigest(raw) || typeof kept.done !== 'number') return { done: 0, half: false };
  return { done: kept.done, half: kept.half === true };
}

/**
 * How many entries of this very list (`raw`, as read from the outbox file) an earlier try
 * already acted on, one whose change is made but whose comment failed included: that change
 * may itself have taken the ticket off the board. Another list of the same writer starts at
 * its first entry.
 */
export function outboxProgress(state: string, writer: Writer, raw: unknown): number {
  const { done, half } = readProgress(state, writer, raw);
  return done + (half ? 1 : 0);
}

/** A pull request as `gh pr view --json title,body,url,isCrossRepository` reports it. */
export interface PrText {
  readonly title: string;
  readonly body: string;
  readonly url?: string;
  readonly isCrossRepository?: boolean;
}

/**
 * Why the address pick gave is not a pull request of this repository the loop may build on,
 * or null. `repository` is this checkout's GitHub URL. A fork's pull request is refused like
 * `ticketPr` refuses it: anyone can write its title and text.
 */
export function prAddressRefusal(pull: string, repository: string, pr: PrText | null): string | null {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^${escaped}/pull/[1-9]\\d*$`).test(pull)) return `${pull} is not a pull request of ${repository}`;
  if (pr === null) return null;
  if (pr.isCrossRepository === true) return `${pull} comes from a fork`;
  return null;
}

/**
 * Why the loop must not work on the pull request pick named, or null when it may. On Jira a
 * pull request is someone's work on the tickets it names, so every open ticket it names has
 * to be the loop's to touch (`writable`), and it has to name the lap's ticket when there is
 * one. `statuses` are the named tickets' status ids; a ticket Jira does not report counts as
 * open, a delivered or canceled one binds nobody.
 */
export function prRefusal(
  pr: PrText,
  target: string | null,
  statuses: ReadonlyMap<string, string>,
  writable: ReadonlySet<string>,
  config: TrackerConfig
): string | null {
  if (target !== null && !namesTicket(pr, target, config.project)) {
    return `the pull request does not name ${target}`;
  }
  const done = new Set([config.status.staging, config.status.live, config.status.canceled]);
  const foreign = prKeys(pr, config.project).filter(
    key => key !== target && !writable.has(key) && !done.has(statuses.get(key) ?? '')
  );
  return foreign.length > 0 ? `the pull request names ${foreign.join(', ')}, which is not the loop's to work on` : null;
}

/** The tickets a pull request names: the key its title opens with, and its `Refs`/`Closes`. */
export function prKeys(pr: PrText, project: string): string[] {
  const lead = new RegExp(`^\\[?(${project}-[1-9]\\d*)\\b`).exec(pr.title.trim())?.[1];
  return [...new Set([...(lead === undefined ? [] : [lead]), ...referencedKeys(pr.body, project)])];
}

/**
 * Apply checked writes. Returns marker → key for the tickets this outbox filed or found.
 *
 * With `resume` (the writer and its list as read), how far the list got is kept in the run's
 * state directory, so a rerun after a failure goes on behind the last write that worked and
 * repeats no comment.
 */
export async function applyOutbox(
  jira: Jira,
  ops: readonly Op[],
  runUrl: string,
  state: string,
  resume?: { readonly writer: Writer; readonly raw: unknown }
): Promise<Record<string, string>> {
  const c = jira.config;
  const created: Record<string, string> = {};
  const digest = resume === undefined ? '' : listDigest(resume.raw);
  const progress = resume === undefined ? null : progressFile(state, resume.writer);
  const { done, half } = resume === undefined ? { done: 0, half: false } : readProgress(state, resume.writer, resume.raw);
  const keep = (count: number, changed: boolean): void => {
    if (progress !== null) writeFileSync(progress, `${JSON.stringify({ digest, done: count, half: changed })}\n`);
  };
  for (const [index, op] of ops.entries()) {
    if (op.op === 'create') {
      // Always asked, also behind the progress mark: it finds its own ticket and returns its key.
      created[op.marker] = await createTicket(jira, op, runUrl, state);
    } else if (index >= done) {
      if (op.op === 'comment') await jira.comment(op.key, op.text);
      else if (op.op === 'ask') await jira.ask(op.key, op.text);
      else {
        // The change first: a comment saying "canceled" on a ticket that is not would be worse
        // than the reverse. It is noted before the comment, so a rerun only adds the comment.
        if (!(half && index === done)) {
          if (op.op === 'cancel') await jira.move(op.key, c.status.canceled);
          else await jira.call('PUT', jira.issue(op.key), { fields: { [c.flagField]: null } });
          keep(index, true);
        }
        await jira.comment(op.key, op.op === 'cancel' ? `${op.text}\n\nAbgebrochen vom Loop: ${runUrl}` : op.text);
      }
    }
    keep(Math.max(done, index + 1), false);
  }
  if (progress !== null) rmSync(progress, { force: true });
  return created;
}

/**
 * One ticket per marker, however often the writer runs: first this run's own record (Jira's
 * search index lags a ticket filed moments ago), then the remote link Jira keeps for the marker.
 * A ticket this run filed but did not finish setting up (link, To Do, sprint) is finished here.
 */
async function createTicket(
  jira: Jira,
  op: Extract<Op, { op: 'create' }>,
  runUrl: string,
  state: string
): Promise<string> {
  const c = jira.config;
  const globalId = `archon:${c.project}:${op.marker}`;
  let key = readCreated(state)[op.marker];
  if (key !== undefined && readFinished(state)[op.marker] === key) return key;
  if (key === undefined) {
    const found = await jira.search(`issue in issuesWithRemoteLinksByGlobalId("${globalId}")`, ['status']);
    if (found.length > 1) throw new Error(`more than one ticket carries ${globalId}`);
    if (found.length === 1) {
      // Linked by an earlier run, so set up by it; where it stands by now is not this run's to change.
      key = String(found[0]?.key);
      recordCreated(state, op.marker, key);
      recordFinished(state, op.marker, key);
      return key;
    }
    const project = await jira.call('GET', `/rest/api/3/project/${c.project}`);
    const issue = await jira.call('POST', '/rest/api/3/issue', {
      fields: {
        project: { id: String(project?.id) },
        issuetype: { name: 'Task' },
        summary: op.title,
        description: adf(`Loop finding: ${op.marker}\n\n${op.text}`),
        assignee: { accountId: c.assignee },
      },
    });
    key = String(issue?.key);
    jira.issue(key); // throws on anything but a key of this project, before it is recorded
    // Recorded at once: a rerun after a failure below must find this ticket, not file another.
    recordCreated(state, op.marker, key);
  }
  // Each step below may run twice: Jira replaces a remote link with the same globalId, the
  // status is moved only when it differs, and a ticket already in the sprint stays there.
  await jira.call('POST', `${jira.issue(key)}/remotelink`, {
    globalId,
    object: { url: runUrl, title: `Archon loop (${op.marker})` },
  });
  if ((await jira.ticket(key)).status !== c.status.todo) await jira.move(key, c.status.todo);
  const sprints = await jira.call('GET', `/rest/agile/1.0/board/${c.board}/sprint?state=active`);
  const active = Array.isArray(sprints?.values) ? (sprints.values as { id?: unknown }[])[0] : undefined;
  if (typeof active?.id === 'number') {
    await jira.call('POST', `/rest/agile/1.0/sprint/${active.id}/issue`, { issues: [key] });
  } else {
    note(`${key} (${op.marker}) is filed on To Do outside a sprint: board ${c.board} has no active sprint, so no lap will start it until it is planned into one.`);
  }
  recordFinished(state, op.marker, key);
  return key;
}

/** `$ARTIFACTS_DIR/tracker/board.md`: the lap's board for pick, in sprint rank order. */
export function boardMarkdown(
  tickets: readonly Ticket[],
  comments: ReadonlyMap<string, readonly TicketComment[]>,
  waiting: ReadonlyMap<string, string>,
  config: TrackerConfig
): string {
  const writable = writableKeys(tickets, config);
  const lines = ['# Board (Reihenfolge = Sprint-Reihenfolge, Rang)', ''];
  let rank = 0;
  for (const t of tickets) {
    const place = t.inOpenSprint ? String((rank += 1)) : 'nicht im Sprint';
    lines.push(
      `## ${t.key} ${t.title}`,
      '',
      `URL: ${t.url}`,
      `Status: ${statusName(t.status, config.status)}`,
      `Rang: ${place}`,
      `Labels: ${t.labels.length > 0 ? t.labels.join(', ') : 'keine'}`,
      `Flagged: ${t.flagged ? 'ja' : 'nein'}`,
      `Schreibbar: ${writable.has(t.key) ? 'ja' : 'nein'}`
    );
    const why = waiting.get(t.key);
    if (why !== undefined) lines.push(`Wartet: ${why}`);
    lines.push('');
    if (t.body !== '') lines.push(t.body, '');
    for (const row of comments.get(t.key) ?? []) {
      lines.push(`### Kommentar ${row.id} (${row.created}, ${authorName(row.author, config)})`, '', row.body, '');
    }
  }
  return lines.join('\n');
}
