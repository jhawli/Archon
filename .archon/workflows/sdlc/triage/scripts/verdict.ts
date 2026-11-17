/**
 * Validate the triage verdict before it routes work, and apply its labels.
 *
 * The prompt judges; the triage node's schema admits only legal decisions (one
 * branch per contract verdict, each carrying only its own fields), so an illegal
 * combination is re-asked at that node rather than refused here. This flattens the
 * decision into the fields every caller reads and checks what a schema cannot:
 * blockers and a closure's link are qualified URLs. Closing the item is not this
 * node's write: a duplicate or delivered ticket is cancelled by pick's outbox (`cancel`).
 * The pack's own labels derive from the declared fields here rather than being chosen
 * by the model, and only when the run was launched with publish=true and the target is
 * a ticket of the repository's tracker (`.archon/tracker.json`) does this read the
 * ticket on Jira, apply the labels, and read them back. Work items live in Jira only:
 * `item` is always the empty value, and any other target gets no labels.
 */

import { record, type QualifiedPr } from '../../.shared/forge.ts';
import { emit, refuse, text, trimmed } from '../../.shared/io.ts';
import { Jira, requireTracker } from '../../.shared/jira.ts';
import {
  type Contract,
  isOwnedLabel,
  OWNED_LABEL_NAMES,
  type Route,
  type Size,
  type WorkType,
  wantedLabels,
  writeTicketLabels,
} from '../../.shared/labels.ts';
import { ticketKeyOf } from '../../.shared/tickets.ts';

/** What made a `NO_ACTION` item closable, as triage declared it. Data only: nothing here closes. */
export type Closure =
  | {
      readonly kind: 'duplicate';
      /** The ticket (or, in old verdicts, the issue) this one duplicates, and its URL. */
      readonly url: string;
      readonly original: QualifiedPr;
    }
  | {
      readonly kind: 'delivered';
      /** The merged change that already delivered the item's outcome. */
      readonly url: string;
    };

/** One of triage's judged fields: a value and the one-line reason for it. */
interface Field<Value extends string> {
  readonly value: Value;
  readonly reason: string;
}
interface Edits {
  readonly title: string;
  readonly body: string;
}

/** A `from:` binding arrives as the producer's JSON, already certified against its schema. */
function bound(value: string | undefined): unknown {
  return JSON.parse(text(value));
}

function isQualifiedUrl(value: string): boolean {
  if (value === '' || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/** One branch of the triage decision, as the node's schema admits it. */
type Decision =
  | { contract: 'READY'; route: Exclude<Route, 'continue'> }
  | { contract: 'READY'; route: 'continue'; pull_request: number }
  | { contract: 'NEEDS_CONTRACT_WORK'; proposed_edits: Edits }
  | { contract: 'BLOCKED'; blocked_reason: string; blocked_by: string[] }
  | { contract: 'NO_ACTION'; closure: Closure };

const JIRA_TICKET_URL = /^https:\/\/[a-z0-9-]+\.atlassian\.net\/browse\/[A-Z][A-Z0-9]+-[1-9]\d*$/;

/** Every link a verdict carries is one the agent opened, so each must be a qualified URL. */
function unqualifiedLink(
  blockedBy: readonly string[],
  related: readonly { url: string }[],
  closure: Closure | null
): string | null {
  if (!blockedBy.every(isQualifiedUrl)) return 'blocked_by must be a list of fully qualified http(s) URLs';
  if (!related.every(entry => isQualifiedUrl(entry.url))) return 'related urls must be fully qualified http(s) URLs';
  if (closure !== null && !isQualifiedUrl(closure.url)) return 'closure.url must be a fully qualified http(s) URL';
  // The empty original is for a Jira ticket only; any other duplicate names its original so the close links back.
  if (closure?.kind === 'duplicate' && closure.original.number === 0 && !JIRA_TICKET_URL.test(closure.url)) {
    return 'only a duplicate of a Jira ticket may leave original empty: closure.url is the URL of the original ticket';
  }
  return null;
}

/**
 * The Jira ticket a target names, when it is one of the repository's own tracker. The
 * tracker is read only for a ticket URL, so no other target needs a checkout.
 */
function jiraTicket(target: string): { jira: Jira; key: string } | null {
  if (!JIRA_TICKET_URL.test(target.trim())) return null;
  const config = requireTracker();
  const key = ticketKeyOf(target, config);
  return key === null ? null : { jira: new Jira(config), key };
}

async function main(): Promise<void> {
  const decision = bound(process.env.INPUTS_DECISION) as Decision;
  const contract: Contract = decision.contract;
  const route = 'route' in decision ? decision.route : 'no_action';
  const edits: Edits = 'proposed_edits' in decision ? decision.proposed_edits : { title: '', body: '' };
  const blockedReason = 'blocked_reason' in decision ? decision.blocked_reason : '';
  const blockedBy = 'blocked_by' in decision ? decision.blocked_by : [];
  const pullRequest = 'pull_request' in decision ? decision.pull_request : null;
  const closure = 'closure' in decision ? decision.closure : null;
  const type = bound(process.env.INPUTS_TYPE) as Field<WorkType>;
  const size = bound(process.env.INPUTS_SIZE) as Field<Size>;
  // Passed through for the caller; no label mirrors these three.
  const complexity = bound(process.env.INPUTS_COMPLEXITY) as Field<string>;
  const importance = bound(process.env.INPUTS_IMPORTANCE) as Field<string>;
  const urgency = bound(process.env.INPUTS_URGENCY) as Field<string>;
  const publish = text(process.env.INPUTS_PUBLISH) === 'true';
  // An empty target means the run's trigger message is the target.
  const target = text(process.env.INPUTS_TARGET) || text(process.env.ARGUMENTS);
  const summary = text(process.env.INPUTS_SUMMARY);
  const area = bound(process.env.INPUTS_AREA_LABELS) as string[];
  const related = bound(process.env.INPUTS_RELATED) as { url: string; relation: string }[];
  const boundItem = record(bound(process.env.INPUTS_ITEM));
  const repo = record(boundItem?.repo);
  if (repo?.host !== '' || repo.path !== '' || boundItem?.number !== 0) {
    refuse('invalid triage verdict: item must be the empty repo and zero sentinel; tickets go through target');
    return;
  }
  const report = bound(process.env.INPUTS_REPORT);

  const invalid = (message: string): void => {
    refuse(`invalid triage verdict: ${message}`);
  };

  const badLink = unqualifiedLink(blockedBy, related, closure);
  if (badLink !== null) {
    invalid(badLink);
    return;
  }
  if (trimmed(summary) === '') {
    invalid('summary is empty');
    return;
  }
  if (area.some(name => name === '')) {
    invalid('area_labels must be label names');
    return;
  }
  if (area.some(isOwnedLabel)) {
    // The state, type and size labels are derived below; a pack label smuggled in
    // as an area label would be added beside the derived ones or removed as stale.
    invalid('area_labels may not name a pack label; those derive from the verdict');
    return;
  }

  const wanted = wantedLabels(decision, type.value, size.value);

  const adding = [...wanted, ...area];
  const removing = OWNED_LABEL_NAMES.filter(name => !wanted.some(label => label === name));
  const ticket = publish ? jiraTicket(target) : null;
  const published = ticket !== null;
  const labels =
    ticket !== null ? await writeTicketLabels(ticket.jira, ticket.key, adding, removing) : [...new Set(adding)].sort();

  emit({
    contract,
    route,
    pull_request: pullRequest,
    ready: contract === 'READY',
    type,
    size,
    complexity,
    importance,
    urgency,
    labels,
    published,
    proposed_edits: { title: edits.title, body: edits.body },
    blocked_reason: blockedReason,
    blocked_by: blockedBy,
    closure,
    related,
    summary,
    report,
  });
}

try {
  await main();
} catch (error) {
  refuse(`triage labels: ${error instanceof Error ? error.message : String(error)}`);
}
