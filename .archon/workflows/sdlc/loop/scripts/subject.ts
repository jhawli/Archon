/**
 * Name what the app check tests, without handing it the builder's account of the change.
 *
 * Given the builder's report or the pull request's description first, the app check anchored
 * on them and tested what they said. So this step reads those only to find the pull request,
 * and passes on facts: the pull request, its head, its base and the files it changes. It also
 * records when the check began, so the evidence check can tell evidence written during the
 * check from files that were already there. An empty `pr` means nothing was delivered.
 */

import { recordLap, runState } from '../../.shared/claims.ts';
import { emit, trimmed } from '../../.shared/io.ts';
import { requireTracker } from '../../.shared/jira.ts';
import { type PrRow, ticketKeyOf, ticketPr } from '../../.shared/tickets.ts';

const started = String(Date.now());
const target = trimmed(process.env.INPUTS_TARGET);
const chosen = trimmed(process.env.INPUTS_PR);
const reports = `${trimmed(process.env.INPUTS_BUILDER)}\n${trimmed(process.env.INPUTS_SHIP)}`;
const config = requireTracker();

function gh(args: string[]): unknown {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.toString().trim()}`);
  return JSON.parse(result.stdout.toString());
}

function findPr(): string {
  if (chosen !== '') return chosen;
  const named = [...reports.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)].map(m => m[0]);
  if (named.length > 0) return named[named.length - 1];
  const key = ticketKeyOf(target, config);
  if (key === null) return '';
  // Listed, not searched: the search index lags a pull request the builder opened moments ago.
  const open = gh(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'url,title,body,updatedAt,isCrossRepository']) as PrRow[];
  return ticketPr(open, key, config.project);
}

const pr = findPr();
// Recorded before the pull request is read: if that read fails, release still knows there is one.
recordLap(runState(), { pr });
if (pr === '') {
  emit({ pr: '', head: '', base: '', files: '', started });
} else {
  const view = gh(['pr', 'view', pr, '--json', 'number,headRefOid,baseRefName,files']) as {
    number: number;
    headRefOid: string;
    baseRefName: string;
    files: { path: string }[];
  };
  // The API's head can lag a push made moments ago; git's view of the pull request's ref does not.
  const ref = `refs/remotes/origin/loop-subject-${view.number}`;
  Bun.spawnSync(['git', 'fetch', '--quiet', 'origin', `+refs/pull/${view.number}/head:${ref}`]);
  const fetched = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', ref], { stdout: 'pipe' });
  const head = fetched.exitCode === 0 ? fetched.stdout.toString().trim() : view.headRefOid;
  emit({ pr, head: head || view.headRefOid, base: view.baseRefName, files: view.files.map(f => f.path).join('\n'), started });
}
