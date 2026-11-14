import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Jira,
  adf,
  plain,
  trackerConfig,
  type TrackerConfig,
  type Transport,
} from '../../workflows/sdlc/.shared/jira';
import {
  closedKeys,
  dependencyKeys,
  isTicketKey,
  referencedKeys,
  ticketKeyOf,
  ticketUrl,
} from '../../workflows/sdlc/.shared/tickets';

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

type Call = [string, string, unknown];

function fake(routes: [string, string, number, unknown][]): { send: Transport; calls: Call[] } {
  const calls: Call[] = [];
  const send: Transport = async (method, path, body) => {
    calls.push([method, path, body]);
    const hit = routes.find(([m, prefix]) => m === method && path.startsWith(prefix));
    if (hit === undefined) return { status: 404, text: '{}' };
    return { status: hit[2], text: hit[3] === undefined ? '' : JSON.stringify(hit[3]) };
  };
  return { send, calls };
}

/** The message of a promise that must reject; a resolved promise fails the test. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a rejection');
}

function repoWith(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'trk-'));
  mkdirSync(join(root, '.archon'));
  writeFileSync(join(root, '.archon/tracker.json'), JSON.stringify(config));
  return root;
}

describe('tracker config', () => {
  it('is null without .archon/tracker.json, so the pack stays on GitHub issues', () => {
    expect(trackerConfig(mkdtempSync(join(tmpdir(), 'trk-')))).toBeNull();
  });
  it('reads the file', () => {
    expect(trackerConfig(repoWith(CFG))?.project).toBe('CONC');
  });
  it('refuses a site that is not an Atlassian https site', () => {
    expect(() => trackerConfig(repoWith({ ...CFG, site: 'http://x' }))).toThrow('https');
  });
  it('refuses a project key that would break the key patterns', () => {
    expect(() => trackerConfig(repoWith({ ...CFG, project: 'CO.*' }))).toThrow('project');
  });
  it('refuses status names instead of status ids', () => {
    const status = { ...CFG.status, todo: 'To Do' };
    expect(() => trackerConfig(repoWith({ ...CFG, status }))).toThrow('numeric ids');
  });
});

describe('ticket keys', () => {
  it('keys and URLs', () => {
    expect(isTicketKey('CONC-12')).toBe(true);
    expect(isTicketKey('#12')).toBe(false);
    expect(ticketKeyOf('https://example.atlassian.net/browse/CONC-12', CFG)).toBe('CONC-12');
    expect(ticketKeyOf('https://other.atlassian.net/browse/CONC-12', CFG)).toBeNull();
    expect(ticketKeyOf('https://example.atlassian.net/browse/VAULT-3', CFG)).toBeNull();
    expect(ticketKeyOf('https://github.com/o/r/issues/12', CFG)).toBeNull();
    expect(ticketUrl('CONC-12', CFG)).toBe('https://example.atlassian.net/browse/CONC-12');
  });
  it('Refs, Closes and Depends on name keys, never PR numbers', () => {
    expect(referencedKeys('Refs CONC-4. Closes CONC-5, fixes #9', 'CONC')).toEqual([
      'CONC-5',
      'CONC-4',
    ]);
    expect(closedKeys('Closes CONC-5 and Refs CONC-4', 'CONC')).toEqual(['CONC-5']);
    expect(closedKeys('Fixes CONC-5, CONC-6 and CONC-7', 'CONC')).toEqual([
      'CONC-5',
      'CONC-6',
      'CONC-7',
    ]);
    expect(
      dependencyKeys('Intro\nDepends on: CONC-3, CONC-7\n- **Depends on:** #9', 'CONC')
    ).toEqual(['CONC-3', 'CONC-7']);
    expect(referencedKeys('see VAULT-3', 'CONC')).toEqual([]);
    expect(referencedKeys('Refs CONC-40', 'CONC')).toEqual(['CONC-40']);
  });
  it('a key is a positive number, so nothing the client would refuse reaches a query', () => {
    expect(isTicketKey('CONC-0')).toBe(false);
    expect(referencedKeys('Refs CONC-0', 'CONC')).toEqual([]);
    expect(dependencyKeys('Depends on: CONC-012, XCONC-4, CONC-4', 'CONC')).toEqual(['CONC-4']);
  });
});

describe('ADF', () => {
  const text =
    'Loop claim: run abc\n\nRoute: simple\nArea: a.py\n\n- eins\n- zwei\n\n```\nx = 1\n\ny = 2\n```';
  it('round-trips paragraphs, line breaks, lists and code', () => {
    expect(plain(adf(text))).toBe(text);
  });
  it('builds one ADF block per paragraph, list and code block', () => {
    expect(adf(text).content.map(node => node.type)).toEqual([
      'paragraph',
      'paragraph',
      'bulletList',
      'codeBlock',
    ]);
  });
  it('never writes an empty text node, which Jira refuses', () => {
    const json = JSON.stringify(adf('a\n\n\n\nb\n\n```\n```'));
    expect(json).not.toContain('"text":""');
  });
  it('bold and code marks come back as ** and backticks, as board_jira writes them', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Offen:', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'x.py', marks: [{ type: 'code' }] },
          ],
        },
      ],
    };
    expect(plain(doc)).toBe('**Offen:** `x.py`');
  });
  it('a mention leads the first paragraph', () => {
    const doc = adf('Frage: was?', 'acc-julian');
    expect(doc.content[0]?.content?.[0]).toEqual({
      type: 'mention',
      attrs: { id: 'acc-julian' },
    });
  });
  it('empty or missing documents read as empty text', () => {
    expect(plain(null)).toBe('');
    expect(plain(undefined)).toBe('');
  });
});

describe('Jira client', () => {
  it('comments come oldest-first by numeric id, across pages', async () => {
    const { send, calls } = fake([
      [
        'GET',
        '/rest/api/3/issue/CONC-5/comment?startAt=0&',
        200,
        {
          startAt: 0,
          total: 3,
          comments: [
            { id: '10019', created: '2026-11-14T18:39:47.721+0100', body: adf('b') },
            { id: '9999', created: '2026-11-14T18:39:47.738+0100', body: adf('a') },
          ],
        },
      ],
      [
        'GET',
        '/rest/api/3/issue/CONC-5/comment?startAt=2&',
        200,
        {
          startAt: 2,
          total: 3,
          comments: [
            {
              id: '10001',
              created: '2026-11-14T18:39:48.000+0100',
              body: adf('c'),
              author: { accountId: 'acc-archon' },
            },
          ],
        },
      ],
    ]);
    const list = await new Jira(CFG, send).comments('CONC-5');
    expect(calls).toHaveLength(2);
    expect(list.map(c => c.id)).toEqual([9999, 10001, 10019]);
    expect(list.map(c => c.body)).toEqual(['a', 'c', 'b']);
    expect(list[0]?.url).toBe('https://example.atlassian.net/browse/CONC-5?focusedCommentId=9999');
    expect(list[0]?.createdAt).toBe(Date.parse('2026-11-14T18:39:47.738+0100'));
    expect(list[1]?.author).toBe('acc-archon');
  });
  it('search follows nextPageToken until the last page', async () => {
    let page = 0;
    const bodies: unknown[] = [];
    const send: Transport = async (_method, _path, body) => {
      bodies.push(body);
      page += 1;
      return page === 1
        ? { status: 200, text: JSON.stringify({ issues: [{ key: 'CONC-1' }], nextPageToken: 't2' }) }
        : { status: 200, text: JSON.stringify({ issues: [{ key: 'CONC-2' }], isLast: true }) };
    };
    const found = await new Jira(CFG, send).search('project = CONC');
    expect(found.map(issue => issue.key)).toEqual(['CONC-1', 'CONC-2']);
    expect(bodies[1]).toMatchObject({ jql: 'project = CONC', nextPageToken: 't2' });
  });
  it('reads a ticket with its flag, sprint-free by default', async () => {
    const { send } = fake([
      [
        'GET',
        '/rest/api/3/issue/CONC-7?fields=',
        200,
        {
          key: 'CONC-7',
          fields: {
            summary: 'Titel',
            description: adf('Text'),
            status: { id: '10015' },
            labels: ['area:ios'],
            assignee: { accountId: 'acc-archon' },
            updated: '2026-11-14T18:39:47.721+0100',
            customfield_10021: [{ id: '10019' }],
          },
        },
      ],
    ]);
    const ticket = await new Jira(CFG, send).ticket('CONC-7');
    expect(ticket).toMatchObject({
      key: 'CONC-7',
      url: 'https://example.atlassian.net/browse/CONC-7',
      title: 'Titel',
      body: 'Text',
      status: '10015',
      labels: ['area:ios'],
      flagged: true,
      assignee: 'acc-archon',
      inOpenSprint: false,
    });
    expect(ticket.updated).toBe(Date.parse('2026-11-14T18:39:47.721+0100'));
  });
  it('move takes the transition that leads to the status id', async () => {
    const { send, calls } = fake([
      [
        'GET',
        '/rest/api/3/issue/CONC-5/transitions',
        200,
        {
          transitions: [
            { id: '11', to: { id: '10016' } },
            { id: '21', to: { id: '3' } },
          ],
        },
      ],
      ['POST', '/rest/api/3/issue/CONC-5/transitions', 204, undefined],
    ]);
    await new Jira(CFG, send).move('CONC-5', '3');
    expect(calls[1]?.[2]).toEqual({ transition: { id: '21' } });
  });
  it('move refuses when no transition leads there', async () => {
    const { send } = fake([
      ['GET', '/rest/api/3/issue/CONC-5/transitions', 200, { transitions: [] }],
    ]);
    expect(await failure(new Jira(CFG, send).move('CONC-5', '10018'))).toContain('no transition');
  });
  it('a refused call throws with Jira text, never silently', async () => {
    const { send } = fake([
      ['POST', '/rest/api/3/issue/CONC-5/comment', 403, { errorMessages: ['nope'] }],
    ]);
    const message = await failure(new Jira(CFG, send).comment('CONC-5', 'x'));
    expect(message).toContain('403');
    expect(message).toContain('nope');
  });
  it('refuses anything but a key of its project before it builds a path', async () => {
    const { send, calls } = fake([['GET', '/rest/api/3/', 200, {}]]);
    const jira = new Jira(CFG, send);
    for (const key of ['../myself', 'CONC-5/../../myself', 'VAULT-3', 'CONC-5 ', 'CONC-0', 'conc-5']) {
      expect(await failure(jira.ticket(key))).toContain('not a CONC ticket key');
      expect(await failure(jira.comments(key))).toContain('not a CONC ticket key');
      expect(await failure(jira.comment(key, 'x'))).toContain('not a CONC ticket key');
      expect(await failure(jira.move(key, '3'))).toContain('not a CONC ticket key');
      expect(await failure(jira.ask(key, 'x'))).toContain('not a CONC ticket key');
    }
    expect(await failure(jira.editComment('CONC-5', 1.5, 'x'))).toContain('comment id');
    expect(calls).toHaveLength(0);
  });
  it('ask comments with the owner mentioned and sets the flag', async () => {
    const { send, calls } = fake([
      ['POST', '/rest/api/3/issue/CONC-8/comment', 201, { id: '1' }],
      ['PUT', '/rest/api/3/issue/CONC-8', 204, undefined],
    ]);
    await new Jira(CFG, send).ask('CONC-8', 'Frage: Testbefehl?');
    expect(JSON.stringify(calls[0]?.[2])).toContain('acc-julian');
    expect(calls[1]?.[2]).toEqual({ fields: { customfield_10021: [{ id: '10019' }] } });
  });
});
