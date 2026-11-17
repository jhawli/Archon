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
import { checkRunOps, type RunOp } from '../../.shared/run-ops.ts';
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
let resumed = new Set<string>();
let allowed: RunOp[] = [];
const skipped: string[] = [];
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);
// Never at the cost of the ticket writes: whatever goes wrong with the run list (no CLI command
// published, a missing binary, output that is not JSON, a broken record of resumes) skips the
// run actions and is logged.
if (runOps.length > 0) {
  try {
    resumed = new Set<string>(existsSync(resumedPath) ? (JSON.parse(readFileSync(resumedPath, 'utf8')) as string[]) : []);
    const listed = cli(['workflow', 'runs', '--limit', '100', '--json']);
    if (listed.exitCode !== 0) throw new Error(`archon workflow runs failed (exit ${listed.exitCode})`);
    const rows = (JSON.parse(listed.stdout.toString()) as { runs?: unknown }).runs;
    if (!Array.isArray(rows)) throw new Error('archon workflow runs printed no list of runs');
    const checked = checkRunOps(runOps, rows, Date.now(), run, resumed, existsSync);
    allowed = checked.allowed;
    skipped.push(...checked.skipped);
  } catch (error) {
    allowed = [];
    skipped.length = 0;
    skipped.push(...runOps.map(op => `${op.op} ${op.run}: the run list could not be read (${reason(error)})`));
  }
}

const jira = new Jira(config);
const boardUrl = `${config.site}/jira/software/projects/${config.project}/boards/${config.board}`;
const { ops, dropped, created } = await managerPass(jira, raw, state, openPulls(), snapshotAll(state), Date.now(), runLine('archon-manager', run), boardUrl);

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
  try {
    const done = cli(op.op === 'abandon' ? ['workflow', 'abandon', op.run] : ['workflow', 'resume', op.run, '--detach']);
    if (done.exitCode === 0) acted.push(`${op.op} ${op.run}: ${op.text}`);
    else skipped.push(`${op.op} ${op.run}: failed: ${done.stderr.toString().trim().slice(0, 300)}`);
  } catch (error) {
    skipped.push(`${op.op} ${op.run}: failed: ${reason(error)}`);
  }
}
// Only now: a rerun after a crash above still finds the run actions (the ticket entries are
// marked done by their progress, a second resume by `manager-resumed.json`).
rmSync(file, { force: true });
for (const line of skipped) note(`manager run action skipped: ${line}`);
const tickets = ops.filter(op => op.op !== 'abandon' && op.op !== 'resume').length;
emit({ applied: String(tickets), created: JSON.stringify(created), dropped: JSON.stringify(dropped), metrics: metrics.line, runs: JSON.stringify({ acted, skipped }) });
