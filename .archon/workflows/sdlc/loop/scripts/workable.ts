/**
 * Launch gate for the loop: print what a lap could start right now, as JSON.
 *
 * Not a node. A scheduler runs it in the repository checkout before it starts a lap,
 * and starts one only when there is more workable work than laps already looking for
 * some (see `.shared/workable.ts` for the rules). It reads GitHub. With
 * `.archon/tracker.json` it reads Jira (startable tickets in the open sprint, the tickets
 * open pull requests name) and GitHub only for pull requests. Its one write: the
 * scheduler names runs it knows have ended (`INPUTS_ENDED_RUNS`, comma-separated), and
 * a claim one of them still holds is released the way the run's own release step would
 * have, because a run killed before that step never frees its item. On Jira it also puts a
 * ticket such a run left on In Progress back where a lap can take it (`recoverOrphans`).
 *
 * Output: `{ "workable": [ref], "claims": [ref + run], "ended": [...], "waiting": [...],
 * "updated" }`. A ref is `{kind: 'ticket', key}` for a Jira ticket and
 * `{kind: 'issue' | 'pull', number}` on GitHub; `updated` is the newest change to any
 * item on the board.
 */

import { deadClaims, expiryHours } from '../../.shared/claims.ts';
import { trimmed } from '../../.shared/io.ts';
import { Jira, trackerConfig } from '../../.shared/jira.ts';
import { ticketPr, type PrRow } from '../../.shared/tickets.ts';
import { GITHUB_FIELDS, githubItems, loadJiraBoard, openPulls, type GithubItem } from '../../.shared/tracker-board.ts';
import { workability, type Board, type Links } from '../../.shared/workable.ts';

function gh(args: string[]): unknown {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  return JSON.parse(result.stdout.toString());
}

/** The newest change to any open item (a comment, a label), as gh's ISO text. */
function newest(items: readonly GithubItem[]): string {
  return items.map(item => item.updatedAt).reduce((at, next) => (next > at ? next : at), '');
}

/** Without a tracker: open GitHub issues and pull requests. Every open one blocks a `Depends on`. */
function githubBoard(pulls: GithubItem[]): { board: Board; updated: string } {
  const issues = githubItems(gh(['issue', 'list', '--state', 'open', '--limit', '200', '--json', GITHUB_FIELDS]));
  const open = new Set([...issues, ...pulls].map(item => item.id));
  return { board: { issues, pulls, open }, updated: newest([...issues, ...pulls]) };
}

const released = (run: string): string =>
  `Loop claim released: run ${run} ended. Its \`Loop review:\` comment, if any, says what it did. (Released by the scheduler: the run ended without releasing it.)`;

const config = trackerConfig();
const pulls = openPulls();
const hours = expiryHours(trimmed(process.env.INPUTS_CLAIM_HOURS));
const endedRuns = new Set(
  trimmed(process.env.INPUTS_ENDED_RUNS)
    .split(',')
    .map(run => run.trim())
    .filter(run => run !== '')
);

/**
 * Tickets a dead run left on In Progress. Nothing else finds them: the board holds To Do
 * tickets and the ones pull requests name, and pick may not write to In Progress. A ticket
 * the loop itself started (`deadClaims`) whose every claim is dead goes back where a lap can
 * take it: Review when an open pull request names it, else To Do, with the `Loop result:`
 * line the run never wrote, so pick counts the attempt. A ticket without such a claim is a
 * session's and stays. One ticket failing does not stop the gate; it is reported and tried
 * again next time.
 */
async function recoverOrphans(client: Jira): Promise<string[]> {
  const c = client.config;
  const lines: string[] = [];
  const stuck = await client.search(
    `project = ${c.project} AND status = ${c.status.progress} AND assignee = "${c.assignee}"`,
    ['status', 'statuscategorychangedate']
  );
  let rows: PrRow[] | undefined;
  for (const row of stuck) {
    const key = String(row.key);
    try {
      const fields = (row.fields ?? {}) as Record<string, unknown>;
      const changed = fields.statuscategorychangedate;
      const startedAt = typeof changed === 'string' ? Date.parse(changed) : Number.NaN;
      const all = await client.comments(key);
      const dead = deadClaims(all, hours, Date.now(), endedRuns, startedAt);
      const holder = dead[0];
      if (holder === undefined) continue;
      rows ??= gh(['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'url,title,body,updatedAt,isCrossRepository']) as PrRow[];
      const pr = ticketPr(rows, key, c.project);
      const status = pr !== '' ? c.status.review : c.status.todo;
      const name = pr !== '' ? 'Review' : 'To Do';
      // In an order a failure can be picked up from: while the ticket is In Progress with its
      // claims on it, the next gate finds it again, so the move comes after the line pick
      // counts (written once) and the claims go last.
      if (!all.some(comment => comment.body.startsWith(`Loop result: run ${holder.run}.`))) {
        await client.comment(
          key,
          `Loop result: run ${holder.run}. PR: ${pr !== '' ? pr : 'kein PR'}. Status: ${name}. (Vom Scheduler: der Lauf endete ohne Abschluss.)`
        );
      }
      await client.move(key, status);
      for (const claim of dead) await client.editComment(key, claim.id, released(claim.run));
      lines.push(`${key}: back to ${name}, ${dead.length} dead claim(s) released`);
    } catch (error) {
      lines.push(`${key}: could not recover (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return lines;
}
let board: Board;
// An answer that lifts a park leaves the same items workable, and the scheduler must still
// see the board as changed.
let updated: string;
let links: Links | undefined;
let jira: Jira | undefined;
if (config === null) {
  ({ board, updated } = githubBoard(pulls));
} else {
  jira = new Jira(config);
  for (const line of await recoverOrphans(jira)) console.error(`workable: ${line}`);
  const loaded = await loadJiraBoard(jira, pulls);
  board = loaded.board;
  links = loaded.links;
  updated = new Date(loaded.updated).toISOString();
}
const result = workability(board, hours, Date.now(), endedRuns, links);
for (const claim of result.ended) {
  if (claim.kind === 'ticket') {
    const id = /[?&]focusedCommentId=(\d+)$/.exec(claim.url)?.[1];
    if (id !== undefined && jira !== undefined) await jira.editComment(claim.key, Number(id), released(claim.run));
    continue;
  }
  const id = /#issuecomment-(\d+)$/.exec(claim.url)?.[1];
  if (id === undefined) continue;
  gh(['api', `repos/{owner}/{repo}/issues/comments/${id}`, '--method', 'PATCH', '-f', `body=${released(claim.run)}`]);
}
process.stdout.write(`${JSON.stringify({ ...result, updated })}\n`);
