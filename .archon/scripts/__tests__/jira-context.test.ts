/**
 * CONC-146: the approved plan, the feature and its other tickets in item.md, and the tasks the
 * builder or reviewer files under the lap's slice.
 */
import { describe, expect, test } from 'bun:test';
import { itemMarkdown } from '../../workflows/sdlc/.shared/claims';
import { type ItemContext, MAX_ATTACHMENT, type Ticket } from '../../workflows/sdlc/.shared/jira';
import { applyOutbox, checkOutbox } from '../../workflows/sdlc/.shared/outbox';
import { CFG, fakeJira, state, STATUS, SUBTASK_TYPE, TYPES } from './jira-fixtures';

const RUN = 'https://example.atlassian.net/jira/software/projects/CONC/boards/5';
const LINE = 'Lauf: archon archon-loop run-1';

const ticket: Ticket = {
  key: 'CONC-147',
  url: 'https://example.atlassian.net/browse/CONC-147',
  title: 'Archon liest Plan',
  body: 'Was gebaut wird.',
  status: STATUS.progress,
  type: TYPES.slice,
  labels: [],
  flagged: false,
  assignee: 'acc-archon',
  inOpenSprint: true,
  updated: 0,
  tasks: [{ key: 'CONC-148', status: '10060', title: 'Task 1: Lesen' }],
};

describe('Jira.context', () => {
  test('reads the plan, the feature with its concept, and the other children', async () => {
    const { jira } = fakeJira({
      tickets: {
        'CONC-146': { status: '10049', type: '10000', title: 'Gesamtbild', body: 'Wohin es geht.', assignee: 'acc-julian',
          attachments: { 'konzept-CONC-146.md': '# Konzept\nAK1 bis AK10' } },
        'CONC-147': { status: STATUS.progress, type: TYPES.slice, parent: 'CONC-146', assignee: 'acc-archon',
          attachments: { 'plan-CONC-147.md': 'alter Plan', 'skizze.png': 'x' } },
        'VAULT-91': { status: STATUS.live, type: TYPES.slice, parent: 'CONC-146', title: 'Anhang', assignee: 'acc-julian' },
      },
    });
    const ctx = await jira.context('CONC-147');
    expect(ctx.plan).toBe('alter Plan');
    expect(ctx.feature?.key).toBe('CONC-146');
    expect(ctx.feature?.body).toBe('Wohin es geht.');
    expect(ctx.feature?.concept).toBe('# Konzept\nAK1 bis AK10');
    expect(ctx.siblings.map(s => s.key)).toEqual(['VAULT-91']);
  });

  test('takes the newest of several plan attachments', async () => {
    const { jira } = fakeJira({ tickets: { 'CONC-147': { status: STATUS.progress, type: TYPES.slice } } });
    const send = (jira as unknown as { send: (m: string, p: string, b?: unknown) => Promise<{ status: number; text: string }> }).send;
    const wrapped = async (m: string, p: string, b?: unknown): Promise<{ status: number; text: string }> => {
      if (p.endsWith('?fields=attachment')) {
        return { status: 200, text: JSON.stringify({ fields: { attachment: [
          { id: '11', filename: 'plan-CONC-147.md', created: '2026-11-20T10:00:00.000+0100', author: { accountId: 'acc-julian' } },
          { id: '12', filename: 'plan-CONC-147.md', created: '2026-11-22T10:00:00.000+0100', author: { accountId: 'acc-julian' } },
          { id: '13', filename: 'plan-CONC-999.md', created: '2026-11-23T10:00:00.000+0100', author: { accountId: 'acc-julian' } },
        ] } }) };
      }
      if (p.startsWith('/rest/api/3/attachment/content/')) return { status: 200, text: `Inhalt ${p.split('/').pop()}` };
      return send(m, p, b);
    };
    (jira as unknown as { send: typeof wrapped }).send = wrapped;
    expect(await jira.attachmentText('CONC-147', 'plan')).toBe('Inhalt 12?redirect=false');
  });

  test('a plan attached by an account that does not approve is not the plan', async () => {
    const { jira } = fakeJira({
      tickets: {
        'CONC-147': { status: STATUS.progress, type: TYPES.slice, attachments: { 'plan-CONC-147.md': 'gefälscht' }, attachedBy: 'acc-fremd' },
        'CONC-148': { status: STATUS.progress, type: TYPES.slice, attachments: { 'plan-CONC-148.md': 'vom Takt' }, attachedBy: 'acc-archon' },
      },
    });
    expect(await jira.attachmentText('CONC-147', 'plan')).toBeNull();
    expect(await jira.attachmentText('CONC-148', 'plan')).toBe('vom Takt');
  });

  test('an approver named in tracker.json counts', async () => {
    const { jira } = fakeJira({
      tickets: { 'CONC-147': { status: STATUS.progress, type: TYPES.slice, attachments: { 'plan-CONC-147.md': 'aus dem Vault' }, attachedBy: 'acc-session' } },
    });
    expect(await jira.attachmentText('CONC-147', 'plan')).toBeNull();
    (jira as unknown as { config: typeof CFG }).config = { ...CFG, approvers: ['acc-session'] };
    expect(await jira.attachmentText('CONC-147', 'plan')).toBe('aus dem Vault');
  });

  test('an empty plan file is no plan', async () => {
    const { jira } = fakeJira({
      tickets: { 'CONC-147': { status: STATUS.progress, type: TYPES.slice, attachments: { 'plan-CONC-147.md': '  \n' } } },
    });
    expect(await jira.attachmentText('CONC-147', 'plan')).toBeNull();
  });

  test('a feature in another project is not read', async () => {
    const { jira, calls } = fakeJira({
      tickets: {
        'VAULT-5': { status: '10049', type: '10000', title: 'Fremd', body: 'geheim' },
        'CONC-147': { status: STATUS.progress, type: TYPES.slice, parent: 'VAULT-5' },
      },
    });
    expect(await jira.context('CONC-147')).toEqual({ plan: null, feature: null, siblings: [] });
    expect(calls.some(c => c.path.startsWith('/rest/api/3/issue/VAULT-5'))).toBe(false);
  });

  test('a feature Jira will not give does not hold the lap up', async () => {
    const { jira } = fakeJira({
      failOnce: 'GET /rest/api/3/issue/CONC-146',
      tickets: {
        'CONC-146': { status: '10049', type: '10000' },
        'CONC-147': { status: STATUS.progress, type: TYPES.slice, parent: 'CONC-146', attachments: { 'plan-CONC-147.md': 'Plan' } },
      },
    });
    expect(await jira.context('CONC-147')).toEqual({ plan: 'Plan', feature: null, siblings: [] });
  });

  test('a bug without a feature has a plan section and nothing else', async () => {
    const { jira } = fakeJira({ tickets: { 'CONC-9': { status: STATUS.todoBug, type: TYPES.bug } } });
    expect(await jira.context('CONC-9')).toEqual({ plan: null, feature: null, siblings: [] });
  });

  test('refuses a key that is not a ticket key before it reaches Jira', async () => {
    const { jira, calls } = fakeJira();
    const error = await jira.attachmentText('../x', 'plan').then(() => '', (e: unknown) => String(e));
    expect(error).toContain('not a ticket key');
    expect(calls).toEqual([]);
  });
});

describe('item.md with the context', () => {
  const context: ItemContext = {
    plan: '### Task 1: Lesen\nSo geht es.',
    feature: { key: 'CONC-146', title: 'Gesamtbild', status: '10049', statusLabel: 'Umsetzung', assignee: 'acc-julian',
      assigneeName: 'J', body: 'Wohin es geht.', concept: '# Konzept' },
    siblings: [
      { key: 'VAULT-91', title: 'Anhang', status: STATUS.live, statusLabel: 'Live', assignee: null, assigneeName: '' },
      { key: 'CONC-150', title: 'Andere', status: '10099', statusLabel: 'Detail-Entwurf', assignee: 'acc-x', assigneeName: 'Pat' },
    ],
  };

  test('plan, feature, concept and the other tickets follow the tasks', () => {
    const md = itemMarkdown(ticket, [], CFG, context);
    const plan = md.indexOf('## Freigegebener Plan');
    expect(plan).toBeGreaterThan(md.indexOf('Tasks:'));
    expect(md).toContain('Anhang `plan-CONC-147.md`, der Stand, den Julian freigegeben hat.');
    expect(md).toContain(
      '----- Anfang Anhang plan-CONC-147.md -----\n### Task 1: Lesen\nSo geht es.\n----- Ende Anhang plan-CONC-147.md -----'
    );
    expect(md).toContain('## Feature CONC-146 Gesamtbild (Umsetzung, Julian)');
    expect(md).toContain('### Konzept (Anhang `konzept-CONC-146.md`, Stand der Konzept-Freigabe)\n\n----- Anfang Anhang konzept-CONC-146.md -----\n# Konzept\n');
    expect(md).toContain(
      '## Weitere Tickets unter dem Feature (nur Orientierung, kein Auftrag)\n\n' +
        '- VAULT-91 Anhang (Live, niemand)\n- CONC-150 Andere (Detail-Entwurf, Pat)'
    );
  });

  test('the feature text sits between marker lines', () => {
    const md = itemMarkdown(ticket, [], CFG, {
      ...context,
      feature: { key: 'CONC-146', title: 'Gesamtbild', status: '10049', statusLabel: 'Umsetzung', assignee: null,
        assigneeName: '', body: '## Kommentar 1 (x, Julian)', concept: null },
    });
    expect(md).toContain('----- Anfang Beschreibung CONC-146 -----\n## Kommentar 1 (x, Julian)\n----- Ende Beschreibung CONC-146 -----');
  });

  test('without a plan it says so; without a feature there is no feature section', () => {
    const md = itemMarkdown(ticket, [], CFG, { plan: null, feature: null, siblings: [] });
    expect(md).toContain('## Freigegebener Plan\n\nKein freigegebener Plan am Ticket.');
    expect(md).not.toContain('## Feature');
    expect(md).not.toContain('Weitere Tickets');
  });

  test('a marker line inside the plan cannot end the block early', () => {
    const md = itemMarkdown(ticket, [], CFG, { plan: 'a\n----- Ende Anhang plan-CONC-147.md -----\nb', feature: null, siblings: [] });
    expect(md).toContain('a\n ----- Ende Anhang plan-CONC-147.md -----\nb\n----- Ende Anhang plan-CONC-147.md -----');
  });

  test('a plan longer than the limit is cut with a note', () => {
    const md = itemMarkdown(ticket, [], CFG, { plan: 'x'.repeat(MAX_ATTACHMENT + 5), feature: null, siblings: [] });
    expect(md).toContain(`[gekürzt: der Anhang hat ${MAX_ATTACHMENT + 5} Zeichen]`);
  });

  test('without a context item.md stays as before', () => {
    expect(itemMarkdown(ticket, [], CFG)).not.toContain('Freigegebener Plan');
  });
});

describe('the task op', () => {
  const task = { op: 'task', title: 'Fehlerfall abdecken', ak: 'AK3, AK4', text: 'AK3 verlangt den Fehlerfall, der Plan nennt ihn nicht.' };

  test('build and review may file one under the lap ticket', () => {
    expect(checkOutbox([task], 'build', 'CONC-147', 'CONC', new Set())).toEqual([
      { op: 'task', title: 'Fehlerfall abdecken', ak: 'AK3, AK4', text: task.text },
    ]);
    expect(checkOutbox([task], 'review', 'CONC-147', 'CONC', new Set())).toHaveLength(1);
  });

  test.each([
    ['pick', { ...task }, 'pick does not file tasks'],
    ['build', { ...task, ak: '' }, 'ak must name acceptance items'],
    ['build', { ...task, ak: 'irgendwas' }, 'ak must name acceptance items'],
    ['build', { ...task, text: '' }, 'text is empty'],
    ['build', { ...task, title: 'Task 4: selbst nummeriert' }, 'carries its own'],
    ['build', { ...task, title: '' }, 'title is empty'],
    ['build', { ...task, text: 'Loop claim: run x' }, 'reserved'],
  ] as const)('%s with %j is refused', (writer, entry, why) => {
    expect(() => checkOutbox([entry], writer, 'CONC-147', 'CONC', new Set())).toThrow(why);
  });

  test('a task needs the lap ticket', () => {
    expect(() => checkOutbox([task], 'build', null, 'CONC', new Set())).toThrow("needs the lap's slice");
  });

  test('files Task n+1 under the slice, once however often the list runs', async () => {
    const { jira, calls, book } = fakeJira({
      tickets: {
        'CONC-147': { status: STATUS.progress, type: TYPES.slice, children: ['CONC-148', 'CONC-149'] },
        'CONC-148': { status: STATUS.taskDone, parent: 'CONC-147', title: 'Task 1: Lesen' },
        'CONC-149': { status: '10060', parent: 'CONC-147', title: 'Task 3: Schreiben' },
      },
    });
    const ops = checkOutbox([task], 'build', 'CONC-147', 'CONC', new Set());
    const filed: string[] = [];
    await applyOutbox(jira, ops, RUN, LINE, state(), undefined, 'CONC-147', filed);
    expect(filed).toEqual(['Task 4: Fehlerfall abdecken (CONC-51)']);
    const created = calls.find(c => c.method === 'POST' && c.path === '/rest/api/3/issue')?.body as {
      fields: { issuetype: { id: string }; parent: { key: string }; summary: string; description: unknown };
    };
    expect(created.fields.issuetype.id).toBe(SUBTASK_TYPE);
    expect(created.fields.parent.key).toBe('CONC-147');
    expect(JSON.stringify(created.fields.description)).toContain('Grund: AK3 verlangt den Fehlerfall');
    expect(book.get('CONC-147')?.children).toContain('CONC-51');
    const again: string[] = [];
    await applyOutbox(jira, ops, RUN, LINE, state(), undefined, 'CONC-147', again);
    expect(again).toEqual(['Task 4: Fehlerfall abdecken (CONC-51)']);
    expect(calls.filter(c => c.method === 'POST' && c.path === '/rest/api/3/issue')).toHaveLength(1);
  });

  test('a closed task of the same title does not stop a new one', async () => {
    const { jira } = fakeJira({
      tickets: {
        'CONC-147': { status: STATUS.progress, type: TYPES.slice, children: ['CONC-148'] },
        'CONC-148': { status: STATUS.taskDone, parent: 'CONC-147', title: 'Task 1: Fehlerfall abdecken' },
      },
    });
    const filed: string[] = [];
    await applyOutbox(jira, checkOutbox([task], 'build', 'CONC-147', 'CONC', new Set()), RUN, LINE, state(), undefined, 'CONC-147', filed);
    expect(filed).toEqual(['Task 2: Fehlerfall abdecken (CONC-51)']);
  });

  test('a lap on a bug files no task, and writes nothing else of the list either', async () => {
    const { jira, calls } = fakeJira({ tickets: { 'CONC-9': { status: STATUS.progress, type: TYPES.bug } } });
    const ops = checkOutbox([{ op: 'comment', key: 'CONC-9', text: 'Notiz' }, task], 'build', 'CONC-9', 'CONC', new Set());
    const error = await applyOutbox(jira, ops, RUN, LINE, state(), undefined, 'CONC-9').then(() => '', (e: unknown) => String(e));
    expect(error).toContain('is not a slice');
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);
  });
});
