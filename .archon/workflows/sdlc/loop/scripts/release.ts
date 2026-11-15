/**
 * Release this run's claim on its work item, whatever happened in the run.
 *
 * Runs after review (and deploy) have finished, failed or been skipped, so a run that
 * broke part-way still frees the item for the next lap. Only this run's own live claim
 * is touched; a claim another run holds is never edited here.
 *
 * On a Jira ticket it then sets the status the lap earned (AK18, `finalStatus`), leaves a
 * `Loop result:` comment that pick counts among its attempts, and asks the owner where the
 * lap could not decide (AK18a). The lap's facts come from files under $ARTIFACTS_DIR, not
 * from bindings: a failed rollout fails the deploy block, and a binding to a failed node
 * fails the node that reads it (see `readLap`).
 */

import { CLAIM_PREFIX, comments, editComment, finalStatus, readLap, statusName, workItem } from '../../.shared/claims.ts';
import { artifactsDir, report, trimmed } from '../../.shared/io.ts';
import { Jira, trackerConfig } from '../../.shared/jira.ts';

const target = trimmed(process.env.INPUTS_TARGET);
const pr = trimmed(process.env.INPUTS_PR);
const run = trimmed(process.env.WORKFLOW_ID);
if (run === '') throw new Error('release: WORKFLOW_ID is not set; the engine supplies it to every exec node.');

const config = trackerConfig();
const item = workItem(target !== '' ? target : pr, config);
const jira = config !== null && item.kind === 'ticket' ? new Jira(config) : undefined;
const prefix = `${CLAIM_PREFIX}${run}`;
const own = (await comments(item, jira)).filter(
  comment => comment.body.startsWith(prefix) && /^\s/.test(comment.body.slice(prefix.length) || ' ')
);
for (const comment of own) {
  await editComment(
    item,
    comment.id,
    `Loop claim released: run ${run} ended. Its \`Loop review:\` comment, if any, says what it did.`,
    jira
  );
}
const lines = [
  own.length > 0 ? `released ${own.length} claim(s) on ${target || pr}` : `run ${run} held no claim on ${target || pr}`,
];

if (config !== null && jira !== undefined && item.kind === 'ticket') {
  const lap = readLap(artifactsDir(), pr);
  const ticket = await jira.ticket(item.key);
  const result = finalStatus(item.key, ticket.status, lap, config.status);
  if (result.status !== null && result.status !== ticket.status) await jira.move(item.key, result.status);
  const name = statusName(result.status ?? ticket.status, config.status);
  await jira.comment(item.key, `Loop result: run ${run}. PR: ${lap.pr !== '' ? lap.pr : 'kein PR'}. Status: ${name}.`);
  if (result.ask !== null) await jira.ask(item.key, result.ask);
  lines.push(`${item.key}: ${name}${result.ask !== null ? ', asked the owner' : ''}`);
}
report(lines.join('\n'));
