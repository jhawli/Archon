import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardAllMarkdown, rights, snapshotAll, writeBoardAll, type BoardAll } from '../../workflows/sdlc/.shared/board-all';
import type { Ticket, TicketComment } from '../../workflows/sdlc/.shared/jira';
import { CFG } from './jira-fixtures';

const NOW = Date.parse('2026-11-18T12:00:00Z');
function t(key: string, status: string, inOpenSprint: boolean, extra: Partial<Ticket> = {}): Ticket {
  return { key, url: `https://example.atlassian.net/browse/${key}`, title: `Titel ${key}`, body: `Text ${key}`, status,
    labels: [], flagged: false, assignee: CFG.assignee, inOpenSprint, updated: 0, ...extra };
}
const ALL: BoardAll = {
  tickets: [t('CONC-5', CFG.status.todo, true), t('CONC-12', CFG.status.staging, false), t('CONC-40', CFG.status.live, false), t('CONC-3', '10014', false)],
  comments: new Map(),
  own: new Map([['CONC-40', 'disc-0123456789abcdef']]),
};

describe('board-all.md', () => {
  const md = boardAllMarkdown(ALL, NOW, CFG);
  it('lists every status, Live and New included', () => {
    for (const key of ['CONC-5', 'CONC-12', 'CONC-40', 'CONC-3']) expect(md).toContain(`## ${key} `);
  });
  it('names where a ticket came from', () => {
    expect(md).toContain('Herkunft: eigen (disc-0123456789abcdef)');
    expect(md.split('## CONC-5 ')[1]).toContain('Herkunft: Julian');
  });
  it('states the manager’s rights per status (AK18i)', () => {
    expect(rights(CFG.status.todo, CFG.status)).toBe('alles');
    expect(rights(CFG.status.review, CFG.status)).toBe('review');
    for (const s of [CFG.status.progress, CFG.status.staging, CFG.status.live, CFG.status.canceled, '10014']) {
      expect(rights(s, CFG.status)).toBe('kommentar');
    }
    expect(md.split('## CONC-12 ')[1]).toContain('Manager darf: nur kommentieren und fragen');
  });
  it('shows New by name', () => {
    expect(md.split('## CONC-3 ')[1]).toContain('Status: New oder anderer (10014)');
  });
  it('records keys and statuses where agents cannot write', () => {
    const state = mkdtempSync(join(tmpdir(), 'state-'));
    writeBoardAll(ALL, NOW, CFG, mkdtempSync(join(tmpdir(), 'art-')), state);
    const kept = JSON.parse(readFileSync(join(state, 'keys-all.json'), 'utf8'));
    expect(Object.keys(kept)).toEqual(['CONC-5', 'CONC-12', 'CONC-40', 'CONC-3']);
    expect(kept['CONC-40']).toEqual({ status: CFG.status.live, title: 'Titel CONC-40', own: 'disc-0123456789abcdef' });
    expect(kept['CONC-5'].own).toBe('');
  });
  it('marks answered questions the manager owes this pass (AK18l), only on To Do and Review', () => {
    const at = (iso: string): { created: string; createdAt: number } => ({ created: iso, createdAt: Date.parse(iso) });
    const q = (key: string): TicketComment => ({ id: 1, body: '@Julian Frage (Produkt): A oder B?', ...at('2026-11-17T10:00:00.000Z'), author: CFG.assignee, url: `u/${key}` });
    const a = (key: string): TicketComment => ({ id: 2, body: 'B', ...at('2026-11-17T11:00:00.000Z'), author: CFG.owner, url: `u/${key}` });
    const all: BoardAll = {
      tickets: [t('CONC-7', CFG.status.todo, true, { flagged: true }), t('CONC-8', CFG.status.todo, true, { flagged: true }), t('CONC-9', CFG.status.staging, false, { flagged: true }), t('CONC-10', CFG.status.todo, true, { flagged: true })],
      comments: new Map([
        ['CONC-7', [q('CONC-7'), a('CONC-7')]],
        ['CONC-8', [q('CONC-8')]],
        ['CONC-9', [q('CONC-9'), a('CONC-9')]],
        ['CONC-10', [q('CONC-10'), a('CONC-10'), { id: 3, body: ':flag_on: Flag added', ...at('2026-11-17T12:00:00.000Z'), author: CFG.owner, url: 'u/CONC-10' }]],
      ]),
      own: new Map(),
    };
    const state = mkdtempSync(join(tmpdir(), 'state-'));
    writeBoardAll(all, NOW, CFG, mkdtempSync(join(tmpdir(), 'art-')), state);
    const kept = JSON.parse(readFileSync(join(state, 'keys-all.json'), 'utf8'));
    expect([kept['CONC-7']?.answered, kept['CONC-8']?.answered, kept['CONC-9']?.answered, kept['CONC-10']?.answered]).toEqual([true, undefined, undefined, undefined]);
    expect(boardAllMarkdown(all, NOW, CFG)).toContain('Beantwortet, diesen Durchgang umsetzen: CONC-7');
  });
  it('a due default shows only on a flagged ticket: without the flag there is nothing to apply', () => {
    const tech = '@Julian Frage (technisch, Vorgabe ab 2026-11-17 10:00 UTC): Cache leeren?\nVorgabe: leeren\n\nLauf: archon archon-manager r1';
    const c = (key: string): TicketComment => ({ id: 1, body: tech, created: '2026-11-16T10:00:00.000Z', createdAt: Date.parse('2026-11-16T10:00:00.000Z'), author: CFG.assignee, url: `u/${key}` });
    const all: BoardAll = {
      tickets: [t('CONC-20', CFG.status.todo, true, { flagged: true }), t('CONC-21', CFG.status.todo, true, { flagged: false })],
      comments: new Map([['CONC-20', [c('CONC-20')]], ['CONC-21', [c('CONC-21')]]]),
      own: new Map(),
    };
    const md = boardAllMarkdown(all, NOW, CFG);
    const block = (key: string): string => md.slice(md.indexOf(`## ${key} `)).split('\n## ')[0] ?? '';
    expect(block('CONC-20')).toContain('Vorgabe fällig');
    expect(block('CONC-21')).not.toContain('Vorgabe fällig');
  });
  it('a snapshot whose answered is not true is refused', () => {
    const state = mkdtempSync(join(tmpdir(), 'state-'));
    writeFileSync(join(state, 'keys-all.json'), JSON.stringify({ 'CONC-5': { status: '1', title: 'x', own: '', answered: false } }));
    expect(() => snapshotAll(state)).toThrow('answered');
  });
});
