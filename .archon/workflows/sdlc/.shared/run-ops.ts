/**
 * The manager's run actions (upstream "keep the loop healthy", Grill G2). The sandboxed agent
 * cannot reach Archon's CLI, so it asks in its outbox and manager-write checks each request
 * against a fresh run list before Archon's own CLI acts: abandon a run that never got going,
 * resume once a loop run that failed (the agent judges that it failed on infrastructure, not on
 * the work; a resumed run is recorded so it is never resumed again).
 */
export const STALE_MS = 30 * 60_000;
/** Resumes per manager pass; more are dropped by `parseManagerOutbox`. */
export const MAX_RESUMES = 2;

export interface RunRow {
  readonly id: string;
  readonly workflow_name: string;
  readonly status: string;
  readonly started_at: string | null;
  readonly last_activity_at: string | null;
  readonly working_path: string | null;
  readonly active_nodes: readonly unknown[];
}

/** Two members, not one with `op: 'abandon' | 'resume'`: so a check on `op` narrows `ManagerOp` both ways. */
export type RunOp =
  | { readonly op: 'abandon'; readonly run: string; readonly text: string }
  | { readonly op: 'resume'; readonly run: string; readonly text: string };

export function runRefusal(op: RunOp, row: RunRow | undefined, now: number, self: string, resumed: ReadonlySet<string>): string | null {
  if (row === undefined) return `run ${op.run} is not in Archon's run list`;
  if (op.run === self) return 'the manager does not act on its own run';
  if (op.op === 'abandon') {
    if (row.status !== 'pending' && row.status !== 'running') return `run ${op.run} is ${row.status}, nothing to abandon`;
    if (row.status === 'running' && row.active_nodes.length > 0) return `run ${op.run} has a node at work`;
    const quiet = now - Date.parse(row.last_activity_at ?? row.started_at ?? '');
    return quiet >= STALE_MS ? null : `run ${op.run} was active less than 30 minutes ago`;
  }
  if (row.workflow_name !== 'archon-loop') return 'only loop runs are resumed';
  if (row.status !== 'failed') return `run ${op.run} is ${row.status}; only a failed run is resumed`;
  if (resumed.has(op.run)) return `run ${op.run} was resumed before`;
  return null;
}
