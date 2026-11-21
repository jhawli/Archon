import { describe, expect, it } from 'bun:test';
import { adf, plain } from '../../workflows/sdlc/.shared/jira';
import { bugReady, missingSections } from '../../workflows/sdlc/.shared/bug-ready';
import { TYPES } from './jira-fixtures';

const BUG = TYPES.bug;
const ticket = (type: string, body: string) => ({ type, body });

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
  it('a slice is never held by this rule', () => {
    expect(bugReady(ticket(TYPES.slice, 'nichts'), BUG)).toBe(true);
  });
});
