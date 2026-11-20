import { describe, expect, it } from 'bun:test';
import type { ItemComment, LapResult, PrView } from '../../workflows/sdlc/.shared/claims';
import { type Released, releaseTicket } from '../../workflows/sdlc/.shared/release-ticket';
import { type Call, CFG, type FakeTicket, fakeJira, SUBTASK_TYPE, TYPES } from './jira-fixtures';

const S = CFG.status;
const PR = 'https://github.com/o/r/pull/9';
const LINE = 'Lauf: archon-loop run-1';
const OPEN: PrView = { state: 'OPEN', mergedAt: null, title: 'CONC-41 Liste', body: '' };
const MERGED: PrView = { state: 'MERGED', mergedAt: '2026-11-20T10:05:00Z', title: 'CONC-41 Liste', body: '' };
const lapOf = (over: Partial<LapResult>): LapResult => ({
  pr: PR, landed: '', deployed: '', delivers: '', tasks: [], reviewed: '', created: {}, ...over,
});
/** A slice in progress under CONC-40 with two open tasks, and a rest slice CONC-90 on Startklar. */
const tickets = (status: string = S.progress, type: string = TYPES.slice): Record<string, FakeTicket> => ({
  'CONC-40': { status: '10055', type: '10000', children: ['CONC-41'] },
  'CONC-41': { status, type, parent: 'CONC-40', sprint: 'active', children: ['CONC-42', 'CONC-43'] },
  'CONC-42': { status: '10060', type: SUBTASK_TYPE, title: 'Task 1: A', parent: 'CONC-41' },
  'CONC-43': { status: '10060', type: SUBTASK_TYPE, title: 'Task 2: B', parent: 'CONC-41' },
  'CONC-90': { status: S.todo, type: TYPES.slice, parent: 'CONC-40' },
});
const posted = (calls: Call[]): string[] =>
  calls.filter(call => call.method === 'POST' && call.path === '/rest/api/3/issue/CONC-41/comment').map(call => JSON.stringify(call.body));
const flagged = (calls: Call[]): boolean => calls.some(call => call.method === 'PUT' && call.path === '/rest/api/3/issue/CONC-41');
const release = async (jira: Parameters<typeof releaseTicket>[0], lap: LapResult, view: PrView | null, all: ItemComment[] = []): Promise<Released> =>
  releaseTicket(jira, 'CONC-41', { recorded: lap, lap, view }, 'run-1', LINE, all);

describe('release: the ticket after a lap (VAULT-28, Julian 2026-11-20)', () => {
  it('sent back: the slice goes back to Startklar with its pull request, the tasks stay open, one result comment', async () => {
    const { jira, calls, book } = fakeJira({ tickets: tickets() });
    const result = await release(jira, lapOf({ reviewed: 'sent-back', delivers: 'none' }), OPEN);
    expect(result).toMatchObject({ name: 'Startklar', asked: false });
    expect(book.get('CONC-41')?.status).toBe(S.todo);
    expect([book.get('CONC-42')?.status, book.get('CONC-43')?.status]).toEqual(['10060', '10060']);
    expect(posted(calls)).toHaveLength(1);
    expect(posted(calls)[0]).toContain(`Loop result: run run-1. PR: ${PR}. Status: Startklar.`);
    expect(flagged(calls)).toBe(false);
  });
  it('a bug on Review sent back goes to Gemeldet', async () => {
    const { jira, book } = fakeJira({ tickets: tickets(S.review, TYPES.bug) });
    expect((await release(jira, lapOf({ reviewed: 'needs-owner', delivers: 'none' }), OPEN)).name).toBe('Gemeldet');
    expect(book.get('CONC-41')?.status).toBe(S.todoBug);
  });
  it('approved for a manual merge with a part and its rest: task 1 done, task 2 moves to the rest, then Review', async () => {
    const { jira, calls, book } = fakeJira({ tickets: tickets() });
    const lap = lapOf({ reviewed: 'approved', delivers: 'part', tasks: [1], created: { 'rest-conc-41': 'CONC-90' } });
    expect((await release(jira, lap, OPEN)).name).toBe('Review');
    expect([book.get('CONC-42')?.status, book.get('CONC-43')?.status]).toEqual([S.taskDone, S.taskDropped]);
    expect(posted(calls)[0]).toContain('Tasks erledigt: CONC-42.');
  });
  it('merged with a part and no rest: the slice stays in Entwicklung, the comment and one question still come', async () => {
    const { jira, calls, book } = fakeJira({ tickets: tickets() });
    const lap = lapOf({ reviewed: 'merge', landed: 'merged', deployed: 'true', delivers: 'part', tasks: [1] });
    const result = await release(jira, lap, MERGED);
    expect(result).toMatchObject({ name: 'Entwicklung', asked: true });
    expect(book.get('CONC-41')?.status).toBe(S.progress);
    expect(book.get('CONC-42')?.status).toBe(S.taskDone);
    expect(posted(calls)[0]).toContain('Status: Entwicklung.');
    const question = posted(calls)[1] ?? '';
    expect(question).toContain('Rest-Ticket');
    expect(question).toContain('Offene Tasks (CONC-43)');
    expect(flagged(calls)).toBe(true);
  });
  it('a second run of the node writes no second result comment', async () => {
    const { jira, calls } = fakeJira({ tickets: tickets() });
    const said: ItemComment = { id: 7, body: `Loop result: run run-1. PR: ${PR}. Status: Startklar.`, createdAt: 0 };
    await release(jira, lapOf({ reviewed: 'sent-back', delivers: 'none' }), OPEN, [said]);
    expect(posted(calls)).toEqual([]);
  });
});
