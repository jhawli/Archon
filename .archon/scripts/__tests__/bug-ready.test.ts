import { describe, expect, it } from 'bun:test';
import { adf, plain } from '../../workflows/sdlc/.shared/jira';
import { askUnready, bugReady, missingSections, unreadyRefusal } from '../../workflows/sdlc/.shared/bug-ready';
import { lastQuestion, mayUnflag } from '../../workflows/sdlc/.shared/questions';
import { applyOutbox } from '../../workflows/sdlc/.shared/outbox';
import { CFG, fakeJira, state, STATUS, TYPES } from './jira-fixtures';

const BUG = TYPES.bug;
const ticket = (type: string, body: string): { type: string; body: string } => ({ type, body });

describe('bug readiness (CONC-32 AK11)', () => {
  it('a bug with both lines is ready', () => {
    expect(bugReady(ticket(BUG, 'Fehler: Gewicht springt auf 0\nRegressionstest: 72,5 eingeben → 72,5 bleibt'), BUG)).toBe(true);
  });
  it('any case counts', () => {
    expect(bugReady(ticket(BUG, 'fehler: Gewicht springt\nREGRESSIONSTEST: 72,5 → 72,5'), BUG)).toBe(true);
  });
  it('a bug with only the error line names what is missing', () => {
    expect(missingSections(ticket(BUG, 'Fehler: Gewicht springt'), BUG)).toEqual(['Regressionstest']);
  });
  it('a bug without either line names both', () => {
    expect(missingSections(ticket(BUG, 'Gewicht springt auf 0'), BUG)).toEqual(['Fehler', 'Regressionstest']);
  });
  it('an empty line after the label does not count', () => {
    expect(missingSections(ticket(BUG, 'Fehler:\nRegressionstest:   '), BUG)).toEqual(['Fehler', 'Regressionstest']);
  });
  it('the text must stand on the label line, not on the next one', () => {
    expect(missingSections(ticket(BUG, 'Fehler:\nGewicht springt\nRegressionstest: 72,5 → 72,5'), BUG)).toEqual(['Fehler']);
  });
  it('a label in the middle of a line does not count', () => {
    expect(missingSections(ticket(BUG, 'Siehe Fehler: x\nRegressionstest: y'), BUG)).toEqual(['Fehler']);
  });
  it('a bold label or a bullet counts, as Jira writes them from its editor', () => {
    expect(bugReady(ticket(BUG, '**Fehler:** Gewicht springt\n- Regressionstest: 72,5 → 72,5'), BUG)).toBe(true);
    expect(missingSections(ticket(BUG, '**Fehler:**\n**Regressionstest:** x'), BUG)).toEqual(['Fehler']);
  });
  it('marks of the editor around a label count: bold with the colon inside or out, code, no-break space', () => {
    for (const body of [
      '**Fehler: **Gewicht springt\n**Regressionstest**: 72,5 → 72,5',
      '`Fehler:` Gewicht springt\n`Regressionstest:` 72,5 → 72,5',
      'Fehler:\u00a0Gewicht springt\nRegressionstest:\u00a072,5 → 72,5',
    ]) {
      expect(missingSections(ticket(BUG, body), BUG)).toEqual([]);
    }
  });
  it('a numbered list item counts, as plain() renders an ordered list', () => {
    const body = plain({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'orderedList',
          content: ['Fehler: Gewicht springt', 'Regressionstest: 72,5 → 72,5'].map(text => ({
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
          })),
        },
      ],
    });
    expect(missingSections(ticket(BUG, body), BUG)).toEqual([]);
  });
  it('a mark alone is no text', () => {
    expect(missingSections(ticket(BUG, '**Fehler:**\n`Regressionstest:`'), BUG)).toEqual(['Fehler', 'Regressionstest']);
  });
  it('reads the lines through Jira: one paragraph with breaks, or a paragraph per line', () => {
    const breaks = plain(adf('Fehler: Gewicht springt\nRegressionstest: 72,5 → 72,5'));
    const paragraphs = plain({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Fehler: Gewicht springt' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Regressionstest: 72,5 → 72,5' }] },
      ],
    });
    expect(bugReady(ticket(BUG, breaks), BUG)).toBe(true);
    expect(bugReady(ticket(BUG, paragraphs), BUG)).toBe(true);
  });
  it('a finding the loop filed itself is ready (decision 6)', () => {
    expect(bugReady(ticket(BUG, 'Loop finding: r12-f1\n\nNull pointer in Sync'), BUG)).toBe(true);
  });
  it('a finding as the outbox files it reads back as ready (decision 6)', async () => {
    const { jira, calls } = fakeJira({ sprint: 7 });
    const op = { op: 'create', marker: 'finding-sync', title: 'Fund', text: 'Null pointer in Sync' } as const;
    await applyOutbox(jira, [op], 'https://example.test/run/1', 'Lauf: archon archon-loop r1', state());
    const filed = calls.find(call => call.method === 'POST' && call.path === '/rest/api/3/issue');
    const fields = (filed?.body as { fields: { issuetype: { id: string }; description: unknown } }).fields;
    expect(fields.issuetype.id).toBe(TYPES.bug);
    expect(bugReady(ticket(fields.issuetype.id, plain(fields.description)), BUG)).toBe(true);
  });
  it('a slice is never held by this rule', () => {
    expect(bugReady(ticket(TYPES.slice, 'nichts'), BUG)).toBe(true);
  });
});

describe('the launch gate asks for an unready bug (CONC-32 AK11)', () => {
  const RUN = 'Lauf: archon archon-loop scheduler';

  it('asks the owner once for each unready bug, with what is missing', async () => {
    const asked: [string, string][] = [];
    const client = {
      ask: async (key: string, text: string): Promise<void> => {
        asked.push([key, text]);
      },
    };
    const lines = await askUnready(client, [{ key: 'CONC-7', missing: ['Regressionstest'] }], RUN);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.[0]).toBe('CONC-7');
    expect(asked[0]?.[1]).toContain('`Regressionstest:`');
    expect(asked[0]?.[1].startsWith('Frage (Produkt): ')).toBe(true);
    expect(asked[0]?.[1].endsWith(`\n\n${RUN}`)).toBe(true);
    expect(lines).toEqual(['CONC-7: unready bug, asked the owner (Regressionstest)']);
  });

  it('names both lines when both are missing', async () => {
    const asked: string[] = [];
    const client = {
      ask: async (_key: string, text: string): Promise<void> => {
        asked.push(text);
      },
    };
    await askUnready(client, [{ key: 'CONC-7', missing: ['Fehler', 'Regressionstest'] }], RUN);
    expect(asked[0]).toContain('`Fehler:` und `Regressionstest:`');
  });

  it('flags the ticket, and the manager does not lift the flag of the unanswered question', async () => {
    const { jira, calls } = fakeJira({ tickets: { 'CONC-7': { status: CFG.status.todoBug, type: TYPES.bug } } });
    await askUnready(jira, [{ key: 'CONC-7', missing: ['Regressionstest'] }], RUN);
    const flag = calls.find(call => call.method === 'PUT' && call.path.includes('CONC-7'));
    expect(flag?.body).toEqual({ fields: { [CFG.flagField]: [{ id: CFG.flagOn }] } });
    const posted = calls.find(call => call.method === 'POST' && call.path.endsWith('/comment'));
    // The comment as the manager reads it back: plain text of the account's comment, mention first.
    const comment = {
      id: 101,
      body: plain((posted?.body as { body: unknown }).body),
      createdAt: Date.now(),
      created: new Date().toISOString(),
      author: CFG.assignee,
      url: 'https://example.atlassian.net/browse/CONC-7?focusedCommentId=101',
    };
    const q = lastQuestion([comment], CFG);
    expect(q?.kind).toBe('produkt');
    expect(q?.byRun).toBe(true);
    expect(q?.answer).toBeNull();
    expect(mayUnflag(q)).toBe(false);
  });

  it('a failing ask is reported and does not stop the gate', async () => {
    const client = {
      ask: async (): Promise<void> => {
        throw new Error('403');
      },
    };
    expect(
      await askUnready(
        client,
        [
          { key: 'CONC-7', missing: ['Fehler'] },
          { key: 'CONC-8', missing: ['Fehler'] },
        ],
        RUN
      )
    ).toEqual(['CONC-7: could not ask (403)', 'CONC-8: could not ask (403)']);
  });
});

describe('claim refuses an unready bug pick chose anyway (CONC-32 AK11)', () => {
  const bug = (status: string, body: string): { key: string; type: string; body: string; status: string } => ({
    key: 'CONC-7',
    type: TYPES.bug,
    body,
    status,
  });
  it('names the missing lines of a bug on its queue', () => {
    expect(unreadyRefusal(bug(STATUS.todoBug, 'Gewicht springt'), CFG)).toBe(
      'CONC-7 is an unready bug: no Fehler: and no Regressionstest: line (CONC-32 AK11)'
    );
  });
  it('lets a ready bug and a slice through', () => {
    expect(unreadyRefusal(bug(STATUS.todoBug, 'Fehler: x\nRegressionstest: y'), CFG)).toBeNull();
    expect(unreadyRefusal({ key: 'CONC-9', type: TYPES.slice, body: '', status: STATUS.todo }, CFG)).toBeNull();
  });
  it('leaves a bug on Review alone: the gate never asks there, its pull request must not hang', () => {
    expect(unreadyRefusal(bug(STATUS.review, 'Gewicht springt'), CFG)).toBeNull();
  });
});
