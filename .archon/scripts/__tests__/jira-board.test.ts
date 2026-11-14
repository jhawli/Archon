import { describe, expect, it } from 'bun:test';
import { Jira, adf, type TrackerConfig, type Transport } from '../../workflows/sdlc/.shared/jira';
import {
  jiraLinks,
  loadJiraBoard,
  githubItems,
  type GithubItem,
} from '../../workflows/sdlc/.shared/tracker-board';
import { workability, type Board, type BoardItem } from '../../workflows/sdlc/.shared/workable';

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
const LINKS = jiraLinks('CONC');

const now = Date.parse('2026-11-20T12:00:00Z');
const claim = (run: string, hoursAgo = 1): BoardItem['comments'][number] => ({
  body: `Loop claim: run ${run}\n\nRoute: simple`,
  createdAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
  url: 'https://example.atlassian.net/browse/CONC-5?focusedCommentId=1',
});
const t = (id: string, extra: Partial<BoardItem> = {}): BoardItem => ({
  id,
  title: id,
  body: '',
  labels: [],
  comments: [],
  owner: false,
  candidate: true,
  ...extra,
});

describe('jira board', () => {
  it('a candidate ticket is workable; a flagged one waits for the owner', () => {
    const board: Board = {
      issues: [t('CONC-5'), t('CONC-7', { owner: true, candidate: false })],
      pulls: [],
      open: new Set(['CONC-5', 'CONC-7']),
    };
    const r = workability(board, 6, now, new Set(), LINKS);
    expect(r.workable).toEqual([{ kind: 'ticket', key: 'CONC-5' }]);
    expect(r.waiting).toEqual([{ kind: 'ticket', key: 'CONC-7', why: 'needs-owner' }]);
  });
  it('Depends on waits until the dependency is no longer open (Staging, Live, Canceled)', () => {
    const board: Board = {
      issues: [t('CONC-5', { body: 'Depends on: CONC-3' })],
      pulls: [],
      open: new Set(['CONC-3', 'CONC-5']),
    };
    expect(workability(board, 6, now, new Set(), LINKS).waiting[0]?.why).toBe('depends on CONC-3');
    expect(
      workability({ ...board, open: new Set(['CONC-5']) }, 6, now, new Set(), LINKS).workable
    ).toEqual([{ kind: 'ticket', key: 'CONC-5' }]);
  });
  it('a ticket loaded only because a pull request names it is never itself started', () => {
    const board: Board = {
      issues: [t('CONC-9', { candidate: false })],
      pulls: [],
      open: new Set(['CONC-9']),
    };
    expect(workability(board, 6, now, new Set(), LINKS).waiting).toEqual([
      { kind: 'ticket', key: 'CONC-9', why: 'not startable' },
    ]);
  });
  it('a linked ticket (in Review under an open PR) is never itself workable, its PR is', () => {
    const board: Board = {
      issues: [t('CONC-9', { candidate: false })],
      pulls: [t('#12', { title: 'CONC-9 x', body: 'Refs CONC-9' })],
      open: new Set(['CONC-9']),
    };
    const r = workability(board, 6, now, new Set(), LINKS);
    expect(r.workable).toEqual([{ kind: 'pull', number: 12 }]);
    expect(r.waiting).toEqual([
      { kind: 'ticket', key: 'CONC-9', why: 'delivered by pull request #12' },
    ]);
  });
  it('a claim on the ticket holds its pull request too', () => {
    const board: Board = {
      issues: [t('CONC-9', { candidate: false, comments: [claim('run-a')] })],
      pulls: [t('#12', { body: 'Refs CONC-9' })],
      open: new Set(['CONC-9']),
    };
    const r = workability(board, 6, now, new Set(), LINKS);
    expect(r.claims).toEqual([{ kind: 'ticket', key: 'CONC-9', run: 'run-a' }]);
    expect(r.waiting[0]).toEqual({ kind: 'pull', number: 12, why: 'claimed by run run-a' });
  });
  it('a claim of an ended run comes back with its Jira comment URL for release', () => {
    const board: Board = {
      issues: [t('CONC-5', { comments: [claim('run-gone')] })],
      pulls: [],
      open: new Set(['CONC-5']),
    };
    const r = workability(board, 6, now, new Set(['run-gone']), LINKS);
    expect(r.ended).toEqual([
      {
        kind: 'ticket',
        key: 'CONC-5',
        run: 'run-gone',
        url: 'https://example.atlassian.net/browse/CONC-5?focusedCommentId=1',
      },
    ]);
    expect(r.workable).toEqual([{ kind: 'ticket', key: 'CONC-5' }]);
  });
});

describe('GitHub rows from gh', () => {
  it('normalizes gh pr list rows into board items with #n ids', () => {
    const rows = githubItems([
      {
        number: 12,
        title: 'CONC-9 x',
        body: 'Refs CONC-9',
        labels: [{ name: 'needs-owner' }],
        comments: [{ body: 'c', createdAt: '2026-11-20T10:00:00Z', url: 'u', author: {} }],
        updatedAt: '2026-11-20T10:45:00Z',
      },
    ]);
    expect(rows).toEqual([
      {
        id: '#12',
        title: 'CONC-9 x',
        body: 'Refs CONC-9',
        labels: ['needs-owner'],
        comments: [{ body: 'c', createdAt: '2026-11-20T10:00:00Z', url: 'u' }],
        owner: true,
        candidate: true,
        updatedAt: '2026-11-20T10:45:00Z',
      },
    ]);
  });
  it('refuses anything but a list, so a broken gh answer stops the gate', () => {
    expect(() => githubItems({})).toThrow('no list');
  });
});

describe('loading the board from Jira', () => {
  const issue = (key: string, fields: Record<string, unknown>): Record<string, unknown> => ({
    key,
    fields: {
      summary: `${key} title`,
      description: adf(typeof fields.text === 'string' ? fields.text : 'text'),
      status: { id: '10015' },
      labels: [],
      assignee: { accountId: 'acc-archon' },
      updated: '2026-11-20T10:00:00.000+0100',
      ...fields,
    },
  });
  function fakeJira(): { send: Transport; jql: string[]; comments: string[] } {
    const jql: string[] = [];
    const comments: string[] = [];
    const send: Transport = async (method, path, body) => {
      const ok = (value: unknown): { status: number; text: string } => ({
        status: 200,
        text: JSON.stringify(value),
      });
      if (method === 'POST' && path === '/rest/api/3/search/jql') {
        const query = String((body as { jql?: unknown }).jql);
        jql.push(query);
        if (query.includes('openSprints()')) {
          return ok({
            isLast: true,
            issues: [
              issue('CONC-5', { text: 'Depends on: CONC-3, CONC-77' }),
              issue('CONC-6', {
                customfield_10021: [{ id: '10019' }],
                updated: '2026-11-20T11:30:00.000+0100',
              }),
            ],
          });
        }
        if (query === 'key in (CONC-9)') {
          return ok({ isLast: true, issues: [issue('CONC-9', { status: { id: '10016' } })] });
        }
        if (query === 'key in (CONC-3,CONC-77)') {
          // CONC-77 is a typo: Jira returns no row for it.
          return ok({ isLast: true, issues: [{ key: 'CONC-3', fields: { status: { id: '10018' } } }] });
        }
        return ok({ isLast: true, issues: [] });
      }
      const match = /^\/rest\/api\/3\/issue\/(CONC-\d+)\/comment\?startAt=0&/.exec(path);
      if (method === 'GET' && match !== null) {
        comments.push(match[1] ?? '');
        const rows =
          match[1] === 'CONC-9'
            ? [{ id: '20', created: '2026-11-20T11:00:00.000+0100', body: adf('Loop claim: run r1\n\nRoute: simple') }]
            : [];
        return ok({ startAt: 0, total: rows.length, comments: rows });
      }
      return { status: 404, text: '{}' };
    };
    return { send, jql, comments };
  }
  const pull: GithubItem = {
    id: '#12',
    title: 'CONC-9 x',
    body: 'Refs CONC-9',
    labels: [],
    comments: [],
    owner: false,
    candidate: true,
    updatedAt: '2026-11-20T10:45:00Z',
  };

  it('reads the open sprint, the tickets pull requests name and what still blocks', async () => {
    const { send, jql, comments } = fakeJira();
    const loaded = await loadJiraBoard(new Jira(CFG, send), [pull]);
    expect(jql[0]).toBe(
      'project = CONC AND sprint in openSprints() AND status = 10015 AND assignee = "acc-archon" ORDER BY Rank ASC'
    );
    expect(jql.slice(1)).toEqual(['key in (CONC-9)', 'key in (CONC-3,CONC-77)']);
    expect(comments).toEqual(['CONC-5', 'CONC-6', 'CONC-9']);
    expect(loaded.board.issues.map(i => [i.id, i.candidate, i.owner])).toEqual([
      ['CONC-5', true, false],
      ['CONC-6', false, true],
      ['CONC-9', false, false],
    ]);
    // CONC-3 is Live and no longer blocks; the unknown CONC-77 stays open, waiting is the safe side.
    expect([...loaded.board.open].sort()).toEqual(['CONC-5', 'CONC-6', 'CONC-77', 'CONC-9']);
    expect(loaded.updated).toBe(Date.parse('2026-11-20T10:45:00Z'));
    expect(loaded.tickets.map(ticket => [ticket.key, ticket.inOpenSprint])).toEqual([
      ['CONC-5', true],
      ['CONC-6', true],
      ['CONC-9', false],
    ]);

    const r = workability(loaded.board, 6, now, new Set(), loaded.links);
    expect(r.workable).toEqual([]);
    expect(r.claims).toEqual([{ kind: 'ticket', key: 'CONC-9', run: 'r1' }]);
    expect(r.waiting).toEqual([
      { kind: 'pull', number: 12, why: 'claimed by run r1' },
      { kind: 'ticket', key: 'CONC-5', why: 'depends on CONC-77' },
      { kind: 'ticket', key: 'CONC-6', why: 'needs-owner' },
      { kind: 'ticket', key: 'CONC-9', why: 'delivered by pull request #12' },
    ]);
  });

  it('asks Jira nothing more when the sprint is empty and no pull request names a ticket', async () => {
    const { send, jql, comments } = fakeJira();
    const empty: Transport = async (method, path, body) =>
      method === 'POST' && String((body as { jql?: unknown }).jql).includes('openSprints()')
        ? { status: 200, text: JSON.stringify({ isLast: true, issues: [] }) }
        : send(method, path, body);
    const loaded = await loadJiraBoard(new Jira(CFG, empty), []);
    expect(loaded.board.issues).toEqual([]);
    expect(jql).toEqual([]);
    expect(comments).toEqual([]);
    expect(loaded.updated).toBe(0);
  });
});
