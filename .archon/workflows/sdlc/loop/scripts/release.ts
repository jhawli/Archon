/**
 * Release this run's claim on its ticket, whatever happened in the run.
 *
 * Runs after review (and deploy) have finished, failed or been skipped, so a run that
 * broke part-way still frees the ticket for the next lap. Only this run's own live claim
 * is touched; a claim another run holds is never edited here.
 *
 * It then sets the status the lap earned (AK18, `finalStatus`), leaves a
 * `Loop result:` comment that pick counts among its attempts, and asks the owner where the
 * lap could not decide (AK18a). The lap's facts come from the run's state records and the
 * deploy block's `deployment.md`, not from bindings: a failed rollout fails the deploy
 * block, and a binding to a failed node fails the node that reads it (see `readLap`). A
 * merge GitHub does not confirm leaves the ticket on Review with a question. If any part of
 * this fails, freeing the claim included, the rest is still tried and the ticket is flagged
 * before the node fails.
 */

import {
  CLAIM_PREFIX,
  comments,
  confirmMerge,
  editComment,
  finalStatus,
  type ItemComment,
  type PrView,
  readClaimedAt,
  readLap,
  runState,
  statusName,
  unnamedPrAsk,
  workItem,
} from '../../.shared/claims.ts';
import { artifactsDir, report, trimmed } from '../../.shared/io.ts';
import { runLine } from '../../.shared/questions.ts';
import { Jira, requireTracker } from '../../.shared/jira.ts';

const target = trimmed(process.env.INPUTS_TARGET);
const pr = trimmed(process.env.INPUTS_PR);
const run = trimmed(process.env.WORKFLOW_ID);
if (run === '') throw new Error('release: WORKFLOW_ID is not set; the engine supplies it to every exec node.');

const config = requireTracker();
// Release runs only after claim held the lap's target, and claim holds tickets only.
const item = workItem(target, config);
const jira = new Jira(config);
const prefix = `${CLAIM_PREFIX}${run}`;
// Every comment and question this lap leaves on its ticket names the run (AK18i).
const line = runLine('archon-loop', run);

// Free the claim. A failure here is kept for the end: the status and the flag below are
// still tried, so the ticket does not sit on In Progress with nothing said.
let all: ItemComment[] = [];
let own: ItemComment[] = [];
let freeError: Error | undefined;
try {
  all = await comments(item, jira);
  own = all.filter(comment => comment.body.startsWith(prefix) && /^\s/.test(comment.body.slice(prefix.length) || ' '));
  for (const comment of own) {
    await editComment(
      item,
      comment.id,
      `Loop claim released: run ${run} ended. Its \`Loop review:\` comment, if any, says what it did.`,
      jira
    );
  }
} catch (error) {
  freeError = error instanceof Error ? error : new Error(String(error));
}
const lines = [
  own.length > 0 ? `released ${own.length} claim(s) on ${item.key}` : `run ${run} held no claim on ${item.key}`,
];

/** The pull request as GitHub reports it, or null when there is none or gh cannot tell. */
function prView(url: string): PrView | null {
  if (!url.startsWith('https://github.com/')) return null;
  const result = Bun.spawnSync(['gh', 'pr', 'view', url, '--json', 'state,mergedAt,title,body'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0 ? (JSON.parse(result.stdout.toString()) as PrView) : null;
}

try {
  const state = runState();
  const recorded = readLap(state, artifactsDir(), pr);
  // What claim recorded, so a second run of this node (its claim already released) still
  // knows it. Without either the time is NaN and no merge is confirmed: the safe side.
  const kept = readClaimedAt(state);
  const claimedAt = Number.isNaN(kept) && own.length > 0 ? Math.min(...own.map(comment => comment.createdAt)) : kept;
  const view = prView(recorded.pr);
  const lap = confirmMerge(recorded, view, item.key, claimedAt, config.project);
  const ticket = await jira.ticket(item.key);
  const doubt = recorded.landed === 'merged' && lap.landed !== 'merged';
  const decided = finalStatus(item.key, ticket.status, lap, config.status);
  const doubted =
    doubt && decided.status !== null && decided.ask === null
      ? {
          ...decided,
          ask: `Der Merge-Schritt meldet ${lap.pr} als gemergt, GitHub bestätigt das für dieses Ticket nicht (gemergt nach dem Claim, Schlüssel im PR). Bitte PR und Status prüfen.`,
        }
      : decided;
  // A pull request without the ticket's key leaves both out of the loop's sight: ask.
  const result =
    doubted.status !== null && doubted.ask === null
      ? { ...doubted, ask: unnamedPrAsk(lap, view, item.key, config.project) }
      : doubted;
  if (result.status !== null && result.status !== ticket.status) await jira.move(item.key, result.status);
  const name = statusName(result.status ?? ticket.status, config.status);
  // Once per run: pick counts these lines as attempts, and this node may run again.
  const said = all.some(comment => comment.body.startsWith(`Loop result: run ${run}.`));
  if (!said) {
    await jira.comment(item.key, `Loop result: run ${run}. PR: ${lap.pr !== '' ? lap.pr : 'kein PR'}. Status: ${name}.\n\n${line}`);
  }
  if (result.ask !== null) await jira.ask(item.key, `${result.ask}\n\n${line}`);
  const unconfirmed = doubt ? ', merge not confirmed by GitHub' : '';
  lines.push(`${item.key}: ${name}${result.ask !== null ? ', asked the owner' : ''}${unconfirmed}`);
  if (freeError !== undefined) throw freeError;
} catch (error) {
  // Flag the ticket so it does not sit there unseen, whatever part of the release failed.
  const why = error instanceof Error ? error.message : String(error);
  try {
    await jira.ask(
      item.key,
      `Lauf ${run} ist nicht sauber zu Ende gekommen (${why.slice(0, 300)}). Bitte Status und Claim des Tickets prüfen.\n\n${line}`
    );
  } catch (flagError) {
    lines.push(`could not flag ${item.key} either: ${flagError instanceof Error ? flagError.message : String(flagError)}`);
  }
  console.error(lines.join('\n'));
  throw error;
}
report(lines.join('\n'));
