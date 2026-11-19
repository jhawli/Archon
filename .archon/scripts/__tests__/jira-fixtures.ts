import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runState } from '../../workflows/sdlc/.shared/claims';
import { adf, Jira, type TrackerConfig, type Transport } from '../../workflows/sdlc/.shared/jira';

/** A Jira tracker for tests: project CONC, the loop's account `acc-archon`, the owner `acc-julian`. */
export const CFG: TrackerConfig = {
  kind: 'jira',
  site: 'https://example.atlassian.net',
  project: 'CONC',
  board: 5,
  keychain: 'none',
  assignee: 'acc-archon',
  owner: 'acc-julian',
  status: {
    todo: '10015',
    progress: '3',
    review: '10016',
    staging: '10017',
    live: '10018',
    canceled: '10008',
  },
  flagField: 'customfield_10021',
  flagOn: '10019',
  sprintField: 'customfield_10020',
};

export interface FakeComment { readonly id: number; readonly author: string; readonly body: string; readonly created: string }
export interface FakeTicket {
  readonly status: string;
  readonly body?: string;
  readonly flagged?: boolean;
  readonly comments?: readonly FakeComment[];
  /** Sub-task of this key (VAULT-22). */
  readonly parent?: string;
  /** The state of the sprint it is in; none without. */
  readonly sprint?: 'active' | 'closed';
  /** Its sub-tasks, by key; their statuses come from their own entries. */
  readonly children?: readonly string[];
  /** Keys it already has a "relates to" link with. */
  readonly relates?: readonly string[];
}
export interface Call { method: string; path: string; body: unknown }

/**
 * A Jira that moves anything anywhere and files new tickets as CONC-51 up. `tickets` are the
 * tickets it knows (status, text, flag, comments), `ranked` the active sprint in rank order,
 * `found` what any other search finds (remote-link lookups).
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
  } = {}
): { jira: Jira; calls: Call[] } {
  const calls: Call[] = [];
  let next = 50;
  let failed = false;
  const ok = (value: unknown, status = 200): { status: number; text: string } => ({
    status,
    text: value === undefined ? '' : JSON.stringify(value),
  });
  const fields = (key: string): Record<string, unknown> => {
    const t = opts.tickets?.[key];
    if (t === undefined) return {};
    return {
      summary: key,
      description: adf(t.body ?? ''),
      status: { id: t.status },
      labels: [],
      [CFG.flagField]: t.flagged ? [{ id: CFG.flagOn }] : [],
      issuetype: { subtask: t.parent !== undefined },
      ...(t.parent !== undefined ? { parent: { key: t.parent } } : {}),
      subtasks: (t.children ?? []).map(child => ({ key: child, fields: { status: { id: opts.tickets?.[child]?.status ?? '' } } })),
      [CFG.sprintField]: t.sprint === undefined ? null : [{ id: 7, state: t.sprint }],
      issuelinks: (t.relates ?? []).map(other => ({ type: { name: 'Relates' }, outwardIssue: { key: other } })),
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
      const listed = opts.tickets === undefined ? null : /^key in \(([^)]*)\)$/.exec(jql);
      const keys = listed !== null
        ? (listed[1] ?? '').split(', ').filter(key => opts.tickets?.[key] !== undefined)
        : opts.ranked !== undefined && jql.endsWith('ORDER BY Rank ASC') ? opts.ranked : (opts.found ?? []);
      return ok({ issues: keys.map(key => ({ key, fields: fields(key) })), isLast: true });
    }
    const comments = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/.exec(bare);
    if (method === 'GET' && comments !== null) {
      const list = opts.tickets?.[comments[1] ?? '']?.comments ?? [];
      return ok({ comments: list.map(c => ({ id: String(c.id), body: adf(c.body), created: c.created, author: { accountId: c.author } })), total: list.length });
    }
    const issue = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(bare);
    if (method === 'GET' && issue !== null && opts.tickets?.[issue[1] ?? ''] !== undefined) return ok({ key: issue[1], fields: fields(issue[1] ?? '') });
    if (method === 'GET' && bare.endsWith('/transitions')) {
      return ok({ transitions: Object.values(CFG.status).map(id => ({ id: `t${id}`, to: { id } })) });
    }
    if (method === 'GET' && bare === '/rest/api/3/project/CONC') {
      return ok({ id: '10002', issueTypes: [{ id: '10009', name: 'Task', subtask: false }, { id: '10010', name: 'Sub-Task', subtask: true }] });
    }
    if (method === 'POST' && bare === '/rest/api/3/issue') return ok({ key: `CONC-${(next += 1)}` }, 201);
    if (method === 'POST' && bare.endsWith('/comment')) return ok({ id: '10100' }, 201);
    if (method === 'GET' && bare.startsWith('/rest/agile/1.0/board/5/sprint')) {
      return ok({ values: opts.sprint === null || opts.sprint === undefined ? [] : [{ id: opts.sprint }] });
    }
    return ok(undefined, 204);
  };
  return { jira: new Jira(CFG, send), calls };
}

/** A fresh state directory for one run, like `jira-outbox.test.ts` uses. */
export const state = (): string => runState(mkdtempSync(join(tmpdir(), 'state-')), 'run-1');
