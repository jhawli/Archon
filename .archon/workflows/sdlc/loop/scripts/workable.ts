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
 * have, because a run killed before that step never frees its item.
 *
 * Output: `{ "workable": [ref], "claims": [ref + run], "ended": [...], "waiting": [...],
 * "updated" }`. A ref is `{kind: 'ticket', key}` for a Jira ticket and
 * `{kind: 'issue' | 'pull', number}` on GitHub; `updated` is the newest change to any
 * item on the board.
 */

import { expiryHours } from '../../.shared/claims.ts';
import { trimmed } from '../../.shared/io.ts';
import { Jira, trackerConfig } from '../../.shared/jira.ts';
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
  const loaded = await loadJiraBoard(jira, pulls);
  board = loaded.board;
  links = loaded.links;
  updated = new Date(loaded.updated).toISOString();
}
const endedRuns = new Set(
  trimmed(process.env.INPUTS_ENDED_RUNS)
    .split(',')
    .map(run => run.trim())
    .filter(run => run !== '')
);
const result = workability(
  board,
  expiryHours(trimmed(process.env.INPUTS_CLAIM_HOURS)),
  Date.now(),
  endedRuns,
  links
);
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
