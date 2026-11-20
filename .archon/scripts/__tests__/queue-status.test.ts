import { describe, expect, it } from 'bun:test';
import type { PrView } from '../../workflows/sdlc/.shared/claims';
import { applyQueueMove, type QueueMove, queueStatus } from '../../workflows/sdlc/.shared/queue-status';
import { type Call, CFG, type FakeTicket, fakeJira, SUBTASK_TYPE, TYPES } from './jira-fixtures';

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
  it('a ticket on its queue moves only for a pull request that says it delivers it (title or Closes), not one that refers to it', () => {
    const onQueue = new Map([['CONC-12', CFG.status.todo], ['CONC-40', CFG.status.todo], ['CONC-41', CFG.status.todoBug]]);
    const v = view({ body: 'Closes CONC-41. Refs CONC-40, relates to CONC-40' });
    const moves = queueStatus([{ url: PR }], true, new Map([[PR, v]]), onQueue, START, CFG);
    expect(moves.map(m => [m.key, m.status, m.ask])).toEqual([
      ['CONC-12', CFG.status.staging, null],
      ['CONC-41', CFG.status.staging, null],
      ['CONC-40', null, null],
    ]);
  });
  it('a ticket on its queue with a merge GitHub does not confirm stays there, with a question', () => {
    const r = queueStatus([{ url: PR }], true, new Map([[PR, view({ mergedAt: '2026-11-20T09:00:00Z' })]]), new Map([['CONC-12', CFG.status.todo]]), START, CFG)[0];
    expect(r?.status).toBeNull();
    expect(r?.ask).toContain('bestätigt');
  });
  it('a ticket in progress moves only for a pull request that delivers it: a reference leaves it and its open tasks alone', () => {
    const inProgress = new Map([['CONC-41', CFG.status.progress], ['CONC-40', CFG.status.progress]]);
    const v = view({ title: 'CONC-39 Andere Arbeit', body: 'Closes CONC-41. Refs CONC-40' });
    const moves = queueStatus([{ url: PR }], true, new Map([[PR, v]]), inProgress, START, CFG);
    expect(moves.map(m => [m.key, m.status, m.ask])).toEqual([
      ['CONC-41', CFG.status.staging, null],
      ['CONC-40', null, null],
    ]);
  });
  it('a ticket on any other status (Bereit, a feature) is listed, not moved', () => {
    const r = queueStatus([{ url: PR }], true, new Map([[PR, view()]]), new Map([['CONC-12', '10053']]), START, CFG)[0];
    expect(r?.key).toBe('CONC-12');
    expect(r?.status).toBeNull();
  });
});

describe('AK18h: the merge queue sets a ticket, closes no task (VAULT-28: only a review says which are done)', () => {
  const S = CFG.status;
  const LINE = 'Lauf: archon-merge-queue mq-1';
  /** A slice CONC-41 with two tasks, open unless `done`. */
  const slice = (status: string, done = false, type: string = TYPES.slice): Record<string, FakeTicket> => ({
    'CONC-40': { status: '10055', type: '10000', children: ['CONC-41'] },
    'CONC-41': { status, type, parent: 'CONC-40', sprint: 'active', children: ['CONC-42', 'CONC-43'] },
    'CONC-42': { status: done ? S.taskDone : '10060', type: SUBTASK_TYPE, title: 'Task 1: A', parent: 'CONC-41' },
    'CONC-43': { status: done ? S.taskDone : '10060', type: SUBTASK_TYPE, title: 'Task 2: B', parent: 'CONC-41' },
  });
  const to = (status: string | null, ask: string | null = null): QueueMove => ({ key: 'CONC-41', pr: PR, status, ask });
  const posted = (calls: Call[]): string[] =>
    calls.filter(call => call.method === 'POST' && call.path === '/rest/api/3/issue/CONC-41/comment').map(call => JSON.stringify(call.body));
  const moved = (calls: Call[]): string[] =>
    calls
      .filter(call => call.method === 'POST' && call.path.endsWith('/transitions'))
      .map(call => `${call.path.split('/')[5]} ${(call.body as { transition: { id: string } }).transition.id.slice(1)}`);

  it('a slice in progress with open tasks (a part the review let through without a rest) stays there, its tasks open, with a question', async () => {
    const { jira, calls, book } = fakeJira({ tickets: slice(S.progress) });
    const result = await applyQueueMove(jira, to(S.staging), S.progress, 'mq-1', LINE);
    expect(result).toMatchObject({ status: S.progress, asked: true });
    expect([book.get('CONC-42')?.status, book.get('CONC-43')?.status]).toEqual(['10060', '10060']);
    expect(moved(calls)).toEqual([]);
    expect(posted(calls)[0]).toContain(`Merge-Queue: Lauf mq-1. PR: ${PR}. Status: Entwicklung.`);
    expect(posted(calls)[1]).toContain('Offene Tasks (CONC-42, CONC-43)');
  });
  it('a slice on its queue with open tasks stays there too, with the question', async () => {
    const { jira, book } = fakeJira({ tickets: slice(S.todo) });
    expect(await applyQueueMove(jira, to(S.staging), S.todo, 'mq-1', LINE)).toMatchObject({ status: S.todo, asked: true });
    expect(book.get('CONC-41')?.status).toBe(S.todo);
  });
  it('a slice whose tasks are all done goes from its queue through Entwicklung and Review to Staging, no question', async () => {
    const { jira, calls } = fakeJira({ tickets: slice(S.todo, true) });
    expect(await applyQueueMove(jira, to(S.staging), S.todo, 'mq-1', LINE)).toMatchObject({ status: S.staging, asked: false });
    expect(moved(calls)).toEqual([`CONC-41 ${S.progress}`, `CONC-41 ${S.review}`, `CONC-41 ${S.staging}`]);
    expect(posted(calls)).toHaveLength(1);
  });
  it('from Review: Staging, and a second run of the node writes no second comment', async () => {
    const { jira, book } = fakeJira({ tickets: slice(S.review, true) });
    await applyQueueMove(jira, to(S.staging), S.review, 'mq-1', LINE);
    expect(book.get('CONC-41')?.status).toBe(S.staging);
    const said = { id: 7, author: 'archon', body: `Merge-Queue: Lauf mq-1. PR: ${PR}. Status: Staging.`, created: '2026-11-20T10:06:00Z' };
    const seen = slice(S.staging, true);
    const again = fakeJira({ tickets: { ...seen, 'CONC-41': { ...seen['CONC-41'], status: S.staging, comments: [said] } } });
    await applyQueueMove(again.jira, to(S.staging), S.staging, 'mq-1', LINE);
    expect(posted(again.calls)).toEqual([]);
  });
  it('the question queueStatus decided comes once, with the open tasks after it', async () => {
    const { jira, calls } = fakeJira({ tickets: slice(S.progress) });
    await applyQueueMove(jira, to(S.review, 'Rollout nicht bestätigt.'), S.progress, 'mq-1', LINE);
    const question = posted(calls)[1] ?? '';
    expect(question).toContain('Rollout nicht bestätigt.');
    expect(question).toContain('Offene Tasks (CONC-42, CONC-43)');
  });
});
