import { describe, expect, it } from 'bun:test';
import { mayPublish, publishBacklog } from '../../workflows/sdlc/.shared/backlog-publish';
import { CFG, fakeJira, state } from './jira-fixtures';

const RUN = 'https://example.atlassian.net/jira/software/projects/CONC/boards/5';

describe('AK18f: the backlog is filed in Jira', () => {
  const doc = 'docs/proben/s4b-backlog.md';
  const core = { key: 'a-core', title: 'A Kernweg', phase: 'Phase 1', body: 'x'.repeat(130), depends_on: [], size: 'small_bounded' };
  const sliced = [
    core,
    { key: 'b-next', title: 'B Folgeweg', phase: 'Phase 1', body: 'y'.repeat(130), depends_on: ['a-core'], size: 'small_bounded' },
    { key: 'c-other', title: 'C Nebenweg', phase: 'Phase 2', body: 'z'.repeat(130), depends_on: [], size: 'risky' },
  ];
  it('three tickets, B waits on A, phase as a line, all in the sprint on To Do', async () => {
    const { jira, calls } = fakeJira({ sprint: 36 });
    const result = await publishBacklog(jira, sliced, doc, {}, state(), RUN);
    expect(result.created).toEqual(['CONC-51', 'CONC-52', 'CONC-53']);
    const bodyOf = (n: number): string => JSON.stringify(calls.filter(c => c.method === 'POST' && c.path === '/rest/api/3/issue')[n]?.body);
    expect(bodyOf(0)).toContain('Phase: Phase 1');
    expect(bodyOf(1)).toContain('Depends on: CONC-51');
    expect(calls.filter(c => c.path === '/rest/agile/1.0/sprint/36/issue')).toHaveLength(3);
  });
  it('a second run on the same document files nothing new', async () => {
    const { jira, calls } = fakeJira({ found: ['CONC-51'] });
    const result = await publishBacklog(jira, sliced, doc, {}, state(), RUN);
    expect(calls.filter(c => c.method === 'POST' && c.path === '/rest/api/3/issue')).toHaveLength(0);
    expect(result.existing).toHaveLength(3);
  });
  it('the same title from the same document counts as existing, even under another slug', async () => {
    const { jira, calls } = fakeJira();
    const snapshot = { 'CONC-60': { status: CFG.status.todo, title: 'A Kernweg', own: 'backlog-s4b-backlog-a-kern' } };
    const result = await publishBacklog(jira, sliced.slice(0, 1), doc, snapshot, state(), RUN);
    expect(result.existing).toEqual(['CONC-60']);
    expect(calls.filter(c => c.method === 'POST' && c.path === '/rest/api/3/issue')).toHaveLength(0);
  });
  it('text that reads as a loop record or as Julian is refused before any write', async () => {
    const { jira, calls } = fakeJira();
    const bad = [{ ...core, body: `Julian: ${'x'.repeat(130)}` }];
    const error = await publishBacklog(jira, bad, doc, {}, state(), RUN).then(() => null, (e: unknown) => (e as Error).message);
    expect(error).toContain('reserved');
    expect(calls).toHaveLength(0);
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
