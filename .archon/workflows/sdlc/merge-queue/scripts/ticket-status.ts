/**
 * The tickets this batch's merges name, after the one rollout (AK18h, Grill G5): each moved as
 * the loop's release moves its ticket (`queueStatus`), with one comment per run and pull request
 * and a question where the rollout or the merge is not confirmed. The facts come from the run's
 * records (merges, start) and the deploy block's `deployment.md`, never from node outputs: a
 * failed rollout fails the deploy block, and a binding to a failed node fails its reader. A
 * ticket that fails is flagged with a question and the others still run; the node fails at the end.
 */
import { artifactsDir, report, trimmed } from '../../.shared/io.ts';
import { deployedFact, type PrView, runState, statusName } from '../../.shared/claims.ts';
import { Jira, pinTrackerConfig } from '../../.shared/jira.ts';
import { queueStatus, readMerges, readStart } from '../../.shared/queue-status.ts';
import { askedBefore, runLine } from '../../.shared/questions.ts';
import { promoteParent } from '../../.shared/subtickets.ts';
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
  // A sub-task's parent may go on after it (VAULT-22).
  const parents = new Map<string, string>();
  for (const key of new Set([...views.values()].flatMap(view => prKeys(view, config.project)))) {
    try {
      const family = await jira.family(key);
      tickets.set(key, family.status);
      if (family.subtask && family.parent !== null) parents.set(key, family.parent);
    } catch (error) {
      failures.push(`${key}: could not be read (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  for (const move of queueStatus(merges, deployed, views, tickets, readStart(state), config)) {
    try {
      const current = tickets.get(move.key) ?? '';
      if (move.status !== null && move.status !== current) await jira.moveTo(move.key, move.status);
      if (move.status !== null) tickets.set(move.key, move.status);
      const name = statusName(move.status ?? current, config.status);
      // Once per run and pull request, the question once per run: this node may run again.
      const comments = await jira.comments(move.key);
      const head = `Merge-Queue: Lauf ${run}. PR: ${move.pr}.`;
      if (!comments.some(comment => comment.body.startsWith(head))) {
        await jira.comment(move.key, `${head} Status: ${name}.\n\n${line}`);
      }
      if (move.ask !== null && !askedBefore(comments, move.ask, line, config)) await jira.ask(move.key, `${move.ask}\n\n${line}`);
      lines.push(`${move.key}: ${name}${move.ask !== null ? ', asked the owner' : ''}`);
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
  // A sub-task this batch set may have been its parent's last open one. A failure here is the
  // parent's; the next loop lap's sweep tries again.
  for (const parent of new Set(parents.values())) {
    try {
      const moved = await promoteParent(jira, parent, line);
      if (moved !== null) lines.push(moved);
    } catch (error) {
      lines.push(`${parent}: not moved on yet (${error instanceof Error ? error.message : String(error)}), the next loop lap's sweep tries again`);
    }
  }
  if (failures.length > 0) {
    console.error([...lines, ...failures].join('\n'));
    throw new Error(`ticket-status: ${failures.length} problem(s), see above`);
  }
  report(lines.length > 0 ? lines.join('\n') : 'merged pull requests name no ticket on the board');
}
