/**
 * Questions to the owner on a ticket and what became of them (AK18a, AK18i to AK18l).
 *
 * Everything in Jira is written by the pack's account, sessions included, so authorship tells
 * nothing. A question is a comment of that account that mentions the owner first. A run of this
 * pack marks what it writes with a `Lauf:` line; the owner's answer is a comment of his own
 * account, or one a session relays with a leading `Julian:`. The manager's questions carry their
 * kind and default in a fixed first line; the default falls due 24 hours after the comment's
 * `created`, never after a time written in the text.
 */
import type { TicketComment, TrackerConfig } from './jira.ts';

export const DEFAULT_AFTER_MS = 24 * 3_600_000;
export type QuestionKind = 'technisch' | 'produkt';

export function runLine(workflow: string, run: string): string {
  return `Lauf: archon ${workflow} ${run}`;
}
const RUN_LINE = /^Lauf: archon [a-z-]+ [A-Za-z0-9_-]+$/m;

export function questionText(kind: QuestionKind, text: string, fallback: string, askedAt: number): string {
  if (kind === 'produkt') return `Frage (Produkt): ${text}`;
  const due = new Date(askedAt + DEFAULT_AFTER_MS).toISOString().slice(0, 16).replace('T', ' ');
  // One line: `lastQuestion` reads the default back from the `Vorgabe:` line alone.
  return `Frage (technisch, Vorgabe ab ${due} UTC): ${text}\nVorgabe: ${fallback.replace(/\s+/g, ' ').trim()}`;
}

/**
 * What only the pack's scripts or the owner may write; an agent's text with it is refused: a loop
 * record, the owner's word, an applied default, a run line in any line (decision 3), a mention
 * first, which makes a comment a question, and Jira's flag note, which `lastQuestion` reads as a
 * new hold.
 */
export function reservedText(text: string): boolean {
  const t = text.trimStart();
  return (
    /^Loop (claim|result|review|wait|wait ended):/.test(t) ||
    t.startsWith('@') ||
    t.startsWith('Julian:') ||
    t.startsWith('Vorgabe angewendet:') ||
    /^:flag_(on|off):/.test(t) ||
    RUN_LINE.test(text)
  );
}

/**
 * The text of a question (an `ask`): also no `Frage (…)` head and no `Vorgabe:` line, since a
 * question's kind and default are read from those and only `questionText` writes them. A plain
 * comment may quote them: it is never read as a question.
 */
export function reservedQuestion(text: string): boolean {
  return reservedText(text) || /^Vorgabe: /m.test(text) || /Frage \((?:technisch|Produkt)/.test(text);
}

export interface Question {
  readonly comment: TicketComment;
  readonly kind: QuestionKind | 'ohne';
  readonly byRun: boolean;
  readonly fallback: string;
  readonly answer: TicketComment | null;
  /** The pack applied the default after the question (`Vorgabe angewendet:`): nothing is due any more. */
  readonly applied: boolean;
  /**
   * Flagged again after the question or its answer (Jira's `:flag_on:` note) without a new
   * question: that flag is someone else's hold, which neither the answer nor the default lifts.
   */
  readonly reflagged: boolean;
}

export function ownerWord(comment: TicketComment, config: TrackerConfig): boolean {
  const body = comment.body.trimStart();
  if (/^:flag_(on|off):/.test(body)) return false;
  if (comment.author === config.owner) return true;
  return comment.author === config.assignee && body.startsWith('Julian:');
}

/** What land writes after a merge that loosened a check (CONC-109): it mentions the owner but asks nothing. */
export const LOOSENED_NOTE = 'Gelockerte Tests (mit Befund gemergt):';
export const loosenedNote = (loosened: string): string => `${LOOSENED_NOTE} ${loosened}`;

function isQuestion(comment: TicketComment, config: TrackerConfig): boolean {
  const body = comment.body.trimStart();
  return comment.author === config.assignee && body.startsWith('@') && !(body.split('\n')[0] ?? '').includes(LOOSENED_NOTE);
}

/** The ticket's latest question and the owner's first answer after it; null when none was asked. */
export function lastQuestion(comments: readonly TicketComment[], config: TrackerConfig): Question | null {
  const sorted = [...comments].sort((a, b) => a.id - b.id);
  const at = sorted.map(comment => isQuestion(comment, config)).lastIndexOf(true);
  const comment = sorted[at];
  if (comment === undefined) return null;
  const head = /Frage \((technisch|Produkt)[^)]*\):/.exec(comment.body);
  const after = sorted.slice(at + 1);
  const answer = after.find(c => ownerWord(c, config)) ?? null;
  const since = answer?.id ?? comment.id;
  return {
    comment,
    kind: head === null ? 'ohne' : head[1] === 'technisch' ? 'technisch' : 'produkt',
    byRun: RUN_LINE.test(comment.body),
    fallback: /^Vorgabe: (.+)$/m.exec(comment.body)?.[1]?.trim() ?? '',
    answer,
    applied: after.some(c => c.author === config.assignee && c.body.trimStart().startsWith('Vorgabe angewendet:')),
    reflagged: after.some(c => c.id > since && c.body.trimStart().startsWith(':flag_on:')),
  };
}

/** True when the ticket already carries this question of this run (`line`): a rerun asks once. */
export function askedBefore(comments: readonly TicketComment[], text: string, line: string, config: TrackerConfig): boolean {
  const first = text.split('\n')[0]?.trim() ?? '';
  return comments.some(c => isQuestion(c, config) && c.body.includes(first) && c.body.includes(line));
}

/** AK18k: an unanswered technical question with a default, 24 hours after it was asked. */
export function defaultDue(q: Question, now: number): boolean {
  return (
    q.kind === 'technisch' &&
    q.fallback !== '' &&
    q.answer === null &&
    !q.applied &&
    !q.reflagged &&
    now >= q.comment.createdAt + DEFAULT_AFTER_MS
  );
}

/**
 * AK18i: the manager lifts a flag only once the owner answered, or for a run's own question
 * that is neither about the product (waits for the owner) nor technical (waits for its default).
 */
export function mayUnflag(q: Question | null): boolean {
  if (q === null || q.reflagged) return false;
  if (q.answer !== null) return true;
  return q.byRun && q.kind === 'ohne';
}
