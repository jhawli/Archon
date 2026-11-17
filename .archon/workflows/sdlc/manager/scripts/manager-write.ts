/**
 * The manager's writes (AK18i to AK18n, Grill G2). Order: the tracker check; the metrics form;
 * the run actions checked against a fresh run list; the tickets checked against Jira now and
 * written all or nothing (`managerPass`); the metrics line, once per run; the run actions last.
 * The agent's run list can be 45 minutes old: a run action that no longer fits, or whose CLI call
 * fails, is skipped and logged, never at the cost of the ticket writes. A run is resumed at most
 * once, also when that attempt failed (recorded before the call).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotAll } from '../../.shared/board-all.ts';
import { runState } from '../../.shared/claims.ts';
import { archonCommand } from '../../.shared/forge.ts';
import { artifactsDir, emit, note } from '../../.shared/io.ts';
import { Jira, pinTrackerConfig, repoRoot } from '../../.shared/jira.ts';
import { managerPass, parseManagerOutbox } from '../../.shared/manager-ops.ts';
import { appendMetrics, checkMetrics } from '../../.shared/metrics.ts';
import { outboxFile, readOutbox } from '../../.shared/outbox.ts';
import { runLine } from '../../.shared/questions.ts';
import { type RunOp, type RunRow, runRefusal } from '../../.shared/run-ops.ts';
import { trackerCheck } from '../../.shared/tracker-check.ts';
import { openPulls } from '../../.shared/tracker-board.ts';

// First, before anything that needs a run: without tracker.json this node fails with the
// tracker message (AK18e).
trackerCheck('archon-manager');
const state = runState();
const stateDir = process.env.STATE_DIR ?? '';
if (stateDir === '') throw new Error('manager-write: STATE_DIR is not set');
const config = pinTrackerConfig(state);
const artifacts = artifactsDir();
const run = process.env.WORKFLOW_ID ?? '';
const root = repoRoot();
const metricsPath = join(artifacts, 'manager', 'metrics.json');
if (!existsSync(metricsPath)) throw new Error('manager-write: the pass left no manager/metrics.json (AK18n: one line per pass)');
const metrics = checkMetrics(JSON.parse(readFileSync(metricsPath, 'utf8')));

const file = outboxFile(artifacts, 'manager');
const raw = readOutbox(file);
const runOps = parseManagerOutbox(raw, config.project).ops.filter((op): op is RunOp => op.op === 'abandon' || op.op === 'resume');

function cli(args: string[]): { exitCode: number; stdout: Buffer; stderr: Buffer } {
  const result = Bun.spawnSync([...archonCommand(), ...args, '--cwd', root], { stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}
const resumedPath = join(stateDir, 'manager-resumed.json');
const resumed = new Set<string>(existsSync(resumedPath) ? (JSON.parse(readFileSync(resumedPath, 'utf8')) as string[]) : []);
const allowed: RunOp[] = [];
const skipped: string[] = [];
if (runOps.length > 0) {
  const listed = cli(['workflow', 'runs', '--limit', '100', '--json']);
  if (listed.exitCode !== 0) {
    skipped.push(...runOps.map(op => `${op.op} ${op.run}: archon workflow runs failed`));
  } else {
    const rows = (JSON.parse(listed.stdout.toString()) as { runs?: RunRow[] }).runs ?? [];
    const now = Date.now();
    // One action per run and pass: a second entry for the same run would pass this check too
    // (the resume is recorded only when it runs) and resume it twice.
    const named = new Set<string>();
    for (const op of runOps) {
      const row = rows.find(r => r.id === op.run);
      const twice = named.has(op.run);
      named.add(op.run);
      const why =
        (twice ? 'named twice in this outbox; only its first entry counts' : null) ??
        runRefusal(op, row, now, run, resumed) ??
        (op.op === 'resume' && (row?.working_path == null || !existsSync(row.working_path)) ? `run ${op.run}: its working path is gone` : null);
      if (why === null) allowed.push(op);
      else skipped.push(`${op.op} ${op.run}: ${why}`);
    }
  }
}

const jira = new Jira(config);
const boardUrl = `${config.site}/jira/software/projects/${config.project}/boards/${config.board}`;
const { ops, dropped, created } = await managerPass(jira, raw, state, openPulls(), snapshotAll(state), Date.now(), runLine('archon-manager', run), boardUrl);
rmSync(file, { force: true });

const once = join(state, 'metrics-appended');
if (!existsSync(once)) {
  appendMetrics(stateDir, metrics);
  writeFileSync(once, `${Date.now()}\n`);
}

const acted: string[] = [];
for (const op of allowed) {
  if (op.op === 'resume') {
    if (resumed.has(op.run)) {
      skipped.push(`resume ${op.run}: resumed before`);
      continue;
    }
    resumed.add(op.run);
    writeFileSync(resumedPath, `${JSON.stringify([...resumed])}\n`); // before the resume: a crash never resumes twice
  }
  const done = cli(op.op === 'abandon' ? ['workflow', 'abandon', op.run] : ['workflow', 'resume', op.run, '--detach']);
  if (done.exitCode === 0) acted.push(`${op.op} ${op.run}: ${op.text}`);
  else skipped.push(`${op.op} ${op.run}: failed: ${done.stderr.toString().trim().slice(0, 300)}`);
}
for (const line of skipped) note(`manager run action skipped: ${line}`);
const tickets = ops.filter(op => op.op !== 'abandon' && op.op !== 'resume').length;
emit({ applied: String(tickets), created: JSON.stringify(created), dropped: JSON.stringify(dropped), metrics: metrics.line, runs: JSON.stringify({ acted, skipped }) });
