import { describe, expect, it } from 'bun:test';
import { readCreated } from '../../workflows/sdlc/.shared/claims';
import { applyOutbox, type Op } from '../../workflows/sdlc/.shared/outbox';
import { reservedText, runLine } from '../../workflows/sdlc/.shared/questions';
import { closeTasks, restFeature, splitTasks, tasksDone } from '../../workflows/sdlc/.shared/subtickets';
import { type Call, CFG, type FakeTicket, fakeJira, state, SUBTASK_TYPE, TYPES } from './jira-fixtures';

const S = CFG.status;
const RUN = 'https://example.atlassian.net/browse/CONC-41';
const LINE = runLine('archon-loop', 'run-1');
/** A feature on Umsetzung: a status the tracker does not name. */
const FEATURE: FakeTicket = { status: '10055', type: '10000', children: ['CONC-41'] };
const SLICE: FakeTicket = { status: S.progress, type: TYPES.slice, parent: 'CONC-40', sprint: 'active' };
const BUG: FakeTicket = { status: S.progress, type: TYPES.bug, sprint: 'active' };
const steps = (calls: Call[]): string[] => calls.map(call => `${call.method} ${call.path.split('?')[0]}`);
const filed = (calls: Call[], n = 0): Record<string, unknown> =>
  (calls.filter(call => call.method === 'POST' && call.path === '/rest/api/3/issue')[n]?.body as { fields: Record<string, unknown> }).fields;
const moves = (calls: Call[]): string[] =>
  calls
    .filter(call => call.method === 'POST' && call.path.endsWith('/transitions'))
    .map(call => `${call.path.split('/')[5]} ${(call.body as { transition: { id: string } }).transition.id.slice(1)}`);
const rest = (key: string): Op => ({ op: 'create', marker: `rest-${key.toLowerCase()}`, title: `${key} Rest: Liste`, text: 'Was fehlt' });
const finding: Op = { op: 'create', marker: 'design-im-weg', title: 'Design im Weg', text: 'Warum' };

describe('the feature a rest goes under (VAULT-28)', () => {
  it('the rest of a slice goes under the feature of that slice', async () => {
    const { jira } = fakeJira({ tickets: { 'CONC-40': FEATURE, 'CONC-41': SLICE } });
    expect(await restFeature(jira, 'CONC-41')).toBe('CONC-40');
  });
  it('a bug, or a slice without a feature, has no feature for its rest', async () => {
    const { jira } = fakeJira({ tickets: { 'CONC-50': BUG, 'CONC-52': { status: S.progress, type: TYPES.slice } } });
    expect(await restFeature(jira, 'CONC-50')).toBeNull();
    expect(await restFeature(jira, 'CONC-52')).toBeNull();
  });
});

describe('a rest is a new slice under the same feature, on Startklar (AK17, VAULT-28)', () => {
  it('filed as the plain type, linked, in the sprint, then moved to a slice on Startklar under the feature', async () => {
    const { jira, calls, bulkMoves, book } = fakeJira({ sprint: 7, tickets: { 'CONC-40': FEATURE, 'CONC-41': SLICE } });
    expect(await applyOutbox(jira, [rest('CONC-41')], RUN, LINE, state(), undefined, 'CONC-41')).toEqual({ 'rest-conc-41': 'CONC-51' });
    expect(filed(calls).issuetype).toEqual({ id: TYPES.filing });
    expect(filed(calls).parent).toBeUndefined();
    expect(bulkMoves).toEqual([{ target: 'CONC,10005,CONC-40', keys: ['CONC-51'], statuses: { '10057': ['10060'] } }]);
    expect(book.get('CONC-51')).toMatchObject({ type: TYPES.slice, parent: 'CONC-40', status: S.todo });
    // Sprint first, then the move: as the Vault's `rest` does it.
    const order = steps(calls);
    expect(order.indexOf('POST /rest/agile/1.0/sprint/7/issue')).toBeLessThan(order.indexOf('POST /rest/api/3/bulk/issues/move'));
    expect(order).toContain('POST /rest/api/3/issueLink');
    expect(moves(calls)).toEqual([]);
  });
  it('a rerun after a failed move files nothing new and moves it once', async () => {
    const tickets = { 'CONC-40': FEATURE, 'CONC-41': SLICE };
    const { jira, calls, bulkMoves } = fakeJira({ sprint: 7, tickets, failOnce: 'POST /rest/api/3/bulk/issues/move' });
    const dir = state();
    const raw = [rest('CONC-41')];
    await applyOutbox(jira, raw, RUN, LINE, dir, { writer: 'review', raw }, 'CONC-41').catch(() => undefined);
    calls.length = 0;
    expect(await applyOutbox(jira, raw, RUN, LINE, dir, { writer: 'review', raw }, 'CONC-41')).toEqual({ 'rest-conc-41': 'CONC-51' });
    expect(steps(calls)).not.toContain('POST /rest/api/3/issue');
    expect(bulkMoves).toHaveLength(1);
  });
  it('a rerun after the move does not move it again', async () => {
    const tickets = { 'CONC-40': FEATURE, 'CONC-41': SLICE };
    const { jira, bulkMoves } = fakeJira({ sprint: 7, tickets, failOnce: 'GET /rest/api/3/bulk/queue/t1' });
    const dir = state();
    const raw = [rest('CONC-41')];
    await applyOutbox(jira, raw, RUN, LINE, dir, { writer: 'review', raw }, 'CONC-41').catch(() => undefined);
    await applyOutbox(jira, raw, RUN, LINE, dir, { writer: 'review', raw }, 'CONC-41');
    expect(bulkMoves).toHaveLength(1);
  });
  it('a bulk move that ends on another status fails loudly', async () => {
    const { jira } = fakeJira({ sprint: 7, tickets: { 'CONC-40': FEATURE, 'CONC-41': SLICE }, bulkStatus: '10060' });
    expect(applyOutbox(jira, [rest('CONC-41')], RUN, LINE, state(), undefined, 'CONC-41')).rejects.toThrow(
      'CONC-51: bulk move left it on 10060'
    );
  });
  it('the rest of a bug is a bug that relates to it', async () => {
    const { jira, calls, bulkMoves } = fakeJira({ sprint: 7, tickets: { 'CONC-50': BUG } });
    await applyOutbox(jira, [rest('CONC-50')], RUN, LINE, state(), undefined, 'CONC-50');
    expect(filed(calls).issuetype).toEqual({ id: TYPES.bug });
    expect(bulkMoves).toEqual([]);
    const link = calls.find(call => call.path === '/rest/api/3/issueLink')?.body as { outwardIssue: { key: string } };
    expect(link.outwardIssue.key).toBe('CONC-50');
  });
});

describe('a ticket delivered in part a second time gets a new rest (VAULT-22)', () => {
  const id = (marker: string): string => `archon:CONC:${marker}`;
  it('the first rest is on Staging: the new one files as rest-conc-41-2, again under the feature', async () => {
    const tickets = { 'CONC-40': FEATURE, 'CONC-41': SLICE, 'CONC-45': { status: S.staging, type: TYPES.slice, parent: 'CONC-40' } };
    const { jira, calls, bulkMoves } = fakeJira({ sprint: 7, tickets, linked: { [id('rest-conc-41')]: 'CONC-45' } });
    const dir = state();
    expect(await applyOutbox(jira, [rest('CONC-41')], RUN, LINE, dir, undefined, 'CONC-41')).toEqual({ 'rest-conc-41': 'CONC-51' });
    expect(JSON.stringify(filed(calls).description)).toContain('Loop finding: rest-conc-41-2');
    const link = calls.find(call => call.path === '/rest/api/3/issue/CONC-51/remotelink')?.body as { globalId: string };
    expect(link.globalId).toBe(id('rest-conc-41-2'));
    expect(bulkMoves[0]?.target).toBe('CONC,10005,CONC-40');
    // Release reads the rest under the marker review wrote.
    expect(readCreated(dir)['rest-conc-41']).toBe('CONC-51');
  });
  it('parts done and canceled alike are passed over; the first open part is used again', async () => {
    const tickets = { 'CONC-41': SLICE, 'CONC-45': { status: S.live }, 'CONC-46': { status: S.canceled }, 'CONC-47': { status: S.todo } };
    const linked = { [id('rest-conc-41')]: 'CONC-45', [id('rest-conc-41-2')]: 'CONC-46', [id('rest-conc-41-3')]: 'CONC-47' };
    const { jira, calls } = fakeJira({ sprint: 7, tickets, linked });
    expect(await applyOutbox(jira, [rest('CONC-41')], RUN, LINE, state(), undefined, 'CONC-41')).toEqual({ 'rest-conc-41': 'CONC-47' });
    expect(calls.some(call => call.method === 'POST' && call.path === '/rest/api/3/issue')).toBe(false);
  });
  it('a rerun of a half set up later part links that part, not the first', async () => {
    const tickets = { 'CONC-40': FEATURE, 'CONC-41': SLICE, 'CONC-45': { status: S.staging } };
    const raw = [rest('CONC-41')];
    const failOnce = 'POST /rest/api/3/issue/CONC-51/remotelink';
    const { jira, calls } = fakeJira({ sprint: 7, tickets, linked: { [id('rest-conc-41')]: 'CONC-45' }, failOnce });
    const dir = state();
    await applyOutbox(jira, raw, RUN, LINE, dir, { writer: 'review', raw }, 'CONC-41').catch(() => undefined);
    calls.length = 0;
    await applyOutbox(jira, raw, RUN, LINE, dir, { writer: 'review', raw }, 'CONC-41');
    const link = calls.find(call => call.path === '/rest/api/3/issue/CONC-51/remotelink')?.body as { globalId: string };
    expect(link.globalId).toBe(id('rest-conc-41-2'));
    expect(calls.some(call => call.method === 'POST' && call.path === '/rest/api/3/issue')).toBe(false);
  });
  it('any other marker names its finding for good: a canceled one is not filed again', async () => {
    const { jira, calls } = fakeJira({ tickets: { 'CONC-45': { status: S.canceled } }, linked: { [id('design-im-weg')]: 'CONC-45' } });
    expect(await applyOutbox(jira, [finding], RUN, LINE, state(), undefined, 'CONC-41')).toEqual({ 'design-im-weg': 'CONC-45' });
    expect(steps(calls)).toEqual(['POST /rest/api/3/search/jql']);
  });
});

describe('a finding of the loop is a bug on Gemeldet (VAULT-28, decision 3)', () => {
  it('a finding during the lap on CONC-41: a bug that relates to CONC-41, in the open sprint, not moved', async () => {
    const { jira, calls, bulkMoves } = fakeJira({ sprint: 7, tickets: { 'CONC-40': FEATURE, 'CONC-41': SLICE } });
    await applyOutbox(jira, [finding], RUN, LINE, state(), undefined, 'CONC-41');
    expect(filed(calls).issuetype).toEqual({ id: TYPES.bug });
    expect(bulkMoves).toEqual([]);
    expect(moves(calls)).toEqual([]);
    expect(steps(calls)).toEqual([
      'POST /rest/api/3/search/jql',
      'GET /rest/api/3/project/CONC',
      'POST /rest/api/3/issue',
      'POST /rest/api/3/issue/CONC-51/remotelink',
      'GET /rest/api/3/issue/CONC-51',
      'POST /rest/api/3/issueLink',
      'GET /rest/api/3/issue/CONC-51',
      'GET /rest/agile/1.0/board/5/sprint',
      'POST /rest/agile/1.0/sprint/7/issue',
    ]);
  });
  it('a link that is there already is not added twice (rerun)', async () => {
    const { jira, calls } = fakeJira({ tickets: { 'CONC-51': { status: S.todoBug, type: TYPES.bug, relates: ['CONC-5'] } } });
    await jira.relate('CONC-51', 'CONC-5');
    expect(steps(calls)).toEqual(['GET /rest/api/3/issue/CONC-51']);
  });
  it('a lap on a pull request alone links nothing: its rest is a bug of its own', async () => {
    const { jira, calls } = fakeJira({ sprint: 7 });
    await applyOutbox(jira, [rest('CONC-41')], RUN, LINE, state(), undefined, null);
    expect(filed(calls).issuetype).toEqual({ id: TYPES.bug });
    expect(steps(calls)).not.toContain('POST /rest/api/3/issueLink');
  });
  it('a ticket of another project never reaches the link call', async () => {
    const { jira } = fakeJira();
    expect(jira.relate('CONC-51', 'VAULT-3')).rejects.toThrow('not a CONC ticket key');
  });
});

const TASKS = [
  { key: 'CONC-42', status: '10061', title: 'Task 1: A' }, // already Erledigt
  { key: 'CONC-43', status: '3', title: 'Task 2: B' },
  { key: 'CONC-44', status: '10060', title: 'Task 3: C' },
  { key: 'CONC-45', status: '10060', title: 'Aufräumen' }, // no number
];

describe('the tasks of a slice after a lap (VAULT-28, decision 5)', () => {
  it('a whole delivery finishes every open task', () => {
    expect(splitTasks(TASKS, [], 'all', S)).toEqual({ done: ['CONC-43', 'CONC-44', 'CONC-45'], rest: [], unknown: [] });
    expect(splitTasks(TASKS, [], '', S).done).toEqual(['CONC-43', 'CONC-44', 'CONC-45']);
  });
  it('a part finishes the named tasks, the others go to the rest', () => {
    expect(splitTasks(TASKS, [2], 'part', S)).toEqual({ done: ['CONC-43'], rest: ['CONC-44', 'CONC-45'], unknown: [] });
  });
  it('a part that names no task leaves every open one to the rest', () => {
    expect(splitTasks(TASKS, [], 'part', S).rest).toEqual(['CONC-43', 'CONC-44', 'CONC-45']);
  });
  it('a number the slice does not have is reported, never guessed', () => {
    expect(splitTasks(TASKS, [2, 9], 'part', S).unknown).toEqual([9]);
    expect(splitTasks(TASKS, [9], 'all', S).unknown).toEqual([9]);
  });
  it('a task already Erledigt or Entfällt is left alone', () => {
    expect(splitTasks(TASKS, [1], 'part', S).done).toEqual([]);
    expect(splitTasks([{ key: 'CONC-46', status: '10062', title: 'Task 4: D' }], [], 'all', S)).toEqual({ done: [], rest: [], unknown: [] });
  });
  it('the line "Tasks done: 1, 2, 5" is read as numbers; anything else is no number', () => {
    expect(tasksDone('Tasks done: 1, 2, 5')).toEqual([1, 2, 5]);
    expect(tasksDone('Tasks done: none')).toEqual([]);
    expect(tasksDone('Tasks done: 1; rm -rf')).toEqual([1]);
    expect(tasksDone('verdict\nTasks done: 3\n')).toEqual([3]);
    expect(tasksDone('')).toEqual([]);
    expect(tasksDone('1, 2')).toEqual([]);
  });
});

describe('closing the tasks before Review (VAULT-28, AK17)', () => {
  const slice = (): Record<string, FakeTicket> => ({
    'CONC-40': FEATURE,
    'CONC-41': { ...SLICE, children: TASKS.map(t => t.key) },
    ...Object.fromEntries(TASKS.map(t => [t.key, { status: t.status, type: SUBTASK_TYPE, title: t.title, parent: 'CONC-41' }])),
    'CONC-90': { status: S.todo, type: TYPES.slice, parent: 'CONC-40' },
  });
  const made = (calls: Call[]): { parent: { key: string }; summary: string; issuetype: unknown }[] =>
    calls
      .filter(call => call.method === 'POST' && call.path === '/rest/api/3/issue')
      .map(call => (call.body as { fields: { parent: { key: string }; summary: string; issuetype: unknown } }).fields);
  it('the tasks left over are filed again under the rest slice and dropped on the old one', async () => {
    const { jira, calls } = fakeJira({ tickets: slice() });
    const notes = await closeTasks(jira, 'CONC-41', { delivers: 'part', tasks: [2] }, 'CONC-90');
    expect(moves(calls)).toEqual(['CONC-43 10061', 'CONC-44 10062', 'CONC-45 10062']);
    expect(made(calls).map(f => [f.parent.key, f.summary])).toEqual([['CONC-90', 'Task 3: C'], ['CONC-90', 'Aufräumen']]);
    expect(made(calls)[0]?.issuetype).toEqual({ id: SUBTASK_TYPE });
    expect(notes).toEqual(['Tasks erledigt: CONC-43.', 'Weiter in CONC-90: CONC-44, CONC-45.']);
  });
  it('a rerun files no task twice under the rest', async () => {
    const { jira, calls } = fakeJira({ tickets: slice() });
    await closeTasks(jira, 'CONC-41', { delivers: 'part', tasks: [2] }, 'CONC-90');
    calls.length = 0;
    await closeTasks(jira, 'CONC-41', { delivers: 'part', tasks: [2] }, 'CONC-90');
    expect(calls.filter(call => call.method === 'POST')).toEqual([]);
  });
  it('a whole delivery closes every open task and files nothing', async () => {
    const { jira, calls } = fakeJira({ tickets: slice() });
    expect(await closeTasks(jira, 'CONC-41', { delivers: 'all', tasks: [] }, null)).toEqual(['Tasks erledigt: CONC-43, CONC-44, CONC-45.']);
    expect(moves(calls)).toEqual(['CONC-43 10061', 'CONC-44 10061', 'CONC-45 10061']);
    expect(made(calls)).toEqual([]);
  });
  it('a part without a rest ticket leaves the other tasks open and says so', async () => {
    const { jira, calls } = fakeJira({ tickets: slice() });
    const notes = await closeTasks(jira, 'CONC-41', { delivers: 'part', tasks: [2, 7] }, null);
    expect(moves(calls)).toEqual(['CONC-43 10061']);
    expect(notes).toEqual([
      'Tasks erledigt: CONC-43.',
      'Offen ohne Rest-Ticket: CONC-44, CONC-45.',
      '„Tasks done“ nennt 7: diese Nummer hat die Scheibe nicht, übergangen.',
    ]);
  });
  it('a ticket without tasks (a bug) is left alone', async () => {
    const { jira, calls } = fakeJira({ tickets: { 'CONC-50': BUG } });
    expect(await closeTasks(jira, 'CONC-50', { delivers: 'all', tasks: [] }, null)).toEqual([]);
    expect(calls.filter(call => call.method === 'POST')).toEqual([]);
  });
});

describe('the old wait records stay the scripts’ own', () => {
  it('an agent may not write a comment that opens like one', () => {
    expect(reservedText('Loop wait: geliefert')).toBe(true);
    expect(reservedText('Loop wait ended: alle')).toBe(true);
    expect(reservedText('Wartet auf CONC-51')).toBe(false);
  });
});
