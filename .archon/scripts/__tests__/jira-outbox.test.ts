import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCreated, readFinished, recordCreated, recordFinished } from '../../workflows/sdlc/.shared/claims';
import type { Ticket, TicketComment, TrackerConfig } from '../../workflows/sdlc/.shared/jira';
import {
  applyOutbox,
  boardMarkdown,
  checkOutbox,
  clearOutbox,
  outboxFile,
  outboxProgress,
  prAddressRefusal,
  prRefusal,
  readOutbox,
  snapshotKeys,
  writableJql,
  writableKeys,
  writableNow,
  type Op,
} from '../../workflows/sdlc/.shared/outbox';
import { runLine } from '../../workflows/sdlc/.shared/questions';
import { prKeys } from '../../workflows/sdlc/.shared/tickets';
import { type Call, fakeJira, state } from './jira-fixtures';

const CFG: TrackerConfig = {
  kind: 'jira',
  site: 'https://example.atlassian.net',
  project: 'CONC',
  board: 5,
  keychain: 'none',
  assignee: 'acc-archon',
  owner: 'acc-julian',
  status: {
    todo: '10015',
    progress: '3',
    review: '10016',
    staging: '10017',
    live: '10018',
    canceled: '10008',
  },
  flagField: 'customfield_10021',
  flagOn: '10019',
  sprintField: 'customfield_10020',
};
const BOARD = new Set(['CONC-5', 'CONC-6']);
const RUN = 'https://example.atlassian.net/browse/CONC-5';
const LINE = runLine('archon-loop', 'run-1');

function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected an error');
}

describe('outbox check', () => {
  it('pick may comment, ask, cancel and unflag on tickets of this lap’s board', () => {
    const ops = ['comment', 'ask', 'cancel', 'unflag'].map(op => ({ op, key: 'CONC-6', text: 'warum' }));
    expect(checkOutbox(ops, 'pick', null, 'CONC', BOARD)).toHaveLength(4);
  });
  it('pick never writes to a ticket outside the snapshot (Julian’s, or one a session holds)', () => {
    expect(failure(() => checkOutbox([{ op: 'comment', key: 'CONC-77', text: 'x' }], 'pick', null, 'CONC', BOARD))).toContain(
      "not on this lap's board"
    );
  });
  it('only pick lifts a flag or cancels', () => {
    expect(failure(() => checkOutbox([{ op: 'unflag', key: 'CONC-5', text: 'x' }], 'review', 'CONC-5', 'CONC', BOARD))).toContain(
      'review may not unflag'
    );
    expect(failure(() => checkOutbox([{ op: 'cancel', key: 'CONC-5', text: 'x' }], 'build', 'CONC-5', 'CONC', BOARD))).toContain(
      'build may not cancel'
    );
  });
  it('build and review write to their target, and file new tickets', () => {
    const ops = [
      { op: 'comment', key: 'CONC-5', text: 'Bericht' },
      { op: 'ask', key: 'CONC-5', text: 'Frage' },
      { op: 'create', marker: 'finding-flaky-sync', title: 'Fund', text: 'Was auffiel' },
    ];
    expect(checkOutbox(ops, 'build', 'CONC-5', 'CONC', BOARD).map(op => op.op)).toEqual(['comment', 'ask', 'create']);
    expect(failure(() => checkOutbox([{ op: 'comment', key: 'CONC-6', text: 'x' }], 'build', 'CONC-5', 'CONC', BOARD))).toContain(
      'build writes only to CONC-5'
    );
    expect(failure(() => checkOutbox([{ op: 'comment', key: 'CONC-5', text: 'x' }], 'review', null, 'CONC', BOARD))).toContain(
      'review writes only to its target'
    );
  });
  it('refuses keys of other projects and keys no ticket can have', () => {
    for (const key of ['VAULT-3', 'CONC-0', 'CONC-5/../x', 5]) {
      expect(failure(() => checkOutbox([{ op: 'comment', key, text: 'x' }], 'pick', null, 'CONC', BOARD))).toContain(
        'key must be a CONC ticket'
      );
    }
  });
  it('refuses unknown ops, empty or huge text and long lists', () => {
    expect(failure(() => checkOutbox([{ op: 'move', key: 'CONC-5', text: 'x' }], 'pick', null, 'CONC', BOARD))).toContain('unknown op');
    expect(failure(() => checkOutbox([{ op: 'comment', key: 'CONC-5' }], 'pick', null, 'CONC', BOARD))).toContain('text is empty');
    expect(
      failure(() => checkOutbox([{ op: 'comment', key: 'CONC-5', text: 'x'.repeat(30_001) }], 'pick', null, 'CONC', BOARD))
    ).toContain('longer than 30000');
    const many = Array.from({ length: 21 }, () => ({ op: 'comment', key: 'CONC-5', text: 'x' }));
    expect(failure(() => checkOutbox(many, 'pick', null, 'CONC', BOARD))).toContain('more than 20');
    expect(failure(() => checkOutbox({ op: 'comment' }, 'pick', null, 'CONC', BOARD))).toContain('JSON list');
    expect(failure(() => checkOutbox(['x'], 'pick', null, 'CONC', BOARD))).toContain('not an object');
  });
  it('create needs a marker, a title and a text; pick files nothing', () => {
    const create = (over: Record<string, unknown>): unknown[] => [{ op: 'create', marker: 'finding-a', title: 'T', text: 'x', ...over }];
    expect(failure(() => checkOutbox(create({ marker: 'A b' }), 'review', 'CONC-5', 'CONC', BOARD))).toContain('marker');
    expect(failure(() => checkOutbox(create({ title: 'x'.repeat(201) }), 'review', 'CONC-5', 'CONC', BOARD))).toContain('title');
    expect(failure(() => checkOutbox(create({}), 'pick', null, 'CONC', BOARD))).toContain('pick does not create');
  });
  it('only review files a rest ticket, which release counts as the rest of a partial delivery', () => {
    const rest = [{ op: 'create', marker: 'rest-conc-5', title: 'Rest', text: 'x' }];
    expect(failure(() => checkOutbox(rest, 'build', 'CONC-5', 'CONC', BOARD))).toContain('only review files rest tickets');
    expect(checkOutbox(rest, 'review', 'CONC-5', 'CONC', BOARD)).toHaveLength(1);
  });
  it('the script before an agent clears the outbox files of the writers still to come', () => {
    const artifacts = mkdtempSync(join(tmpdir(), 'outbox-'));
    mkdirSync(join(artifacts, 'tracker', 'outbox'), { recursive: true });
    for (const writer of ['pick', 'build', 'review'] as const) writeFileSync(outboxFile(artifacts, writer), '[]');
    clearOutbox(artifacts, ['build', 'review']);
    expect(existsSync(outboxFile(artifacts, 'pick'))).toBe(true);
    expect(existsSync(outboxFile(artifacts, 'build'))).toBe(false);
    expect(existsSync(outboxFile(artifacts, 'review'))).toBe(false);
    clearOutbox(artifacts, ['review']);
  });
  it('no file or an empty file is no writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-'));
    expect(readOutbox(join(dir, 'pick.json'))).toBeUndefined();
    writeFileSync(join(dir, 'pick.json'), '  \n');
    expect(readOutbox(join(dir, 'pick.json'))).toBeUndefined();
    expect(checkOutbox(undefined, 'pick', null, 'CONC', BOARD)).toEqual([]);
    writeFileSync(join(dir, 'pick.json'), '[{"op":"comment","key":"CONC-5","text":"x"}]');
    expect(readOutbox(join(dir, 'pick.json'))).toEqual([{ op: 'comment', key: 'CONC-5', text: 'x' }]);
  });
  it('a write that would read as a claim or a loop result is refused, as the readers will see it', () => {
    for (const text of ['Loop claim: run x', '\n\nLoop claim: run x\nRoute: simple', '  Loop result: run x. Status: Staging.']) {
      expect(failure(() => checkOutbox([{ op: 'comment', key: 'CONC-5', text }], 'pick', null, 'CONC', BOARD))).toContain(
        'reserved'
      );
    }
    expect(
      failure(() => checkOutbox([{ op: 'comment', key: 'CONC-5', text: 'Loop review: sent back' }], 'pick', null, 'CONC', BOARD))
    ).toContain('reserved');
    expect(
      checkOutbox([{ op: 'comment', key: 'CONC-5', text: 'Loop review: sent back' }], 'review', 'CONC-5', 'CONC', BOARD)
    ).toHaveLength(1);
    expect(checkOutbox([{ op: 'comment', key: 'CONC-5', text: '```\nLoop claim: run x\n```' }], 'pick', null, 'CONC', BOARD)).toHaveLength(1);
  });
  it('an agent may not write what reads as Julian, as a run or as an applied default', () => {
    for (const text of ['Julian: ja, so machen', 'Erledigt.\nLauf: archon archon-loop abc', 'Vorgabe angewendet: Cache leeren']) {
      for (const writer of ['pick', 'build', 'review'] as const) {
        expect(failure(() => checkOutbox([{ op: 'comment', key: 'CONC-5', text }], writer, 'CONC-5', 'CONC', BOARD))).toContain(
          'reserved'
        );
      }
    }
  });
});

const ticket = (key: string, over: Partial<Ticket> = {}): Ticket => ({
  key,
  url: `https://example.atlassian.net/browse/${key}`,
  title: `Titel ${key}`,
  body: '',
  status: CFG.status.todo,
  labels: [],
  flagged: false,
  assignee: CFG.assignee,
  inOpenSprint: true,
  updated: 0,
  ...over,
});

describe('which tickets pick may write to', () => {
  it('Archon’s tickets in the sprint on To Do, and Archon’s on Review; never Julian’s, never one In Progress', () => {
    const tickets = [
      ticket('CONC-1'),
      ticket('CONC-2', { flagged: true }),
      ticket('CONC-3', { assignee: CFG.owner }),
      ticket('CONC-4', { status: CFG.status.progress, inOpenSprint: false }),
      ticket('CONC-5', { status: CFG.status.review, inOpenSprint: false }),
      ticket('CONC-6', { status: CFG.status.review, assignee: CFG.owner, inOpenSprint: false }),
      ticket('CONC-7', { inOpenSprint: false }),
      ticket('CONC-8', { assignee: null }),
    ];
    expect([...writableKeys(tickets, CFG)]).toEqual(['CONC-1', 'CONC-2', 'CONC-5']);
  });
});

describe('the write-time check of pick’s keys', () => {
  it('asks Jira for the same rule as the snapshot, for the snapshot’s keys only', () => {
    expect(writableJql(['CONC-5', 'CONC-6', 'VAULT-3', 'CONC-0'], CFG)).toBe(
      'key in (CONC-5,CONC-6) AND assignee = "acc-archon" AND (status = 10016 OR (status = 10015 AND sprint in openSprints()))'
    );
    expect(writableJql([], CFG)).toBeNull();
    expect(writableJql(['VAULT-3'], CFG)).toBeNull();
  });
});


const steps = (calls: Call[]): string[] => calls.map(call => `${call.method} ${call.path.split('?')[0]}`);

describe('outbox apply', () => {
  it('every comment, question, cancel and lift a lap writes ends with its run line', async () => {
    const { jira, calls } = fakeJira();
    const ops: Op[] = [
      { op: 'comment', key: 'CONC-5', text: 'Contract' },
      { op: 'ask', key: 'CONC-5', text: 'Welche Farbe?' },
      { op: 'unflag', key: 'CONC-6', text: 'Nur Buchhaltung' },
      { op: 'cancel', key: 'CONC-6', text: 'Doppelt zu CONC-5' },
    ];
    await applyOutbox(jira, ops, RUN, LINE, state());
    const comments = calls.filter(call => call.method === 'POST' && call.path.endsWith('/comment'));
    expect(comments).toHaveLength(4);
    for (const call of comments) expect(JSON.stringify(call.body)).toContain('Lauf: archon archon-loop run-1');
  });
  it('unflag: the flag off first, then the reason', async () => {
    const { jira, calls } = fakeJira();
    await applyOutbox(jira, [{ op: 'unflag', key: 'CONC-6', text: 'Nur Buchhaltung' }], RUN, LINE, state());
    expect(steps(calls)).toEqual(['PUT /rest/api/3/issue/CONC-6', 'POST /rest/api/3/issue/CONC-6/comment']);
    expect(calls[0]?.body).toEqual({ fields: { customfield_10021: null } });
  });
  it('cancel: Canceled first, then a comment that says why and from where', async () => {
    const { jira, calls } = fakeJira();
    await applyOutbox(jira, [{ op: 'cancel', key: 'CONC-6', text: 'Doppelt zu CONC-5' }], RUN, LINE, state());
    expect(steps(calls)).toEqual([
      'GET /rest/api/3/issue/CONC-6/transitions',
      'POST /rest/api/3/issue/CONC-6/transitions',
      'POST /rest/api/3/issue/CONC-6/comment',
    ]);
    expect(JSON.stringify(calls[2]?.body)).toContain('Doppelt zu CONC-5');
    expect(JSON.stringify(calls[2]?.body)).toContain(RUN);
    expect(calls[1]?.body).toEqual({ transition: { id: `t${CFG.status.canceled}` } });
  });
  it('cancel that cannot move the ticket leaves no comment saying it was canceled', async () => {
    const { jira, calls } = fakeJira({ failOnce: 'POST /rest/api/3/issue/CONC-6/transitions' });
    const run = applyOutbox(jira, [{ op: 'cancel', key: 'CONC-6', text: 'Doppelt' }], RUN, LINE, state(), { writer: 'pick', raw: 'cancel' });
    expect(run).rejects.toThrow('400');
    await run.catch(() => undefined);
    expect(steps(calls)).not.toContain('POST /rest/api/3/issue/CONC-6/comment');
  });
  it('a rerun after a failed write goes on behind the last one that worked', async () => {
    const { jira, calls } = fakeJira({ failOnce: 'PUT /rest/api/3/issue/CONC-6' });
    const dir = state();
    const ops: Op[] = [
      { op: 'comment', key: 'CONC-5', text: 'Erster' },
      { op: 'unflag', key: 'CONC-6', text: 'Nur Buchhaltung' },
    ];
    await applyOutbox(jira, ops, RUN, LINE, dir, { writer: 'pick', raw: ops }).catch(() => undefined);
    expect(steps(calls)).toEqual(['POST /rest/api/3/issue/CONC-5/comment', 'PUT /rest/api/3/issue/CONC-6']);
    calls.length = 0;
    await applyOutbox(jira, ops, RUN, LINE, dir, { writer: 'pick', raw: ops });
    expect(steps(calls)).toEqual(['PUT /rest/api/3/issue/CONC-6', 'POST /rest/api/3/issue/CONC-6/comment']);
    expect(existsSync(join(dir, 'progress-pick.json'))).toBe(false);
  });
  it('progress counts only for the same list: another list starts at its first entry', async () => {
    const { jira, calls } = fakeJira({ failOnce: 'PUT /rest/api/3/issue/CONC-6' });
    const dir = state();
    const first: Op[] = [{ op: 'comment', key: 'CONC-5', text: 'Erster' }, { op: 'unflag', key: 'CONC-6', text: 'x' }];
    await applyOutbox(jira, first, RUN, LINE, dir, { writer: 'pick', raw: first }).catch(() => undefined);
    expect(outboxProgress(dir, 'pick', first)).toBe(1);
    const other: Op[] = [{ op: 'comment', key: 'CONC-5', text: 'Anderer' }];
    expect(outboxProgress(dir, 'pick', other)).toBe(0);
    calls.length = 0;
    await applyOutbox(jira, other, RUN, LINE, dir, { writer: 'pick', raw: other });
    expect(steps(calls)).toEqual(['POST /rest/api/3/issue/CONC-5/comment']);
  });
  it('a cancel whose comment failed: the rerun passes the board check and only adds the comment', async () => {
    const { jira, calls } = fakeJira({ failOnce: 'POST /rest/api/3/issue/CONC-9/comment' });
    const dir = state();
    const list: Op[] = [
      { op: 'cancel', key: 'CONC-9', text: 'Doppelt' },
      { op: 'comment', key: 'CONC-5', text: 'Weiter' },
    ];
    await applyOutbox(jira, list, RUN, LINE, dir, { writer: 'pick', raw: list }).catch(() => undefined);
    // CONC-9 is Canceled now and off the board; entry 0 still counts as acted on.
    expect(outboxProgress(dir, 'pick', list)).toBe(1);
    expect(checkOutbox(list, 'pick', null, 'CONC', new Set(['CONC-5']), outboxProgress(dir, 'pick', list))).toHaveLength(2);
    calls.length = 0;
    await applyOutbox(jira, list, RUN, LINE, dir, { writer: 'pick', raw: list });
    expect(steps(calls)).toEqual(['POST /rest/api/3/issue/CONC-9/comment', 'POST /rest/api/3/issue/CONC-5/comment']);
  });
  it('a rerun does not ask the board again about entries it already wrote: a cancel took its ticket off it', () => {
    const list = [
      { op: 'cancel', key: 'CONC-9', text: 'Doppelt' },
      { op: 'comment', key: 'CONC-5', text: 'Weiter' },
    ];
    const board = new Set(['CONC-5']);
    expect(() => checkOutbox(list, 'pick', null, 'CONC', board)).toThrow('CONC-9 is not on this lap');
    expect(checkOutbox(list, 'pick', null, 'CONC', board, 1)).toHaveLength(2);
    expect(() => checkOutbox(list, 'pick', null, 'CONC', new Set(), 1)).toThrow('CONC-5 is not on this lap');
  });
  it('create: a new ticket with its marker, linked, on To Do, in the open sprint', async () => {
    const { jira, calls } = fakeJira({ sprint: 7 });
    const dir = state();
    const op: Op = { op: 'create', marker: 'rest-conc-5', title: 'Rest von CONC-5', text: 'Was fehlt' };
    expect(await applyOutbox(jira, [op], RUN, LINE, dir)).toEqual({ 'rest-conc-5': 'CONC-51' });
    expect(steps(calls)).toEqual([
      'POST /rest/api/3/search/jql',
      'GET /rest/api/3/project/CONC',
      'POST /rest/api/3/issue',
      'POST /rest/api/3/issue/CONC-51/remotelink',
      'GET /rest/api/3/issue/CONC-51',
      'GET /rest/api/3/issue/CONC-51/transitions',
      'POST /rest/api/3/issue/CONC-51/transitions',
      'GET /rest/agile/1.0/board/5/sprint',
      'POST /rest/agile/1.0/sprint/7/issue',
    ]);
    expect((calls[0]?.body as { jql: string }).jql).toBe('issue in issuesWithRemoteLinksByGlobalId("archon:CONC:rest-conc-5")');
    const fields = (calls[2]?.body as { fields: Record<string, unknown> }).fields;
    expect(fields.project).toEqual({ id: '10002' });
    expect(fields.assignee).toEqual({ accountId: CFG.assignee });
    expect(JSON.stringify(fields.description)).toContain('Loop finding: rest-conc-5');
    expect((calls[3]?.body as { globalId: string }).globalId).toBe('archon:CONC:rest-conc-5');
    expect(calls[8]?.body).toEqual({ issues: ['CONC-51'] });
    expect(readCreated(dir)).toEqual({ 'rest-conc-5': 'CONC-51' });
    expect(readFinished(dir)).toEqual({ 'rest-conc-5': 'CONC-51' });
  });
  it('create: a ticket filed but not set up is finished on the rerun, not filed again', async () => {
    const { jira, calls } = fakeJira({ sprint: 7, failOnce: 'POST /rest/api/3/issue/CONC-51/remotelink' });
    const dir = state();
    const op: Op = { op: 'create', marker: 'rest-conc-5', title: 'Rest von CONC-5', text: 'Was fehlt' };
    await applyOutbox(jira, [op], RUN, LINE, dir, { writer: 'review', raw: [op] }).catch(() => undefined);
    expect(readCreated(dir)).toEqual({ 'rest-conc-5': 'CONC-51' });
    expect(readFinished(dir)).toEqual({});
    calls.length = 0;
    expect(await applyOutbox(jira, [op], RUN, LINE, dir, { writer: 'review', raw: [op] })).toEqual({ 'rest-conc-5': 'CONC-51' });
    expect(steps(calls)).toEqual([
      'POST /rest/api/3/issue/CONC-51/remotelink',
      'GET /rest/api/3/issue/CONC-51',
      'GET /rest/api/3/issue/CONC-51/transitions',
      'POST /rest/api/3/issue/CONC-51/transitions',
      'GET /rest/agile/1.0/board/5/sprint',
      'POST /rest/agile/1.0/sprint/7/issue',
    ]);
    expect(readFinished(dir)).toEqual({ 'rest-conc-5': 'CONC-51' });
  });
  it('create: a ticket Jira already links to the marker is reused, not doubled', async () => {
    const { jira, calls } = fakeJira({ found: ['CONC-44'] });
    const op: Op = { op: 'create', marker: 'rest-conc-5', title: 'Rest', text: 'x' };
    expect(await applyOutbox(jira, [op], RUN, LINE, state())).toEqual({ 'rest-conc-5': 'CONC-44' });
    expect(steps(calls)).toEqual(['POST /rest/api/3/search/jql']);
  });
  it('create: a ticket this run already filed is reused before Jira’s lagging search is asked', async () => {
    const { jira, calls } = fakeJira();
    const dir = state();
    recordCreated(dir, 'rest-conc-5', 'CONC-51');
    recordFinished(dir, 'rest-conc-5', 'CONC-51');
    const op: Op = { op: 'create', marker: 'rest-conc-5', title: 'Rest', text: 'x' };
    expect(await applyOutbox(jira, [op], RUN, LINE, dir)).toEqual({ 'rest-conc-5': 'CONC-51' });
    expect(calls).toEqual([]);
  });
  it('create without an open sprint files the ticket outside a sprint', async () => {
    const { jira, calls } = fakeJira({ sprint: null });
    await applyOutbox(jira, [{ op: 'create', marker: 'finding-a', title: 'T', text: 'x' }], RUN, LINE, state());
    expect(steps(calls).at(-1)).toBe('GET /rest/agile/1.0/board/5/sprint');
  });
});

describe('what pick may touch right now', () => {
  it('only keys on the snapshot that Jira still puts in the loop’s hands', async () => {
    const dir = state();
    writeFileSync(join(dir, 'keys.json'), JSON.stringify(['CONC-5', 'CONC-6']));
    expect(snapshotKeys(dir)).toEqual(['CONC-5', 'CONC-6']);
    const { jira, calls } = fakeJira({ found: ['CONC-5'] });
    expect([...(await writableNow(jira, dir))]).toEqual(['CONC-5']);
    expect((calls[0]?.body as { jql: string }).jql).toStartWith('key in (CONC-5,CONC-6) AND assignee');
  });
  it('a ticket pick names that is not on the snapshot is never asked about, and is not writable', async () => {
    const dir = state();
    writeFileSync(join(dir, 'keys.json'), JSON.stringify(['CONC-5']));
    const { jira, calls } = fakeJira({ found: ['CONC-9'] });
    expect((await writableNow(jira, dir, 'CONC-9')).size).toBe(0);
    expect(calls).toEqual([]);
  });
  it('the lap’s target is asked about alone', async () => {
    const dir = state();
    writeFileSync(join(dir, 'keys.json'), JSON.stringify(['CONC-5', 'CONC-6']));
    const { jira, calls } = fakeJira({ found: ['CONC-6'] });
    expect((await writableNow(jira, dir, 'CONC-6')).has('CONC-6')).toBe(true);
    expect((calls[0]?.body as { jql: string }).jql).toStartWith('key in (CONC-6) AND');
  });
  it('no snapshot, nothing writable', async () => {
    const { jira } = fakeJira({ found: ['CONC-5'] });
    expect((await writableNow(jira, state(), 'CONC-5')).size).toBe(0);
  });
});

describe('a pull request pick wants the lap to continue', () => {
  const pr = (title: string, body = ''): { title: string; body: string } => ({ title, body });
  const none = new Map<string, string>();
  it('names its tickets by the key its title opens with and by Refs and Closes', () => {
    expect(prKeys(pr('CONC-5 Sync', 'Refs CONC-6\nCloses CONC-5'), 'CONC').sort()).toEqual(['CONC-5', 'CONC-6']);
    expect(prKeys(pr('Bump deps'), 'CONC')).toEqual([]);
  });
  it('reads a bracketed key in the title too', () => {
    expect(prKeys(pr('[CONC-5] Sync'), 'CONC')).toEqual(['CONC-5']);
  });
  it('must be a pull request of this repository, and not from a fork', () => {
    const repo = 'https://github.com/jhawli/concairge';
    expect(prAddressRefusal(`${repo}/pull/12`, repo, null)).toBeNull();
    expect(prAddressRefusal(`${repo}/pull/12`, repo, { title: 'CONC-5 x', body: '', isCrossRepository: false })).toBeNull();
    expect(prAddressRefusal('https://github.com/fremd/concairge/pull/1', repo, null)).toContain('not a pull request of');
    expect(prAddressRefusal('--repo', repo, null)).toContain('not a pull request of');
    expect(prAddressRefusal('https://github.com/jhawli/concairgeX/pull/1', repo, null)).toContain('not a pull request of');
    expect(prAddressRefusal(`${repo}/pull/12`, repo, { title: 'CONC-5 x', body: '', isCrossRepository: true })).toContain('fork');
  });
  it('is fine when it names the lap’s ticket and nothing that is someone else’s', () => {
    expect(prRefusal(pr('CONC-5 Sync', 'Refs CONC-5'), 'CONC-5', none, new Set(['CONC-5']), CFG)).toBeNull();
  });
  it('is refused when it does not name the lap’s ticket', () => {
    expect(prRefusal(pr('CONC-9 Anderes', 'Refs CONC-9'), 'CONC-5', none, new Set(['CONC-5', 'CONC-9']), CFG)).toContain(
      'does not name CONC-5'
    );
  });
  it('is refused when it also names a ticket a session works on', () => {
    const statuses = new Map([['CONC-9', CFG.status.progress]]);
    expect(prRefusal(pr('CONC-5 Sync', 'Refs CONC-5\nRefs CONC-9'), 'CONC-5', statuses, new Set(['CONC-5']), CFG)).toContain('CONC-9');
  });
  it('a ticket Jira does not report counts as open, so naming it is refused', () => {
    expect(prRefusal(pr('CONC-5 Sync', 'Refs CONC-9'), 'CONC-5', none, new Set(['CONC-5']), CFG)).toContain('CONC-9');
  });
  it('a delivered or canceled ticket it names binds nobody', () => {
    const statuses = new Map([['CONC-3', CFG.status.staging], ['CONC-4', CFG.status.canceled]]);
    expect(prRefusal(pr('CONC-5 Sync', 'Refs CONC-3, CONC-4'), 'CONC-5', statuses, new Set(['CONC-5']), CFG)).toBeNull();
  });
});

describe('the board snapshot for pick', () => {
  it('rank order, facts, why it waits, then every comment with its author', () => {
    const comments: TicketComment[] = [
      { id: 10018, body: 'Loop claim: run bbb', created: '2026-11-15T11:00:00.738+0100', createdAt: 0, author: 'acc-archon', url: '' },
      { id: 10019, body: 'Bitte so', created: '2026-11-15T12:00:00.000+0100', createdAt: 0, author: 'acc-julian', url: '' },
    ];
    const text = boardMarkdown(
      [
        ticket('CONC-5', { body: 'Beschreibung', labels: ['route:simple'] }),
        ticket('CONC-6', { flagged: true }),
        ticket('CONC-9', { status: CFG.status.review, inOpenSprint: false }),
      ],
      new Map([['CONC-5', comments]]),
      new Map([['CONC-6', 'needs-owner']]),
      CFG
    );
    expect(text.split('\n')[0]).toBe('# Board (Reihenfolge = Sprint-Reihenfolge, Rang)');
    expect(text).toContain(
      [
        '## CONC-5 Titel CONC-5',
        '',
        'URL: https://example.atlassian.net/browse/CONC-5',
        'Status: To Do',
        'Rang: 1',
        'Labels: route:simple',
        'Flagged: nein',
        'Schreibbar: ja',
        '',
        'Beschreibung',
        '',
        '### Kommentar 10018 (2026-11-15T11:00:00.738+0100, Archon)',
        '',
        'Loop claim: run bbb',
        '',
        '### Kommentar 10019 (2026-11-15T12:00:00.000+0100, Julian)',
        '',
        'Bitte so',
      ].join('\n')
    );
    expect(text).toContain('Rang: 2\nLabels: keine\nFlagged: ja\nSchreibbar: ja\nWartet: needs-owner');
    expect(text).toContain('## CONC-9 Titel CONC-9\n\nURL: https://example.atlassian.net/browse/CONC-9\nStatus: Review\nRang: nicht im Sprint');
    expect(
      boardMarkdown([ticket('CONC-7', { assignee: CFG.owner })], new Map(), new Map(), CFG)
    ).toContain('Schreibbar: nein');
  });
});
