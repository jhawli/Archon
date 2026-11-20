/**
 * Launch gate for the loop: print what a lap could start right now, as JSON.
 *
 * Not a node. A scheduler runs it in the repository checkout before it starts a lap,
 * and starts one only when there is more workable work than laps already looking for
 * some (see `.shared/workable.ts` for the rules). It needs `.archon/tracker.json` (AK18e)
 * and reads Jira (startable tickets in the open sprint, the tickets open pull requests
 * name) and GitHub only for pull requests. Its one write: the
 * scheduler names runs it knows have ended (`INPUTS_ENDED_RUNS`, comma-separated), and
 * a claim one of them still holds is released the way the run's own release step would
 * have, because a run killed before that step never frees its item. It also puts a ticket
 * such a run left in progress back on its own queue (`recoverOrphans`), with its pull request
 * open for the next lap, and a question when Jira refuses the way.
 *
 * Output: `{ "workable": [ref], "claims": [ticket + run], "ended": [...], "waiting": [...],
 * "updated" }`. A ref is `{kind: 'ticket', key}` for a Jira ticket and
 * `{kind: 'pull', number}` for a pull request (claims are on tickets only); `updated` is the newest change to any item
 * on the board.
 */

import { deadClaims, expiryHours, statusName } from '../../.shared/claims.ts';
import { trimmed } from '../../.shared/io.ts';
import { Jira, requireTracker, todoFor } from '../../.shared/jira.ts';
import { ticketPr, type PrRow } from '../../.shared/tickets.ts';
import { trackerCheck } from '../../.shared/tracker-check.ts';
import { loadJiraBoard, openPulls } from '../../.shared/tracker-board.ts';
import { runLine } from '../../.shared/questions.ts';
import { workability } from '../../.shared/workable.ts';

function gh(args: string[]): unknown {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  return JSON.parse(result.stdout.toString());
}

const released = (run: string): string =>
  `Loop claim released: run ${run} ended. Its \`Loop review:\` comment, if any, says what it did. (Released by the scheduler: the run ended without releasing it.)`;

// Before anything reads GitHub or Jira: a repository without tracker.json gets no lap (AK18e).
trackerCheck('archon-loop');
const config = requireTracker();
const pulls = openPulls();
const hours = expiryHours(trimmed(process.env.INPUTS_CLAIM_HOURS));
const endedRuns = new Set(
  trimmed(process.env.INPUTS_ENDED_RUNS)
    .split(',')
    .map(run => run.trim())
    .filter(run => run !== '')
);

/**
 * Tickets a dead run left in progress. Nothing else finds them: the board holds the queues' tickets and the
 * ones pull requests name, and pick may not write to a ticket in progress. A ticket
 * the loop itself started (`deadClaims`) whose every claim is dead goes back where a lap can
 * take it: its own queue, with the `Loop result:` line the run never wrote, so pick counts the
 * attempt. An open pull request stays open and the next lap continues it: no review approved it,
 * so it is not Review's (Julian 2026-11-20). A ticket without such a claim is a
 * session's and stays. One ticket failing does not stop the gate; it is reported and tried
 * again next time.
 */
async function recoverOrphans(client: Jira): Promise<string[]> {
  const c = client.config;
  const lines: string[] = [];
  const stuck = await client.search(
    `project = ${c.project} AND status = ${c.status.progress} AND assignee = "${c.assignee}"`,
    ['status', 'issuetype', 'statuscategorychangedate']
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
      const typeId = ((fields.issuetype ?? {}) as Record<string, unknown>).id;
      const type = typeof typeId === 'string' ? typeId : '';
      const status = todoFor(type, c);
      const name = statusName(status, c.status);
      // In an order a failure can be picked up from: while the ticket is in progress with its
      // claims on it, the next gate finds it again, so the move comes after the line pick
      // counts (written once) and the claims go last.
      if (!all.some(comment => comment.body.startsWith(`Loop result: run ${holder.run}.`))) {
        await client.comment(
          key,
          `Loop result: run ${holder.run}. PR: ${pr !== '' ? pr : 'kein PR'}. Status: ${name}. (Vom Scheduler: der Lauf endete ohne Abschluss.)`
        );
      }
      let moved = true;
      try {
        await client.moveTo(key, status);
      } catch (error) {
        // Jira keeps it in progress (no way to its queue from where it stands). The owner
        // decides; the claims go anyway, so the ticket does not come back at every gate.
        moved = false;
        const why = error instanceof Error ? error.message : String(error);
        await client.ask(
          key,
          `Lauf ${holder.run} endete ohne Abschluss, und das Ticket kommt nicht auf ${name} (${why.slice(0, 300)}). Bitte Tasks und Status prüfen.\n\n${runLine('archon-loop', 'scheduler')}`
        );
      }
      for (const claim of dead) await client.editComment(key, claim.id, released(claim.run));
      const outcome = moved ? `back to ${name}` : 'stays in progress, asked the owner';
      lines.push(`${key}: ${outcome}, ${dead.length} dead claim(s) released`);
    } catch (error) {
      lines.push(`${key}: could not recover (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return lines;
}
const jira = new Jira(config);
for (const line of await recoverOrphans(jira)) console.error(`workable: ${line}`);
const loaded = await loadJiraBoard(jira, pulls);
// An answer that lifts a park leaves the same items workable, and the scheduler must still
// see the board as changed.
const updated = new Date(loaded.updated).toISOString();
const result = workability(loaded.board, hours, Date.now(), endedRuns, loaded.links);
for (const claim of result.ended) {
  const id = /[?&]focusedCommentId=(\d+)$/.exec(claim.url)?.[1];
  if (id !== undefined) await jira.editComment(claim.key, Number(id), released(claim.run));
}
process.stdout.write(`${JSON.stringify({ ...result, updated })}\n`);
