/**
 * Jira as the work-item tracker, used instead of GitHub issues when the repository carries
 * `.archon/tracker.json` with `"kind": "jira"`. Pull requests stay on GitHub.
 *
 * Only script nodes and the launch gate use this module: they run on the host and read the
 * API token from the macOS keychain. Agent nodes never hold the token; they read a ticket
 * from the files a script node wrote under $ARTIFACTS_DIR/tracker and leave their writes in
 * its outbox for a script node to check and apply.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TrackerConfig {
  readonly kind: 'jira';
  readonly site: string;
  readonly project: string;
  /** The Scrum board whose active sprint new loop tickets join (AK18c). */
  readonly board: number;
  /** Keychain service holding the account mail (account) and the API token (password). */
  readonly keychain: string;
  readonly assignee: string;
  readonly owner: string;
  /**
   * Status ids. Two queues: a bug waits on `todoBug`, anything else on `todo`; a lap works on
   * `progress`. `taskDone` and `taskDropped` end the tasks of a slice (VAULT-28).
   */
  readonly status: {
    readonly todo: string;
    readonly todoBug: string;
    readonly progress: string;
    readonly review: string;
    readonly staging: string;
    readonly live: string;
    readonly canceled: string;
    readonly taskDone: string;
    readonly taskDropped: string;
  };
  /** Issue type ids: a bug, a slice (child of a feature), and the plain type a new ticket is filed as. */
  readonly types: { readonly bug: string; readonly slice: string; readonly filing: string };
  readonly flagField: string;
  readonly flagOn: string;
  readonly sprintField: string;
}

/**
 * The statuses past the work: delivered (Staging, Live) or canceled. Jira's sub-task blocking
 * condition on the Staging transition of the board workflow names the same three (VAULT-22).
 */
export function doneStatuses(s: TrackerConfig['status']): ReadonlySet<string> {
  return new Set([s.staging, s.live, s.canceled]);
}

/** Where a ticket of this type waits for the loop: a bug on its own start status, anything else on todo. */
export function todoFor(typeId: string, c: Pick<TrackerConfig, 'status' | 'types'>): string {
  return typeId === c.types.bug ? c.status.todoBug : c.status.todo;
}

/** The loop's queues: the statuses a ticket waits on until a lap claims it. */
export function todoStatuses(s: TrackerConfig['status']): string[] {
  return [...new Set([s.todo, s.todoBug])];
}

/**
 * The statuses a move from `from` to `to` passes, the target last. The lifecycle has no
 * shortcut (VAULT-28): a delivery reaches Staging only through Review, where Jira checks a
 * slice's tasks, and a ticket goes back to its queue only through progress.
 */
export function movePath(from: string, to: string, s: TrackerConfig['status']): string[] {
  if (to === s.staging && from === s.progress) return [s.review, s.staging];
  if (todoStatuses(s).includes(to) && from === s.review) return [s.progress, to];
  return [to];
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : '';
}

export function repoRoot(cwd = process.cwd()): string {
  const result = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(`not a git checkout: ${cwd}`);
  return result.stdout.toString().trim();
}

const STATUS_KEYS = ['todo', 'todoBug', 'progress', 'review', 'staging', 'live', 'canceled', 'taskDone', 'taskDropped'] as const;
const TYPE_KEYS = ['bug', 'slice', 'filing'] as const;

const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Where a run keeps the tracker config its first node read, or null outside a run. */
function pinnedPath(stateDir = process.env.STATE_DIR ?? '', run = process.env.WORKFLOW_ID ?? ''): string | null {
  return stateDir !== '' && RUN_ID.test(run) ? join(stateDir, 'tracker', run, 'tracker.json') : null;
}

/**
 * The repository's tracker, or null when it has none. Only a reader: whatever needs a tracker
 * calls `requireTracker`, because this fork tracks work in Jira only (AK18e).
 *
 * Inside a run that pinned its config (`pinTrackerConfig`, the loop's first node) the pinned
 * copy is the answer, whatever the checkout says by then: agents write in the checkout, and
 * the file names the owner whose comment approves a merge, the statuses release sets and the
 * keychain item the scripts read. An explicit `root` always reads that checkout.
 */
export function trackerConfig(root?: string): TrackerConfig | null {
  if (root === undefined) {
    const pinned = pinnedPath();
    if (pinned !== null && existsSync(pinned)) {
      const raw = JSON.parse(readFileSync(pinned, 'utf8')) as unknown;
      return raw === null ? null : parseTracker(obj(raw));
    }
  }
  const path = join(root ?? repoRoot(), '.archon', 'tracker.json');
  if (!existsSync(path)) return null;
  return parseTracker(obj(JSON.parse(readFileSync(path, 'utf8'))));
}

/** The one sentence a run without a tracker ends with (AK18e). */
export const NEEDS_TRACKER = 'braucht .archon/tracker.json: dieser Fork führt Tickets nur in Jira';

/** The repository's tracker; there is no GitHub-issue mode any more, so a missing file is an error. */
export function requireTracker(root?: string): TrackerConfig {
  const config = trackerConfig(root);
  if (config === null) throw new Error(NEEDS_TRACKER);
  return config;
}

/**
 * Read the checkout's tracker config once, before the run's first agent, and keep it in the
 * run's state directory (`state`, where agents cannot write) for every later node. A pin that
 * is already there stays: a resumed run must not pick up what an agent wrote since. Without
 * a tracker nothing is pinned and the run ends here (AK18e); a "no tracker" pin an older run
 * left behind ends it the same way.
 */
export function pinTrackerConfig(state: string, root = repoRoot()): TrackerConfig {
  const pinned = join(state, 'tracker.json');
  if (existsSync(pinned)) {
    const raw = JSON.parse(readFileSync(pinned, 'utf8')) as unknown;
    if (raw === null) throw new Error(NEEDS_TRACKER);
    return parseTracker(obj(raw));
  }
  const config = requireTracker(root);
  writeFileSync(pinned, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

function parseTracker(raw: Json): TrackerConfig {
  const text = (key: string): string => {
    const value = raw[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`.archon/tracker.json: ${key} is missing`);
    }
    return value;
  };
  if (raw.kind !== 'jira') throw new Error('.archon/tracker.json: kind must be "jira"');
  const site = text('site');
  if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/.test(site)) {
    throw new Error('.archon/tracker.json: site must be https://<name>.atlassian.net');
  }
  const project = text('project');
  if (!/^[A-Z][A-Z0-9]+$/.test(project)) {
    throw new Error('.archon/tracker.json: project must be a Jira key prefix like CONC');
  }
  const status = obj(raw.status);
  if (!STATUS_KEYS.every(id => /^\d+$/.test(str(status[id])))) {
    throw new Error(`.archon/tracker.json: status needs numeric ids for ${STATUS_KEYS.join(', ')}`);
  }
  const types = obj(raw.types);
  if (!TYPE_KEYS.every(id => /^\d+$/.test(str(types[id])))) {
    throw new Error(`.archon/tracker.json: types needs numeric ids for ${TYPE_KEYS.join(', ')}`);
  }
  if (typeof raw.board !== 'number' || !Number.isInteger(raw.board)) {
    throw new Error('.archon/tracker.json: board must be a board id');
  }
  return {
    kind: 'jira',
    site,
    project,
    board: raw.board,
    keychain: text('keychain'),
    assignee: text('assignee'),
    owner: text('owner'),
    status: Object.fromEntries(STATUS_KEYS.map(id => [id, str(status[id])])) as TrackerConfig['status'],
    types: Object.fromEntries(TYPE_KEYS.map(id => [id, str(types[id])])) as TrackerConfig['types'],
    flagField: text('flagField'),
    flagOn: text('flagOn'),
    sprintField: text('sprintField'),
  };
}

// --- ADF: paragraphs, hard breaks, bullet lists, code blocks, one leading mention ---

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string }[];
  content?: AdfNode[];
}

export interface Doc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

function textNodes(line: string): AdfNode[] {
  return line === '' ? [] : [{ type: 'text', text: line }];
}

function textBlock(lines: string[]): AdfNode {
  if (lines.every(line => line.startsWith('- '))) {
    return {
      type: 'bulletList',
      content: lines.map(line => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: textNodes(line.slice(2)) }],
      })),
    };
  }
  const inline: AdfNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) inline.push({ type: 'hardBreak' });
    inline.push(...textNodes(line));
  });
  return { type: 'paragraph', content: inline };
}

/**
 * Plain text to ADF. Blank lines separate blocks; a block whose lines all start with `- ` is a
 * bullet list; a ``` fence opens a code block that runs to the next fence, blank lines included.
 * Jira refuses empty text nodes, so none is written.
 */
export function adf(text: string, mention?: string): Doc {
  const content: AdfNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let block: string[] = [];
  const flush = (): void => {
    if (block.length > 0) content.push(textBlock(block));
    block = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      flush();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      content.push({ type: 'codeBlock', content: textNodes(code.join('\n')) });
    } else if (line.trim() === '') {
      flush();
    } else {
      block.push(line);
    }
  }
  flush();
  if (mention !== undefined) {
    const lead: AdfNode[] = [{ type: 'mention', attrs: { id: mention } }];
    const first = content[0];
    if (first?.type === 'paragraph') {
      first.content = [...lead, { type: 'text', text: ' ' }, ...(first.content ?? [])];
    } else {
      content.unshift({ type: 'paragraph', content: lead });
    }
  }
  return { type: 'doc', version: 1, content };
}

function marked(node: AdfNode): string {
  const kinds = new Set((node.marks ?? []).map(mark => mark.type));
  let text = node.text ?? '';
  if (kinds.has('code')) text = `\`${text}\``;
  if (kinds.has('strong')) text = `**${text}**`;
  return text;
}

const INLINE_PARENTS = new Set(['paragraph', 'heading']);

function render(node: AdfNode): string {
  const children = node.content ?? [];
  switch (node.type) {
    case 'text':
      return marked(node);
    case 'hardBreak':
      return '\n';
    case 'mention': {
      const name = str(node.attrs?.text) || str(node.attrs?.id);
      return `@${name.replace(/^@/, '')}`;
    }
    case 'emoji':
      return str(node.attrs?.text) || str(node.attrs?.shortName);
    case 'inlineCard':
      return str(node.attrs?.url);
    case 'codeBlock': {
      const code = children.map(render).join('');
      return code === '' ? '```\n```' : `\`\`\`\n${code}\n\`\`\``;
    }
    case 'bulletList':
      return children.map(item => `- ${render(item)}`).join('\n');
    case 'orderedList':
      return children.map((item, i) => `${i + 1}. ${render(item)}`).join('\n');
    default:
      return children.map(render).join(INLINE_PARENTS.has(node.type) ? '' : '\n');
  }
}

/** ADF back to the plain text the agents read and the claim protocol matches. */
export function plain(doc: unknown): string {
  const blocks = list(obj(doc).content) as AdfNode[];
  return blocks.map(render).join('\n\n');
}

// --- Transport and client ---

export type Transport = (
  method: string,
  path: string,
  body?: unknown
) => Promise<{ status: number; text: string; retryAfter?: number }>;

/** Tries per call, the first included. */
const ATTEMPTS = 3;
/** Statuses that say "not now" rather than "no". */
const BUSY = [429, 502, 503, 504];
const MAX_WAIT_MS = 30_000;

/** `security` by absolute path (the keychain ACL is per binary), bounded so a prompt cannot hang a run. */
function credentials(service: string): { mail: string; token: string } {
  const run = (args: string[]): { exitCode: number | null; stdout: string } => {
    const result = Bun.spawnSync(
      ['/usr/bin/security', 'find-generic-password', '-s', service, ...args],
      { stdout: 'pipe', stderr: 'pipe', timeout: 15_000 }
    );
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  };
  const attr = run([]);
  const pw = run(['-w']);
  const mail = /"acct"<blob>="([^"]+)"/.exec(attr.stdout)?.[1] ?? '';
  const token = pw.stdout.trim();
  if (attr.exitCode !== 0 || pw.exitCode !== 0 || mail === '' || token === '') {
    throw new Error(
      `keychain item ${service} is missing, locked or timed out (exit ${attr.exitCode}/${pw.exitCode})`
    );
  }
  return { mail, token };
}

export function keychainTransport(config: TrackerConfig): Transport {
  const { mail, token } = credentials(config.keychain);
  const auth = `Basic ${btoa(`${mail}:${token}`)}`;
  return async (method, path, body) => {
    const response = await fetch(config.site + path, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const seconds = Number(response.headers.get('retry-after') ?? '');
    return {
      status: response.status,
      text: await response.text(),
      ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfter: seconds } : {}),
    };
  };
}

export interface TicketComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: number;
  readonly created: string;
  readonly author: string;
  readonly url: string;
}

export interface Ticket {
  readonly key: string;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly status: string;
  /** Issue type id. */
  readonly type: string;
  readonly labels: readonly string[];
  readonly flagged: boolean;
  readonly assignee: string | null;
  readonly inOpenSprint: boolean;
  readonly updated: number;
}

export const TICKET_FIELDS: readonly string[] = [
  'summary',
  'description',
  'status',
  'issuetype',
  'labels',
  'assignee',
  'updated',
];

/** A ticket's place in Jira's hierarchy, read straight from the issue (never through search). */
export interface Family {
  readonly key: string;
  readonly status: string;
  /** Issue type id. */
  readonly type: string;
  /** A Jira sub-task: it cannot have sub-tasks of its own. */
  readonly subtask: boolean;
  /** The parent's key, for a sub-task (and for a ticket under an epic). */
  readonly parent: string | null;
  /** In the board's active sprint (a sub-task carries its parent's). */
  readonly activeSprint: boolean;
  readonly children: readonly { readonly key: string; readonly status: string }[];
}

/** A search that pages past this is a runaway query, not a board. */
const MAX_SEARCH_PAGES = 50;

export class Jira {
  constructor(
    readonly config: TrackerConfig,
    private readonly send: Transport = keychainTransport(config),
    private readonly pause: (ms: number) => Promise<void> = ms => Bun.sleep(ms)
  ) {}

  /**
   * A key of this project, checked before it goes into a REST path. Keys reach the client from
   * agent-written outbox files; `../` in one would aim the token at another endpoint.
   */
  issue(key: string): string {
    if (!new RegExp(`^${this.config.project}-[1-9]\\d*$`).test(key)) {
      throw new Error(`not a ${this.config.project} ticket key: ${JSON.stringify(key)}`);
    }
    return `/rest/api/3/issue/${key}`;
  }

  /**
   * One REST call. A passing hiccup is tried again, up to ATTEMPTS times in all: a 429 always
   * (Jira did nothing), and for GET and PUT also a gateway error or a transport failure such
   * as the time limit. A POST that may have reached Jira is never sent twice: it files a
   * ticket or a comment each time.
   */
  /** An object answer, or null for an empty one (`request` for any other shape). */
  async call(method: string, path: string, body?: unknown, ok = [200, 201, 204]): Promise<Json | null> {
    const reply = await this.request(method, path, body, ok);
    return reply === null ? null : obj(reply);
  }

  /** The parsed answer in whatever shape Jira sends it (a remote-link listing is a list), or null when empty. */
  async request(method: string, path: string, body?: unknown, ok = [200, 201, 204]): Promise<unknown> {
    const repeatable = method === 'GET' || method === 'PUT';
    for (let attempt = 1; ; attempt += 1) {
      const last = attempt >= ATTEMPTS;
      let reply: Awaited<ReturnType<Transport>>;
      try {
        reply = await this.send(method, path, body);
      } catch (error) {
        if (!repeatable || last) throw error;
        await this.pause(1000 * attempt);
        continue;
      }
      const { status, text } = reply;
      if (ok.includes(status)) return text.trim() === '' ? null : (JSON.parse(text) as unknown);
      const again = status === 429 || (repeatable && BUSY.includes(status));
      if (!again || last) throw new Error(`Jira ${method} ${path} -> ${status}: ${text.slice(0, 500)}`);
      await this.pause(Math.min(MAX_WAIT_MS, reply.retryAfter !== undefined ? reply.retryAfter * 1000 : 1000 * attempt));
    }
  }

  /** The marker of the `archon:<PROJECT>:<marker>` link this pack puts on tickets it files, or null. */
  async ownMarker(key: string): Promise<string | null> {
    const prefix = `archon:${this.config.project}:`;
    for (const link of list(await this.request('GET', `${this.issue(key)}/remotelink`))) {
      const id = str(obj(link).globalId);
      if (id.startsWith(prefix)) return id.slice(prefix.length);
    }
    return null;
  }

  /** Move a ticket in the rank order (AK18m); exactly one of before and after. */
  async rank(key: string, place: { before: string } | { after: string }): Promise<void> {
    const other = 'before' in place ? place.before : place.after;
    this.issue(key); // both keys are checked before they reach Jira
    this.issue(other);
    const body = 'before' in place ? { issues: [key], rankBeforeIssue: other } : { issues: [key], rankAfterIssue: other };
    await this.call('PUT', '/rest/agile/1.0/issue/rank', body, [200, 204]);
  }

  toTicket(raw: Json, openSprint: boolean): Ticket {
    const fields = obj(raw.fields);
    const key = str(raw.key);
    const assignee = str(obj(fields.assignee).accountId);
    return {
      key,
      url: `${this.config.site}/browse/${key}`,
      title: str(fields.summary),
      body: plain(fields.description),
      status: str(obj(fields.status).id),
      type: str(obj(fields.issuetype).id),
      labels: list(fields.labels).map(str),
      flagged: list(fields[this.config.flagField]).length > 0,
      assignee: assignee === '' ? null : assignee,
      inOpenSprint: openSprint,
      updated: Date.parse(str(fields.updated)) || 0,
    };
  }

  /** Every match, page by page (`/search/jql` pages with nextPageToken). */
  async search(jql: string, fields = [...TICKET_FIELDS, this.config.flagField]): Promise<Json[]> {
    const found: Json[] = [];
    let token = '';
    for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
      const result = obj(
        await this.call('POST', '/rest/api/3/search/jql', {
          jql,
          maxResults: 100,
          fields,
          ...(token === '' ? {} : { nextPageToken: token }),
        })
      );
      found.push(...list(result.issues).map(obj));
      token = str(result.nextPageToken);
      if (result.isLast === true || token === '') return found;
    }
    throw new Error(`Jira search ran past ${MAX_SEARCH_PAGES} pages: ${jql}`);
  }

  async ticket(key: string): Promise<Ticket> {
    const fields = [...TICKET_FIELDS, this.config.flagField].join(',');
    return this.toTicket(obj(await this.call('GET', `${this.issue(key)}?fields=${fields}`)), false);
  }

  async family(key: string): Promise<Family> {
    const path = `${this.issue(key)}?fields=status,issuetype,parent,subtasks,${this.config.sprintField}`;
    const fields = obj(obj(await this.call('GET', path)).fields);
    const parent = str(obj(fields.parent).key);
    return {
      key,
      status: str(obj(fields.status).id),
      type: str(obj(fields.issuetype).id),
      subtask: obj(fields.issuetype).subtask === true,
      parent: parent === '' ? null : parent,
      activeSprint: list(fields[this.config.sprintField]).some(sprint => str(obj(sprint).state) === 'active'),
      children: list(fields.subtasks).map(raw => ({
        key: str(obj(raw).key),
        status: str(obj(obj(obj(raw).fields).status).id),
      })),
    };
  }

  /** A Jira "relates to" link between two tickets of this project; one that is there already is not added again. */
  async relate(key: string, other: string): Promise<void> {
    this.issue(other);
    const fields = obj(obj(await this.call('GET', `${this.issue(key)}?fields=issuelinks`)).fields);
    const linked = list(fields.issuelinks).some(raw => {
      const link = obj(raw);
      const ends = [str(obj(link.inwardIssue).key), str(obj(link.outwardIssue).key)];
      return str(obj(link.type).name) === 'Relates' && ends.includes(other);
    });
    if (linked) return;
    await this.call('POST', '/rest/api/3/issueLink', {
      type: { name: 'Relates' },
      inwardIssue: { key },
      outwardIssue: { key: other },
    });
  }

  /** All comments, oldest (lowest id) first. Read straight from the issue, never through search. */
  async comments(key: string): Promise<TicketComment[]> {
    const found: TicketComment[] = [];
    for (let startAt = 0; ; ) {
      const page = obj(
        await this.call(
          'GET',
          `${this.issue(key)}/comment?startAt=${startAt}&maxResults=100&orderBy=created`
        )
      );
      const rows = list(page.comments).map(obj);
      for (const row of rows) {
        const id = Number(str(row.id));
        if (!Number.isSafeInteger(id)) throw new Error(`${key}: comment id ${str(row.id)} is not a number`);
        const created = str(row.created);
        found.push({
          id,
          body: plain(row.body),
          created,
          createdAt: Date.parse(created),
          author: str(obj(row.author).accountId),
          url: `${this.config.site}/browse/${key}?focusedCommentId=${id}`,
        });
      }
      startAt += rows.length;
      if (rows.length === 0 || startAt >= Number(page.total ?? 0)) break;
    }
    // Ids are unique but not in `created` order under concurrent writes; every round orders by id.
    return found.sort((a, b) => a.id - b.id);
  }

  async comment(key: string, text: string, mention?: string): Promise<number> {
    const created = await this.call('POST', `${this.issue(key)}/comment`, {
      body: adf(text, mention),
    });
    const id = Number(str(created?.id));
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${key}: the comment was not created`);
    return id;
  }

  async editComment(key: string, id: number, text: string): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${key}: comment id ${id} is not a comment id`);
    await this.call('PUT', `${this.issue(key)}/comment/${id}`, { body: adf(text) });
  }

  /** One step: the transition Jira offers to `statusId` from where the ticket stands. */
  async move(key: string, statusId: string): Promise<void> {
    const listed = obj(await this.call('GET', `${this.issue(key)}/transitions`));
    const hit = list(listed.transitions)
      .map(obj)
      .find(transition => str(obj(transition.to).id) === statusId);
    if (hit === undefined) throw new Error(`${key}: no transition to status ${statusId}`);
    await this.call('POST', `${this.issue(key)}/transitions`, { transition: { id: str(hit.id) } });
  }

  /**
   * To `statusId` along `movePath`, reading where the ticket stands before each step, so a walk
   * cut short finishes on the next call. Jira decides each step: a condition it does not meet
   * (a slice's open task before Review) hides the way, and the error names where it stuck.
   */
  async moveTo(key: string, statusId: string): Promise<void> {
    // Two steps at most; the third only catches a Jira that does not move.
    for (let step = 0; step < 3; step += 1) {
      const now = await this.status(key);
      if (now === statusId) return;
      const next = movePath(now, statusId, this.config.status)[0] ?? statusId;
      try {
        await this.move(key, next);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        const short = why.startsWith(`${key}: no transition to status `) ? `no transition to ${next}` : why;
        throw new Error(`${key}: stuck on ${now} on the way to ${statusId}: ${short}`);
      }
    }
    throw new Error(`${key}: not on ${statusId} after three moves`);
  }

  /** The ticket's status id, read straight from the issue. */
  async status(key: string): Promise<string> {
    return str(obj(obj(obj(await this.call('GET', `${this.issue(key)}?fields=status`)).fields).status).id);
  }

  /**
   * A question for the owner (AK18a): the flag, then the mention. Status and assignee stay.
   * The flag goes first because it is what keeps the loop off the ticket; if the comment then
   * fails, a flagged ticket without its question is seen, a question without the flag is worked on.
   */
  async ask(key: string, text: string): Promise<void> {
    await this.call('PUT', this.issue(key), {
      fields: { [this.config.flagField]: [{ id: this.config.flagOn }] },
    });
    await this.comment(key, text, this.config.owner);
  }
}
