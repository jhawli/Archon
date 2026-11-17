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

/** The fields `runRow` reads; run-ops.test.ts holds them against the engine's run listing schema. */
export const RUN_ROW_FIELDS: readonly (keyof RunRow)[] = [
  'id', 'workflow_name', 'status', 'started_at', 'last_activity_at', 'working_path', 'active_nodes',
];

/** A row of `archon workflow runs --json`, field by field; the name of the first field that is not as expected otherwise. */
function runRow(raw: unknown): RunRow | string {
  if (typeof raw !== 'object' || raw === null) return 'the row';
  const r = raw as Record<string, unknown>;
  const text = (key: string): boolean => typeof r[key] === 'string';
  const maybe = (key: string): boolean => r[key] === null || typeof r[key] === 'string';
  for (const key of ['id', 'workflow_name', 'status'] as const) if (!text(key)) return key;
  for (const key of ['started_at', 'last_activity_at', 'working_path'] as const) if (!maybe(key)) return key;
  if (!Array.isArray(r.active_nodes)) return 'active_nodes';
  return r as unknown as RunRow;
}

/**
 * The run actions of one pass (G2), each against the fresh run list: one action per run (a
 * second entry would pass the check too and resume it twice), `runRefusal`, a resume only into
 * a working path that is still there, and a row whose fields the engine changed is skipped with
 * the field's name, never thrown.
 */
export function checkRunOps(
  ops: readonly RunOp[],
  rows: readonly unknown[],
  now: number,
  self: string,
  resumed: ReadonlySet<string>,
  exists: (path: string) => boolean
): { allowed: RunOp[]; skipped: string[] } {
  const refusalFor = (op: RunOp, row: RunRow | string | undefined): string | null => {
    if (typeof row === 'string') return `run ${op.run}: the run list shows no usable ${row}`;
    const refused = runRefusal(op, row, now, self, resumed);
    if (refused !== null || row === undefined || op.op !== 'resume') return refused;
    return row.working_path !== null && exists(row.working_path) ? null : `run ${op.run}: its working path is gone`;
  };
  const allowed: RunOp[] = [];
  const skipped: string[] = [];
  const named = new Set<string>();
  for (const op of ops) {
    const twice = named.has(op.run);
    named.add(op.run);
    const raw = rows.find(r => typeof r === 'object' && r !== null && (r as { id?: unknown }).id === op.run);
    const why = twice ? 'named twice in this outbox; only its first entry counts' : refusalFor(op, raw === undefined ? undefined : runRow(raw));
    if (why === null) allowed.push(op);
    else skipped.push(`${op.op} ${op.run}: ${why}`);
  }
  return { allowed, skipped };
}
