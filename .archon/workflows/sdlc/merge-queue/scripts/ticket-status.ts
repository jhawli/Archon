/**
 * The tickets this batch's merges name, after the one rollout (AK18h, Grill G5): each moved as
 * the loop's release moves its ticket (`queueStatus`, `applyQueueMove`), with one comment per run
 * and pull request and a question where the rollout or the merge is not confirmed, or where a
 * slice still has open tasks (a merge closes none). The facts come from the run's
 * records (merges, start) and the deploy block's `deployment.md`, never from node outputs: a
 * failed rollout fails the deploy block, and a binding to a failed node fails its reader. A
 * ticket that fails is flagged with a question and the others still run; the node fails at the end.
 */
import { artifactsDir, report, trimmed } from '../../.shared/io.ts';
import { deployedFact, type PrView, runState, statusName } from '../../.shared/claims.ts';
import { Jira, pinTrackerConfig } from '../../.shared/jira.ts';
import { applyQueueMove, queueStatus, readMerges, readStart } from '../../.shared/queue-status.ts';
import { runLine } from '../../.shared/questions.ts';
import { prKeys } from '../../.shared/tickets.ts';

const run = trimmed(process.env.WORKFLOW_ID);
const state = runState();
const merges = readMerges(state);
if (merges.length === 0) {
  report('no merges');
} else {
  const config = pinTrackerConfig(state);
  const jira = new Jira(config);
  const line = runLine('archon-merge-queue', run);
  const deployed = deployedFact(artifactsDir()) === 'true';
  const failures: string[] = [];
  const lines: string[] = [];

  /** The pull request as GitHub reports it, or null when gh cannot tell. */
  const prView = (url: string): PrView | null => {
    const result = Bun.spawnSync(['gh', 'pr', 'view', url, '--json', 'state,mergedAt,title,body'], { stdout: 'pipe', stderr: 'pipe' });
    return result.exitCode === 0 ? (JSON.parse(result.stdout.toString()) as PrView) : null;
  };
  const views = new Map<string, PrView>();
  for (const { url } of merges) {
    const view = prView(url);
    if (view === null) failures.push(`${url}: GitHub did not show the pull request, its tickets stay as they are`);
    else views.set(url, view);
  }
  const tickets = new Map<string, string>();
  for (const key of new Set([...views.values()].flatMap(view => prKeys(view, config.project)))) {
    try {
      const family = await jira.family(key);
      tickets.set(key, family.status);
    } catch (error) {
      failures.push(`${key}: could not be read (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  for (const move of queueStatus(merges, deployed, views, tickets, readStart(state), config)) {
    try {
      const done = await applyQueueMove(jira, move, tickets.get(move.key) ?? '', run, line);
      tickets.set(move.key, done.status);
      lines.push(`${move.key}: ${statusName(done.status, config.status)}${done.asked ? ', asked the owner' : ''}`, ...done.notes);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      failures.push(`${move.key}: ${why}`);
      try {
        await jira.ask(move.key, `Merge-Queue-Lauf ${run} konnte das Ticket nach dem Merge von ${move.pr} nicht setzen (${why.slice(0, 300)}). Bitte Status prüfen.\n\n${line}`);
      } catch (flagError) {
        failures.push(`could not flag ${move.key} either: ${flagError instanceof Error ? flagError.message : String(flagError)}`);
      }
    }
  }
  if (failures.length > 0) {
    console.error([...lines, ...failures].join('\n'));
    throw new Error(`ticket-status: ${failures.length} problem(s), see above`);
  }
  report(lines.length > 0 ? lines.join('\n') : 'merged pull requests name no ticket on the board');
}
