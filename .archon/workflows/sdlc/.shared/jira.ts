/**
 * Jira as the work-item tracker, used instead of GitHub issues when the repository carries
 * `.archon/tracker.json` with `"kind": "jira"`. Pull requests stay on GitHub.
 *
 * Only script nodes and the launch gate use this module: they run on the host and read the
 * API token from the macOS keychain. Agent nodes never hold the token; they read a ticket
 * from the files a script node wrote under $ARTIFACTS_DIR/tracker and leave their writes in
 * its outbox for a script node to check and apply.
 */
import { existsSync, readFileSync } from 'node:fs';
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
  readonly status: {
    readonly todo: string;
    readonly progress: string;
    readonly review: string;
    readonly staging: string;
    readonly live: string;
    readonly canceled: string;
  };
  readonly flagField: string;
  readonly flagOn: string;
  readonly sprintField: string;
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

const STATUS_KEYS = ['todo', 'progress', 'review', 'staging', 'live', 'canceled'] as const;

/** The repository's tracker, or null when it has none (the pack then uses GitHub issues). */
export function trackerConfig(root = repoRoot()): TrackerConfig | null {
  const path = join(root, '.archon', 'tracker.json');
  if (!existsSync(path)) return null;
  const raw = obj(JSON.parse(readFileSync(path, 'utf8')));
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
    status: {
      todo: str(status.todo),
      progress: str(status.progress),
      review: str(status.review),
      staging: str(status.staging),
      live: str(status.live),
      canceled: str(status.canceled),
    },
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
) => Promise<{ status: number; text: string }>;

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
    return { status: response.status, text: await response.text() };
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
  'labels',
  'assignee',
  'updated',
];

/** A search that pages past this is a runaway query, not a board. */
const MAX_SEARCH_PAGES = 50;

export class Jira {
  constructor(
    readonly config: TrackerConfig,
    private readonly send: Transport = keychainTransport(config)
  ) {}

  async call(method: string, path: string, body?: unknown, ok = [200, 201, 204]): Promise<Json | null> {
    const { status, text } = await this.send(method, path, body);
    if (!ok.includes(status)) throw new Error(`Jira ${method} ${path} -> ${status}: ${text.slice(0, 500)}`);
    return text.trim() === '' ? null : obj(JSON.parse(text));
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
    return this.toTicket(obj(await this.call('GET', `/rest/api/3/issue/${key}?fields=${fields}`)), false);
  }

  /** All comments, oldest (lowest id) first. Read straight from the issue, never through search. */
  async comments(key: string): Promise<TicketComment[]> {
    const found: TicketComment[] = [];
    for (let startAt = 0; ; ) {
      const page = obj(
        await this.call(
          'GET',
          `/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=100&orderBy=created`
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
    const created = await this.call('POST', `/rest/api/3/issue/${key}/comment`, {
      body: adf(text, mention),
    });
    const id = Number(str(created?.id));
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${key}: the comment was not created`);
    return id;
  }

  async editComment(key: string, id: number, text: string): Promise<void> {
    await this.call('PUT', `/rest/api/3/issue/${key}/comment/${id}`, { body: adf(text) });
  }

  async move(key: string, statusId: string): Promise<void> {
    const listed = obj(await this.call('GET', `/rest/api/3/issue/${key}/transitions`));
    const hit = list(listed.transitions)
      .map(obj)
      .find(transition => str(obj(transition.to).id) === statusId);
    if (hit === undefined) throw new Error(`${key}: no transition to status ${statusId}`);
    await this.call('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: str(hit.id) } });
  }

  /** A question for the owner (AK18a): mention, then the flag. Status and assignee stay. */
  async ask(key: string, text: string): Promise<void> {
    await this.comment(key, text, this.config.owner);
    await this.call('PUT', `/rest/api/3/issue/${key}`, {
      fields: { [this.config.flagField]: [{ id: this.config.flagOn }] },
    });
  }
}
