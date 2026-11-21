/**
 * Claim the ticket pick chose, so a parallel run of this loop never works it too.
 *
 * Posts this run's claim, reads the ticket back, and holds it only when this run's claim
 * is the oldest live one. A run that lost the race withdraws its claim and does no work
 * this lap; the next lap picks again. Pick already skips claimed tickets, so a lost race
 * means two picks chose the same ticket within moments of each other.
 *
 * A claim already on the ticket for this same run (a resumed run) is reused, not doubled.
 *
 * The run that holds the ticket moves it from its queue to progress and writes it
 * to `$ARTIFACTS_DIR/tracker/item.md`, where the agents read it: they hold no token. A
 * failure anywhere after the claim was posted withdraws it before the node fails, because
 * release only runs for a held claim and the ticket would stay blocked until the claim expired.
 *
 * Pick is an agent, and the ticket it names is checked like its outbox writes (decision 11):
 * it must be a ticket at all (`targetRefusal`; a pull request is continued through the ticket
 * it names), on this lap's snapshot, still the loop's in Jira (`writableNow`), not flagged, not
 * a bug without its `Fehler:` and `Regressionstest:` lines (`unreadyRefusal`), and a pull request it names must not belong to a ticket that is someone else's (`prRefusal`).
 * Anything else, the owner's or a session's, is not claimed and the lap does no work.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAIM_PREFIX,
  claimStart,
  editComment,
  expiryHours,
  itemMarkdown,
  liveClaims,
  postComment,
  recordClaim,
  runState,
  targetRefusal,
  type WorkItem,
  workItem,
} from '../../.shared/claims.ts';
import { unreadyRefusal } from '../../.shared/bug-ready.ts';
import { artifactsDir, emit, trimmed } from '../../.shared/io.ts';
import { Jira, requireTracker } from '../../.shared/jira.ts';
import { clearOutbox, type PrText, prAddressRefusal, prRefusal, writableNow } from '../../.shared/outbox.ts';
import { prKeys } from '../../.shared/tickets.ts';

const target = trimmed(process.env.INPUTS_TARGET);
const pr = trimmed(process.env.INPUTS_PR);
const route = trimmed(process.env.INPUTS_ROUTE);
const area = trimmed(process.env.INPUTS_AREA);
const hours = expiryHours(trimmed(process.env.INPUTS_CLAIM_HOURS));
const run = trimmed(process.env.WORKFLOW_ID);
if (run === '') throw new Error('claim: WORKFLOW_ID is not set; the engine supplies it to every exec node.');

const config = requireTracker();
const jira = new Jira(config);
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Why pick's ticket is not the loop's to work on, or null. */
async function refusal(key: string): Promise<string | null> {
  const state = runState();
  if (!(await writableNow(jira, state, key)).has(key)) {
    return `${key} is not on this lap's board, or no longer assigned to the loop on its queue (Startklar, Gemeldet) or Review`;
  }
  // The launch rule leaves a flagged ticket alone; a flag pick lifted this lap is already off.
  const ticket = await jira.ticket(key);
  if (ticket.flagged) return `${key} is flagged: a question to the owner is open`;
  const unready = unreadyRefusal(ticket, config.types.bug);
  if (unready !== null) return unready;
  if (pr === '') return null;
  const gh = (args: string[]): string => {
    const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(`claim: gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.toString().trim()}`);
    return result.stdout.toString();
  };
  // The address is an agent's: it is this repository's pull request URL before gh sees it.
  const repository = (JSON.parse(gh(['repo', 'view', '--json', 'url'])) as { url: string }).url;
  const address = prAddressRefusal(pr, repository, null);
  if (address !== null) return address;
  const text = JSON.parse(gh(['pr', 'view', pr, '--json', 'title,body,isCrossRepository'])) as PrText;
  const fork = prAddressRefusal(pr, repository, text);
  if (fork !== null) return fork;
  const others = prKeys(text, config.project).filter(named => named !== key);
  const statuses = new Map<string, string>();
  if (others.length > 0) {
    for (const row of await jira.search(`key in (${others.join(',')})`, ['status'])) {
      statuses.set(jira.toTicket(row, false).key, jira.toTicket(row, false).status);
    }
  }
  return prRefusal(text, key, statuses, await writableNow(jira, state), config);
}

/** Claim the ticket, and hold it when this run's claim is the oldest live one. */
async function claimTicket(item: WorkItem): Promise<void> {
  /** Take this run's claim back; a failure to do so must not hide the error that led here. */
  async function withdraw(id: number, why: string): Promise<void> {
    try {
      await editComment(item, id, `Loop claim withdrawn: run ${run} ${why}`, jira);
    } catch (error) {
      console.error(`claim: could not withdraw claim ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let claims = await liveClaims(item, hours, Date.now(), jira);
  let mine = claims.find(claim => claim.run === run);
  // A claim of this run already on the ticket passed this check when it was posted.
  const refused = mine === undefined ? await refusal(item.key) : null;
  if (refused !== null) {
    emit({ held: 'false', holder: '', reason: `${refused}; this run does no work this lap` });
    return;
  }
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
  if (holder.id !== mine.id) {
    await withdraw(mine.id, `(run ${holder.run} claimed this item first).`);
    emit({
      held: 'false',
      holder: holder.run,
      reason: `run ${holder.run} claimed ${target} first; this run does no work this lap`,
    });
    return;
  }
  // The builder runs next: an outbox left in its name or the reviewer's by pick is not theirs.
  clearOutbox(artifactsDir(), ['build', 'review']);
  try {
    // For release: a merge counts only when it came after this claim.
    recordClaim(runState(), mine.createdAt);
    const ticket = await jira.ticket(item.key);
    const start = claimStart(ticket.status, config.status);
    const status = start ?? ticket.status;
    const dir = join(artifactsDir(), 'tracker');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'item.md'), itemMarkdown({ ...ticket, status }, await jira.comments(item.key), config));
    // Last, so a failure above leaves the ticket in its queue, where pick finds it again.
    if (start !== null) await jira.move(item.key, start);
  } catch (error) {
    await withdraw(mine.id, `could not set up the ticket (${reason(error)}).`);
    throw error;
  }
  emit({ held: 'true', holder: run, reason: `run ${run} holds ${target}` });
}

// Pick is an agent: a target that is not a ticket is refused before anything is posted.
const notTicket = targetRefusal(target, pr, config);
if (notTicket !== null) emit({ held: 'false', holder: '', reason: `${notTicket}; this run does no work this lap` });
else await claimTicket(workItem(target, config));
