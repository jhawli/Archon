/**
 * The manager's writes (AK18i to AK18m). Its outbox is parsed (`parseManagerOutbox`), then the
 * whole list is checked against the tickets as Jira has them now (`checkManagerOps`), simulating
 * each entry's effect on the next, before the first write (`applyManagerOps`). Five new and five
 * rewritten tickets per pass; beyond that the entries are dropped and named, everything else
 * that breaks a rule refuses the list.
 */
import { rights, type Snapshot } from './board-all.ts';
import { statusName } from './claims.ts';
import { adf, type Jira, type TrackerConfig } from './jira.ts';
import { createTicket, outboxCursor, outboxProgress, type PrText } from './outbox.ts';
import { defaultDue, lastQuestion, mayUnflag, type Question, type QuestionKind, questionText, reservedText } from './questions.ts';
import { prKeys } from './tickets.ts';

export const MANAGER_CAP = 5;
const MAX_ENTRIES = 40;
const MAX_TEXT = 30_000;

export interface AskSpec {
  readonly text: string;
  readonly kind: QuestionKind;
  readonly fallback: string;
  /** AK18j: two to six options, and the recommendation, which is one of them. */
  readonly options: readonly string[];
  readonly recommendation: string;
}

/** AK18j: the question as the owner reads it, with its options and the recommendation. */
export function askBody(a: AskSpec): string {
  return `${a.text}\nOptionen: ${a.options.join(' | ')}\nEmpfehlung: ${a.recommendation}`;
}
export type ManagerOp =
  | { readonly op: 'comment' | 'cancel' | 'todo' | 'unflag' | 'default'; readonly key: string; readonly text: string }
  | { readonly op: 'ask'; readonly key: string; readonly ask: AskSpec }
  | { readonly op: 'create'; readonly marker: string; readonly title: string; readonly text: string; readonly ask: AskSpec | null; readonly top: boolean }
  | { readonly op: 'rewrite'; readonly key: string; readonly text: string; readonly reason: string }
  | { readonly op: 'rank'; readonly key: string; readonly before: string | null; readonly after: string | null; readonly top: boolean; readonly text: string };

export interface Live {
  readonly status: string;
  readonly flagged: boolean;
  /** Filed by this pack (remote link `archon:<PROJECT>:…`). */
  readonly own: boolean;
  readonly body: string;
  readonly question: Question | null;
  /** An open pull request of this repository names the ticket. */
  readonly prOpen: boolean;
}

/** Links to concept documents: a `Konzept:` line or any URL into an `Ideas/` or `konzepte/` folder. */
export function conceptLinks(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/\S+?\/(?:Ideas|konzepte)\/[^\s)\]]+/g) ?? [])];
}

function words(e: Record<string, unknown>, field: string, where: string, max = MAX_TEXT): string {
  const raw = e[field];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '' || value.length > max) throw new Error(`${where}: ${field} is empty or longer than ${max}`);
  if (reservedText(value)) throw new Error(`${where}: ${field} opens like a record of the loop or of the owner, which is reserved`);
  return value;
}

function askSpec(raw: unknown, where: string): AskSpec {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${where}: ask must be an object`);
  const e = raw as Record<string, unknown>;
  if (e.kind !== 'technisch' && e.kind !== 'produkt') throw new Error(`${where}: kind must be technisch or produkt`);
  const fallback = e.kind === 'technisch' ? words(e, 'fallback', where, 2000) : '';
  const options = Array.isArray(e.options) ? e.options.map((o, i) => words({ option: o }, 'option', `${where} option ${i}`, 300)) : [];
  if (options.length < 2 || options.length > 6) throw new Error(`${where}: a question names 2 to 6 options (AK18j)`);
  const recommendation = words(e, 'recommendation', where, 300);
  if (!options.includes(recommendation)) throw new Error(`${where}: the recommendation must be one of the options (AK18j)`);
  return { text: words(e, 'text', where), kind: e.kind, fallback, options, recommendation };
}

export function parseManagerOutbox(raw: unknown, project: string): { ops: ManagerOp[]; dropped: string[] } {
  if (raw === undefined || raw === null) return { ops: [], dropped: [] };
  if (!Array.isArray(raw)) throw new Error('manager outbox must be a JSON list');
  if (raw.length > MAX_ENTRIES) throw new Error(`manager outbox has more than ${MAX_ENTRIES} entries`);
  const keyOk = new RegExp(`^${project}-[1-9]\\d*$`);
  const key = (e: Record<string, unknown>, field: string, where: string): string => {
    const value = e[field];
    if (typeof value !== 'string' || !keyOk.test(value)) throw new Error(`${where}: ${field} must be a ${project} ticket`);
    return value;
  };
  const ops: ManagerOp[] = [];
  const dropped: string[] = [];
  let creates = 0;
  let rewrites = 0;
  raw.forEach((entry, i) => {
    const where = `manager outbox entry ${i}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`${where}: not an object`);
    const e = entry as Record<string, unknown>;
    switch (e.op) {
      case 'create': {
        if (typeof e.marker !== 'string' || !/^mgr-[a-z0-9-]{3,56}$/.test(e.marker)) throw new Error(`${where}: marker must be mgr- and 3-56 of a-z, 0-9, -`);
        const title = words(e, 'title', where, 200);
        const op = { op: 'create' as const, marker: e.marker, title, text: words(e, 'text', where), ask: e.ask === undefined ? null : askSpec(e.ask, where), top: e.top === true };
        if ((creates += 1) > MANAGER_CAP) dropped.push(`create ${op.marker} „${title}“`);
        else ops.push(op);
        return;
      }
      case 'rewrite': {
        const op = { op: 'rewrite' as const, key: key(e, 'key', where), text: words(e, 'text', where), reason: words(e, 'reason', where, 2000) };
        if ((rewrites += 1) > MANAGER_CAP) dropped.push(`rewrite ${op.key}`);
        else ops.push(op);
        return;
      }
      case 'ask':
        ops.push({ op: 'ask', key: key(e, 'key', where), ask: askSpec(e, where) });
        return;
      case 'rank': {
        const places = [e.before !== undefined, e.after !== undefined, e.top === true].filter(Boolean).length;
        if (places !== 1) throw new Error(`${where}: rank needs exactly one of before, after, top`);
        ops.push({
          op: 'rank', key: key(e, 'key', where), text: words(e, 'text', where), top: e.top === true,
          before: e.before === undefined ? null : key(e, 'before', where), after: e.after === undefined ? null : key(e, 'after', where),
        });
        return;
      }
      case 'comment':
      case 'cancel':
      case 'todo':
      case 'unflag':
      case 'default':
        ops.push({ op: e.op, key: key(e, 'key', where), text: words(e, 'text', where) });
        return;
      default:
        throw new Error(`${where}: unknown op ${JSON.stringify(e.op)}`);
    }
  });
  return { ops, dropped };
}

/** Null when the manager may do this to a ticket in this state, else why not. */
export function refusal(op: ManagerOp, l: Live, s: TrackerConfig['status'], now: number): string | null {
  if (op.op === 'create' || op.op === 'comment' || op.op === 'ask') return null;
  const r = rights(l.status, s);
  if (r === 'kommentar') return `${op.key} steht auf ${statusName(l.status, s)}: der Manager darf hier nur kommentieren und fragen (AK18i)`;
  switch (op.op) {
    case 'cancel':
      return r === 'alles' ? null : `${op.key} steht auf Review: erst den PR schließen und zurück auf To Do, dann verwerfen (AK18i)`;
    case 'rank':
      return r === 'alles' ? null : `${op.key}: den Rang ändert der Manager nur auf To Do (AK18i)`;
    case 'todo':
      if (r !== 'review') return `${op.key}: zurück auf To Do geht nur von Review`;
      return l.prOpen ? `${op.key}: der PR ist noch offen; erst schließen, dann zurück auf To Do (AK18i)` : null;
    case 'unflag':
      if (!l.flagged) return `${op.key} ist nicht markiert`;
      return mayUnflag(l.question) ? null : `${op.key}: die Markierung bleibt bis zu Julians Antwort oder zur fälligen Vorgabe (AK18i, AK18k)`;
    case 'default':
      return l.question !== null && defaultDue(l.question, now) ? null : `${op.key}: keine technische Frage mit fälliger Vorgabe (AK18k)`;
    case 'rewrite': {
      const lost = conceptLinks(l.body).find(link => !op.text.includes(link));
      if (lost !== undefined) return `${op.key}: der Konzept-Link fehlt im neuen Text (${lost})`;
      if (l.own && !op.text.startsWith('Loop finding: ')) return `${op.key}: die erste Zeile „Loop finding: …“ bleibt`;
      return null;
    }
  }
}

/** The whole list against the tickets as Jira has them, each entry's effect carried to the next. */
export function checkManagerOps(ops: readonly ManagerOp[], board: ReadonlyMap<string, Live>, s: TrackerConfig['status'], now: number): void {
  const sim = new Map(board);
  ops.forEach((op, i) => {
    if (op.op === 'create') return;
    const l = sim.get(op.key);
    if (l === undefined) throw new Error(`manager outbox entry ${i}: ${op.key} is not on the board`);
    if (op.op === 'rank') {
      for (const other of [op.before, op.after]) {
        if (other !== null && !sim.has(other)) throw new Error(`manager outbox entry ${i}: ${other} is not on the board`);
      }
    }
    const why = refusal(op, l, s, now);
    if (why !== null) throw new Error(`manager outbox entry ${i}: ${why}`);
    if (op.op === 'todo') sim.set(op.key, { ...l, status: s.todo });
    if (op.op === 'cancel') sim.set(op.key, { ...l, status: s.canceled });
    if (op.op === 'unflag' || op.op === 'default') sim.set(op.key, { ...l, flagged: false });
    if (op.op === 'ask') sim.set(op.key, { ...l, flagged: true, question: null });
    if (op.op === 'rewrite') sim.set(op.key, { ...l, body: op.text });
  });
}

/**
 * The tickets the entries name, as Jira has them now (AK18i). Only keys the read node put on
 * the board (`known`, from keys-all.json) are looked up: a key the board never showed stays out
 * of the map, so `checkManagerOps` refuses it, and Jira never sees a query for a key that may not
 * exist. The origin comes from the board too; it does not change between read and write.
 */
export async function liveTickets(
  jira: Jira,
  ops: readonly ManagerOp[],
  pulls: readonly PrText[],
  known: Readonly<Record<string, Snapshot>>
): Promise<Map<string, Live>> {
  const c = jira.config;
  const keys = new Set<string>();
  for (const op of ops) {
    if ('key' in op) keys.add(op.key);
    if (op.op === 'rank') for (const other of [op.before, op.after]) if (other !== null) keys.add(other);
  }
  const wanted = [...keys].filter(key => known[key] !== undefined);
  const board = new Map<string, Live>();
  if (wanted.length === 0) return board;
  const named = new Set(pulls.flatMap(pr => prKeys(pr, c.project)));
  const asked = new Set(ops.flatMap(op => (op.op === 'unflag' || op.op === 'default' ? [op.key] : [])));
  for (const row of await jira.search(`key in (${wanted.join(', ')})`)) {
    const t = jira.toTicket(row, false);
    board.set(t.key, {
      status: t.status,
      flagged: t.flagged,
      own: (known[t.key]?.own ?? '') !== '',
      body: t.body,
      question: asked.has(t.key) ? lastQuestion(await jira.comments(t.key), c) : null,
      prOpen: named.has(t.key),
    });
  }
  return board;
}

/** The first ticket of the active sprint other than `key`, by rank; null when there is none. */
async function firstInSprint(jira: Jira, key: string): Promise<string | null> {
  const rows = await jira.search(`project = ${jira.config.project} AND sprint in openSprints() ORDER BY Rank ASC`, ['status']);
  return rows.map(row => String(row.key)).find(other => other !== key) ?? null;
}

async function rankPlace(jira: Jira, key: string, op: { before: string | null; after: string | null; top: boolean }): Promise<void> {
  if (op.before !== null) return jira.rank(key, { before: op.before });
  if (op.after !== null) return jira.rank(key, { after: op.after });
  const first = await firstInSprint(jira, key);
  if (first !== null) await jira.rank(key, { before: first });
}

/**
 * The default of a ticket's technical question: from the board, or read again when a rerun's
 * board left the ticket out (its change was already made, so it was not checked again).
 */
async function fallbackOf(jira: Jira, key: string, board: ReadonlyMap<string, Live>): Promise<string> {
  const q = board.get(key)?.question ?? lastQuestion(await jira.comments(key), jira.config);
  if (q === null || q.fallback === '') throw new Error(`${key}: no default to apply`);
  return q.fallback;
}

/**
 * Applies a checked list (AK18i to AK18m) behind an earlier try's progress, like `applyOutbox`:
 * each change first, noted, then its comment with the run line, so a rerun after a failed
 * comment adds only the comment. A `create` is always asked (it finds its own ticket); its rank
 * and question come once, behind the progress mark.
 */
export async function applyManagerOps(
  jira: Jira,
  ops: readonly ManagerOp[],
  line: string,
  state: string,
  raw: unknown,
  now: number,
  board: ReadonlyMap<string, Live>,
  boardUrl: string
): Promise<Record<string, string>> {
  const c = jira.config;
  const cursor = outboxCursor(state, 'manager', raw);
  const signed = (text: string): string => `${text}\n\n${line}`;
  const question = (a: AskSpec): string => signed(questionText(a.kind, askBody(a), a.fallback, now));
  const created: Record<string, string> = {};
  for (const [index, op] of ops.entries()) {
    const changed = cursor.half && index === cursor.done;
    if (op.op === 'create') {
      const { key } = await createTicket(jira, { op: 'create', marker: op.marker, title: op.title, text: op.text }, boardUrl, state);
      created[op.marker] = key;
      if (index < cursor.done) continue;
      if (!changed) {
        if (op.top) await rankPlace(jira, key, { before: null, after: null, top: true });
        cursor.keep(index, true);
      }
      if (op.ask !== null) await jira.ask(key, question(op.ask));
      cursor.keep(index + 1, false);
      continue;
    }
    if (index < cursor.done) continue;
    if (op.op === 'comment') await jira.comment(op.key, signed(op.text));
    else if (op.op === 'ask') await jira.ask(op.key, question(op.ask));
    else {
      if (!changed) {
        if (op.op === 'cancel') await jira.move(op.key, c.status.canceled);
        else if (op.op === 'todo') await jira.move(op.key, c.status.todo);
        else if (op.op === 'rank') await rankPlace(jira, op.key, op);
        else if (op.op === 'rewrite') await jira.call('PUT', jira.issue(op.key), { fields: { description: adf(op.text) } });
        else await jira.call('PUT', jira.issue(op.key), { fields: { [c.flagField]: null } }); // unflag, default
        cursor.keep(index, true);
      }
      const text =
        op.op === 'cancel' ? `${op.text}\n\nVerworfen vom Manager.`
        : op.op === 'rewrite' ? `Text umgeschrieben: ${op.reason}`
        : op.op === 'default' ? `Vorgabe angewendet: ${await fallbackOf(jira, op.key, board)}\n\n${op.text}`
        : op.text;
      await jira.comment(op.key, signed(text));
    }
    cursor.keep(index + 1, false);
  }
  cursor.clear();
  return created;
}

/**
 * One pass's ticket writes, as manager-write runs them: the list parsed, the part an earlier try
 * has not acted on checked against the tickets as Jira has them now, then applied. Nothing is
 * written when the check refuses.
 */
export async function managerPass(
  jira: Jira,
  raw: unknown,
  state: string,
  pulls: readonly PrText[],
  known: Readonly<Record<string, Snapshot>>,
  now: number,
  line: string,
  boardUrl: string
): Promise<{ ops: ManagerOp[]; dropped: string[]; created: Record<string, string> }> {
  const { ops, dropped } = parseManagerOutbox(raw, jira.config.project);
  // AK18l: every answered question the board showed (To Do or Review, flagged) is acted on in
  // this very list: rewritten to the answer and unflagged, or canceled. Checked before any read.
  const owed = Object.entries(known).filter(([, s]) => s.answered === true).map(([key]) => key);
  const missing = owed.filter(key => !ops.some(op => 'key' in op && op.key === key && (op.op === 'unflag' || op.op === 'cancel')));
  if (missing.length > 0) {
    throw new Error(`manager outbox: AK18l, answered questions not acted on: ${missing.join(', ')} (rewrite to the answer and unflag, or cancel)`);
  }
  const open = ops.slice(outboxProgress(state, 'manager', raw));
  const board = await liveTickets(jira, open, pulls, known);
  checkManagerOps(open, board, jira.config.status, now);
  const created = ops.length === 0 ? {} : await applyManagerOps(jira, ops, line, state, raw, now, board, boardUrl);
  return { ops, dropped, created };
}
