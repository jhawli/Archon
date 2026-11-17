/**
 * The manager's first node: the tracker check (AK18e), then what its agent reads. Every
 * ticket (`tracker/board-all.md`), the recent runs (`manager/runs.json`, from Archon's CLI,
 * which the sandboxed agent cannot reach: the database lives under ~/.archon) and the last
 * metrics lines (`manager/metrics-last.txt`). The run list is help, not a condition: without
 * it the pass reports less.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBoardAll, writeBoardAll } from '../../.shared/board-all.ts';
import { runState } from '../../.shared/claims.ts';
import { archonCommand } from '../../.shared/forge.ts';
import { artifactsDir, emit, note } from '../../.shared/io.ts';
import { Jira, pinTrackerConfig, repoRoot } from '../../.shared/jira.ts';
import { METRICS_FILE } from '../../.shared/metrics.ts';
import { clearOutbox } from '../../.shared/outbox.ts';
import { trackerCheck } from '../../.shared/tracker-check.ts';

trackerCheck('archon-manager');
const state = runState();
const config = pinTrackerConfig(state);
const artifacts = artifactsDir();
clearOutbox(artifacts, ['manager']);
const all = await loadBoardAll(new Jira(config));
const board = writeBoardAll(all, Date.now(), config, artifacts, state);
const dir = join(artifacts, 'manager');
mkdirSync(dir, { recursive: true });
const runs = join(dir, 'runs.json');
// Help, not a condition: any failure (no CLI command published, a missing binary, a failed or
// unreadable list) leaves `{ error }` for the agent, never a failed node.
let failed = '';
try {
  const listed = Bun.spawnSync([...archonCommand(), 'workflow', 'runs', '--limit', '60', '--cwd', repoRoot(), '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (listed.exitCode !== 0) failed = listed.stderr.toString().trim() || `exit ${listed.exitCode}`;
  else {
    JSON.parse(listed.stdout.toString());
    writeFileSync(runs, listed.stdout);
  }
} catch (error) {
  failed = error instanceof Error ? error.message : String(error);
}
if (failed !== '') {
  writeFileSync(runs, `${JSON.stringify({ error: failed.slice(0, 500) })}\n`);
  note('archon workflow runs failed; the manager reports without the run list');
}
const metrics = join(process.env.STATE_DIR ?? '', METRICS_FILE);
const last = existsSync(metrics) ? readFileSync(metrics, 'utf8').split('\n').filter(Boolean).slice(-6) : [];
writeFileSync(join(dir, 'metrics-last.txt'), last.length > 0 ? `${last.join('\n')}\n` : '');
emit({ board, tickets: String(all.tickets.length), runs });
