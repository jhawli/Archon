import { describe, expect, it } from 'bun:test';
import { checkManagerOps, conceptLinks, managerPass, parseManagerOutbox, type Live } from '../../workflows/sdlc/.shared/manager-ops';
import { type Call, CFG, fakeJira, type FakeComment, type FakeTicket, state } from './jira-fixtures';

const S = CFG.status;
const NOW = Date.parse('2026-11-18T12:00:00Z');
const KONZEPT = 'Konzept: https://github.com/jhawli/projektkoordination/blob/main/Clusters/Wohnung/Ideas/einkaufsliste.md';
function live(status: string, extra: Partial<Live> = {}): Live {
  return { status, flagged: false, own: false, body: `${KONZEPT}\n\nText`, question: null, prOpen: false, ...extra };
}
function check(raw: unknown[], board: Record<string, Live>): void {
  checkManagerOps(parseManagerOutbox(raw, 'CONC').ops, new Map(Object.entries(board)), S, NOW);
}
const fails = (raw: unknown[], board: Record<string, Live>): string => {
  try { check(raw, board); } catch (e) { return (e as Error).message; }
  throw new Error('expected a refusal');
};

describe('AK18i: rights by status', () => {
  it('CONC-9 (Julian’s, To Do) doubles CONC-4: cancel', () => {
    check([{ op: 'cancel', key: 'CONC-9', text: 'Doppel von CONC-4' }], { 'CONC-9': live(S.todo) });
  });
  it('CONC-20 on Review: sharpen with a comment, but no cancel straight away', () => {
    check([{ op: 'rewrite', key: 'CONC-20', text: `${KONZEPT}\n\nSchärfer`, reason: 'dreimal am selben Kriterium zurückgewiesen' }], { 'CONC-20': live(S.review) });
    expect(fails([{ op: 'cancel', key: 'CONC-20', text: 'x' }], { 'CONC-20': live(S.review) })).toContain('erst');
  });
  it('Review back to To Do only with the PR closed; then cancel in the same pass', () => {
    expect(fails([{ op: 'todo', key: 'CONC-20', text: 'PR nicht zu retten' }], { 'CONC-20': live(S.review, { prOpen: true }) })).toContain('PR');
    check([{ op: 'todo', key: 'CONC-20', text: 'PR geschlossen' }, { op: 'cancel', key: 'CONC-20', text: 'überholt durch CONC-21' }], { 'CONC-20': live(S.review) });
  });
  it('In Progress, Staging, New: comment and ask only', () => {
    for (const s of [S.progress, S.staging, '10014']) {
      check([{ op: 'comment', key: 'CONC-15', text: 'Hinweis' }], { 'CONC-15': live(s) });
      expect(fails([{ op: 'rewrite', key: 'CONC-15', text: `${KONZEPT}\nneu`, reason: 'r' }], { 'CONC-15': live(s) })).toContain('nur kommentieren');
    }
    expect(fails([{ op: 'cancel', key: 'CONC-12', text: 'x' }], { 'CONC-12': live(S.staging) })).toContain('nur kommentieren');
  });
  it('the concept link stays', () => {
    expect(fails([{ op: 'rewrite', key: 'CONC-9', text: 'ohne Link', reason: 'r' }], { 'CONC-9': live(S.todo) })).toContain('Konzept-Link');
    expect(conceptLinks(KONZEPT)).toEqual(['https://github.com/jhawli/projektkoordination/blob/main/Clusters/Wohnung/Ideas/einkaufsliste.md']);
  });
  it('5 new tickets pass, the 6th is dropped and named', () => {
    const creates = [1, 2, 3, 4, 5, 6].map(n => ({ op: 'create', marker: `mgr-fund-${n}`, title: `Fund ${n}`, text: 'Was ein Nutzer sieht' }));
    const parsed = parseManagerOutbox(creates, 'CONC');
    expect(parsed.ops).toHaveLength(5);
    expect(parsed.dropped).toEqual(['create mgr-fund-6 „Fund 6“']);
  });
});

describe('AK18m: rank', () => {
  it('main red to rank 1 with a comment', () => {
    check([{ op: 'rank', key: 'CONC-41', top: true, text: 'main rot: make check' }], { 'CONC-41': live(S.todo) });
  });
  it('a rank change without a comment is refused', () => {
    expect(() => parseManagerOutbox([{ op: 'rank', key: 'CONC-41', top: true, text: '' }], 'CONC')).toThrow('text is empty');
  });
  it('a ticket ranked before or after itself is refused before any write', () => {
    for (const place of ['before', 'after']) {
      expect(() => parseManagerOutbox([{ op: 'rank', key: 'CONC-41', [place]: 'CONC-41', text: 'x' }], 'CONC')).toThrow('itself');
    }
  });
});

describe('AK18k: the default', () => {
  const asked = Date.parse('2026-11-17T12:00:01Z');
  const q = { comment: { id: 1, author: CFG.assignee, body: '', createdAt: asked, created: '', url: '' }, kind: 'technisch' as const, byRun: true, fallback: 'Cache leeren', answer: null, applied: false, reflagged: false };
  it('one second before 24 hours: refused', () => {
    expect(fails([{ op: 'default', key: 'CONC-7', text: 'keine Antwort' }], { 'CONC-7': live(S.todo, { flagged: true, question: q }) })).toContain('fällig');
  });
  it('a ticket no longer flagged gets no default, however old its question', () => {
    const due = { ...q, comment: { ...q.comment, createdAt: asked - 3_600_000 } };
    expect(fails([{ op: 'default', key: 'CONC-7', text: 'keine Antwort' }], { 'CONC-7': live(S.todo, { flagged: false, question: due }) })).toContain('nicht markiert');
  });
});

describe('agent text that reads as someone else', () => {
  it('is refused before anything is written', () => {
    expect(() => parseManagerOutbox([{ op: 'comment', key: 'CONC-5', text: 'Julian: passt' }], 'CONC')).toThrow('reserved');
  });
  it('a comment may name a question; the question itself may not carry a head or a default line', () => {
    const quote = 'Die Frage (Produkt) auf CONC-4 wartet auf Julian.\nVorgabe: keine';
    expect(() => parseManagerOutbox([{ op: 'comment', key: 'CONC-5', text: quote }], 'CONC')).not.toThrow();
    const ask = { op: 'ask', key: 'CONC-5', text: quote, kind: 'produkt', options: ['A', 'B'], recommendation: 'A' };
    expect(() => parseManagerOutbox([ask], 'CONC')).toThrow('reserved');
  });
});

describe('questions and caps in the outbox', () => {
  it('a question without options, or a recommendation outside them, refuses the list (AK18j)', () => {
    const ask = (over: object): Record<string, unknown>[] => [{ op: 'ask', key: 'CONC-5', text: 'A oder B?', kind: 'produkt', options: ['A', 'B'], recommendation: 'A', ...over }];
    expect(() => parseManagerOutbox(ask({}), 'CONC')).not.toThrow();
    expect(() => parseManagerOutbox(ask({ options: ['A'] }), 'CONC')).toThrow('2 to 6 options');
    expect(() => parseManagerOutbox(ask({ recommendation: 'C' }), 'CONC')).toThrow('one of the options');
  });
  it('six rewrites (AK18i): five pass, the sixth is dropped and named', () => {
    const raw = [5, 6, 7, 8, 9, 10].map(n => ({ op: 'rewrite', key: `CONC-${n}`, text: 'neu', reason: 'klarer' }));
    const { ops, dropped } = parseManagerOutbox(raw, 'CONC');
    expect(ops).toHaveLength(5);
    expect(dropped).toEqual(['rewrite CONC-10']);
  });
});

describe('AK18i to AK18m: what the manager writes, and in which order', () => {
  const LINE = 'Lauf: archon archon-manager run-9';
  const BOARD = 'https://example.atlassian.net/jira/software/projects/CONC/boards/5';
  const known = (tickets: Record<string, FakeTicket>): Record<string, { status: string; title: string; own: string }> =>
    Object.fromEntries(Object.entries(tickets).map(([key, t]) => [key, { status: t.status, title: key, own: '' }]));
  const writes = (calls: Call[]): Call[] =>
    calls.filter(c => c.method !== 'GET' && c.path !== '/rest/api/3/search/jql');
  async function pass(
    raw: unknown[],
    tickets: Record<string, FakeTicket>,
    extra: Parameters<typeof fakeJira>[0] = {},
    st = state()
  ): Promise<{ calls: Call[]; error: string | null }> {
    const { jira, calls } = fakeJira({ ...extra, tickets });
    const error = await managerPass(jira, raw, st, [], known(tickets), NOW, LINE, BOARD).then(
      () => null,
      (e: unknown) => (e as Error).message
    );
    return { calls, error };
  }
  const asked = (created: string): FakeComment => ({
    id: 100, author: CFG.assignee, created,
    body: '@Julian Frage (technisch, Vorgabe ab 2026-11-17 11:00 UTC): Ausblenden?\nVorgabe: Hinweis zeigen\n\nLauf: archon archon-manager run-1',
  });

  it('a rewrite of a ticket on In Progress refuses the list before any write', async () => {
    const { calls, error } = await pass([{ op: 'rewrite', key: 'CONC-15', text: 'neu', reason: 'unklar' }], { 'CONC-15': { status: S.progress } });
    expect(error ?? '').toContain('nur kommentieren');
    expect(writes(calls)).toHaveLength(0);
  });
  it('a key the board did not show is not looked up, and refuses the list', async () => {
    const { calls, error } = await pass([{ op: 'comment', key: 'CONC-999', text: 'x' }], {});
    expect(error ?? '').toContain('is not on the board');
    expect(calls).toHaveLength(0);
  });
  it('rewrite: the new text first, then the comment with the reason and the run line', async () => {
    const { calls, error } = await pass([{ op: 'rewrite', key: 'CONC-9', text: 'Liste zeigt einen Hinweis.', reason: 'Kriterium prüfbar gemacht' }], { 'CONC-9': { status: S.todo, body: 'alt' } });
    expect(error).toBeNull();
    expect(writes(calls).map(c => `${c.method} ${c.path}`)).toEqual(['PUT /rest/api/3/issue/CONC-9', 'POST /rest/api/3/issue/CONC-9/comment']);
    expect(JSON.stringify(writes(calls)[1]?.body)).toContain('Text umgeschrieben: Kriterium prüfbar gemacht');
    expect(JSON.stringify(writes(calls)[1]?.body)).toContain(LINE);
  });
  it('rank top: before the first other ticket of the sprint', async () => {
    const { calls, error } = await pass([{ op: 'rank', key: 'CONC-41', top: true, text: 'main ist rot' }], { 'CONC-41': { status: S.todo } }, { ranked: ['CONC-3', 'CONC-41'] });
    expect(error).toBeNull();
    expect(calls.find(c => c.path === '/rest/agile/1.0/issue/rank')?.body).toEqual({ issues: ['CONC-41'], rankBeforeIssue: 'CONC-3' });
  });
  it('a failed comment after cancel: the rerun sends only the comment', async () => {
    const raw = [{ op: 'cancel', key: 'CONC-9', text: 'Doppel von CONC-4' }];
    const tickets = { 'CONC-9': { status: S.todo } };
    const st = state();
    expect((await pass(raw, tickets, { failOnce: 'POST /rest/api/3/issue/CONC-9/comment' }, st)).error).not.toBeNull();
    const again = await pass(raw, tickets, {}, st);
    expect(again.error).toBeNull();
    expect(writes(again.calls).map(c => `${c.method} ${c.path}`)).toEqual(['POST /rest/api/3/issue/CONC-9/comment']);
  });
  it('a rerun after the whole list was written writes nothing again', async () => {
    const raw = [{ op: 'comment', key: 'CONC-9', text: 'Hinweis' }, { op: 'ask', key: 'CONC-9', text: 'A oder B?', kind: 'produkt', options: ['A', 'B'], recommendation: 'A' }];
    const tickets = { 'CONC-9': { status: S.todo } };
    const st = state();
    expect((await pass(raw, tickets, {}, st)).error).toBeNull();
    const again = await pass(raw, tickets, {}, st);
    expect(again.error).toBeNull();
    expect(writes(again.calls)).toHaveLength(0);
  });
  it('ask (AK18j): the flag, then the question with the mention, its kind and when the default is due', async () => {
    const { calls, error } = await pass([{ op: 'ask', key: 'CONC-5', text: 'Leere Liste ausblenden oder Hinweis?', kind: 'technisch', fallback: 'Hinweis zeigen', options: ['Ausblenden', 'Hinweis zeigen'], recommendation: 'Hinweis zeigen' }], { 'CONC-5': { status: S.todo } });
    expect(error).toBeNull();
    expect(writes(calls)[0]?.body).toEqual({ fields: { [CFG.flagField]: [{ id: CFG.flagOn }] } });
    const text = JSON.stringify(writes(calls)[1]?.body);
    expect(text).toContain('Frage (technisch, Vorgabe ab 2026-11-19 12:00 UTC)');
    expect(text).toContain('Optionen: Ausblenden | Hinweis zeigen');
    expect(text).toContain('Empfehlung: Hinweis zeigen');
    expect(text).toContain(CFG.owner);
  });
  it('create at rank 1 with a question (AK18j, AK18m): filed and ranked once, asked once, also after a failed question', async () => {
    const raw = [{ op: 'create', marker: 'mgr-leere-liste', title: 'Frage: Leere Einkaufsliste', text: 'Was zeigt eine leere Liste?', top: true, ask: { text: 'Ausblenden oder Hinweis?', kind: 'produkt', options: ['Ausblenden', 'Hinweis zeigen'], recommendation: 'Hinweis zeigen' } }];
    const st = state();
    const first = await pass(raw, {}, { sprint: 36, ranked: ['CONC-3'], failOnce: 'POST /rest/api/3/issue/CONC-51/comment' }, st);
    expect(first.error).not.toBeNull();
    expect(first.calls.filter(c => c.path === '/rest/agile/1.0/issue/rank')).toHaveLength(1);
    const again = await pass(raw, {}, { sprint: 36, ranked: ['CONC-3'] }, st);
    expect(again.error).toBeNull();
    expect(again.calls.filter(c => c.method === 'POST' && c.path === '/rest/api/3/issue')).toHaveLength(0);
    expect(again.calls.filter(c => c.path === '/rest/agile/1.0/issue/rank')).toHaveLength(0);
    expect(again.calls.filter(c => c.path === '/rest/api/3/issue/CONC-51/comment')).toHaveLength(1);
    expect(JSON.stringify(again.calls.find(c => c.path === '/rest/api/3/issue/CONC-51/comment')?.body)).toContain('Frage (Produkt)');
  });
  it('a technical default that is due (AK18k): flag off, then "Vorgabe angewendet:" with the default', async () => {
    const { calls, error } = await pass([{ op: 'default', key: 'CONC-7', text: 'Hinweis eingebaut' }], { 'CONC-7': { status: S.todo, flagged: true, comments: [asked('2026-11-17T11:00:00.000Z')] } });
    expect(error).toBeNull();
    expect(writes(calls)[0]?.body).toEqual({ fields: { [CFG.flagField]: null } });
    expect(JSON.stringify(writes(calls)[1]?.body)).toContain('Vorgabe angewendet: Hinweis zeigen');
  });
  it('a failed comment after a default: the rerun still names the default', async () => {
    const raw = [{ op: 'default', key: 'CONC-7', text: 'Hinweis eingebaut' }];
    const tickets = { 'CONC-7': { status: S.todo, flagged: true, comments: [asked('2026-11-17T11:00:00.000Z')] } };
    const st = state();
    expect((await pass(raw, tickets, { failOnce: 'POST /rest/api/3/issue/CONC-7/comment' }, st)).error).not.toBeNull();
    const again = await pass(raw, tickets, {}, st);
    expect(again.error).toBeNull();
    expect(writes(again.calls).map(c => `${c.method} ${c.path}`)).toEqual(['POST /rest/api/3/issue/CONC-7/comment']);
    expect(JSON.stringify(writes(again.calls)[0]?.body)).toContain('Vorgabe angewendet: Hinweis zeigen');
  });
  it('the same default not yet due refuses the list', async () => {
    const { error } = await pass([{ op: 'default', key: 'CONC-7', text: 'zu früh' }], { 'CONC-7': { status: S.todo, flagged: true, comments: [asked('2026-11-17T12:00:01.000Z')] } });
    expect(error ?? '').toContain('keine technische Frage mit fälliger Vorgabe');
  });
  it('a create whose marker an earlier ticket carries refuses the list, before any call', async () => {
    const known = { 'CONC-12': { status: S.staging, title: 'x', own: 'mgr-leere-liste' } };
    const { jira, calls } = fakeJira({ tickets: { 'CONC-12': { status: S.staging } } });
    const raw = [{ op: 'create', marker: 'mgr-leere-liste', title: 'Leere Liste', text: 'x', top: true }];
    const error = await managerPass(jira, raw, state(), [], known, NOW, LINE, BOARD).then(() => null, (e: unknown) => (e as Error).message);
    expect(error ?? '').toContain('CONC-12');
    expect(calls).toHaveLength(0);
  });
  it('an answered question the list does not act on refuses it, before any call (AK18l)', async () => {
    const known = { 'CONC-5': { status: S.todo, title: 'x', own: '', answered: true as const } };
    const { jira, calls } = fakeJira({ tickets: { 'CONC-5': { status: S.todo, flagged: true } } });
    const error = await managerPass(jira, [{ op: 'comment', key: 'CONC-5', text: 'gesehen' }], state(), [], known, NOW, LINE, BOARD)
      .then(() => null, (e: unknown) => (e as Error).message);
    expect(error ?? '').toContain('AK18l');
    expect(calls).toHaveLength(0);
  });
  it('acting on it passes: rewritten to the answer, then the flag lifted (AK18l)', async () => {
    const q = { id: 100, author: CFG.assignee, created: '2026-11-17T11:00:00.000Z', body: '@Julian Frage (Produkt): Leere Liste ausblenden oder Hinweis?\nOptionen: Ausblenden | Hinweis zeigen\nEmpfehlung: Hinweis zeigen\n\nLauf: archon archon-manager run-1' };
    const a = { id: 101, author: CFG.owner, created: '2026-11-17T15:00:00.000Z', body: 'Hinweis zeigen' };
    const known = { 'CONC-5': { status: S.todo, title: 'x', own: 'mgr-leere-liste', answered: true as const } };
    const raw = [
      { op: 'rewrite', key: 'CONC-5', text: 'Loop finding: mgr-leere-liste\n\nEine leere Einkaufsliste zeigt einen Hinweis.', reason: 'Antwort umgesetzt' },
      { op: 'unflag', key: 'CONC-5', text: 'beantwortet: Hinweis zeigen' },
    ];
    const { jira, calls } = fakeJira({ tickets: { 'CONC-5': { status: S.todo, flagged: true, comments: [q, a] } } });
    const error = await managerPass(jira, raw, state(), [], known, NOW, LINE, BOARD).then(() => null, (e: unknown) => (e as Error).message);
    expect(error).toBeNull();
    expect(calls.filter(c => c.method === 'PUT').map(c => Object.keys((c.body as { fields: object }).fields))).toEqual([['description'], [CFG.flagField]]);
  });
});

describe('Grill G2: run actions in the manager outbox', () => {
  const id = (n: number): string => `a1b2c3d4-0000-4000-8000-00000000000${n}`;
  it('abandon and resume are read, a third resume is dropped, not refused', () => {
    const raw = [1, 2, 3].map(n => ({ op: 'resume', run: id(n), text: 'DB-Fehler' })).concat([{ op: 'abandon', run: id(4), text: 'nie gestartet' }]);
    expect(() => parseManagerOutbox(raw, 'CONC')).not.toThrow();
    const { ops, dropped } = parseManagerOutbox(raw, 'CONC');
    expect(ops.map(o => o.op)).toEqual(['resume', 'resume', 'abandon']);
    expect(dropped).toEqual([`resume ${id(3)}`]);
  });
  it('a run that is not an id, or no reason: the whole outbox is refused', () => {
    expect(() => parseManagerOutbox([{ op: 'abandon', run: 'latest', text: 'x' }], 'CONC')).toThrow('run must be');
    expect(() => parseManagerOutbox([{ op: 'resume', run: id(1), text: '' }], 'CONC')).toThrow('text is empty');
  });
  it('the ticket check passes run actions by', () => {
    expect(() => parseManagerOutbox([{ op: 'abandon', run: id(1), text: 'x' }], 'CONC')).not.toThrow();
    const { ops } = parseManagerOutbox([{ op: 'abandon', run: id(1), text: 'x' }], 'CONC');
    expect(() => {
      checkManagerOps(ops, new Map(), S, NOW);
    }).not.toThrow();
  });
  it('run actions pass through managerPass untouched: only the ticket entry is written', async () => {
    const { jira, calls } = fakeJira({ tickets: { 'CONC-5': { status: S.todo } } });
    const raw = [{ op: 'abandon', run: id(1), text: 'nie gestartet' }, { op: 'comment', key: 'CONC-5', text: 'y' }];
    const error = await managerPass(jira, raw, state(), [], { 'CONC-5': { status: S.todo, title: 'x', own: '' } }, NOW, 'Lauf: archon archon-manager r1', 'https://example.atlassian.net/b')
      .then(() => null, (e: unknown) => (e as Error).message);
    expect(error).toBeNull();
    expect(calls.filter(c => c.method === 'POST' && c.path !== '/rest/api/3/search/jql').map(c => c.path)).toEqual(['/rest/api/3/issue/CONC-5/comment']);
  });
});
