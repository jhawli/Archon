/**
 * The loop's board from Jira: the startable tickets, the tickets open pull requests name,
 * and which `Depends on` targets still block. Used by the launch gate and by tracker-read,
 * so both see the same facts. Pull requests stay on GitHub and come in as `gh pr list` rows.
 */
import { doneStatuses, type Jira, type Ticket, type TicketComment, todoStatuses } from './jira.ts';
import { dependencyKeys, prKeys } from './tickets.ts';
import { OWNER_LABEL, type Board, type BoardItem, type Links } from './workable.ts';

/** A GitHub pull request as a board item (`#n`), with gh's `updatedAt`. */
export interface GithubItem extends BoardItem {
  readonly updatedAt: string;
}

export interface JiraBoard {
  readonly board: Board;
  /** The tickets on the board: the open sprint's, in rank order, then the ones pull requests name. */
  readonly tickets: Ticket[];
  /** Every ticket's comments, lowest id first, as read for the board. */
  readonly comments: ReadonlyMap<string, readonly TicketComment[]>;
  /** Newest change to any ticket or pull request on the board, in ms; 0 for an empty board. */
  readonly updated: number;
  readonly links: Links;
}

export function jiraLinks(project: string): Links {
  return {
    pullKeys: pull => prKeys(pull, project),
    dependencies: body => dependencyKeys(body, project),
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** `gh pr list --json number,title,body,labels,comments,updatedAt` rows. */
export function githubItems(raw: unknown): GithubItem[] {
  if (!Array.isArray(raw)) throw new Error('gh returned no list');
  return rows(raw).map(row => {
    const labels = rows(row.labels).map(label => str(label.name));
    return {
      id: `#${Number(row.number)}`,
      title: str(row.title),
      body: str(row.body),
      labels,
      comments: rows(row.comments).map(comment => ({
        body: str(comment.body),
        createdAt: str(comment.createdAt),
        url: str(comment.url),
      })),
      owner: labels.includes(OWNER_LABEL),
      candidate: true,
      updatedAt: str(row.updatedAt),
    };
  });
}

export const GITHUB_FIELDS = 'number,title,body,labels,comments,updatedAt';

/** The repository's open pull requests, as the launch gate and tracker-read both read them. */
export function openPulls(): GithubItem[] {
  const result = Bun.spawnSync(
    ['gh', 'pr', 'list', '--state', 'open', '--limit', '100', '--json', GITHUB_FIELDS],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0) {
    throw new Error(`gh pr list failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  return githubItems(JSON.parse(result.stdout.toString()));
}

export async function loadJiraBoard(jira: Jira, pulls: readonly GithubItem[]): Promise<JiraBoard> {
  const c = jira.config;
  const links = jiraLinks(c.project);
  // Flagged tickets come too: pick may lift a flag that was only bookkeeping (they are not candidates).
  const startable = (
    await jira.search(
      `project = ${c.project} AND sprint in openSprints() AND status in (${todoStatuses(c.status).join(', ')}) AND assignee = "${c.assignee}" ORDER BY Rank ASC`
    )
  ).map(raw => jira.toTicket(raw, true));
  const have = new Set(startable.map(ticket => ticket.key));
  const named = [...new Set(pulls.flatMap(pull => links.pullKeys(pull)))].filter(key => !have.has(key));
  // `key in (...)` returns no row for a key Jira does not know, rather than failing the search.
  const linked =
    named.length === 0
      ? []
      : (await jira.search(`key in (${named.join(',')})`)).map(raw => jira.toTicket(raw, false));
  const tickets = [...startable, ...linked];

  const done = doneStatuses(c.status);
  const open = new Set(tickets.filter(ticket => !done.has(ticket.status)).map(ticket => ticket.key));
  const deps = [...new Set(tickets.flatMap(ticket => links.dependencies(ticket.body)))];
  const depRows = deps.length === 0 ? [] : await jira.search(`key in (${deps.join(',')})`, ['status']);
  const known = new Set<string>();
  for (const row of depRows) {
    const ticket = jira.toTicket(row, false);
    known.add(ticket.key);
    if (done.has(ticket.status)) open.delete(ticket.key);
    else open.add(ticket.key);
  }
  // A dependency key Jira does not know (a typo, another project) stays open: waiting is the safe side.
  for (const key of deps) if (!known.has(key)) open.add(key);

  const issues: BoardItem[] = [];
  const read = new Map<string, TicketComment[]>();
  for (const ticket of tickets) {
    const rows = await jira.comments(ticket.key);
    read.set(ticket.key, rows);
    const comments = rows.map(comment => ({
      body: comment.body,
      createdAt: new Date(comment.createdAt).toISOString(),
      url: comment.url,
    }));
    issues.push({
      id: ticket.key,
      title: ticket.title,
      body: ticket.body,
      labels: ticket.labels,
      comments,
      owner: ticket.flagged || ticket.labels.includes(OWNER_LABEL),
      candidate: have.has(ticket.key) && !ticket.flagged,
    });
  }
  const updated = Math.max(
    0,
    ...tickets.map(ticket => ticket.updated),
    ...pulls.map(pull => Date.parse(pull.updatedAt) || 0)
  );
  return { board: { issues, pulls, open }, tickets, comments: read, updated, links };
}
