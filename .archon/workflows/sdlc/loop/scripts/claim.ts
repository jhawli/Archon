/**
 * Claim the work item pick chose, so a parallel run of this loop never works it too.
 *
 * Posts this run's claim, reads the item back, and holds it only when this run's claim
 * is the oldest live one. A run that lost the race withdraws its claim and does no work
 * this lap; the next lap picks again. Pick already skips claimed items, so a lost race
 * means two picks chose the same item within moments of each other.
 *
 * A claim already on the item for this same run (a resumed run) is reused, not doubled.
 *
 * On a Jira ticket the run that holds it moves it from To Do to In Progress and writes it
 * to `$ARTIFACTS_DIR/tracker/item.md`, where the agents read it: they hold no token. A
 * failure there withdraws the claim before the node fails, because release only runs for
 * a held claim and the ticket would stay blocked until the claim expired.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAIM_PREFIX,
  editComment,
  expiryHours,
  itemMarkdown,
  liveClaims,
  postComment,
  workItem,
} from '../../.shared/claims.ts';
import { artifactsDir, emit, trimmed } from '../../.shared/io.ts';
import { Jira, trackerConfig } from '../../.shared/jira.ts';

const target = trimmed(process.env.INPUTS_TARGET);
const pr = trimmed(process.env.INPUTS_PR);
const route = trimmed(process.env.INPUTS_ROUTE);
const area = trimmed(process.env.INPUTS_AREA);
const hours = expiryHours(trimmed(process.env.INPUTS_CLAIM_HOURS));
const run = trimmed(process.env.WORKFLOW_ID);
if (run === '') throw new Error('claim: WORKFLOW_ID is not set; the engine supplies it to every exec node.');

const config = trackerConfig();
const item = workItem(target !== '' ? target : pr, config);
const jira = config !== null && item.kind === 'ticket' ? new Jira(config) : undefined;
let claims = await liveClaims(item, hours, Date.now(), jira);
let mine = claims.find(claim => claim.run === run);
if (mine === undefined) {
  const body = [
    `${CLAIM_PREFIX}${run}`,
    '',
    `Route: ${route}${pr !== '' ? ` (${pr})` : ''}`,
    `Area: ${area !== '' ? area : 'not stated'}`,
    '',
    `This loop is working this item. Other runs of the loop leave it, and work in the area above, alone until this claim is released or is ${hours} hours old.`,
  ].join('\n');
  await postComment(item, body, jira);
  // A rival's claim posted a moment earlier may not be readable yet; let it settle so
  // both runs read the same set of claims back.
  Bun.sleepSync(5000);
  claims = await liveClaims(item, hours, Date.now(), jira);
  mine = claims.find(claim => claim.run === run);
  if (mine === undefined) throw new Error('claim: this run\'s claim is not on the item after posting it');
}

const holder = claims[0];
if (holder.id === mine.id) {
  if (config !== null && jira !== undefined && item.kind === 'ticket') {
    try {
      const ticket = await jira.ticket(item.key);
      const start = ticket.status === config.status.todo;
      const status = start ? config.status.progress : ticket.status;
      const dir = join(artifactsDir(), 'tracker');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'item.md'),
        itemMarkdown({ ...ticket, status }, await jira.comments(item.key), config.status)
      );
      // Last, so a failure above leaves the ticket on To Do, where pick finds it again.
      if (start) await jira.move(item.key, config.status.progress);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      await editComment(
        item,
        mine.id,
        `Loop claim withdrawn: run ${run} could not set up the ticket (${why.slice(0, 300)}).`,
        jira
      );
      throw error;
    }
  }
  emit({ held: 'true', holder: run, reason: `run ${run} holds ${target || pr}` });
} else {
  await editComment(item, mine.id, `Loop claim withdrawn: run ${run} (run ${holder.run} claimed this item first).`, jira);
  emit({
    held: 'false',
    holder: holder.run,
    reason: `run ${holder.run} claimed ${target || pr} first; this run does no work this lap`,
  });
}
