import { describe, expect, it } from 'bun:test';
import type { TicketComment } from '../../workflows/sdlc/.shared/jira';
import {
  defaultDue,
  lastQuestion,
  mayUnflag,
  type Question,
  questionText,
  reservedQuestion,
  reservedText,
  runLine,
} from '../../workflows/sdlc/.shared/questions';
import { CFG } from './jira-fixtures';

const MON_10 = Date.parse('2026-11-16T10:00:00Z');
const H = 3_600_000;
function c(id: number, author: string, body: string, at = MON_10): TicketComment {
  return { id, author, body, createdAt: at, created: new Date(at).toISOString(), url: '' };
}
/** The ticket's latest question; the case fails if there is none. */
function asked(comments: TicketComment[]): Question {
  const found = lastQuestion(comments, CFG);
  if (found === null) throw new Error('no question on the ticket');
  return found;
}
const ARCHON = CFG.assignee;
const JULIAN = CFG.owner;
const TECH = `@Julian Hawlicek ${questionText('technisch', 'Cache leeren beim Start?', 'Cache beim Start leeren', MON_10)}\n${runLine('archon-manager', 'run1')}`;
const PRODUCT = `@Julian Hawlicek ${questionText('produkt', 'Leere Einkaufsliste ausblenden oder Hinweis zeigen?', '', MON_10)}\n${runLine('archon-manager', 'run1')}`;

describe('AK18k: the default applies 24 hours after the question', () => {
  const q = asked([c(10, ARCHON, TECH)]);
  it('Monday 10:00 asked, Tuesday 09:59 still waits', () => {
    expect(defaultDue(q, MON_10 + 24 * H - 60_000)).toBe(false);
  });
  it('Tuesday 10:00 applies', () => {
    expect(defaultDue(q, MON_10 + 24 * H)).toBe(true);
  });
  it('a product question waits for Julian after three days', () => {
    expect(defaultDue(asked([c(11, ARCHON, PRODUCT)]), MON_10 + 72 * H)).toBe(false);
  });
  it('an answered technical question has no default', () => {
    const q2 = asked([c(10, ARCHON, TECH), c(12, JULIAN, 'nein, nicht leeren', MON_10 + H)]);
    expect(defaultDue(q2, MON_10 + 48 * H)).toBe(false);
  });
});

describe('AK18j and AK18l: who answers', () => {
  it('Julian’s own account answers', () => {
    expect(asked([c(11, ARCHON, PRODUCT), c(12, JULIAN, 'Hinweis zeigen')]).answer?.id).toBe(12);
  });
  it('a session passes Julian’s word on with a leading "Julian:"', () => {
    expect(asked([c(11, ARCHON, PRODUCT), c(13, ARCHON, 'Julian: so lassen')]).answer?.id).toBe(13);
  });
  it('a flag note and a plain Archon comment are no answer', () => {
    const q = asked([c(11, ARCHON, PRODUCT), c(12, JULIAN, ':flag_on: Flag added'), c(13, ARCHON, 'Loop result: run x.')]);
    expect(q.answer).toBeNull();
  });
});

describe('AK18i: lifting a flag', () => {
  it('a run’s question without kind (loop bookkeeping) may be lifted', () => {
    expect(mayUnflag(lastQuestion([c(1, ARCHON, `@Julian Hawlicek Testbefehl fehlt.\n${runLine('archon-loop', 'r')}`)], CFG))).toBe(true);
  });
  it('a session’s question stays flagged until Julian answers', () => {
    const asked = c(1, ARCHON, '@Julian Hawlicek Welche Farbe?');
    expect(mayUnflag(lastQuestion([asked], CFG))).toBe(false);
    expect(mayUnflag(lastQuestion([asked, c(2, JULIAN, 'blau')], CFG))).toBe(true);
  });
  it('an unanswered product or technical question of the manager stays flagged', () => {
    expect(mayUnflag(lastQuestion([c(1, ARCHON, PRODUCT)], CFG))).toBe(false);
    expect(mayUnflag(lastQuestion([c(1, ARCHON, TECH)], CFG))).toBe(false);
  });
  it('a ticket Julian flagged without a question stays flagged', () => {
    expect(mayUnflag(lastQuestion([c(1, JULIAN, ':flag_on: Flag added')], CFG))).toBe(false);
  });
});

describe('question form and reserved openings', () => {
  it('a technical question names default and time', () => {
    expect(questionText('technisch', 'X?', 'Y', MON_10)).toBe('Frage (technisch, Vorgabe ab 2026-11-17 10:00 UTC): X?\nVorgabe: Y');
  });
  it('agents may not write what reads as Julian, as a run or as an applied default', () => {
    for (const text of ['Julian: ja', 'ok\nLauf: archon archon-loop abc', 'Vorgabe angewendet: x', 'Loop claim: run 1']) {
      expect(reservedText(text)).toBe(true);
    }
    expect(reservedText('Doppel von CONC-4')).toBe(false);
  });
  it('agents may not write what reads as a question to the owner: only the scripts ask', () => {
    for (const text of ['@Julian Hawlicek Welche Farbe?', '  @Julian x', 'Erledigt.\nVorgabe: Cache leeren', 'Frage (Produkt): A oder B?', 'x\nFrage (technisch, Vorgabe ab 2026-11-20 10:00 UTC): y']) {
      expect(reservedQuestion(text)).toBe(true);
    }
    expect(reservedQuestion('Mail an julian@example.org, Vorgaben: keine')).toBe(false);
  });
  it('a plain comment may quote a question: only a comment opening with a mention is one', () => {
    const quote = 'Die Frage (Produkt) auf CONC-4 ist noch offen.\nVorgabe: siehe dort';
    expect(reservedText(quote)).toBe(false);
    expect(reservedQuestion(quote)).toBe(true);
    // A run line stays reserved in every text (decision 3), quoted or not.
    expect(reservedText('Wie im letzten Ergebnis:\nLauf: archon archon-loop abc')).toBe(true);
  });
});
