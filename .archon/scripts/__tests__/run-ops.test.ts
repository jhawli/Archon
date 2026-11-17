import { describe, expect, it } from 'bun:test';
import { dashboardWorkflowRunSchema } from '../../../packages/workflows/src/schemas/workflow-run-listing';
import { checkRunOps, RUN_ROW_FIELDS, runRefusal, type RunRow } from '../../workflows/sdlc/.shared/run-ops';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const MIN = 60_000;
const row = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'a1b2c3d4-0000-4000-8000-000000000001', workflow_name: 'archon-loop', status: 'pending',
  started_at: new Date(NOW - 31 * MIN).toISOString(), last_activity_at: null, working_path: '/tmp/wt', active_nodes: [], ...over,
});
const op = (kind: 'abandon' | 'resume') => ({ op: kind, run: row().id, text: 'warum' } as const);

describe('Grill G2: the manager abandons stuck runs and resumes infrastructure failures once', () => {
  it('pending and quiet for 31 minutes: abandon', () => {
    expect(runRefusal(op('abandon'), row(), NOW, 'self', new Set())).toBeNull();
  });
  it('quiet for 29 minutes: not yet', () => {
    expect(runRefusal(op('abandon'), row({ started_at: new Date(NOW - 29 * MIN).toISOString() }), NOW, 'self', new Set())).toContain('30');
  });
  it('a running run with a node at work is not abandoned', () => {
    expect(runRefusal(op('abandon'), row({ status: 'running', active_nodes: ['build'] }), NOW, 'self', new Set())).not.toBeNull();
  });
  it('a failed loop run is resumed once, never twice', () => {
    expect(runRefusal(op('resume'), row({ status: 'failed' }), NOW, 'self', new Set())).toBeNull();
    expect(runRefusal(op('resume'), row({ status: 'failed' }), NOW, 'self', new Set([row().id]))).toContain('before');
  });
  it('only loop runs are resumed, never the manager’s own, never an unknown id', () => {
    expect(runRefusal(op('resume'), row({ status: 'failed', workflow_name: 'archon-holdouts' }), NOW, 'self', new Set())).toContain('loop');
    expect(runRefusal(op('abandon'), row(), NOW, row().id, new Set())).toContain('own');
    expect(runRefusal(op('abandon'), undefined, NOW, 'self', new Set())).toContain('run list');
  });
});

describe('Grill G2: the run actions of one pass, against the run list', () => {
  const failed = row({ status: 'failed' });
  const there = (): boolean => true;
  it('a run named twice counts once: never two resumes in one pass', () => {
    const { allowed, skipped } = checkRunOps([op('resume'), op('resume')], [failed], NOW, 'self', new Set(), there);
    expect(allowed).toHaveLength(1);
    expect(skipped[0]).toContain('twice');
  });
  it('a resume whose working path is gone is skipped', () => {
    expect(checkRunOps([op('resume')], [failed], NOW, 'self', new Set(), () => false).skipped[0]).toContain('working path');
  });
  it('a row the engine changed (a field missing) is skipped with the reason, not thrown', () => {
    const broken = Object.fromEntries(Object.entries(row({ status: 'running' })).filter(([field]) => field !== 'active_nodes'));
    const { allowed, skipped } = checkRunOps([op('abandon')], [broken], NOW, 'self', new Set(), there);
    expect(allowed).toHaveLength(0);
    expect(skipped[0]).toContain('active_nodes');
  });
  it('the fields read are the engine’s: every one is in the run listing schema', () => {
    expect([...RUN_ROW_FIELDS].sort() as string[]).toEqual(Object.keys(row()).sort());
    expect(RUN_ROW_FIELDS.filter(field => !(field in dashboardWorkflowRunSchema.shape))).toEqual([]);
  });
});
