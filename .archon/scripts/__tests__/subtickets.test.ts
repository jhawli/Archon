import { describe, expect, it } from 'bun:test';
import { readCreated } from '../../workflows/sdlc/.shared/claims';
import { applyOutbox, type Op } from '../../workflows/sdlc/.shared/outbox';
import { queueStatus } from '../../workflows/sdlc/.shared/queue-status';
import { reservedText, runLine } from '../../workflows/sdlc/.shared/questions';
import {
  promoteParent,
  restParent,
  sweepWaiting,
  WAIT_ENDED_PREFIX,
  WAIT_PREFIX,
  waiting,
  waitText,
} from '../../workflows/sdlc/.shared/subtickets';
import { type Call, CFG, type FakeComment, type FakeTicket, fakeJira, state } from './jira-fixtures';

const S = CFG.status;
const RUN = 'https://example.atlassian.net/browse/CONC-5';
const LINE = runLine('archon-loop', 'run-1');
const steps = (calls: Call[]): string[] => calls.map(call => `${call.method} ${call.path.split('?')[0]}`);
const filed = (calls: Call[]): Record<string, unknown> =>
  (calls.find(call => call.method === 'POST' && call.path === '/rest/api/3/issue')?.body as { fields: Record<string, unknown> }).fields;
const rest: Op = { op: 'create', marker: 'rest-conc-5', title: 'CONC-5 Rest: Liste', text: 'Was fehlt' };
const finding: Op = { op: 'create', marker: 'design-im-weg', title: 'Design im Weg', text: 'Warum' };
const lapTicket: FakeTicket = { status: S.progress, sprint: 'active' };

describe('a rest ticket files as a sub-task of the lap’s ticket (VAULT-22)', () => {
  it('rest of CONC-5, open in the active sprint: a Jira sub-task under CONC-5, on To Do, no own sprint step', async () => {
    const { jira, calls } = fakeJira({ sprint: 7, tickets: { 'CONC-5': lapTicket } });
    expect(await applyOutbox(jira, [rest], RUN, LINE, state(), undefined, 'CONC-5')).toEqual({ 'rest-conc-5': 'CONC-51' });
    const fields = filed(calls);
    expect(fields.issuetype).toEqual({ id: '10010' });
    expect(fields.parent).toEqual({ key: 'CONC-5' });
    expect(fields.assignee).toEqual({ accountId: CFG.assignee });
    // The marker's remote link stays: it is how a rerun finds the ticket.
    expect(steps(calls)).toContain('POST /rest/api/3/issue/CONC-51/remotelink');
    expect(steps(calls)).toContain('POST /rest/api/3/issue/CONC-51/transitions');
    expect(steps(calls).some(step => step.includes('/sprint'))).toBe(false);
    expect(steps(calls)).not.toContain('POST /rest/api/3/issueLink');
  });
  it('the lap’s ticket is a sub-task itself: the rest goes under its parent, beside it', async () => {
    const tickets = { 'CONC-5': { status: S.progress, parent: 'CONC-2', sprint: 'active' as const }, 'CONC-2': { status: S.progress, sprint: 'active' as const } };
    const { jira, calls } = fakeJira({ sprint: 7, tickets });
    await applyOutbox(jira, [rest], RUN, LINE, state(), undefined, 'CONC-5');
    expect(filed(calls).parent).toEqual({ key: 'CONC-2' });
  });
  it('a parent not open in the active sprint: a ticket of its own that relates to the lap’s ticket', async () => {
    for (const parent of [
      { status: S.staging, sprint: 'active' as const },
      { status: S.progress, sprint: 'closed' as const },
      { status: S.progress },
    ]) {
      const { jira, calls } = fakeJira({ sprint: 7, tickets: { 'CONC-5': { status: S.progress, parent: 'CONC-2', sprint: 'active' }, 'CONC-2': parent } });
      await applyOutbox(jira, [rest], RUN, LINE, state(), undefined, 'CONC-5');
      expect(filed(calls).issuetype).toEqual({ name: 'Task' });
      expect(filed(calls).parent).toBeUndefined();
      expect(calls.find(call => call.path === '/rest/api/3/issueLink')?.body).toEqual({
        type: { name: 'Relates' },
        inwardIssue: { key: 'CONC-51' },
        outwardIssue: { key: 'CONC-5' },
      });
      expect(steps(calls)).toContain('POST /rest/agile/1.0/sprint/7/issue');
    }
  });
  it('a rest named for another ticket than the lap’s is no sub-task: it only relates', async () => {
    const { jira, calls } = fakeJira({ sprint: 7, tickets: { 'CONC-5': lapTicket } });
    await applyOutbox(jira, [{ ...rest, marker: 'rest-conc-9' }], RUN, LINE, state(), undefined, 'CONC-5');
    expect(filed(calls).parent).toBeUndefined();
    expect(steps(calls)).toContain('POST /rest/api/3/issueLink');
  });
});

describe('a ticket delivered in part a second time gets a new rest (VAULT-22)', () => {
  const id = (marker: string): string => `archon:CONC:${marker}`;
  it('the first rest is on Staging: the new one files as rest-conc-5-2, under CONC-5', async () => {
    const tickets = { 'CONC-5': lapTicket, 'CONC-45': { status: S.staging, parent: 'CONC-5' } };
    const { jira, calls } = fakeJira({ sprint: 7, tickets, linked: { [id('rest-conc-5')]: 'CONC-45' } });
    const dir = state();
    expect(await applyOutbox(jira, [rest], RUN, LINE, dir, undefined, 'CONC-5')).toEqual({ 'rest-conc-5': 'CONC-51' });
    expect(filed(calls).parent).toEqual({ key: 'CONC-5' });
    expect(JSON.stringify(filed(calls).description)).toContain('Loop finding: rest-conc-5-2');
    const link = calls.find(call => call.path === '/rest/api/3/issue/CONC-51/remotelink')?.body as { globalId: string };
    expect(link.globalId).toBe(id('rest-conc-5-2'));
    // Release reads the rest under the marker review wrote.
    expect(readCreated(dir)['rest-conc-5']).toBe('CONC-51');
  });
  it('parts done and canceled alike are passed over; the first open part is used again', async () => {
    const tickets = { 'CONC-5': lapTicket, 'CONC-45': { status: S.live }, 'CONC-46': { status: S.canceled }, 'CONC-47': { status: S.todo } };
    const linked = { [id('rest-conc-5')]: 'CONC-45', [id('rest-conc-5-2')]: 'CONC-46', [id('rest-conc-5-3')]: 'CONC-47' };
    const { jira, calls } = fakeJira({ sprint: 7, tickets, linked });
    expect(await applyOutbox(jira, [rest], RUN, LINE, state(), undefined, 'CONC-5')).toEqual({ 'rest-conc-5': 'CONC-47' });
    expect(calls.some(call => call.method === 'POST' && call.path === '/rest/api/3/issue')).toBe(false);
  });
  it('a rerun of a half set up later part links that part, not the first', async () => {
    const tickets = { 'CONC-5': lapTicket, 'CONC-45': { status: S.staging } };
    const { jira, calls } = fakeJira({ sprint: 7, tickets, linked: { [id('rest-conc-5')]: 'CONC-45' }, failOnce: 'POST /rest/api/3/issue/CONC-51/remotelink' });
    const dir = state();
    await applyOutbox(jira, [rest], RUN, LINE, dir, { writer: 'review', raw: [rest] }, 'CONC-5').catch(() => undefined);
    calls.length = 0;
    await applyOutbox(jira, [rest], RUN, LINE, dir, { writer: 'review', raw: [rest] }, 'CONC-5');
    const link = calls.find(call => call.path === '/rest/api/3/issue/CONC-51/remotelink')?.body as { globalId: string };
    expect(link.globalId).toBe(id('rest-conc-5-2'));
    expect(calls.some(call => call.method === 'POST' && call.path === '/rest/api/3/issue')).toBe(false);
  });
  it('any other marker names its finding for good: a canceled one is not filed again', async () => {
    const { jira, calls } = fakeJira({ tickets: { 'CONC-45': { status: S.canceled } }, linked: { [id('design-im-weg')]: 'CONC-45' } });
    expect(await applyOutbox(jira, [finding], RUN, LINE, state(), undefined, 'CONC-5')).toEqual({ 'design-im-weg': 'CONC-45' });
    expect(steps(calls)).toEqual(['POST /rest/api/3/search/jql']);
  });
});

describe('other tickets a lap files relate to its ticket', () => {
  it('a finding during the lap on CONC-5: a Task with "relates to" CONC-5, in the open sprint', async () => {
    const { jira, calls } = fakeJira({ sprint: 7, tickets: { 'CONC-5': lapTicket } });
    await applyOutbox(jira, [finding], RUN, LINE, state(), undefined, 'CONC-5');
    expect(filed(calls).issuetype).toEqual({ name: 'Task' });
    expect(steps(calls)).toEqual([
      'POST /rest/api/3/search/jql',
      'GET /rest/api/3/project/CONC',
      'POST /rest/api/3/issue',
      'POST /rest/api/3/issue/CONC-51/remotelink',
      'GET /rest/api/3/issue/CONC-51',
      'POST /rest/api/3/issueLink',
      'GET /rest/api/3/issue/CONC-51',
      'GET /rest/api/3/issue/CONC-51/transitions',
      'POST /rest/api/3/issue/CONC-51/transitions',
      'GET /rest/agile/1.0/board/5/sprint',
      'POST /rest/agile/1.0/sprint/7/issue',
    ]);
  });
  it('a link that is there already is not added twice (rerun)', async () => {
    const { jira, calls } = fakeJira({ tickets: { 'CONC-51': { status: S.todo, relates: ['CONC-5'] } } });
    await jira.relate('CONC-51', 'CONC-5');
    expect(steps(calls)).toEqual(['GET /rest/api/3/issue/CONC-51']);
  });
  it('a lap on a pull request alone links nothing', async () => {
    const { jira, calls } = fakeJira({ sprint: 7 });
    await applyOutbox(jira, [rest], RUN, LINE, state(), undefined, null);
    expect(filed(calls).parent).toBeUndefined();
    expect(steps(calls)).not.toContain('POST /rest/api/3/issueLink');
  });
  it('a ticket of another project never reaches the link call', async () => {
    const { jira } = fakeJira();
    expect(jira.relate('CONC-51', 'VAULT-3')).rejects.toThrow('not a CONC ticket key');
  });
});

describe('restParent', () => {
  it('a sub-task under a sub-task does not exist: a parent that is a sub-task gives none', async () => {
    const tickets = { 'CONC-5': { status: S.progress, parent: 'CONC-2', sprint: 'active' as const }, 'CONC-2': { status: S.progress, parent: 'CONC-1', sprint: 'active' as const } };
    const { jira } = fakeJira({ tickets });
    expect(await restParent(jira, 'CONC-5')).toBeNull();
  });
});

const at = (id: number, body: string, author = CFG.assignee): FakeComment => ({ id, author, body, created: `2026-11-18T10:0${id % 10}:00.000+0000` });
const waitingParent = (comments: FakeComment[], children = ['CONC-51', 'CONC-52']): Record<string, FakeTicket> => ({
  'CONC-5': { status: S.progress, sprint: 'active', children, comments },
  'CONC-51': { status: S.staging, parent: 'CONC-5' },
  'CONC-52': { status: S.canceled, parent: 'CONC-5' },
});

describe('the waiting parent goes to Staging when its sub-tasks are done', () => {
  it('waiting, every sub-task on Staging, Live or Canceled: Staging, then a comment with the run line', async () => {
    const { jira, calls } = fakeJira({ tickets: waitingParent([at(1, 'Loop claim: run r0 x'), at(2, waitText(['CONC-51']))]) });
    expect(await promoteParent(jira, 'CONC-5', LINE)).toContain('Staging');
    const moved = calls.findIndex(call => call.method === 'POST' && call.path.endsWith('/transitions'));
    const said = calls.findIndex(call => call.method === 'POST' && call.path.endsWith('/comment'));
    expect(calls[moved]?.body).toEqual({ transition: { id: `t${S.staging}` } });
    expect(moved).toBeLessThan(said);
    expect(JSON.stringify(calls[said]?.body)).toContain('Lauf: archon archon-loop run-1');
  });
  it('one sub-task still open: nothing', async () => {
    const tickets = { ...waitingParent([at(1, waitText(['CONC-51']))]), 'CONC-52': { status: S.todo, parent: 'CONC-5' } };
    const { jira, calls } = fakeJira({ tickets });
    expect(await promoteParent(jira, 'CONC-5', LINE)).toBeNull();
    expect(steps(calls).some(step => step.startsWith('POST'))).toBe(false);
  });
  it('no wait record, a live claim after it, or one by another account: not a waiting parent', async () => {
    for (const comments of [
      [at(1, 'Loop result: run r1. Status: In Progress.')],
      [at(1, waitText(['CONC-51'])), at(2, 'Loop claim: run r2 x')],
      [at(1, waitText(['CONC-51']), CFG.owner)],
    ]) {
      const { jira, calls } = fakeJira({ tickets: waitingParent(comments) });
      expect(await promoteParent(jira, 'CONC-5', LINE)).toBeNull();
      expect(steps(calls).some(step => step.startsWith('POST'))).toBe(false);
    }
  });
  it('a wait that ended (the parent went to Staging) does not count again when the ticket is set back to In Progress', async () => {
    const comments = [at(1, waitText(['CONC-51'])), at(2, `${WAIT_ENDED_PREFIX}alle Subtickets fertig`)];
    const { jira, calls } = fakeJira({ tickets: waitingParent(comments) });
    expect(await promoteParent(jira, 'CONC-5', LINE)).toBeNull();
    expect(steps(calls).some(step => step.startsWith('POST'))).toBe(false);
    expect(waiting(comments.map(c => ({ ...c, createdAt: 0, url: '' })), CFG)).toBe(false);
  });
  it('the comment that moves the parent ends the wait', async () => {
    const { jira, calls } = fakeJira({ tickets: waitingParent([at(1, waitText(['CONC-51']))]) });
    await promoteParent(jira, 'CONC-5', LINE);
    const said = calls.find(call => call.method === 'POST' && call.path.endsWith('/comment'));
    expect(JSON.stringify(said?.body)).toContain(WAIT_ENDED_PREFIX.trim());
  });
  it('a released claim after the wait no longer counts as one', async () => {
    const { jira } = fakeJira({ tickets: waitingParent([at(1, waitText(['CONC-51'])), at(2, 'Loop claim released: run r2 ended.')]) });
    expect(await promoteParent(jira, 'CONC-5', LINE)).not.toBeNull();
  });
  it('a ticket not In Progress, or without sub-tasks, is left alone', async () => {
    const onReview = { ...waitingParent([at(1, waitText(['CONC-51']))]), 'CONC-5': { status: S.review, children: ['CONC-51'], comments: [at(1, waitText(['CONC-51']))] } };
    expect(await promoteParent(fakeJira({ tickets: onReview }).jira, 'CONC-5', LINE)).toBeNull();
    expect(await promoteParent(fakeJira({ tickets: waitingParent([at(1, waitText(['CONC-51']))], []) }).jira, 'CONC-5', LINE)).toBeNull();
  });
  it('the sweep asks for the loop’s In Progress tickets and goes on past one that fails', async () => {
    const tickets = { ...waitingParent([at(1, waitText(['CONC-51']))]), 'CONC-6': { status: S.progress } };
    const { jira, calls } = fakeJira({ found: ['CONC-6', 'CONC-5'], tickets, failOnce: 'GET /rest/api/3/issue/CONC-6' });
    const lines = await sweepWaiting(jira, LINE);
    expect((calls[0]?.body as { jql: string }).jql).toBe(`project = CONC AND status = ${S.progress} AND assignee = "${CFG.assignee}"`);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('CONC-6: could not be moved');
    expect(lines[1]).toContain('CONC-5: Staging');
  });
});

describe('the wait record is the scripts’ own', () => {
  it('an agent may not write a comment that opens like it', () => {
    expect(reservedText(waitText(['CONC-51']))).toBe(true);
    expect(reservedText(`${WAIT_PREFIX}x`)).toBe(true);
    expect(reservedText(`${WAIT_ENDED_PREFIX}x`)).toBe(true);
    expect(reservedText('Wartet auf CONC-51')).toBe(false);
  });
});

describe('the merge queue holds a parent with open sub-tasks too', () => {
  it('merged and rolled out, a sub-task open: In Progress, waiting on it', () => {
    const view = { state: 'MERGED', mergedAt: '2026-11-20T10:05:00Z', title: 'CONC-5 Liste', body: '' };
    const url = 'https://github.com/o/r/pull/9';
    const moves = queueStatus([{ url }], true, new Map([[url, view]]), new Map([['CONC-5', S.review]]), Date.parse('2026-11-20T10:00:00Z'), CFG, new Map([['CONC-5', ['CONC-51']]]));
    expect(moves).toEqual([{ key: 'CONC-5', pr: url, status: S.progress, ask: null, waitingOn: ['CONC-51'] }]);
  });
});
