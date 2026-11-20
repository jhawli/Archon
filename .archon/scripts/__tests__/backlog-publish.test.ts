import { describe, expect, it } from 'bun:test';
import { backlogFeature, backlogMarker, mayPublish, publishBacklog } from '../../workflows/sdlc/.shared/backlog-publish';
import { CFG, type FakeTicket, fakeJira, state, TYPES } from './jira-fixtures';

const RUN = 'https://example.atlassian.net/jira/software/projects/CONC/boards/5';
/** The feature the slices go under: Umsetzung, a status the tracker does not name. */
const FEATURE: Record<string, FakeTicket> = { 'CONC-34': { status: '10055', type: '10000' } };

describe('AK18f: the backlog is filed in Jira', () => {
  const doc = 'docs/proben/s4b-backlog.md';
  const core = { key: 'a-core', title: 'A Kernweg', phase: 'Phase 1', body: 'x'.repeat(130), depends_on: [], size: 'small_bounded' };
  const sliced = [
    core,
    { key: 'b-next', title: 'B Folgeweg', phase: 'Phase 1', body: 'y'.repeat(130), depends_on: ['a-core'], size: 'small_bounded' },
    { key: 'c-other', title: 'C Nebenweg', phase: 'Phase 2', body: 'z'.repeat(130), depends_on: [], size: 'risky' },
  ];
  it('three tickets, B waits on A, phase as a line, all in the sprint as slices on Startklar under the feature', async () => {
    const { jira, calls, bulkMoves } = fakeJira({ sprint: 36, tickets: FEATURE });
    const result = await publishBacklog(jira, sliced, doc, {}, state(), RUN, 'CONC-34');
    expect(result.created).toEqual(['CONC-51', 'CONC-52', 'CONC-53']);
    const bodyOf = (n: number): string => JSON.stringify(calls.filter(c => c.method === 'POST' && c.path === '/rest/api/3/issue')[n]?.body);
    expect(bodyOf(0)).toContain('Phase: Phase 1');
    expect(bodyOf(1)).toContain('Depends on: CONC-51');
    expect(calls.filter(c => c.path === '/rest/agile/1.0/sprint/36/issue')).toHaveLength(3);
    expect(bulkMoves.map(m => [m.target, m.keys[0], Object.keys(m.statuses)[0]])).toEqual([
      ['CONC,10005,CONC-34', 'CONC-51', CFG.status.todo],
      ['CONC,10005,CONC-34', 'CONC-52', CFG.status.todo],
      ['CONC,10005,CONC-34', 'CONC-53', CFG.status.todo],
    ]);
  });
  it('a second run on the same document files nothing new', async () => {
    const { jira, calls } = fakeJira({ found: ['CONC-51'] });
    const result = await publishBacklog(jira, sliced, doc, {}, state(), RUN, 'CONC-34');
    expect(calls.filter(c => c.method === 'POST' && c.path === '/rest/api/3/issue')).toHaveLength(0);
    expect(result.existing).toHaveLength(3);
  });
  it('the same title from the same document counts as existing, even under another slug', async () => {
    const { jira, calls } = fakeJira();
    const snapshot = { 'CONC-60': { status: CFG.status.todo, title: 'A Kernweg', own: backlogMarker(doc, 'a-kern') } };
    const result = await publishBacklog(jira, sliced.slice(0, 1), doc, snapshot, state(), RUN, 'CONC-34');
    expect(result.existing).toEqual(['CONC-60']);
    expect(calls.filter(c => c.method === 'POST' && c.path === '/rest/api/3/issue')).toHaveLength(0);
  });
  it('text that reads as a loop record or as Julian is refused before any write', async () => {
    const { jira, calls } = fakeJira();
    const bad = [{ ...core, body: `Julian: ${'x'.repeat(130)}` }];
    const error = await publishBacklog(jira, bad, doc, {}, state(), RUN, 'CONC-34').then(() => null, (e: unknown) => (e as Error).message);
    expect(error).toContain('reserved');
    expect(calls).toHaveLength(0);
  });
  it('another document with the same file name, or the same first 16 letters, is not this one', async () => {
    expect(backlogMarker('docs/feature-concept-a.md', 'a-core')).not.toBe(backlogMarker('docs/feature-concept-b.md', 'a-core'));
    const { jira, calls } = fakeJira();
    const snapshot = { 'CONC-60': { status: CFG.status.todo, title: 'A Kernweg', own: backlogMarker('Ideas/a/PRD.md', 'a-core') } };
    const result = await publishBacklog(jira, sliced.slice(0, 1), 'Ideas/b/PRD.md', snapshot, state(), RUN, 'CONC-34');
    expect(result.created).toEqual(['CONC-51']);
    expect(calls.filter(c => c.method === 'POST' && c.path === '/rest/api/3/issue')).toHaveLength(1);
  });
  it('a key with a line break never reaches a marker', async () => {
    const { jira, calls } = fakeJira();
    const error = await publishBacklog(jira, [{ ...core, key: 'a-core\n' }], doc, {}, state(), RUN, 'CONC-34').then(() => null, (e: unknown) => (e as Error).message);
    expect(error).toContain('key');
    expect(calls).toHaveLength(0);
  });
});

describe('the feature the backlog goes under (VAULT-28)', () => {
  const tickets: Record<string, FakeTicket> = {
    ...FEATURE,
    'CONC-41': { status: CFG.status.todo, type: TYPES.slice, parent: 'CONC-34' },
    'CONC-50': { status: CFG.status.todoBug, type: TYPES.bug },
    'CONC-33': { status: CFG.status.live, type: '10000' },
  };
  it('an open feature of the project passes', async () => {
    expect(await backlogFeature(fakeJira({ tickets }).jira, 'CONC-34')).toBe('CONC-34');
  });
  it('a slice, a bug, a done feature or a key of another project is refused', async () => {
    const { jira } = fakeJira({ tickets });
    expect(backlogFeature(jira, 'CONC-41')).rejects.toThrow('CONC-41 is not a feature');
    expect(backlogFeature(jira, 'CONC-50')).rejects.toThrow('CONC-50 is not a feature');
    expect(backlogFeature(jira, 'CONC-33')).rejects.toThrow('CONC-33 is done');
    expect(backlogFeature(jira, 'VAULT-3')).rejects.toThrow('not a CONC ticket key');
    expect(backlogFeature(jira, '')).rejects.toThrow('not a CONC ticket key');
  });
});

describe('AK18f: preview writes nothing (also for discoveries)', () => {
  it('only auto, or approve with the decision approve, publishes', () => {
    expect(mayPublish('preview', null)).toBe(false);
    expect(mayPublish('approve', null)).toBe(false);
    expect(mayPublish('approve', { decision: 'hold' })).toBe(false);
    expect(mayPublish('approve', { decision: 'approve' })).toBe(true);
    expect(mayPublish('auto', null)).toBe(true);
    expect(mayPublish('Auto', null)).toBe(false);
  });
});
