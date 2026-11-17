import { describe, expect, it } from 'bun:test';
import { type Proposal, publishDiscoveries } from '../../workflows/sdlc/.shared/discoveries-publish';
import { CFG, fakeJira, state } from './jira-fixtures';

const RUN = 'https://example.atlassian.net/jira/software/projects/CONC/boards/5';

describe('AK18g: findings in Jira', () => {
  const finding = (over: Partial<Proposal> = {}): Proposal => ({
    marker: 'disc-0123456789abcdef', classification: 'new', actionable: true, target_item: null,
    related_items: [{ key: 'CONC-12' }], public_title: 'Absturz bei leerem Barcode',
    public_summary: 'Die App stürzt ab, wenn der Barcode leer ist.', evidence: ['app/scan.swift:41'], ...over,
  });
  const snap = { 'CONC-12': { status: CFG.status.live, title: 'Scanner', own: '' }, 'CONC-40': { status: CFG.status.todo, title: 'Absturz', own: 'disc-0123456789abcdef' } };
  it('a new finding becomes a ticket with Related lines', async () => {
    const { jira, calls } = fakeJira({ sprint: 36 });
    const r = await publishDiscoveries(jira, [finding()], true, snap, state(), RUN);
    expect(r.created).toEqual(['CONC-51']);
    expect(JSON.stringify(calls.find(c => c.path === '/rest/api/3/issue')?.body)).toContain('Related: CONC-12');
  });
  it('the same finding with new evidence, CONC-40 open: one comment, text and labels stay', async () => {
    const { jira, calls } = fakeJira({ tickets: { 'CONC-40': { status: CFG.status.todo } } });
    const r = await publishDiscoveries(jira, [finding({ classification: 'update-existing', target_item: { key: 'CONC-40' } })], true, snap, state(), RUN);
    expect(r.commented).toEqual(['CONC-40']);
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0);
    expect(calls.filter(c => c.method === 'POST' && c.path === '/rest/api/3/issue')).toHaveLength(0);
  });
  it('a rerun after the comment was written: the same evidence is not posted twice', async () => {
    const before = { id: 7, author: CFG.assignee, body: 'Neuer Beleg: Die App stürzt ab, wenn der Barcode leer ist.\nBeleg: app/scan.swift:41\n\nLauf: archon archon-discoveries r1', created: '2026-11-17T10:00:00.000+0000' };
    const { jira, calls } = fakeJira({ tickets: { 'CONC-40': { status: CFG.status.todo, comments: [before] } } });
    const r = await publishDiscoveries(jira, [finding({ classification: 'update-existing', target_item: { key: 'CONC-40' } })], true, snap, state(), RUN);
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
    expect(r.existing).toEqual(['CONC-40']);
  });
  it('Jira did not answer during the search: nothing written, "nicht geprüft"', async () => {
    const { jira, calls } = fakeJira();
    const r = await publishDiscoveries(jira, [finding()], false, snap, state(), RUN);
    expect(r.summary).toContain('nicht geprüft');
    expect(calls).toHaveLength(0);
  });
  it('a target or related key outside the board snapshot is refused', async () => {
    const { jira } = fakeJira();
    const error = await publishDiscoveries(jira, [finding({ related_items: [{ key: 'CONC-999' }] })], true, snap, state(), RUN)
      .then(() => null, (e: unknown) => (e as Error).message);
    expect(error).toContain('CONC-999');
  });
  it('a target that is no longer open gets no comment', async () => {
    const { jira, calls } = fakeJira({ tickets: { 'CONC-12': { status: CFG.status.live } } });
    const r = await publishDiscoveries(jira, [finding({ classification: 'update-existing', target_item: { key: 'CONC-12' } })], true, snap, state(), RUN);
    expect(r.skipped[0]).toContain('CONC-12');
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
  });
});
