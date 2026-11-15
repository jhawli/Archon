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
import { GITHUB_FIELDS, githubItems, jiraLinks, loadJiraBoard, openPulls, type GithubItem } from '../../.shared/tracker-board.ts';
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
 * whose every claim is dead (run ended, or past the expiry) goes back where a lap can take
 * it: Review when an open pull request names it, else To Do, with the `Loop result:` line the
 * run never wrote, so pick counts the attempt. A ticket without any claim is a session's and
 * stays. One ticket failing does not stop the gate; it is reported and tried again next time.
 */
async function recoverOrphans(client: Jira): Promise<string[]> {
  const c = client.config;
  const lines: string[] = [];
  const named = new Set(pulls.flatMap(pull => jiraLinks(c.project).references(pull.body)));
  const stuck = await client.search(
    `project = ${c.project} AND status = ${c.status.progress} AND assignee = "${c.assignee}"`,
    ['status']
  );
  for (const row of stuck) {
    const key = String(row.key);
    try {
      const dead = deadClaims(await client.comments(key), hours, Date.now(), endedRuns);
      if (dead.length === 0) continue;
      const status = named.has(key) ? c.status.review : c.status.todo;
      // The status first: with the claims still on it, a failure here is found again next time.
      await client.move(key, status);
      const name = status === c.status.review ? 'Review' : 'To Do';
      for (const claim of dead) {
        await client.comment(key, `Loop result: run ${claim.run}. PR: nicht bekannt. Status: ${name}. (Vom Scheduler: der Lauf endete ohne Abschluss.)`);
        await client.editComment(key, claim.id, released(claim.run));
      }
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
