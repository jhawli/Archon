import { describe, expect, it } from 'bun:test';
import type { PrView } from '../../workflows/sdlc/.shared/claims';
import { queueStatus } from '../../workflows/sdlc/.shared/queue-status';
import { CFG } from './jira-fixtures';

const START = Date.parse('2026-11-20T10:00:00Z');
const PR = 'https://github.com/jhawli/concairge/pull/120';
const PR2 = 'https://github.com/jhawli/concairge/pull/121';
const view = (over: Partial<PrView> = {}): PrView => ({ state: 'MERGED', mergedAt: '2026-11-20T10:05:00Z', title: 'CONC-12 Leere Liste', body: 'Refs CONC-12', ...over });
const view2 = view({ title: 'CONC-13 Suche', body: 'Closes CONC-13', mergedAt: '2026-11-20T10:07:00Z' });
const onReview = new Map([['CONC-12', CFG.status.review], ['CONC-13', CFG.status.review]]);

describe('AK18h: the merge queue moves tickets like the loop, after one rollout', () => {
  it('stack of two merged and rolled out: both from Review to Staging', () => {
    const moves = queueStatus([{ url: PR }, { url: PR2 }], true, new Map([[PR, view()], [PR2, view2]]), onReview, START, CFG);
    expect(moves.map(m => [m.key, m.status, m.ask])).toEqual([['CONC-12', CFG.status.staging, null], ['CONC-13', CFG.status.staging, null]]);
  });
  it('merged, health check after the stack failed: every ticket on Review with a question, never Staging', () => {
    const moves = queueStatus([{ url: PR }, { url: PR2 }], false, new Map([[PR, view()], [PR2, view2]]), onReview, START, CFG);
    expect(moves).toHaveLength(2);
    expect(moves.every(m => m.status === CFG.status.review && (m.ask ?? '').includes('Rollout'))).toBe(true);
  });
  it('a merge GitHub does not confirm for this run: Review with a question', () => {
    const r = queueStatus([{ url: PR }], true, new Map([[PR, view({ mergedAt: '2026-11-20T09:00:00Z' })]]), onReview, START, CFG)[0];
    expect(r?.status).toBe(CFG.status.review);
    expect(r?.ask).toContain('bestätigt');
  });
  it('held: no merge recorded, no ticket touched', () => {
    expect(queueStatus([], false, new Map(), onReview, START, CFG)).toEqual([]);
  });
  it('two merged pull requests name the same ticket: it moves once, the second sees it on Staging', () => {
    const moves = queueStatus([{ url: PR }, { url: PR2 }], true, new Map([[PR, view()], [PR2, view({ title: 'CONC-12 Rest', mergedAt: '2026-11-20T10:07:00Z' })]]), onReview, START, CFG);
    expect(moves.map(m => [m.key, m.status])).toEqual([['CONC-12', CFG.status.staging], ['CONC-12', null]]);
  });
  it('a ticket on its queue (a lap gave it back with its pull request) goes to Staging with the merge', () => {
    const r = queueStatus([{ url: PR }], true, new Map([[PR, view()]]), new Map([['CONC-12', CFG.status.todo]]), START, CFG)[0];
    expect(r?.status).toBe(CFG.status.staging);
    expect(r?.ask).toBeNull();
  });
  it('a ticket on any other status (Bereit, a feature) is listed, not moved', () => {
    const r = queueStatus([{ url: PR }], true, new Map([[PR, view()]]), new Map([['CONC-12', '10053']]), START, CFG)[0];
    expect(r?.key).toBe('CONC-12');
    expect(r?.status).toBeNull();
  });
});
