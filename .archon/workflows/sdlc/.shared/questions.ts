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
  return `Frage (technisch, Vorgabe ab ${due} UTC): ${text}\nVorgabe: ${fallback}`;
}

/** Openings only the pack's scripts or the owner may write; an agent's text with one is refused. */
export function reservedText(text: string): boolean {
  const t = text.trimStart();
  return (
    /^Loop (claim|result|review):/.test(t) ||
    t.startsWith('Julian:') ||
    t.startsWith('Vorgabe angewendet:') ||
    RUN_LINE.test(text)
  );
}

export interface Question {
  readonly comment: TicketComment;
  readonly kind: QuestionKind | 'ohne';
  readonly byRun: boolean;
  readonly fallback: string;
  readonly answer: TicketComment | null;
}

export function ownerWord(comment: TicketComment, config: TrackerConfig): boolean {
  const body = comment.body.trimStart();
  if (/^:flag_(on|off):/.test(body)) return false;
  if (comment.author === config.owner) return true;
  return comment.author === config.assignee && body.startsWith('Julian:');
}

function isQuestion(comment: TicketComment, config: TrackerConfig): boolean {
  return comment.author === config.assignee && comment.body.trimStart().startsWith('@');
}

/** The ticket's latest question and the owner's first answer after it; null when none was asked. */
export function lastQuestion(comments: readonly TicketComment[], config: TrackerConfig): Question | null {
  const sorted = [...comments].sort((a, b) => a.id - b.id);
  const at = sorted.map(comment => isQuestion(comment, config)).lastIndexOf(true);
  const comment = sorted[at];
  if (comment === undefined) return null;
  const head = /Frage \((technisch|Produkt)[^)]*\):/.exec(comment.body);
  return {
    comment,
    kind: head === null ? 'ohne' : head[1] === 'technisch' ? 'technisch' : 'produkt',
    byRun: RUN_LINE.test(comment.body),
    fallback: /^Vorgabe: (.+)$/m.exec(comment.body)?.[1]?.trim() ?? '',
    answer: sorted.slice(at + 1).find(c => ownerWord(c, config)) ?? null,
  };
}

/** AK18k: an unanswered technical question with a default, 24 hours after it was asked. */
export function defaultDue(q: Question, now: number): boolean {
  return q.kind === 'technisch' && q.fallback !== '' && q.answer === null && now >= q.comment.createdAt + DEFAULT_AFTER_MS;
}

/**
 * AK18i: the manager lifts a flag only once the owner answered, or for a run's own question
 * that is neither about the product (waits for the owner) nor technical (waits for its default).
 */
export function mayUnflag(q: Question | null): boolean {
  if (q === null) return false;
  if (q.answer !== null) return true;
  return q.byRun && q.kind === 'ohne';
}
