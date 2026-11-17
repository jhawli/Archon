/**
 * Every ticket of the project for the agents that look across the board (manager, backlog,
 * discoveries): all statuses, Live and Canceled included, with comments, origin, the open
 * question and what the manager may do. Keys and statuses also go to the run's state
 * directory (`keys-all.json`, where agents cannot write): the allowlist the script publishers
 * check agent-written targets against.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorName, statusName } from './claims.ts';
import { note } from './io.ts';
import type { Jira, Ticket, TicketComment, TrackerConfig } from './jira.ts';
import { defaultDue, lastQuestion, type Question } from './questions.ts';

/** Past this the board still goes out, with a note: 200 tickets are about 260 KB. */
export const BOARD_WARN_BYTES = 300_000;

export interface BoardAll {
  readonly tickets: readonly Ticket[];
  readonly comments: ReadonlyMap<string, readonly TicketComment[]>;
  /** Tickets this pack filed: key → marker of their remote link. */
  readonly own: ReadonlyMap<string, string>;
}

export async function loadBoardAll(jira: Jira): Promise<BoardAll> {
  const c = jira.config;
  const sprint = new Set(
    (await jira.search(`project = ${c.project} AND sprint in openSprints()`, ['status'])).map(row => String(row.key))
  );
  const ranked = (await jira.search(`project = ${c.project} ORDER BY Rank ASC`)).map(raw =>
    jira.toTicket(raw, sprint.has(String(raw.key)))
  );
  const comments = new Map<string, readonly TicketComment[]>();
  const own = new Map<string, string>();
  for (const ticket of ranked) {
    comments.set(ticket.key, await jira.comments(ticket.key));
    const marker = await jira.ownMarker(ticket.key);
    if (marker !== null) own.set(ticket.key, marker);
  }
  return { tickets: [...ranked.filter(t => t.inOpenSprint), ...ranked.filter(t => !t.inOpenSprint)], comments, own };
}

export type Rights = 'alles' | 'review' | 'kommentar';

/** AK18i: To Do everything, Review sharpen and send back, every other status comment and ask. */
export function rights(status: string, s: TrackerConfig['status']): Rights {
  if (status === s.todo) return 'alles';
  if (status === s.review) return 'review';
  return 'kommentar';
}

const RIGHTS_TEXT: Record<Rights, string> = {
  alles: 'alles (umschreiben, verwerfen, Rang, fragen, fällige Vorgabe anwenden; Markierung heben nur bei beantworteter Frage oder Lauf-Frage ohne Art)',
  review: 'Review (kommentieren, fragen, Kriterien schärfen, fällige Vorgabe anwenden, Markierung heben wie bei To Do, nach geschlossenem PR zurück auf To Do)',
  kommentar: 'nur kommentieren und fragen',
};

function status(id: string, config: TrackerConfig): string {
  const name = statusName(id, config.status);
  return name.startsWith('status ') ? `New oder anderer (${id})` : name;
}

function questionLine(q: Question | null, now: number, flagged: boolean): string {
  if (q === null) return 'keine';
  const state = q.reflagged
    ? 'danach erneut markiert, ohne neue Frage'
    : q.answer !== null
      ? `beantwortet (Kommentar ${q.answer.id})`
      : q.applied
        ? 'Vorgabe angewendet'
        : flagged && defaultDue(q, now)
          ? 'offen, Vorgabe fällig'
          : 'offen';
  return `Kommentar ${q.comment.id}, ${q.kind === 'ohne' ? 'ohne Art' : q.kind}, von ${q.byRun ? 'einem Lauf' : 'einer Session'}, ${state}`;
}

/** AK18l: a flagged ticket on To Do or Review whose latest question the owner answered. */
function owed(t: Ticket, all: BoardAll, config: TrackerConfig): boolean {
  if (!t.flagged || (t.status !== config.status.todo && t.status !== config.status.review)) return false;
  const q = lastQuestion(all.comments.get(t.key) ?? [], config);
  // Flagged again after the answer without a new question: that flag is someone else's hold.
  if (q === null) return false;
  return q.answer !== null && !q.reflagged;
}

export function boardAllMarkdown(all: BoardAll, now: number, config: TrackerConfig): string {
  const due = all.tickets.filter(t => owed(t, all, config)).map(t => t.key);
  const lines = ['# Alle Tickets (erst der Sprint nach Rang, dann der Rest nach Rang)', '', `Stand: ${new Date(now).toISOString()}`, ''];
  if (due.length > 0) lines.push(`Beantwortet, diesen Durchgang umsetzen: ${due.join(', ')}`, '');
  let place = 0;
  for (const t of all.tickets) {
    const rows = all.comments.get(t.key) ?? [];
    const marker = all.own.get(t.key);
    lines.push(
      `## ${t.key} ${t.title}`,
      '',
      `URL: ${t.url}`,
      `Status: ${status(t.status, config)}`,
      `Rang: ${t.inOpenSprint ? `${(place += 1)} im Sprint` : 'nicht im Sprint'}`,
      `Herkunft: ${marker === undefined ? 'Julian' : `eigen (${marker})`}`,
      `Labels: ${t.labels.length > 0 ? t.labels.join(', ') : 'keine'}`,
      `Flagged: ${t.flagged ? 'ja' : 'nein'}`,
      `Frage: ${questionLine(lastQuestion(rows, config), now, t.flagged)}`,
      `Manager darf: ${RIGHTS_TEXT[rights(t.status, config.status)]}`,
      ''
    );
    if (t.body !== '') lines.push(t.body, '');
    for (const row of rows) {
      lines.push(`### Kommentar ${row.id} (${row.created}, ${authorName(row.author, config)})`, '', row.body, '');
    }
  }
  return lines.join('\n');
}

/** `$ARTIFACTS_DIR/tracker/board-all.md` for the agents, `keys-all.json` in the state directory. */
export function writeBoardAll(all: BoardAll, now: number, config: TrackerConfig, artifacts: string, state: string): string {
  const dir = join(artifacts, 'tracker');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'board-all.md');
  const text = boardAllMarkdown(all, now, config);
  writeFileSync(path, text);
  const bytes = Buffer.byteLength(text);
  if (bytes > BOARD_WARN_BYTES) note(`board-all.md has ${bytes} bytes (warning above ${BOARD_WARN_BYTES}); agents read it in parts.`);
  const kept = Object.fromEntries(
    all.tickets.map(x => [
      x.key,
      { status: x.status, title: x.title, own: all.own.get(x.key) ?? '', ...(owed(x, all, config) ? { answered: true } : {}) },
    ])
  );
  writeFileSync(join(state, 'keys-all.json'), `${JSON.stringify(kept, null, 2)}\n`);
  return path;
}

export interface Snapshot {
  readonly status: string;
  readonly title: string;
  readonly own: string;
  /** AK18l: flagged on To Do or Review, and the owner answered its latest question; the manager owes it this pass. */
  readonly answered?: true;
}

/** The allowlist `writeBoardAll` left for this run, as read then (no file: empty). */
export function snapshotAll(state: string): Record<string, Snapshot> {
  const path = join(state, 'keys-all.json');
  if (!existsSync(path)) return {};
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${path} is not an object of tickets`);
  for (const [key, value] of Object.entries(raw)) {
    // Read as untyped JSON: the file is checked here, not trusted.
    const v = (value ?? {}) as Record<string, unknown>;
    if (typeof v.status !== 'string' || typeof v.title !== 'string' || typeof v.own !== 'string') throw new Error(`${path}: ${key} has no status, title and own`);
    if (v.answered !== undefined && v.answered !== true) throw new Error(`${path}: ${key} answered must be true or absent`);
  }
  return raw as Record<string, Snapshot>;
}
