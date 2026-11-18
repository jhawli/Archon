/**
 * Rest tickets as Jira sub-tasks, and the parent that waits for them (VAULT-22).
 *
 * A partial delivery files its rest as a sub-task of the lap's ticket, so the parts stay
 * together in Jira. The parent does not go to Staging while a sub-task is open: it stays In
 * Progress with a `Loop wait:` record (`finalStatus`), and goes to Staging once every sub-task
 * is on Staging, Live or Canceled. Jira's workflow holds the same line on its own (a sub-task
 * blocking condition on the Staging and Live transitions), so neither a session nor the UI
 * moves such a parent past it either.
 *
 * Who moves the waiting parent: the lap or merge queue that sets its last sub-task
 * (`promoteParent`), and every lap's first node for the rest (`sweepWaiting`), a sub-task
 * canceled by hand included.
 */
import { CLAIM_PREFIX } from './claims.ts';
import { doneStatuses, type Family, type Jira, type TicketComment, type TrackerConfig } from './jira.ts';

/** The record of a parent waiting for its sub-tasks; agents may not write it (`reservedText`). */
export const WAIT_PREFIX = 'Loop wait: ';
/** The record that the wait is over (the parent went to Staging); a later In Progress is not a wait. */
export const WAIT_ENDED_PREFIX = 'Loop wait ended: ';

/** Sub-tasks that keep their parent from Staging: any not on Staging, Live or Canceled. */
export function openChildren(family: Family, s: TrackerConfig['status']): string[] {
  const done = doneStatuses(s);
  return family.children.filter(child => !done.has(child.status)).map(child => child.key);
}

/**
 * The ticket a rest of `key` goes under: `key` itself, or its parent when `key` is a sub-task
 * (Jira has no sub-task under a sub-task). Null when that ticket is not open in the active
 * sprint (not in it, or on Staging, Live or Canceled): then the rest is a ticket of its own.
 */
export async function restParent(jira: Jira, key: string): Promise<string | null> {
  const s = jira.config.status;
  const own = await jira.family(key);
  const target = own.subtask ? own.parent : key;
  if (target === null) return null;
  const family = target === key ? own : await jira.family(target);
  if (family.subtask) return null;
  return family.activeSprint && !doneStatuses(s).has(family.status) ? target : null;
}

export function waitText(keys: readonly string[]): string {
  return `${WAIT_PREFIX}geliefert, wartet auf die Subtickets ${keys.join(', ')}. Stehen alle auf Staging, Live oder Canceled, setzt der Loop dieses Ticket auf Staging.`;
}

/**
 * Whether the ticket's latest loop record says it waits for its sub-tasks. A live claim after
 * it means a lap took the ticket up again (a released claim no longer reads as one), and a
 * `Loop wait ended:` means the wait is over: a ticket set back to In Progress later is not waiting.
 */
export function waiting(comments: readonly TicketComment[], config: TrackerConfig): boolean {
  const records = comments.filter(
    comment =>
      comment.author === config.assignee &&
      [WAIT_PREFIX, WAIT_ENDED_PREFIX, CLAIM_PREFIX].some(prefix => comment.body.startsWith(prefix))
  );
  return records.at(-1)?.body.startsWith(WAIT_PREFIX) ?? false;
}

/**
 * Moves a waiting parent to Staging once none of its sub-tasks is open. Returns what it did,
 * or null when the ticket is not a waiting parent or still has open sub-tasks. The move goes
 * first: a comment saying Staging on a ticket that is not would be worse than the reverse.
 */
export async function promoteParent(jira: Jira, key: string, line: string): Promise<string | null> {
  const s = jira.config.status;
  const family = await jira.family(key);
  if (family.status !== s.progress || family.children.length === 0) return null;
  if (openChildren(family, s).length > 0) return null;
  if (!waiting(await jira.comments(key), jira.config)) return null;
  await jira.move(key, s.staging);
  const children = family.children.map(child => child.key).join(', ');
  await jira.comment(key, `${WAIT_ENDED_PREFIX}alle Subtickets (${children}) stehen auf Staging, Live oder Canceled: ${key} geht auf Staging.\n\n${line}`);
  return `${key}: Staging, its sub-tasks are done`;
}

/**
 * Every waiting parent of the loop's (In Progress, assigned to the loop), moved where its
 * sub-tasks allow. A ticket that fails is reported and left for the next lap; it never stops
 * the lap that sweeps.
 */
export async function sweepWaiting(jira: Jira, line: string): Promise<string[]> {
  const c = jira.config;
  const found = await jira.search(`project = ${c.project} AND status = ${c.status.progress} AND assignee = "${c.assignee}"`, ['status']);
  const lines: string[] = [];
  for (const row of found) {
    const key = String(row.key);
    try {
      const done = await promoteParent(jira, key, line);
      if (done !== null) lines.push(done);
    } catch (error) {
      lines.push(`${key}: could not be moved to Staging (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return lines;
}
