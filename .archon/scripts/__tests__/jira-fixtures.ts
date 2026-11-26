import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runState } from '../../workflows/sdlc/.shared/claims';
import { adf, Jira, type TrackerConfig, type Transport } from '../../workflows/sdlc/.shared/jira';

/**
 * The lifecycle statuses (VAULT-28): Startklar and Gemeldet are the two queues, Entwicklung the
 * work, Erledigt and Entfällt the ends of a task. Tests read ids from here, never a copy.
 */
export const STATUS = {
  todo: '10057', todoBug: '10059', progress: '10058', review: '10016', staging: '10017',
  live: '10018', canceled: '10063', taskDone: '10061', taskDropped: '10062',
} as const;
/** Bug, Scheibe (under a feature) and the plain type a new ticket is filed as (Aufgabe). */
export const TYPES = { bug: '10011', slice: '10005', filing: '10009' } as const;
/** The project's sub-task type (Task): the only type with `subtask: true`. */
export const SUBTASK_TYPE = '10010';

/** A Jira tracker for tests: project CONC, the loop's account `acc-archon`, the owner `acc-julian`. */
export const CFG: TrackerConfig = {
  kind: 'jira',
  site: 'https://example.atlassian.net',
  project: 'CONC',
  board: 5,
  keychain: 'none',
  assignee: 'acc-archon',
  owner: 'acc-julian',
  status: STATUS,
  types: TYPES,
  flagField: 'customfield_10021',
  flagOn: '10019',
  sprintField: 'customfield_10020',
};

export interface FakeComment { readonly id: number; readonly author: string; readonly body: string; readonly created: string }
export interface FakeTicket {
  readonly status: string;
  /** Issue type id; without it a sub-task when it has a parent, else a slice. */
  readonly type?: string;
  readonly title?: string;
  readonly body?: string;
  readonly flagged?: boolean;
  readonly comments?: readonly FakeComment[];
  /** Its parent: the feature of a slice, the slice of a task. */
  readonly parent?: string;
  /** The state of the sprint it is in; none without. */
  readonly sprint?: 'active' | 'closed';
  /** Its sub-tasks, by key; their statuses and titles come from their own entries. */
  readonly children?: readonly string[];
  /** Keys it already has a "relates to" link with. */
  readonly relates?: readonly string[];
  /** Its attachments, file name → text; ids follow their order (CONC-146). */
  readonly attachments?: Readonly<Record<string, string>>;
  /** Who uploaded its attachments; the owner without it. */
  readonly attachedBy?: string;
  /** The account it is assigned to. */
  readonly assignee?: string;
  readonly labels?: readonly string[];
}
export interface Call { method: string; path: string; body: unknown }
/** One bulk move as Jira received it: `target` is `project,type,parent`, `statuses` target → sources. */
export interface FakeBulkMove { readonly target: string; readonly keys: readonly string[]; readonly statuses: Record<string, string[]> }

interface Booked {
  status: string;
  type: string;
  title: string;
  body: string;
  flagged: boolean;
  comments: readonly FakeComment[];
  parent?: string;
  sprint?: 'active' | 'closed';
  children: string[];
  relates: readonly string[];
  attachments: {
    readonly id: string;
    readonly filename: string;
    readonly created: string;
    readonly author: { readonly accountId: string };
  }[];
  assignee?: string;
  labels: readonly string[];
}

/** Where a ticket filed as this type starts (VAULT-28): a bug on Gemeldet, anything else on Offen. */
const START: Record<string, string> = { [TYPES.bug]: STATUS.todoBug };
const OPEN = '10060';

/**
 * A Jira that moves anything anywhere and files new tickets as CONC-51 up. `tickets` are the
 * tickets it knows (status, type, text, flag, comments), `ranked` the active sprint in rank order,
 * `found` what any other search finds (remote-link lookups). It remembers what happens: a
 * transition moves a ticket, a filed ticket is there afterwards (a sub-task under its parent),
 * and a bulk move sets type, parent and status (`bulkStatus` makes it land elsewhere).
 */
export function fakeJira(
  opts: {
    found?: string[];
    sprint?: number | null;
    failOnce?: string;
    tickets?: Record<string, FakeTicket>;
    ranked?: string[];
    /** Remote-link lookups by globalId (`archon:CONC:<marker>` → key); without it they find `found`. */
    linked?: Record<string, string>;
    /** The status a bulk move really leaves its tickets on, whatever it asked for. */
    bulkStatus?: string;
    /** The ticket labels with Befund-Pflicht; without it the tracker names none. */
    befundLabels?: string[];
  } = {}
): { jira: Jira; calls: Call[]; bulkMoves: FakeBulkMove[]; book: ReadonlyMap<string, Readonly<Booked>> } {
  const calls: Call[] = [];
  const bulkMoves: FakeBulkMove[] = [];
  let next = 50;
  let failed = false;
  const book = new Map<string, Booked>();
  // Attachment id → text; ids and times count up over all tickets, so a later file is newer.
  const files = new Map<string, string>();
  const attach = (named: Readonly<Record<string, string>>, by: string): Booked['attachments'] =>
    Object.entries(named).map(([filename, text]) => {
      const id = String(9001 + files.size);
      files.set(id, text);
      return {
        id,
        filename,
        created: `2026-11-23T10:${String(files.size).padStart(2, '0')}:00.000+0100`,
        author: { accountId: by },
      };
    });
  for (const [key, t] of Object.entries(opts.tickets ?? {})) {
    book.set(key, {
      status: t.status,
      type: t.type ?? (t.parent !== undefined ? SUBTASK_TYPE : TYPES.slice),
      title: t.title ?? key,
      body: t.body ?? '',
      flagged: t.flagged ?? false,
      comments: t.comments ?? [],
      ...(t.parent !== undefined ? { parent: t.parent } : {}),
      ...(t.sprint !== undefined ? { sprint: t.sprint } : {}),
      children: [...(t.children ?? [])],
      relates: t.relates ?? [],
      attachments: attach(t.attachments ?? {}, t.attachedBy ?? CFG.owner),
      ...(t.assignee !== undefined ? { assignee: t.assignee } : {}),
      labels: t.labels ?? [],
    });
  }
  const ok = (value: unknown, status = 200): { status: number; text: string } => ({
    status,
    text: value === undefined ? '' : JSON.stringify(value),
  });
  const fields = (key: string): Record<string, unknown> => {
    const t = book.get(key);
    if (t === undefined) return {};
    return {
      summary: t.title,
      description: adf(t.body),
      status: { id: t.status },
      labels: t.labels,
      [CFG.flagField]: t.flagged ? [{ id: CFG.flagOn }] : [],
      issuetype: { id: t.type, subtask: t.type === SUBTASK_TYPE },
      ...(t.parent !== undefined ? { parent: { key: t.parent } } : {}),
      subtasks: t.children.map(child => ({
        key: child,
        fields: { status: { id: book.get(child)?.status ?? '' }, summary: book.get(child)?.title ?? child },
      })),
      [CFG.sprintField]: t.sprint === undefined ? null : [{ id: 7, state: t.sprint }],
      issuelinks: t.relates.map(other => ({ type: { name: 'Relates' }, outwardIssue: { key: other } })),
      attachment: t.attachments,
      assignee: t.assignee === undefined ? null : { accountId: t.assignee, displayName: `Name ${t.assignee}` },
    };
  };
  const send: Transport = async (method, path, body) => {
    calls.push({ method, path, body });
    const bare = path.split('?')[0] ?? '';
    if (!failed && `${method} ${bare}` === opts.failOnce) {
      failed = true;
      return ok({ errorMessages: ['boom'] }, 400);
    }
    if (method === 'POST' && bare === '/rest/api/3/search/jql') {
      const asked = (body as { jql?: unknown } | undefined)?.jql;
      const jql = typeof asked === 'string' ? asked : '';
      // The new options answer only the two searches they were made for; every other search
      // (writableJql, remote-link lookups) finds `found`, as before.
      const global = opts.linked === undefined ? null : /^issue in issuesWithRemoteLinksByGlobalId\("([^"]+)"\)$/.exec(jql);
      if (global !== null) {
        const hit = opts.linked?.[global[1] ?? ''];
        return ok({ issues: hit === undefined ? [] : [{ key: hit, fields: fields(hit) }], isLast: true });
      }
      const under = /^parent = ([A-Z]+-\d+) ORDER BY key$/.exec(jql);
      if (under !== null) {
        const kids = [...book.entries()].filter(([, t]) => t.parent === under[1]).map(([key]) => key).sort();
        return ok({ issues: kids.map(key => ({ key, fields: fields(key) })), isLast: true });
      }
      const listed = opts.tickets === undefined ? null : /^key in \(([^)]*)\)$/.exec(jql);
      const keys = listed !== null
        ? (listed[1] ?? '').split(', ').filter(key => book.has(key))
        : opts.ranked !== undefined && jql.endsWith('ORDER BY Rank ASC') ? opts.ranked : (opts.found ?? []);
      return ok({ issues: keys.map(key => ({ key, fields: fields(key) })), isLast: true });
    }
    const content = /^\/rest\/api\/3\/attachment\/content\/(\d+)$/.exec(bare);
    if (method === 'GET' && content !== null) {
      const stored = files.get(content[1] ?? '');
      return stored === undefined ? ok({ errorMessages: ['nicht da'] }, 404) : { status: 200, text: stored };
    }
    const comments = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/.exec(bare);
    if (method === 'GET' && comments !== null) {
      const list = book.get(comments[1] ?? '')?.comments ?? [];
      return ok({ comments: list.map(c => ({ id: String(c.id), body: adf(c.body), created: c.created, author: { accountId: c.author } })), total: list.length });
    }
    const issue = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(bare);
    if (method === 'GET' && issue !== null && book.has(issue[1] ?? '')) return ok({ key: issue[1], fields: fields(issue[1] ?? '') });
    if (method === 'GET' && bare.endsWith('/transitions')) {
      // Jira's condition on a slice (VAULT-26 AK7): no way from Entwicklung to Review while a task is open.
      const t = book.get(bare.split('/')[5] ?? '');
      const done: string[] = [STATUS.taskDone, STATUS.taskDropped];
      const barred =
        t?.type === TYPES.slice &&
        t.status === STATUS.progress &&
        t.children.some(child => !done.includes(book.get(child)?.status ?? ''));
      const to = Object.values(CFG.status).filter(id => !(barred && id === STATUS.review));
      return ok({ transitions: to.map(id => ({ id: `t${id}`, to: { id } })) });
    }
    const moving = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/transitions$/.exec(bare);
    if (method === 'POST' && moving !== null) {
      const id = (body as { transition?: { id?: unknown } } | undefined)?.transition?.id;
      const t = book.get(moving[1] ?? '');
      if (t !== undefined && typeof id === 'string') t.status = id.slice(1);
      return ok(undefined, 204);
    }
    if (method === 'GET' && bare === '/rest/api/3/project/CONC') {
      return ok({
        id: '10002',
        issueTypes: [
          { id: '10000', name: 'Feature', subtask: false },
          { id: TYPES.slice, name: 'Scheibe', subtask: false },
          { id: TYPES.filing, name: 'Aufgabe', subtask: false },
          { id: SUBTASK_TYPE, name: 'Task', subtask: true },
          { id: TYPES.bug, name: 'Bug', subtask: false },
        ],
      });
    }
    if (method === 'POST' && bare === '/rest/api/3/issue') {
      const key = `CONC-${(next += 1)}`;
      const f = (body as { fields?: { issuetype?: { id?: string; name?: string }; parent?: { key?: string }; summary?: string } }).fields ?? {};
      const type = f.issuetype?.id ?? (f.issuetype?.name === 'Task' ? TYPES.filing : '');
      const parent = f.parent?.key;
      book.set(key, {
        status: START[type] ?? OPEN, type, title: f.summary ?? key, body: '', flagged: false, comments: [],
        ...(parent !== undefined ? { parent } : {}), children: [], relates: [], attachments: [], labels: [],
      });
      if (parent !== undefined) book.get(parent)?.children.push(key);
      return ok({ key }, 201);
    }
    if (method === 'POST' && bare === '/rest/api/3/bulk/issues/move') {
      const mapping = (body as { targetToSourcesMapping: Record<string, { issueIdsOrKeys: string[]; targetStatus: { statuses: Record<string, string[]> }[] }> })
        .targetToSourcesMapping;
      for (const [target, m] of Object.entries(mapping)) {
        const statuses = m.targetStatus[0]?.statuses ?? {};
        bulkMoves.push({ target, keys: m.issueIdsOrKeys, statuses });
        const [, type, parent] = target.split(',');
        for (const key of m.issueIdsOrKeys) {
          const t = book.get(key);
          if (t === undefined) continue;
          t.type = type ?? t.type;
          if (parent !== undefined) t.parent = parent;
          t.status = opts.bulkStatus ?? Object.keys(statuses)[0] ?? t.status;
        }
      }
      return ok({ taskId: 't1' }, 201);
    }
    if (method === 'GET' && bare === '/rest/api/3/bulk/queue/t1') return ok({ status: 'COMPLETE' });
    if (method === 'POST' && bare.endsWith('/comment')) return ok({ id: '10100' }, 201);
    if (method === 'GET' && bare.startsWith('/rest/agile/1.0/board/5/sprint')) {
      return ok({ values: opts.sprint === null || opts.sprint === undefined ? [] : [{ id: opts.sprint }] });
    }
    return ok(undefined, 204);
  };
  const config: TrackerConfig = opts.befundLabels === undefined ? CFG : { ...CFG, befundLabels: opts.befundLabels };
  return { jira: new Jira(config, send, () => Promise.resolve()), calls, bulkMoves, book };
}

/** A fresh state directory for one run, like `jira-outbox.test.ts` uses. */
export const state = (): string => runState(mkdtempSync(join(tmpdir(), 'state-')), 'run-1');
