/**
 * The ticket side of the loop's release node (AK18, VAULT-28): the status the lap earned
 * (`finalStatus`), the slice's tasks settled on the way (`settleAndMove`), one `Loop result:`
 * comment per run that pick counts among its attempts, and one question per run where the lap
 * could not decide (AK18a). release.ts reads the lap's facts and frees the claim around it.
 */
import { finalStatus, type ItemComment, type LapResult, type PrView, restMarker, statusName, unnamedPrAsk } from './claims.ts';
import { type Jira, todoFor } from './jira.ts';
import { askedBefore } from './questions.ts';
import { reopenBuilt, settleAndMove } from './subtickets.ts';

/** How many passed-over progress reports the `Loop result:` comment names (CONC-176 AK3). */
const MAX_PASSED = 10;

export interface Released {
  /** The status the ticket is on now, by its lifecycle name. */
  readonly name: string;
  readonly asked: boolean;
  /** The merge land recorded is one GitHub does not confirm. */
  readonly unconfirmed: boolean;
  readonly notes: readonly string[];
}

/**
 * `recorded` is the lap as its nodes recorded it, `lap` the same after `confirmMerge`, `view` the
 * pull request as GitHub shows it, `all` the ticket's comments as read before the claim was
 * freed: a `Loop result:` of this run among them means this node ran before, and it is not
 * written again. `line` signs every comment and question with the run. `passed` are the progress
 * reports the loop passed over this run (CONC-176 AK3), named in the `Loop result:` comment.
 */
export async function releaseTicket(
  jira: Jira,
  key: string,
  laps: { readonly recorded: LapResult; readonly lap: LapResult; readonly view: PrView | null },
  run: string,
  line: string,
  all: readonly ItemComment[],
  passed: readonly string[] = []
): Promise<Released> {
  const c = jira.config;
  const { recorded, lap, view } = laps;
  const ticket = await jira.ticket(key);
  const unconfirmed = recorded.landed === 'merged' && lap.landed !== 'merged';
  // A lap without a pull request gives the ticket back to its own queue: a bug to its start status.
  const decided = finalStatus(key, ticket.status, lap, c.status, todoFor(ticket.type, c));
  const doubted =
    unconfirmed && decided.status !== null && decided.ask === null
      ? {
          ...decided,
          ask: `Der Merge-Schritt meldet ${lap.pr} als gemergt, GitHub bestätigt das für dieses Ticket nicht (gemergt nach dem Claim, Schlüssel im PR). Bitte PR und Status prüfen.`,
        }
      : decided;
  // A pull request without the ticket's key leaves both out of the loop's sight: ask.
  const result =
    doubted.status !== null && doubted.ask === null ? { ...doubted, ask: unnamedPrAsk(lap, view, key, c.project) } : doubted;
  // Jira lets a slice onto Review only without open tasks: the lap settles them first (VAULT-28,
  // decision 5), the rest's tasks under the rest slice review filed; then the move goes along the
  // lifecycle (a delivery from progress passes Review, a way back from Review passes progress).
  const goal = result.status ?? ticket.status;
  const settled =
    goal !== ticket.status
      ? await settleAndMove(jira, key, ticket.status, goal, lap, lap.created[restMarker(key)] ?? null)
      : { status: goal, notes: [], left: [] };
  // CONC-176: a lap that settled no task and merged nothing (sent back, given back) sends its built
  // tasks the review did not name back to In Arbeit; the named ones stay built until a delivery. A
  // lap on its way to Review (approved for a manual merge) waits for that merge and sends none back.
  const settledTasks = goal !== ticket.status && (goal === c.status.review || goal === c.status.staging);
  // `recorded`, not `lap`: a merge GitHub does not confirm may still be a delivery, so nothing goes back.
  const reopened = !settledTasks && recorded.landed !== 'merged' ? await reopenBuilt(jira, key, lap.tasks) : [];
  // Tasks the review did not settle keep the slice in progress: the owner says what is missing.
  const leftAsk =
    settled.left.length > 0
      ? `Offene Tasks (${settled.left.join(', ')}): Jira lässt die Scheibe so nicht auf ${statusName(goal, c.status)}. Was fehlt noch?`
      : null;
  const ask = result.ask !== null && leftAsk !== null ? `${result.ask}\n\n${leftAsk}` : (leftAsk ?? result.ask);
  const name = statusName(settled.status, c.status);
  // Once per run: pick counts these lines as attempts, and this node may run again.
  if (!all.some(comment => comment.body.startsWith(`Loop result: run ${run}.`))) {
    // At most MAX_PASSED reasons: a list of 80 bad reports would bury the result.
    const shown = passed.length > MAX_PASSED ? [...passed.slice(0, MAX_PASSED), `… und ${passed.length - MAX_PASSED} weitere übergangene Meldungen.`] : passed;
    const lines = [...settled.notes, ...reopened, ...shown];
    const tasks = lines.length > 0 ? `\n\n${lines.join('\n')}` : '';
    await jira.comment(key, `Loop result: run ${run}. PR: ${lap.pr !== '' ? lap.pr : 'kein PR'}. Status: ${name}.${tasks}\n\n${line}`);
  }
  // Once per run as well: a second `@` mention would mail the owner twice.
  if (ask !== null && !askedBefore(await jira.comments(key), ask, line, c)) {
    await jira.ask(key, `${ask}\n\n${line}`);
  }
  return { name, asked: ask !== null, unconfirmed, notes: [...settled.notes, ...reopened] };
}
