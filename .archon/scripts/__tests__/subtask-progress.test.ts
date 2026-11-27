import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LapResult, type PrView, readPassed, recordPassed } from '../../workflows/sdlc/.shared/claims';
import { trackerConfig } from '../../workflows/sdlc/.shared/jira';
import { applyOutbox, checkOutbox, type Op } from '../../workflows/sdlc/.shared/outbox';
import { runLine } from '../../workflows/sdlc/.shared/questions';
import { releaseTicket } from '../../workflows/sdlc/.shared/release-ticket';
import { closeTasks, reopenBuilt } from '../../workflows/sdlc/.shared/subtickets';
import { type Call, CFG, type FakeTicket, fakeJira, state, STEPS, SUBTASK_TYPE, TYPES } from './jira-fixtures';
import { trackTempRoots } from './temp-roots';

const temp = trackTempRoots();

/**
 * CONC-176: the builder reports each task In Arbeit and Gebaut (`progress` in its outbox), only
 * the review finishes it, and a lap that merges nothing sends its unnamed built tasks back.
 */
const S = CFG.status;
const OFFEN = '10060';
const RUN = 'https://example.atlassian.net/browse/CONC-41';
const LINE = runLine('archon-loop', 'run-1');
const BOARD = new Set<string>();

/** A slice CONC-41 under feature CONC-40 with tasks 1–5 on the given statuses (CONC-42 … CONC-46). */
function slice(...statuses: string[]): Record<string, FakeTicket> {
  const keys = statuses.map((_, i) => `CONC-${42 + i}`);
  const tasks = Object.fromEntries(
    statuses.map((status, i): [string, FakeTicket] => [
      `CONC-${42 + i}`,
      { status, type: SUBTASK_TYPE, title: `Task ${i + 1}: Schritt ${i + 1}`, parent: 'CONC-41' },
    ])
  );
  return {
    'CONC-40': { status: '10055', type: '10000', children: ['CONC-41'] },
    'CONC-41': { status: S.progress, type: TYPES.slice, parent: 'CONC-40', sprint: 'active', children: keys },
    'CONC-90': { status: S.todo, type: TYPES.slice, parent: 'CONC-40' },
    ...tasks,
  };
}
const moves = (calls: Call[]): string[] =>
  calls
    .filter(call => call.method === 'POST' && call.path.endsWith('/transitions'))
    .map(call => `${call.path.split('/')[5]} ${(call.body as { transition: { id: string } }).transition.id.slice(1)}`);
const comments = (calls: Call[], key = 'CONC-41'): string[] =>
  calls.filter(call => call.method === 'POST' && call.path === `/rest/api/3/issue/${key}/comment`).map(call => JSON.stringify(call.body));
const progress = (task: unknown, step: unknown = 'gebaut'): Record<string, unknown> => ({ op: 'progress', task, state: step });
const statusOf = (book: ReadonlyMap<string, { status: string }>, key: string): string | undefined => book.get(key)?.status;

describe('checking a progress report (CONC-176 AK2, AK3)', () => {
  it('the builder reports a task in progress and built', () => {
    expect(checkOutbox([progress(3, 'arbeit'), progress(3, 'gebaut')], 'build', 'CONC-41', 'CONC', BOARD)).toEqual([
      { op: 'progress', task: 3, state: 'arbeit' },
      { op: 'progress', task: 3, state: 'gebaut' },
    ]);
  });
  it('from pick or review it is passed over with the reason, and the rest of the list still counts', () => {
    for (const writer of ['pick', 'review'] as const) {
      const key = writer === 'pick' ? 'CONC-6' : 'CONC-41';
      const ops = checkOutbox([progress(3), { op: 'comment', key, text: 'warum' }], writer, writer === 'pick' ? null : 'CONC-41', 'CONC', new Set(['CONC-6']));
      expect(ops[0]).toEqual({ op: 'passed', why: `Task 3: den Stand eines Tasks meldet nur der Bau, nicht ${writer}; übergangen.` });
      expect(ops[1]).toMatchObject({ op: 'comment', key });
    }
  });
  it('a report without a valid task number or step is passed over, not refused', () => {
    const bad = [progress(0), progress(1000), progress('3'), progress(2.5), { op: 'progress', state: 'gebaut' }];
    for (const entry of bad) {
      expect(checkOutbox([entry], 'build', 'CONC-41', 'CONC', BOARD)).toEqual([
        { op: 'passed', why: 'Eine Stand-Meldung ohne gültige Task-Nummer, übergangen.' },
      ]);
    }
    expect(checkOutbox([progress(1), progress(999)], 'build', 'CONC-41', 'CONC', BOARD)).toHaveLength(2);
    for (const step of ['fertig', 'Loop result: x', { a: 1 }, null]) {
      expect(checkOutbox([progress(3, step)], 'build', 'CONC-41', 'CONC', BOARD)).toEqual([
        { op: 'passed', why: 'Task 3: unbekannter Stand (nur arbeit oder gebaut), übergangen.' },
      ]);
    }
  });
  it('reports do not count toward the 20 writes, but have their own bound of 80', () => {
    const notes = Array.from({ length: 20 }, () => ({ op: 'comment', key: 'CONC-41', text: 'x' }));
    const reports = Array.from({ length: 80 }, (_, i) => progress((i % 40) + 1));
    expect(checkOutbox([...notes, ...reports], 'build', 'CONC-41', 'CONC', BOARD)).toHaveLength(100);
    expect(() => checkOutbox([...notes, notes[0]], 'build', 'CONC-41', 'CONC', BOARD)).toThrow('more than 20 writes');
    expect(() => checkOutbox([...reports, progress(1)], 'build', 'CONC-41', 'CONC', BOARD)).toThrow('more than 80 progress reports');
  });
});

describe('applying a progress report (CONC-176 AK2–AK4)', () => {
  const apply = async (
    tickets: Record<string, FakeTicket>,
    ops: readonly Op[],
    opts: { steps?: boolean; failOnce?: string; target?: string } = {}
  ): Promise<{ passed: string[]; calls: Call[]; book: ReadonlyMap<string, { status: string }> }> => {
    const { jira, calls, book } = fakeJira({ tickets, steps: opts.steps ?? true, failOnce: opts.failOnce });
    const passed: string[] = [];
    await applyOutbox(jira, ops, RUN, LINE, state(), undefined, opts.target ?? 'CONC-41', [], passed);
    return { passed, calls, book };
  };

  it('gebaut on an open task goes through In Arbeit to Gebaut (AK2)', async () => {
    const { passed, calls, book } = await apply(slice(OFFEN, OFFEN, OFFEN), [{ op: 'progress', task: 3, state: 'gebaut' }]);
    expect(moves(calls)).toEqual([`CONC-44 ${STEPS.taskProgress}`, `CONC-44 ${STEPS.taskBuilt}`]);
    expect(statusOf(book, 'CONC-44')).toBe(STEPS.taskBuilt);
    expect([statusOf(book, 'CONC-42'), statusOf(book, 'CONC-43')]).toEqual([OFFEN, OFFEN]);
    expect(passed).toEqual([]);
  });
  it('arbeit then gebaut in one list: one move each', async () => {
    const ops: Op[] = [
      { op: 'progress', task: 1, state: 'arbeit' },
      { op: 'progress', task: 1, state: 'gebaut' },
      { op: 'progress', task: 2, state: 'arbeit' },
    ];
    const { calls, book } = await apply(slice(OFFEN, OFFEN), ops);
    expect(moves(calls)).toEqual([`CONC-42 ${STEPS.taskProgress}`, `CONC-42 ${STEPS.taskBuilt}`, `CONC-43 ${STEPS.taskProgress}`]);
    expect([statusOf(book, 'CONC-42'), statusOf(book, 'CONC-43')]).toEqual([STEPS.taskBuilt, STEPS.taskProgress]);
  });
  it('a task already on its step stays as it is, without a note (AK4)', async () => {
    const ops: Op[] = [
      { op: 'progress', task: 1, state: 'gebaut' },
      { op: 'progress', task: 2, state: 'arbeit' },
    ];
    const { passed, calls } = await apply(slice(STEPS.taskBuilt, STEPS.taskProgress), ops);
    expect(moves(calls)).toEqual([]);
    expect(passed).toEqual([]);
  });
  it('the same list applied twice moves each task once (AK4, a rerun of tracker-write)', async () => {
    const { jira, calls, book } = fakeJira({ tickets: slice(OFFEN, OFFEN), steps: true });
    const ops: Op[] = [{ op: 'progress', task: 2, state: 'gebaut' }];
    const dir = state();
    const raw = [progress(2)];
    await applyOutbox(jira, ops, RUN, LINE, dir, { writer: 'build', raw }, 'CONC-41');
    await applyOutbox(jira, ops, RUN, LINE, dir, { writer: 'build', raw }, 'CONC-41');
    expect(moves(calls)).toEqual([`CONC-43 ${STEPS.taskProgress}`, `CONC-43 ${STEPS.taskBuilt}`]);
    expect(statusOf(book, 'CONC-43')).toBe(STEPS.taskBuilt);
  });
  it('a built task taken up again goes back to In Arbeit in one step', async () => {
    const { calls } = await apply(slice(STEPS.taskBuilt), [{ op: 'progress', task: 1, state: 'arbeit' }]);
    expect(moves(calls)).toEqual([`CONC-42 ${STEPS.taskProgress}`]);
  });
  it('an unknown number is passed over with the reason, and the other entries still apply (AK3)', async () => {
    const ops: Op[] = [
      { op: 'progress', task: 99, state: 'gebaut' },
      { op: 'comment', key: 'CONC-41', text: 'Zwischenstand' },
      { op: 'progress', task: 1, state: 'arbeit' },
    ];
    const { passed, calls } = await apply(slice(OFFEN), ops);
    expect(passed).toEqual(['Task 99 gibt es an der Scheibe nicht, übergangen.']);
    expect(comments(calls)).toHaveLength(1);
    expect(moves(calls)).toEqual([`CONC-42 ${STEPS.taskProgress}`]);
  });
  it('a task on Erledigt or Entfällt is not moved back (AK3)', async () => {
    const ops: Op[] = [
      { op: 'progress', task: 1, state: 'arbeit' },
      { op: 'progress', task: 2, state: 'gebaut' },
    ];
    const { passed, calls } = await apply(slice(S.taskDone, S.taskDropped), ops);
    expect(moves(calls)).toEqual([]);
    expect(passed).toEqual(['Task 1 ist schon erledigt, übergangen.', 'Task 2 entfällt schon, übergangen.']);
  });
  it('a passed entry from the check is named as well', async () => {
    const { passed } = await apply(slice(OFFEN), [{ op: 'passed', why: 'Eine Stand-Meldung ohne gültige Task-Nummer, übergangen.' }]);
    expect(passed).toEqual(['Eine Stand-Meldung ohne gültige Task-Nummer, übergangen.']);
  });
  it('a tracker without the steps passes every report over and moves nothing', async () => {
    const { passed, calls } = await apply(slice(OFFEN), [{ op: 'progress', task: 1, state: 'gebaut' }], { steps: false });
    expect(moves(calls)).toEqual([]);
    expect(passed).toEqual(['Task 1: der Tracker kennt die Stände In Arbeit und Gebaut nicht (taskProgress, taskBuilt), übergangen.']);
  });
  it('a lap on a bug has no tasks: the report is passed over', async () => {
    const tickets: Record<string, FakeTicket> = { 'CONC-50': { status: S.progress, type: TYPES.bug, sprint: 'active' } };
    const { passed, calls } = await apply(tickets, [{ op: 'progress', task: 1, state: 'gebaut' }], { target: 'CONC-50' });
    expect(moves(calls)).toEqual([]);
    expect(passed).toEqual(['Task 1: dieser Lauf hat keine Scheibe mit Tasks, übergangen.']);
  });
  it('a rerun after a later write failed moves no task back and forth (AK4)', async () => {
    const { jira, calls, book } = fakeJira({
      tickets: slice(OFFEN, OFFEN),
      steps: true,
      failOnce: 'POST /rest/api/3/issue/CONC-41/comment',
    });
    const ops: Op[] = [
      { op: 'progress', task: 1, state: 'arbeit' },
      { op: 'progress', task: 1, state: 'gebaut' },
      { op: 'comment', key: 'CONC-41', text: 'Zwischenstand' },
    ];
    const dir = state();
    const raw = [progress(1, 'arbeit'), progress(1), { op: 'comment', key: 'CONC-41', text: 'Zwischenstand' }];
    const first: string[] = [];
    const failed = await applyOutbox(jira, ops, RUN, LINE, dir, { writer: 'build', raw }, 'CONC-41', [], first).then(
      () => false,
      () => true
    );
    expect(failed).toBe(true);
    expect(statusOf(book, 'CONC-42')).toBe(STEPS.taskBuilt);
    await applyOutbox(jira, ops, RUN, LINE, dir, { writer: 'build', raw }, 'CONC-41');
    expect(moves(calls)).toEqual([`CONC-42 ${STEPS.taskProgress}`, `CONC-42 ${STEPS.taskBuilt}`]);
    expect(statusOf(book, 'CONC-42')).toBe(STEPS.taskBuilt);
    expect(comments(calls)).toHaveLength(2);
  });
  it('a move Jira refuses is named, and the next report still moves its task', async () => {
    const ops: Op[] = [
      { op: 'progress', task: 1, state: 'arbeit' },
      { op: 'progress', task: 2, state: 'arbeit' },
    ];
    const { passed, book } = await apply(slice(OFFEN, OFFEN), ops, { failOnce: 'POST /rest/api/3/issue/CONC-42/transitions' });
    expect(passed).toHaveLength(1);
    expect(passed[0]).toStartWith('Task 1 (CONC-42): Jira lässt den Wechsel auf In Arbeit nicht zu (');
    expect([statusOf(book, 'CONC-42'), statusOf(book, 'CONC-43')]).toEqual([OFFEN, STEPS.taskProgress]);
  });
});

describe('the review settles built tasks (CONC-176 AK5, Julian 2026-11-27)', () => {
  it('a whole delivery finishes every open task, built or not', async () => {
    const { jira, book } = fakeJira({ tickets: slice(STEPS.taskBuilt, STEPS.taskProgress, OFFEN), steps: true });
    await closeTasks(jira, 'CONC-41', { delivers: 'all', tasks: [1] }, null);
    expect(['CONC-42', 'CONC-43', 'CONC-44'].map(key => statusOf(book, key))).toEqual([S.taskDone, S.taskDone, S.taskDone]);
  });
  it('a partial one finishes the named tasks from any open step and moves the others to the rest', async () => {
    const { jira, book } = fakeJira({ tickets: slice(STEPS.taskBuilt, STEPS.taskProgress, STEPS.taskBuilt, OFFEN), steps: true });
    await closeTasks(jira, 'CONC-41', { delivers: 'part', tasks: [1, 2] }, 'CONC-90');
    expect(['CONC-42', 'CONC-43', 'CONC-44', 'CONC-45'].map(key => statusOf(book, key))).toEqual([
      S.taskDone, S.taskDone, S.taskDropped, S.taskDropped,
    ]);
  });
  it('nothing delivered: built tasks the review did not name go back to In Arbeit, named ones stay built', async () => {
    const { jira, calls, book } = fakeJira({
      tickets: slice(STEPS.taskBuilt, STEPS.taskBuilt, STEPS.taskProgress, OFFEN, S.taskDone),
      steps: true,
    });
    expect(await reopenBuilt(jira, 'CONC-41', [1])).toEqual(['Zurück auf In Arbeit, gebaut, aber nicht in „Tasks done“: CONC-43.']);
    expect(moves(calls)).toEqual([`CONC-43 ${STEPS.taskProgress}`]);
    expect(['CONC-42', 'CONC-43', 'CONC-44', 'CONC-45', 'CONC-46'].map(key => statusOf(book, key))).toEqual([
      STEPS.taskBuilt, STEPS.taskProgress, STEPS.taskProgress, OFFEN, S.taskDone,
    ]);
  });
  it('no built task, or a tracker without the steps: nothing moves and nothing is said', async () => {
    const none = fakeJira({ tickets: slice(OFFEN, STEPS.taskProgress), steps: true });
    expect(await reopenBuilt(none.jira, 'CONC-41', [])).toEqual([]);
    expect(moves(none.calls)).toEqual([]);
    const without = fakeJira({ tickets: slice(STEPS.taskBuilt) });
    expect(await reopenBuilt(without.jira, 'CONC-41', [])).toEqual([]);
    expect(without.calls).toEqual([]);
  });
  it('a move back Jira refuses is named, the other built tasks still go back', async () => {
    const { jira, book } = fakeJira({
      tickets: slice(STEPS.taskBuilt, STEPS.taskBuilt),
      steps: true,
      failOnce: 'POST /rest/api/3/issue/CONC-42/transitions',
    });
    const notes = await reopenBuilt(jira, 'CONC-41', []);
    expect(notes[0]).toBe('Zurück auf In Arbeit, gebaut, aber nicht in „Tasks done“: CONC-43.');
    expect(notes[1]).toStartWith('Bleibt auf Gebaut, Jira lässt In Arbeit nicht zu: CONC-42 (');
    expect([statusOf(book, 'CONC-42'), statusOf(book, 'CONC-43')]).toEqual([STEPS.taskBuilt, STEPS.taskProgress]);
  });
});

describe('release names the built tasks and the passed reports (CONC-176)', () => {
  const PR = 'https://github.com/o/r/pull/9';
  const OPEN: PrView = { state: 'OPEN', mergedAt: null, title: 'CONC-41 Liste', body: '' };
  const MERGED: PrView = { state: 'MERGED', mergedAt: '2026-11-20T10:05:00Z', title: 'CONC-41 Liste', body: '' };
  const lapOf = (over: Partial<LapResult>): LapResult => ({
    pr: PR, landed: '', deployed: '', delivers: '', tasks: [], reviewed: '', created: {}, ...over,
  });

  it('sent back: the unnamed built task goes back to In Arbeit, the result says so and names the passed report', async () => {
    const { jira, calls, book } = fakeJira({ tickets: slice(STEPS.taskBuilt, STEPS.taskBuilt), steps: true });
    const lap = lapOf({ reviewed: 'sent-back', delivers: 'none', tasks: [1] });
    const passed = ['Task 99 gibt es an der Scheibe nicht, übergangen.'];
    const result = await releaseTicket(jira, 'CONC-41', { recorded: lap, lap, view: OPEN }, 'run-1', LINE, [], passed);
    expect([statusOf(book, 'CONC-42'), statusOf(book, 'CONC-43')]).toEqual([STEPS.taskBuilt, STEPS.taskProgress]);
    expect(result.notes).toEqual(['Zurück auf In Arbeit, gebaut, aber nicht in „Tasks done“: CONC-43.']);
    const comment = comments(calls)[0] ?? '';
    expect(comment).toContain('Zurück auf In Arbeit, gebaut, aber nicht in „Tasks done“: CONC-43.');
    expect(comment).toContain('Task 99 gibt es an der Scheibe nicht, übergangen.');
  });
  it('names at most ten passed reports, and how many more there were', async () => {
    const { jira, calls } = fakeJira({ tickets: slice(OFFEN), steps: true });
    const lap = lapOf({ reviewed: 'sent-back', delivers: 'none' });
    const passed = Array.from({ length: 12 }, (_, i) => `Task ${i + 50} gibt es an der Scheibe nicht, übergangen.`);
    await releaseTicket(jira, 'CONC-41', { recorded: lap, lap, view: OPEN }, 'run-1', LINE, [], passed);
    const comment = comments(calls)[0] ?? '';
    expect(comment).toContain('Task 59 gibt es');
    expect(comment).not.toContain('Task 60 gibt es');
    expect(comment).toContain('… und 2 weitere übergangene Meldungen.');
  });
  it('merged as a whole: every built task is done, none goes back', async () => {
    const { jira, book } = fakeJira({ tickets: slice(STEPS.taskBuilt, STEPS.taskBuilt), steps: true });
    const lap = lapOf({ reviewed: 'merge', landed: 'merged', deployed: 'true', delivers: 'all', tasks: [1] });
    expect((await releaseTicket(jira, 'CONC-41', { recorded: lap, lap, view: MERGED }, 'run-1', LINE, [])).name).toBe('Staging');
    expect([statusOf(book, 'CONC-42'), statusOf(book, 'CONC-43')]).toEqual([S.taskDone, S.taskDone]);
  });
  it('a merge GitHub does not confirm sends no built task back, also from the queue', async () => {
    for (const status of [S.progress, S.todo]) {
      const tickets = slice(STEPS.taskBuilt, STEPS.taskBuilt);
      tickets['CONC-41'] = { ...tickets['CONC-41'], status } as FakeTicket;
      const { jira, book } = fakeJira({ tickets, steps: true });
      const recorded = lapOf({ reviewed: 'merge', landed: 'merged', deployed: 'true', delivers: 'all', tasks: [1] });
      const lap = { ...recorded, landed: '' };
      await releaseTicket(jira, 'CONC-41', { recorded, lap, view: OPEN }, 'run-1', LINE, []);
      expect(statusOf(book, 'CONC-43')).not.toBe(STEPS.taskProgress);
    }
  });
  it('merged in part without a rest: the slice stays, but its built tasks are not sent back', async () => {
    const { jira, book } = fakeJira({ tickets: slice(STEPS.taskBuilt, STEPS.taskBuilt), steps: true });
    const lap = lapOf({ reviewed: 'merge', landed: 'merged', deployed: 'true', delivers: 'part', tasks: [1] });
    expect((await releaseTicket(jira, 'CONC-41', { recorded: lap, lap, view: MERGED }, 'run-1', LINE, [])).name).toBe('Entwicklung');
    expect([statusOf(book, 'CONC-42'), statusOf(book, 'CONC-43')]).toEqual([S.taskDone, STEPS.taskBuilt]);
  });
});

describe('the passed reports kept for release (CONC-176 AK3)', () => {
  it('each writer’s list replaces its last one; read in loop order, each reason once', () => {
    const dir = temp(mkdtempSync(join(tmpdir(), 'passed-')));
    expect(readPassed(dir)).toEqual([]);
    recordPassed(dir, 'build', ['Task 9 gibt es an der Scheibe nicht, übergangen.']);
    recordPassed(dir, 'build', ['Task 9 gibt es an der Scheibe nicht, übergangen.', 'Task 1 ist schon erledigt, übergangen.']);
    recordPassed(dir, 'review', ['Task 9 gibt es an der Scheibe nicht, übergangen.']);
    recordPassed(dir, 'pick', ['Task 2: den Stand eines Tasks meldet nur der Bau, nicht pick; übergangen.']);
    expect(readPassed(dir)).toEqual([
      'Task 2: den Stand eines Tasks meldet nur der Bau, nicht pick; übergangen.',
      'Task 9 gibt es an der Scheibe nicht, übergangen.',
      'Task 1 ist schon erledigt, übergangen.',
    ]);
    recordPassed(dir, 'build', []);
    expect(readPassed(dir)).toHaveLength(2);
  });
});

describe('the task steps in the tracker config (CONC-176 AK1)', () => {
  const repoWith = (config: unknown): string => {
    const root = temp(mkdtempSync(join(tmpdir(), 'trk-')));
    mkdirSync(join(root, '.archon'));
    writeFileSync(join(root, '.archon/tracker.json'), JSON.stringify(config));
    return root;
  };
  it('read when given, absent without them, refused when not ids', () => {
    expect(trackerConfig(repoWith({ ...CFG, status: { ...CFG.status, ...STEPS } }))?.status).toMatchObject(STEPS);
    const without = trackerConfig(repoWith(CFG))?.status;
    expect(without?.taskProgress).toBeUndefined();
    expect(without?.taskBuilt).toBeUndefined();
    expect(() => trackerConfig(repoWith({ ...CFG, status: { ...CFG.status, taskBuilt: 'Gebaut' } }))).toThrow(
      'status taskBuilt must be numeric ids when given'
    );
  });
});
