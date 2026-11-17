import { describe, expect, it } from 'bun:test';
import type { TicketComment } from '../../workflows/sdlc/.shared/jira';
import {
  askedBefore,
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
  it('flagged again after the answer: that hold is someone else’s, not the answer’s', () => {
    const q = asked([c(11, ARCHON, PRODUCT), c(12, JULIAN, 'Hinweis zeigen'), c(13, JULIAN, ':flag_on: Flag added')]);
    expect(q.reflagged).toBe(true);
    expect(mayUnflag(q)).toBe(false);
  });
});

describe('a question the default or a new flag settled', () => {
  it('a flag note before the answer is not a new hold: the answer still counts', () => {
    const q = asked([c(11, ARCHON, PRODUCT), c(12, JULIAN, ':flag_on: Flag added'), c(13, JULIAN, 'Hinweis zeigen')]);
    expect(q.reflagged).toBe(false);
    expect(mayUnflag(q)).toBe(true);
  });
  it('an applied default closes the question: no second default', () => {
    const q = asked([c(10, ARCHON, TECH), c(14, ARCHON, `Vorgabe angewendet: Cache beim Start leeren\n\nkeine Antwort\n\n${runLine('archon-manager', 'run2')}`, MON_10 + 25 * H)]);
    expect(q.applied).toBe(true);
    expect(defaultDue(q, MON_10 + 48 * H)).toBe(false);
  });
  it('a technical question flagged again by hand waits for Julian, not for its default', () => {
    expect(defaultDue(asked([c(10, ARCHON, TECH), c(15, JULIAN, ':flag_on: Flag added', MON_10 + H)]), MON_10 + 48 * H)).toBe(false);
  });
  it('a default over several lines is read whole', () => {
    const body = `@Julian Hawlicek ${questionText('technisch', 'Cache?', 'Cache leeren\nund den Test anpassen', MON_10)}\n${runLine('archon-manager', 'run1')}`;
    expect(asked([c(10, ARCHON, body)]).fallback).toBe('Cache leeren und den Test anpassen');
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
  it('agents may not write what reads as Jira’s flag note: it would hide an answer from the manager', () => {
    for (const text of [':flag_on: noch offen', '  :flag_off: erledigt']) expect(reservedText(text)).toBe(true);
    expect(reservedText('Markierung :flag_on: bleibt')).toBe(false);
  });
  it('a plain comment may quote a question: only a comment opening with a mention is one', () => {
    const quote = 'Die Frage (Produkt) auf CONC-4 ist noch offen.\nVorgabe: siehe dort';
    expect(reservedText(quote)).toBe(false);
    expect(reservedQuestion(quote)).toBe(true);
    // A run line stays reserved in every text (decision 3), quoted or not.
    expect(reservedText('Wie im letzten Ergebnis:\nLauf: archon archon-loop abc')).toBe(true);
  });
});

describe('a rerun asks once', () => {
  const ask = 'Gemergt, aber der Staging-Rollout ist nicht bestätigt.';
  const asked1 = c(5, ARCHON, `@Julian Hawlicek ${ask}\n\n${runLine('archon-merge-queue', 'r1')}`);
  it('the same question of the same run is already on the ticket', () => {
    expect(askedBefore([asked1], ask, runLine('archon-merge-queue', 'r1'), CFG)).toBe(true);
  });
  it('another run, or another question, asks again', () => {
    expect(askedBefore([asked1], ask, runLine('archon-merge-queue', 'r2'), CFG)).toBe(false);
    expect(askedBefore([asked1], 'Was fehlt noch?', runLine('archon-merge-queue', 'r1'), CFG)).toBe(false);
  });
});
