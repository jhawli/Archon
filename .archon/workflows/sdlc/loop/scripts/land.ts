/**
 * The merge gate: merge what the reviewer accepted, only when the record supports it.
 *
 * Left to merge by itself, the reviewer merged over defects the app check had seen, over a
 * shipping pipeline whose review step had crashed, and onto a default branch that had moved
 * since anything was tested. So the reviewer decides `merge` and names the commit, and this
 * step, with no model, merges only when the record rules in `.shared/merge-gate.ts` hold, the
 * pull request's head is the reviewed commit, contains the current default branch, and is what
 * the app check tested (or that plus a clean merge of the default branch that touches none of
 * this change's files).
 * A refusal is posted as `Loop review: not merged`, so the next lap continues with the
 * reasons in hand. The forge is GitHub, through `gh`, like the rest of this loop.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { needsBefund, readBefund, type Befund } from '../../.shared/befund.ts';
import { readCreated, recordLanding, runState } from '../../.shared/claims.ts';
import { Jira, requireTracker, type Ticket, type TicketComment } from '../../.shared/jira.ts';
import { artifactsDir, emit, text, trimmed } from '../../.shared/io.ts';
import {
  CLOCK_SLACK_MS,
  parseDispositions,
  parseJudgeChanges,
  readAppCheck,
  recordRefusals,
  shipFailuresInLog,
  ownerApprovals,
  trackingRefs,
  untestedMerge,
} from '../../.shared/merge-gate.ts';
import { protectedFiles } from '../../.shared/protected-paths.ts';
import { loosenedNote } from '../../.shared/questions.ts';
import { ticketKeyOf } from '../../.shared/tickets.ts';

const prUrl = trimmed(process.env.INPUTS_PR);
const named = trimmed(process.env.INPUTS_SHA);
const route = trimmed(process.env.INPUTS_ROUTE);
const target = trimmed(process.env.INPUTS_TARGET);
const delivers = trimmed(process.env.INPUTS_DELIVERS);
// The review's `Tasks done: 1, 2` line (VAULT-28); release reads only the numbers out of it.
const tasks = trimmed(process.env.INPUTS_TASKS);
const evidenceProblems = text(process.env.INPUTS_EVIDENCE_PROBLEMS).split('\n').filter(line => line.trim() !== '');
const reviewStarted = Number(trimmed(process.env.INPUTS_REVIEW_STARTED)) || 0;
const prFiles = text(process.env.INPUTS_FILES).split('\n').map(f => f.trim()).filter(f => f !== '');
const logPath = join(trimmed(process.env.LOG_DIR), `${trimmed(process.env.WORKFLOW_ID)}.jsonl`);
const artifacts = artifactsDir();
// Release reads the outcome from the run's state directory. Resolved before any merge, so a
// broken one fails the gate rather than a merged pull request's bookkeeping.
const config = requireTracker();
const trackerState = runState();
const report = readAppCheck(text(process.env.INPUTS_REPORT));

function run(cmd: string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

// A reviewer may name the commit by a short id (seen live); compare the full one it stands for.
const resolved = named === '' ? null : run(['git', 'rev-parse', '--verify', '--quiet', `${named}^{commit}`]);
const sha = resolved !== null && resolved.code === 0 ? resolved.out.trim() : named;

const dispositions = parseDispositions(text(process.env.INPUTS_DISPOSITIONS));
// The gate asks synchronously, so every reference a disposition names is read here first:
// `CONC-n` or `new:<marker>` (a ticket the review filed this run).
let client: Jira | undefined;
const tracking = await trackingRefs([...dispositions.values()].map(d => d.issue), {
  jira: {
    config,
    created: readCreated(trackerState),
    target: ticketKeyOf(target, config) ?? '',
    // The keychain is read only when a disposition names a ticket or an approval a comment.
    ticket: async (key): Promise<Ticket> => (client ??= new Jira(config)).ticket(key),
  },
});
const judgeChanges = parseJudgeChanges(text(process.env.INPUTS_JUDGE_CHANGES));
// An approval is a link to a comment the owner wrote: read here, as the gate is synchronous.
const approvals = await ownerApprovals(judgeChanges.map(j => j.approval), {
  config,
  comments: async (key): Promise<TicketComment[]> => (client ??= new Jira(config)).comments(key),
});
// A ticket with Befund-Pflicht (befund.ts) merges only with the finding on it, and then what a
// check judges needs no word of the owner. Jira silent: refused, the next lap asks again.
const lapKey = ticketKeyOf(target, config);
let befund: Befund | undefined;
const befundProblems: string[] = [];
if ((config.befundLabels?.length ?? 0) > 0 && lapKey !== null) {
  try {
    client ??= new Jira(config);
    if (needsBefund((await client.ticket(lapKey)).labels, config)) {
      befund = readBefund(await client.comments(lapKey), new Set([config.assignee, config.owner]));
    }
  } catch (error) {
    befundProblems.push(`Jira did not answer for ${lapKey}, so its finding cannot be ruled in: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const refusals = recordRefusals({
  report,
  evidenceProblems,
  dispositions,
  judgeChanges,
  shipFailures: existsSync(logPath) ? shipFailuresInLog(readFileSync(logPath, 'utf8')) : [],
  // A non-empty file (not a folder, whose time moves with anything written inside it).
  freshFile: ref => {
    const path = ref === '' ? '' : isAbsolute(ref) ? ref : join(artifacts, ref);
    if (path === '' || !existsSync(path)) return false;
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0 && stat.mtimeMs + CLOCK_SLACK_MS >= reviewStarted;
  },
  issueExists: ref => tracking.open.has(ref.trim()),
  ownerApprovals: approvals.approved,
  ...(befund !== undefined ? { befund } : {}),
});
refusals.push(...befundProblems);
if (route === 'complex' && !existsSync(logPath)) refusals.push('the run log is missing, so a failed shipping step cannot be ruled out');
const prNumber = (url: string): string => /\/pull\/(\d+)/.exec(url)?.[1] ?? url;
if (report.pr !== '' && prNumber(report.pr) !== prNumber(prUrl)) refusals.push(`the app check tested ${report.pr}, not ${prUrl}`);
// Files only the owner may change (governance, holdouts and the fence around them) never merge
// through the loop, whatever the review said: a reviewed change once rewrote a governance file.
const owned = protectedFiles(text(process.env.INPUTS_PROTECTED_PATHS), prFiles);
if (owned === 'invalid') refusals.push('protected_paths cannot be read, so a change to an owner-only file cannot be ruled out');
else if (owned.length > 0) refusals.push(`it changes ${owned.slice(0, 5).join(', ')}, which only the owner changes; the owner merges it by hand if it is intended`);

/** A commit's tree id, or '' when git does not know it. */
const treeOf = (commit: string): string => {
  const out = commit === '' ? null : run(['git', 'rev-parse', '--verify', '--quiet', `${commit}^{tree}`]);
  return out !== null && out.code === 0 ? out.out.trim() : '';
};

let branch = '';
let alreadyMerged = false;
let landSha = sha;
let note = '';
const view = run(['gh', 'pr', 'view', prUrl, '--json', 'number,state,headRefOid,headRefName,baseRefName,isCrossRepository']);
if (view.code !== 0) {
  refusals.push(`could not read the pull request: ${view.err.trim().slice(0, 200)}`);
} else {
  const pr = JSON.parse(view.out) as {
    number: number;
    state: string;
    headRefOid: string;
    headRefName: string;
    baseRefName: string;
    isCrossRepository: boolean;
  };
  // A fork's branch is not ours to delete (a same-named branch here would go instead).
  branch = pr.isCrossRepository ? '' : pr.headRefName;
  if (pr.state === 'MERGED') alreadyMerged = true;
  else if (pr.state !== 'OPEN') refusals.push(`the pull request is ${pr.state.toLowerCase()}`);
  else if (pr.headRefOid !== sha) {
    refusals.push(`its head is ${pr.headRefOid.slice(0, 12)}, not the reviewed ${sha.slice(0, 12) || '(none named)'}`);
  } else {
    const base = `origin/${pr.baseRefName}`;
    const fetched = run(['git', 'fetch', '--quiet', 'origin', pr.baseRefName, `+refs/pull/${pr.number}/head:refs/remotes/origin/loop-land-${pr.number}`]);
    if (fetched.code !== 0) {
      refusals.push(`could not fetch ${pr.baseRefName}: ${fetched.err.trim().slice(0, 200)}`);
    } else {
      /** The tree of `commit` merged cleanly with the base, and the files the base brings in; '' on conflict. */
      const withBaseOf = (commit: string): { tree: string; fromBase: string[] } => {
        const out = run(['git', 'merge-tree', '--write-tree', commit, base]);
        const tree = out.code === 0 ? (out.out.split('\n')[0] ?? '').trim() : '';
        const fromBase = tree === '' ? [] : run(['git', 'diff', '--name-only', treeOf(commit), tree]).out.split('\n').filter(f => f !== '');
        return { tree, fromBase };
      };
      // The commit the check tested: its merge with the base, or the head when the merge changed nothing.
      const tested = treeOf(report.merged_with) !== '' ? report.merged_with : report.head;
      const t = withBaseOf(tested);
      const untested = untestedMerge({ shaTree: treeOf(sha), testedTree: treeOf(tested), withBaseTree: t.tree, fromBase: t.fromBase, prFiles });
      const baseMoved = run(['git', 'merge-base', '--is-ancestor', base, sha]).code !== 0;
      if (untested !== null) {
        refusals.push(`${untested}; the next lap checks the new head`);
      } else if (baseMoved) {
        // The base moved after the review. Throwing the lap away for that costs a whole new lap, so
        // the gate merges the base in itself when the merge is clean and touches none of this
        // change's files (what was tested stays exactly what lands, plus commits already on the base).
        const m = withBaseOf(sha);
        const shared = m.fromBase.filter(file => prFiles.includes(file));
        if (pr.isCrossRepository || m.tree === '' || shared.length > 0) {
          const why = m.tree === '' ? 'and conflicts with it' : shared.length > 0 ? `in ${shared.slice(0, 5).join(', ')}, which this change also changes` : '(a fork branch the gate cannot push to)';
          refusals.push(`${pr.baseRefName} has moved past what was tested ${why}; the next lap re-checks the merge`);
        } else {
          const made = run(['git', 'commit-tree', m.tree, '-p', sha, '-p', base, '-m', `Merge ${pr.baseRefName} into ${pr.headRefName} (merge gate: it touches no file of this change)`]);
          const commit = made.code === 0 ? made.out.trim() : '';
          const pushed = commit === '' ? null : run(['git', 'push', '--quiet', 'origin', `${commit}:refs/heads/${pr.headRefName}`]);
          if (pushed?.code !== 0) {
            refusals.push(`${pr.baseRefName} has moved past what was tested and the gate could not push the clean merge: ${(pushed?.err ?? made.err).trim().slice(0, 200)}`);
          } else {
            landSha = commit;
            note = ` (the gate merged ${pr.baseRefName} in first: ${m.fromBase.length} file(s) from it, none of this change's)`;
          }
        }
      }
    }
  }
}

/** The outcome, recorded first for release (a ticket's status needs it even if a later node fails). */
const landed = (outcome: 'merged' | 'refused', reason: string): void => {
  recordLanding(trackerState, artifacts, { pr: prUrl, landed: outcome, delivers, tasks });
  emit({ outcome, reason });
};

const comment = (body: string): void => {
  if (prUrl !== '') run(['gh', 'pr', 'comment', prUrl, '--body', body]);
};
// A ticket Jira could not read explains a refusal; it does not refuse a merge that never needed it.
if (refusals.length > 0) refusals.push(...tracking.problems, ...approvals.problems);
const list = refusals.map(r => `- ${r}`).join('\n');

if (alreadyMerged) {
  comment(`Loop review: merged (route: ${route}) outside the merge gate. The gate's own checks, for the record:\n\n${list || '- all held'}`);
  landed('merged', 'the pull request was already merged when the gate ran');
} else if (refusals.length > 0) {
  comment(`Loop review: not merged (route: ${route}). The merge gate refused the reviewer's merge:\n\n${list}\n\nThe next lap continues this pull request.`);
  landed('refused', refusals.join('; '));
} else {
  const merged = run(['gh', 'pr', 'merge', prUrl, '--squash', '--match-head-commit', landSha]);
  if (merged.code !== 0) {
    const why = merged.err.trim().slice(0, 300);
    comment(`Loop review: not merged (route: ${route}). \`gh pr merge\` refused: ${why}`);
    landed('refused', `gh pr merge failed: ${why}`);
  } else {
    if (branch !== '') run(['git', 'push', '--quiet', 'origin', '--delete', branch]);
    comment(`Loop review: merged (route: ${route}) at ${landSha} by the merge gate, after the review above${note}.`);
    landed('merged', `merged ${landSha}${note}`);
    // The owner hears what the finding loosened; a failed comment must not undo the record.
    if (befund !== undefined && befund.loosened !== '' && lapKey !== null) {
      try {
        await (client ??= new Jira(config)).comment(lapKey, loosenedNote(befund.loosened), config.owner);
      } catch (error) {
        console.error(`the owner was not told about loosened tests on ${lapKey}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
