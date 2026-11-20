import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClaimClient,
  type LapResult,
  type PrView,
  claimStart,
  confirmMerge,
  unnamedPrAsk,
  deadClaims,
  editComment,
  finalStatus,
  itemMarkdown,
  liveClaims,
  postComment,
  pruneRunStates,
  readClaimedAt,
  readCreated,
  readLap,
  recordClaim,
  recordCreated,
  recordLanding,
  recordLap,
  addToLap,
  runState,
  restMarker,
  statusName,
  targetRefusal,
  workItem,
} from '../../workflows/sdlc/.shared/claims';
import type { Ticket, TicketComment, TrackerConfig } from '../../workflows/sdlc/.shared/jira';
import { STATUS, TYPES } from './jira-fixtures';

const CFG: TrackerConfig = {
  kind: 'jira',
  site: 'https://example.atlassian.net',
  project: 'CONC',
  board: 5,
  keychain: 'none',
  assignee: 'acc-archon',
  owner: 'acc-julian',
  status: STATUS,
  types: TYPES,
  flagField: 'customfield_10021',
  flagOn: '10019',
  sprintField: 'customfield_10020',
};
const S = CFG.status;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const TICKET = { kind: 'ticket', key: 'CONC-5' } as const;

/** Comments in memory. Ids are handed out from `ids` when given, so a test can make them disagree with creation order. */
class FakeJira implements ClaimClient {
  rows: TicketComment[] = [];
  edits: [number, string][] = [];
  private next = 10000;
  constructor(private readonly ids: number[] = []) {}
  add(id: number, body: string, created: string): void {
    this.rows.push({ id, body, created, createdAt: Date.parse(created), author: 'acc-archon', url: '' });
  }
  async comments(): Promise<TicketComment[]> {
    return [...this.rows].sort((a, b) => a.id - b.id);
  }
  async comment(_key: string, text: string): Promise<number> {
    const id = this.ids.shift() ?? (this.next += 1);
    this.add(id, text, new Date(NOW).toISOString());
    return id;
  }
  async editComment(_key: string, id: number, text: string): Promise<void> {
    this.edits.push([id, text]);
    const row = this.rows.find(r => r.id === id);
    if (row !== undefined) this.rows[this.rows.indexOf(row)] = { ...row, body: text };
  }
}

const lap = (over: Partial<LapResult> = {}): LapResult => ({
  pr: '',
  landed: '',
  deployed: '',
  delivers: '',
  tasks: [],
  reviewed: '',
  created: {},
  ...over,
});

describe('work items', () => {
  it('a Jira ticket URL is a ticket', () => {
    expect(workItem('https://example.atlassian.net/browse/CONC-5', CFG)).toEqual(TICKET);
  });
  it('a pull request is not a work item: the loop continues it through the ticket it names', () => {
    expect(() => workItem('https://github.com/o/r/pull/9', CFG)).toThrow('not a work item URL');
  });
  it('claim refuses a target that is not a ticket, before it posts anything', () => {
    expect(targetRefusal('https://example.atlassian.net/browse/CONC-5', '', CFG)).toBeNull();
    expect(targetRefusal('https://example.atlassian.net/browse/CONC-5', 'https://github.com/o/r/pull/9', CFG)).toBeNull();
    expect(targetRefusal('https://github.com/o/r/pull/9', 'https://github.com/o/r/pull/9', CFG)).toContain('not a CONC ticket');
    expect(targetRefusal('', 'https://github.com/o/r/pull/9', CFG)).toContain('not a CONC ticket');
    expect(targetRefusal('https://github.com/o/r/issues/9', '', CFG)).toContain('not a CONC ticket');
  });
  it('eine GitHub-Issue-Adresse ist kein Arbeitsstück', () => {
    expect(() => workItem('https://github.com/o/r/issues/9', CFG)).toThrow('not a work item URL');
  });
  it('a ticket of another site or project is not a work item', () => {
    expect(() => workItem('https://other.atlassian.net/browse/CONC-5', CFG)).toThrow('not a work item');
    expect(() => workItem('https://example.atlassian.net/browse/VAULT-3', CFG)).toThrow('not a work item');
  });
});

describe('claims on a ticket', () => {
  it('the lowest id holds the ticket, whatever order Jira created them in', async () => {
    const jira = new FakeJira();
    jira.add(10019, 'Loop claim: run aaa\n\nRoute: simple', '2026-11-15T11:00:00.721+0100');
    jira.add(10018, 'Loop claim: run bbb\n\nRoute: simple', '2026-11-15T11:00:00.738+0100');
    jira.add(10017, 'Just a comment', '2026-11-15T10:00:00.000+0100');
    const claims = await liveClaims(TICKET, 6, NOW, jira);
    expect(claims.map(c => [c.id, c.run])).toEqual([
      [10018, 'bbb'],
      [10019, 'aaa'],
    ]);
  });
  it('a claim older than the expiry does not count', async () => {
    const jira = new FakeJira();
    jira.add(10010, 'Loop claim: run old', '2026-11-15T04:00:00.000+0100');
    jira.add(10011, 'Loop claim: run new', '2026-11-15T12:00:00.000+0100');
    expect((await liveClaims(TICKET, 6, NOW, jira)).map(c => c.run)).toEqual(['new']);
  });
  it('two runs claiming at once: both read the same holder back', async () => {
    const jira = new FakeJira([10031, 10030]);
    await postComment(TICKET, 'Loop claim: run first', jira);
    await postComment(TICKET, 'Loop claim: run second', jira);
    const [holder] = await liveClaims(TICKET, 6, NOW, jira);
    expect(holder?.run).toBe('second');
  });
  it('edits go to the ticket', async () => {
    const jira = new FakeJira();
    const id = await postComment(TICKET, 'Loop claim: run x', jira);
    await editComment(TICKET, id, 'Loop claim withdrawn: run x', jira);
    expect(jira.edits).toEqual([[id, 'Loop claim withdrawn: run x']]);
    expect(await liveClaims(TICKET, 6, NOW, jira)).toEqual([]);
  });
});

describe('claims no run stands behind', () => {
  const HOUR = 3_600_000;
  const row = (id: number, body: string, at = NOW - HOUR): { id: number; body: string; createdAt: number } => ({
    id,
    body,
    createdAt: at,
  });
  /** The ticket went to In Progress 20 s after the claim, as a holding run does it. */
  const STARTED = NOW - HOUR + 20_000;
  it('a claim of a run the scheduler names as ended is dead', () => {
    const rows = [row(1, 'Loop claim: run aaa\n\nRoute: simple')];
    expect(deadClaims(rows, 6, NOW, new Set(['aaa']), STARTED).map(c => c.run)).toEqual(['aaa']);
  });
  it('a claim past the expiry is dead', () => {
    const at = NOW - 7 * HOUR;
    expect(deadClaims([row(1, 'Loop claim: run aaa', at)], 6, NOW, new Set(), at + 20_000)).toHaveLength(1);
  });
  it('one claim that may still be worked on keeps every claim on the ticket', () => {
    const rows = [row(1, 'Loop claim: run aaa'), row(2, 'Loop claim: run bbb')];
    expect(deadClaims(rows, 6, NOW, new Set(['aaa']), STARTED)).toEqual([]);
  });
  it('a ticket without a claim is a session’s: nothing to recover', () => {
    const rows = [row(1, 'Loop claim released: run aaa ended.'), row(2, 'Ich arbeite daran')];
    expect(deadClaims(rows, 6, NOW, new Set(['aaa']), STARTED)).toEqual([]);
  });
  it('a stale claim on a ticket a session started hours later is not the loop’s to take back', () => {
    const rows = [row(1, 'Loop claim: run aaa', NOW - 9 * HOUR)];
    expect(deadClaims(rows, 6, NOW, new Set(), NOW - HOUR)).toEqual([]);
  });
  it('the claim sits at most ten minutes before the start, and not after it', () => {
    const rows = [row(1, 'Loop claim: run aaa')];
    const at = NOW - HOUR;
    expect(deadClaims(rows, 6, NOW, new Set(['aaa']), at + 10 * 60_000)).toHaveLength(1);
    expect(deadClaims(rows, 6, NOW, new Set(['aaa']), at + 10 * 60_000 + 1)).toEqual([]);
    expect(deadClaims(rows, 6, NOW, new Set(['aaa']), at - 5000)).toHaveLength(1);
    expect(deadClaims(rows, 6, NOW, new Set(['aaa']), at - 60_000)).toEqual([]);
  });
  it('without the time the ticket was started nothing is taken back', () => {
    expect(deadClaims([row(1, 'Loop claim: run aaa')], 6, NOW, new Set(['aaa']), Number.NaN)).toEqual([]);
  });
  it('the newest claim comes first: its run is the one that held the ticket', () => {
    const rows = [row(1, 'Loop claim: run aaa', NOW - HOUR - 60_000), row(2, 'Loop claim: run bbb')];
    expect(deadClaims(rows, 6, NOW, new Set(['aaa', 'bbb']), STARTED).map(c => c.run)).toEqual(['bbb', 'aaa']);
  });
});

describe('when this run claimed its ticket', () => {
  it('is kept for release, and NaN when the run recorded none', () => {
    const dir = runState(mkdtempSync(join(tmpdir(), 'state-')), 'run-1');
    expect(readClaimedAt(dir)).toBeNaN();
    recordClaim(dir, NOW);
    expect(readClaimedAt(dir)).toBe(NOW);
  });
  it('a merge is not confirmed without a claim time (NaN), the safe side', () => {
    const view = { state: 'MERGED', mergedAt: '2026-11-15T12:30:00Z', title: 'CONC-5 x', body: 'Refs CONC-5' };
    expect(confirmMerge(lap({ landed: 'merged' }), view, 'CONC-5', Number.NaN, 'CONC').landed).toBe('');
    expect(confirmMerge(lap({ landed: 'merged' }), view, 'CONC-5', NOW, 'CONC').landed).toBe('merged');
  });
});

describe('status after the lap', () => {
  const merged = { pr: 'https://github.com/o/r/pull/9', landed: 'merged', deployed: 'true' };
  it('leaves a ticket alone that is not in progress or on Review (the pick canceled it)', () => {
    expect(finalStatus('CONC-5', S.canceled, lap(merged), S, S.todo)).toEqual({ status: null, ask: null });
    expect(finalStatus('CONC-5', S.todo, lap({ pr: merged.pr }), S, S.todo)).toEqual({ status: null, ask: null });
  });
  it('a merge delivers a ticket on its queue too (a lap gave it back with its pull request)', () => {
    expect(finalStatus('CONC-5', S.todo, lap({ ...merged, delivers: 'all' }), S, S.todo)).toEqual({ status: S.staging, ask: null });
    expect(finalStatus('CONC-5', S.todoBug, lap({ ...merged, delivers: 'all' }), S, S.todoBug).status).toBe(S.staging);
    expect(finalStatus('CONC-5', '10053', lap({ ...merged, delivers: 'all' }), S, S.todo).status).toBeNull();
  });
  it('merged, rollout not confirmed: Review and a question', () => {
    for (const deployed of ['', 'false']) {
      const result = finalStatus('CONC-5', S.progress, lap({ ...merged, deployed }), S, S.todo);
      expect(result.status).toBe(S.review);
      expect(result.ask).toContain('Staging-Rollout ist nicht bestätigt');
    }
  });
  it('merged, deployed, all delivered: Staging', () => {
    expect(finalStatus('CONC-5', S.progress, lap({ ...merged, delivers: 'all' }), S, S.todo)).toEqual({ status: S.staging, ask: null });
  });
  it('merged, deployed, part delivered with a rest ticket: Staging', () => {
    const created = { [restMarker('CONC-5')]: 'CONC-40' };
    expect(finalStatus('CONC-5', S.review, lap({ ...merged, delivers: 'part', created }), S, S.todo)).toEqual({ status: S.staging, ask: null });
  });
  it('merged, deployed, part delivered without a rest ticket: Staging and a question', () => {
    const result = finalStatus('CONC-5', S.progress, lap({ ...merged, delivers: 'part' }), S, S.todo);
    expect(result.status).toBe(S.staging);
    expect(result.ask).toContain('Rest-Ticket');
  });
  it('merged and rolled out goes to Staging whatever tasks the slice has (VAULT-28: no waiting)', () => {
    const created = { [restMarker('CONC-5')]: 'CONC-51' };
    expect(finalStatus('CONC-5', S.progress, lap({ ...merged, delivers: 'part', created }), S, S.todo)).toEqual({ status: '10017', ask: null });
  });
  it('an open pull request the review approved for a person to merge: Review', () => {
    expect(finalStatus('CONC-5', S.progress, lap({ pr: merged.pr, reviewed: 'approved' }), S, S.todo)).toEqual({ status: S.review, ask: null });
  });
  it('a merge the review ordered that land did not confirm (land broke, GitHub doubts it): Review', () => {
    expect(finalStatus('CONC-5', S.progress, lap({ pr: merged.pr, reviewed: 'merge' }), S, S.todo)).toEqual({ status: S.review, ask: null });
  });
  it('any other open pull request goes back to the queue with it, and the next lap continues it (Julian 2026-11-20)', () => {
    for (const reviewed of ['sent-back', 'needs-owner', 'nothing', '']) {
      expect(finalStatus('CONC-5', S.progress, lap({ pr: merged.pr, reviewed }), S, S.todo)).toEqual({ status: S.todo, ask: null });
      expect(finalStatus('CONC-5', S.review, lap({ pr: merged.pr, reviewed }), S, S.todoBug)).toEqual({ status: S.todoBug, ask: null });
    }
    // The merge gate refused it: the pull request needs more work, not a person's merge.
    expect(finalStatus('CONC-5', S.progress, lap({ pr: merged.pr, reviewed: 'merge', landed: 'refused' }), S, S.todo).status).toBe(S.todo);
  });
  it('a lap without a pull request gives a bug back to Gemeldet, a slice to Startklar', () => {
    expect(finalStatus('CONC-5', S.progress, lap(), S, S.todoBug).status).toBe('10059');
    expect(finalStatus('CONC-5', S.progress, lap(), S, S.todo).status).toBe('10057');
    expect(finalStatus('CONC-5', S.review, lap(), S, S.todoBug).status).toBe('10059');
  });
});

describe('status names the agents read (VAULT-28)', () => {
  it('are the German lifecycle names', () => {
    expect(statusName('10057', S)).toBe('Startklar');
    expect(statusName('10059', S)).toBe('Gemeldet');
    expect(statusName('10058', S)).toBe('Entwicklung');
    expect(statusName('10063', S)).toBe('Verworfen');
    expect(statusName('10061', S)).toBe('Erledigt');
    expect(statusName('10062', S)).toBe('Entfällt');
  });
  it('a status the tracker does not name is shown by its id', () => {
    expect(statusName('10014', S)).toBe('status 10014');
  });
});

describe('the rest marker', () => {
  it('the rest marker is the key in lower case', () => {
    expect(restMarker('CONC-5')).toBe('rest-conc-5');
  });
});

describe('lap facts', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'lap-'));
  const run = (): { state: string; artifacts: string } => ({ state: runState(dir(), 'run-1'), artifacts: dir() });
  it('reads what land, the outbox writer and deploy left, even when deploy failed', () => {
    const { state, artifacts } = run();
    recordLap(state, { pr: 'https://github.com/o/r/pull/9' });
    addToLap(state, { reviewed: 'merge', delivers: 'part', tasks: 'Tasks done: 1, 3' });
    recordLanding(state, artifacts, { pr: 'https://github.com/o/r/pull/9', landed: 'merged' });
    recordCreated(state, 'rest-conc-5', 'CONC-40');
    writeFileSync(join(artifacts, 'deployment.md'), '# Deployment\n\n- deployed: False\n- revision: abc\n');
    expect(readLap(state, artifacts, '')).toEqual({
      pr: 'https://github.com/o/r/pull/9',
      landed: 'merged',
      deployed: 'false',
      delivers: 'part',
      tasks: [1, 3],
      reviewed: 'merge',
      created: { 'rest-conc-5': 'CONC-40' },
    });
  });
  it('the records live in the run state directory, never under ARTIFACTS_DIR', () => {
    const root = dir();
    const state = runState(root, 'run-1');
    expect(state).toBe(join(root, 'tracker', 'run-1'));
    recordLap(state, { pr: 'https://github.com/o/r/pull/9' });
    expect(existsSync(join(state, 'lap.json'))).toBe(true);
    expect(() => runState(root, '../x')).toThrow('not a run id');
    expect(() => runState('', 'run-1')).toThrow('STATE_DIR');
  });
  it('the lap start (subject) replaces an older record; the review and land add to it', () => {
    const { state, artifacts } = run();
    recordLanding(state, artifacts, { pr: 'https://github.com/o/r/pull/9', landed: 'refused', delivers: 'all' });
    recordLap(state, { pr: 'https://github.com/o/r/pull/10' });
    expect(readLap(state, artifacts, '')).toEqual(lap({ pr: 'https://github.com/o/r/pull/10' }));
    // The review's word reaches release without land (sent back, approved for a manual merge).
    addToLap(state, { reviewed: 'sent-back', delivers: 'none', tasks: 'Tasks done: none' });
    expect(readLap(state, artifacts, '')).toEqual(lap({ pr: 'https://github.com/o/r/pull/10', reviewed: 'sent-back', delivers: 'none' }));
  });
  it('created tickets add up across writers', () => {
    const { state } = run();
    recordCreated(state, 'finding-a', 'CONC-41');
    recordCreated(state, 'rest-conc-5', 'CONC-42');
    expect(readCreated(state)).toEqual({ 'finding-a': 'CONC-41', 'rest-conc-5': 'CONC-42' });
  });
  it('a confirmed rollout reads as true', () => {
    const { state, artifacts } = run();
    writeFileSync(join(artifacts, 'deployment.md'), '# Deployment\n\n- deployed: True\n');
    expect(readLap(state, artifacts, '').deployed).toBe('true');
  });
  it('land clears a deployment.md written before it, so only the deploy block can confirm a rollout', () => {
    const { state, artifacts } = run();
    writeFileSync(join(artifacts, 'deployment.md'), '- deployed: True\n');
    recordLanding(state, artifacts, { pr: 'https://github.com/o/r/pull/9', landed: 'merged', delivers: 'all' });
    expect(existsSync(join(artifacts, 'deployment.md'))).toBe(false);
    expect(readLap(state, artifacts, '').deployed).toBe('');
  });
  it('nothing recorded: the pull request pick chose, nothing else', () => {
    const { state, artifacts } = run();
    expect(readLap(state, artifacts, 'https://github.com/o/r/pull/3')).toEqual(lap({ pr: 'https://github.com/o/r/pull/3' }));
  });
  it('a recorded pr that is not a pull request URL is ignored', () => {
    const { state, artifacts } = run();
    recordLap(state, { pr: '--web' });
    expect(readLap(state, artifacts, 'https://github.com/o/r/pull/3').pr).toBe('https://github.com/o/r/pull/3');
  });
  it('a malformed record is an error, not an empty lap', () => {
    const { state, artifacts } = run();
    writeFileSync(join(state, 'lap.json'), '[1]');
    expect(() => readLap(state, artifacts, '')).toThrow('lap.json');
  });
  it('old run directories are pruned, fresh ones and strangers stay', () => {
    const root = dir();
    const old = runState(root, 'old-run');
    runState(root, 'new-run');
    mkdirSync(join(root, 'tracker', 'not a run'));
    const past = (Date.now() - 10 * 86_400_000) / 1000;
    utimesSync(old, past, past);
    expect(pruneRunStates(root, 7 * 86_400_000)).toEqual(['old-run']);
    expect(existsSync(join(root, 'tracker', 'new-run'))).toBe(true);
    expect(existsSync(join(root, 'tracker', 'not a run'))).toBe(true);
  });
});

describe('a merge counts only when GitHub confirms it', () => {
  const claimedAt = Date.parse('2026-11-15T10:00:00Z');
  const recorded = lap({ pr: 'https://github.com/o/r/pull/9', landed: 'merged', deployed: 'true', delivers: 'all' });
  const view = (over: Partial<PrView> = {}): PrView => ({
    state: 'MERGED',
    mergedAt: '2026-11-15T11:00:00Z',
    title: 'CONC-5 Tags für Notizen',
    body: 'Closes CONC-5',
    ...over,
  });
  it('merged after the claim, naming the ticket: merged', () => {
    expect(confirmMerge(recorded, view(), 'CONC-5', claimedAt, 'CONC').landed).toBe('merged');
    expect(confirmMerge(recorded, view({ title: 'Tags', body: 'Refs CONC-5' }), 'CONC-5', claimedAt, 'CONC').landed).toBe(
      'merged'
    );
  });
  it('anything GitHub does not back is not merged', () => {
    const cases: (PrView | null)[] = [
      null,
      view({ state: 'OPEN', mergedAt: null }),
      view({ mergedAt: '2026-11-15T09:00:00Z' }),
      view({ title: 'CONC-50 Anderes', body: 'Closes CONC-50' }),
    ];
    for (const seen of cases) {
      expect(confirmMerge(recorded, seen, 'CONC-5', claimedAt, 'CONC').landed).toBe('');
    }
  });
  it('a lap that did not claim a merge is left as it is', () => {
    const open = lap({ pr: 'https://github.com/o/r/pull/9', landed: 'refused' });
    expect(confirmMerge(open, null, 'CONC-5', claimedAt, 'CONC')).toEqual(open);
  });
});

describe('a pull request that does not name its ticket is put to the owner', () => {
  const open = (title: string, body = ''): PrView => ({ state: 'OPEN', mergedAt: null, title, body });
  const built = lap({ pr: 'https://github.com/o/r/pull/9' });
  it('a pull request without the key: nothing leads the loop back, so the owner is asked', () => {
    expect(unnamedPrAsk(built, open('Tags für Notizen'), 'CONC-5', 'CONC')).toContain('CONC-5');
    expect(unnamedPrAsk(built, open('CONC-50 Anderes', 'Refs CONC-50'), 'CONC-5', 'CONC')).toContain('CONC-5');
  });
  it('a pull request naming the ticket, no pull request, or one GitHub cannot show asks nothing', () => {
    expect(unnamedPrAsk(built, open('CONC-5 Tags'), 'CONC-5', 'CONC')).toBeNull();
    expect(unnamedPrAsk(built, open('Tags', 'Refs CONC-5'), 'CONC-5', 'CONC')).toBeNull();
    expect(unnamedPrAsk(lap({ pr: '' }), null, 'CONC-5', 'CONC')).toBeNull();
    expect(unnamedPrAsk(built, null, 'CONC-5', 'CONC')).toBeNull();
  });
});

describe('the ticket file for the agents', () => {
  it('head, facts, description, then every comment', () => {
    const ticket: Ticket = {
      key: 'CONC-5',
      url: 'https://example.atlassian.net/browse/CONC-5',
      title: 'Tags für Notizen',
      body: 'Was gebaut wird.\n\n- eins',
      status: S.progress,
      type: TYPES.slice,
      labels: ['route:simple'],
      flagged: false,
      assignee: 'acc-archon',
      inOpenSprint: true,
      updated: 0,
      tasks: [],
    };
    const comments: TicketComment[] = [
      { id: 10018, body: 'Loop claim: run bbb', created: '2026-11-15T11:00:00.738+0100', createdAt: 0, author: 'acc-archon', url: '' },
      { id: 10020, body: 'Ja, so.', created: '2026-11-15T12:00:00.000+0100', createdAt: 0, author: 'acc-julian', url: '' },
    ];
    // The author tells the reviewer which comment is the owner's words (a judge change's approval).
    expect(itemMarkdown(ticket, comments, CFG)).toBe(
      [
        '# CONC-5 Tags für Notizen',
        '',
        'URL: https://example.atlassian.net/browse/CONC-5',
        'Status: Entwicklung',
        'Labels: route:simple',
        '',
        'Was gebaut wird.',
        '',
        '- eins',
        '',
        '## Kommentar 10018 (2026-11-15T11:00:00.738+0100, Archon)',
        '',
        'Loop claim: run bbb',
        '',
        '## Kommentar 10020 (2026-11-15T12:00:00.000+0100, Julian)',
        '',
        'Ja, so.',
        '',
      ].join('\n')
    );
  });
});

describe('the tasks in the ticket the agents read (VAULT-28)', () => {
  it('lists the tasks of the slice with their state, after the text', () => {
    const ticket: Ticket = {
      key: 'CONC-41', url: 'https://example.atlassian.net/browse/CONC-41', title: 'Liste', body: 'Text',
      status: S.progress, type: TYPES.slice, labels: [], flagged: false, assignee: 'acc-archon', inOpenSprint: true, updated: 0,
      tasks: [
        { key: 'CONC-42', status: S.taskDone, title: 'Task 1: A' },
        { key: 'CONC-43', status: '3', title: 'Task 2: B' },
        { key: 'CONC-44', status: '10060', title: 'Task 3: C' },
        { key: 'CONC-45', status: S.taskDropped, title: 'Task 4: D' },
      ],
    };
    expect(itemMarkdown(ticket, [], CFG)).toContain(
      'Text\n\nTasks:\n- Task 1: A (Erledigt)\n- Task 2: B (offen)\n- Task 3: C (offen)\n- Task 4: D (Entfällt)\n'
    );
  });
  it('a ticket without tasks has no such block', () => {
    const ticket: Ticket = {
      key: 'CONC-50', url: 'https://example.atlassian.net/browse/CONC-50', title: 'Bug', body: 'Text',
      status: S.progress, type: TYPES.bug, labels: [], flagged: false, assignee: 'acc-archon', inOpenSprint: true, updated: 0, tasks: [],
    };
    expect(itemMarkdown(ticket, [], CFG)).not.toContain('Tasks:');
  });
});

describe('a claim starts the work (VAULT-28)', () => {
  it('from either queue to Entwicklung, a bug from Gemeldet too; a ticket further along stays', () => {
    expect(claimStart(S.todo, S)).toBe('10058');
    expect(claimStart(S.todoBug, S)).toBe('10058');
    expect(claimStart(S.progress, S)).toBeNull();
    expect(claimStart(S.review, S)).toBeNull();
  });
});
