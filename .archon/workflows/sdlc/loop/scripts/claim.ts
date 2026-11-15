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
 * failure anywhere after the claim was posted withdraws it before the node fails, because
 * release only runs for a held claim and the ticket would stay blocked until the claim expired.
 *
 * Pick is an agent, and the ticket it names is checked like its outbox writes (decision 11):
 * it must be on this lap's snapshot, still the loop's in Jira (`writableNow`) and not flagged,
 * and a pull request it names must not belong to a ticket that is someone else's (`prRefusal`).
 * Anything else, the owner's or a session's, is not claimed and the lap does no work.
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
  recordClaim,
  runState,
  workItem,
} from '../../.shared/claims.ts';
import { artifactsDir, emit, trimmed } from '../../.shared/io.ts';
import { Jira, trackerConfig } from '../../.shared/jira.ts';
import { clearOutbox, type PrText, prKeys, prRefusal, writableNow } from '../../.shared/outbox.ts';

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
// The pull request the lap continues: named beside the ticket, or itself the target.
const pull = pr !== '' ? pr : item.kind === 'github' ? target : '';

/** Take this run's claim back; a failure to do so must not hide the error that led here. */
async function withdraw(id: number, why: string): Promise<void> {
  try {
    await editComment(item, id, `Loop claim withdrawn: run ${run} ${why}`, jira);
  } catch (error) {
    console.error(`claim: could not withdraw claim ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

let claims = await liveClaims(item, hours, Date.now(), jira);
let mine = claims.find(claim => claim.run === run);

/** Why pick's choice is not the loop's to work on, or null. Jira only; GitHub has no such rule. */
async function refusal(): Promise<string | null> {
  if (config === null) return null;
  const client = jira ?? new Jira(config);
  const state = runState();
  const key = item.kind === 'ticket' ? item.key : null;
  if (key !== null) {
    if (!(await writableNow(client, state, key)).has(key)) {
      return `${key} is not on this lap's board, or no longer assigned to the loop on To Do or Review`;
    }
    // The launch rule leaves a flagged ticket alone; a flag pick lifted this lap is already off.
    if ((await client.ticket(key)).flagged) return `${key} is flagged: a question to the owner is open`;
  }
  if (pull === '') return null;
  const view = Bun.spawnSync(['gh', 'pr', 'view', pull, '--json', 'title,body'], { stdout: 'pipe', stderr: 'pipe' });
  if (view.exitCode !== 0) throw new Error(`claim: gh pr view ${pull} failed: ${view.stderr.toString().trim()}`);
  const text = JSON.parse(view.stdout.toString()) as PrText;
  const others = prKeys(text, config.project).filter(named => named !== key);
  const statuses = new Map<string, string>();
  if (others.length > 0) {
    for (const row of await client.search(`key in (${others.join(',')})`, ['status'])) {
      statuses.set(client.toTicket(row, false).key, client.toTicket(row, false).status);
    }
  }
  return prRefusal(text, key, statuses, await writableNow(client, state), config);
}

// A claim of this run already on the item passed this check when it was posted.
const refused = mine === undefined ? await refusal() : null;
if (refused !== null) {
  emit({ held: 'false', holder: '', reason: `${refused}; this run does no work this lap` });
} else {
  if (mine === undefined) {
    const body = [
      `${CLAIM_PREFIX}${run}`,
      '',
      `Route: ${route}${pr !== '' ? ` (${pr})` : ''}`,
      `Area: ${area !== '' ? area : 'not stated'}`,
      '',
      `This loop is working this item. Other runs of the loop leave it, and work in the area above, alone until this claim is released or is ${hours} hours old.`,
    ].join('\n');
    const posted = await postComment(item, body, jira);
    try {
      // A rival's claim posted a moment earlier may not be readable yet; let it settle so
      // both runs read the same set of claims back.
      Bun.sleepSync(5000);
      claims = await liveClaims(item, hours, Date.now(), jira);
      mine = claims.find(claim => claim.run === run);
      if (mine === undefined) throw new Error('claim: this run\'s claim is not on the item after posting it');
    } catch (error) {
      await withdraw(posted, `could not read its claim back (${reason(error)}).`);
      throw error;
    }
  }

  const holder = claims[0];
  if (holder.id === mine.id) {
    // The builder runs next: an outbox left in its name or the reviewer's by pick is not theirs.
    if (config !== null) clearOutbox(artifactsDir(), ['build', 'review']);
    if (config !== null && jira !== undefined && item.kind === 'ticket') {
      try {
        // For release: a merge counts only when it came after this claim.
        recordClaim(runState(), mine.createdAt);
        const ticket = await jira.ticket(item.key);
        const start = ticket.status === config.status.todo;
        const status = start ? config.status.progress : ticket.status;
        const dir = join(artifactsDir(), 'tracker');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'item.md'),
          itemMarkdown({ ...ticket, status }, await jira.comments(item.key), config)
        );
        // Last, so a failure above leaves the ticket on To Do, where pick finds it again.
        if (start) await jira.move(item.key, config.status.progress);
      } catch (error) {
        await withdraw(mine.id, `could not set up the ticket (${reason(error)}).`);
        throw error;
      }
    }
    emit({ held: 'true', holder: run, reason: `run ${run} holds ${target || pr}` });
  } else {
    await withdraw(mine.id, `(run ${holder.run} claimed this item first).`);
    emit({
      held: 'false',
      holder: holder.run,
      reason: `run ${holder.run} claimed ${target || pr} first; this run does no work this lap`,
    });
  }
}
