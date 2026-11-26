/**
 * The pack's labels and the writes that apply them.
 *
 * Every label the pack writes is declared here with its color and description,
 * and every stage that writes labels goes through `writeTicketLabels` (tickets live
 * in Jira; this fork has no GitHub-issue path). Stages are joined by labels, one stage's
 * exit label being the next stage's entry label, so a name declared anywhere else
 * is a copy that can drift.
 */

import { needsBefund } from './befund.ts';
import type { Jira } from './jira.ts';

interface LabelSpec {
  readonly color: string;
  readonly description: string;
}

export const PACK_LABELS = {
  'archon-ready': { color: '0E8A16', description: 'Triage: ready to deliver' },
  'archon-plan': { color: '1D76DB', description: 'Triage: ready; a plan comes before delivery' },
  'archon-investigate': {
    color: 'C5DEF5',
    description: 'Triage: ready; an investigation comes before delivery',
  },
  'archon-needs-contract': {
    color: 'D93F0B',
    description: "Triage: one of the contract's six elements is missing",
  },
  'archon-blocked': {
    color: 'B60205',
    description: 'Triage: a prerequisite or human decision must land first',
  },
  'archon-close': {
    color: '6A737D',
    description: 'Triage: a duplicate, or already delivered',
  },
  'archon-type-bug': { color: 'D73A4A', description: 'Triage: something that worked is broken' },
  'archon-type-feature': { color: 'A2EEEF', description: 'Triage: new behavior' },
  'archon-type-refactor': { color: 'BFD4F2', description: 'Triage: same behavior, better structure' },
  'archon-type-maintenance': {
    color: 'D4C5F9',
    description: 'Triage: dependencies, tooling, CI, or upkeep',
  },
  'archon-type-docs': { color: '0075CA', description: 'Triage: documentation only' },
  'archon-type-question': { color: 'D876E3', description: 'Triage: a question for a person' },
  'archon-size-s': { color: 'C2E0C6', description: 'Triage: a few files on one surface' },
  'archon-size-m': { color: 'FEF2C0', description: 'Triage: several files or two surfaces' },
  'archon-size-l': { color: 'F9D0C4', description: 'Triage: several packages, schemas, or surfaces' },
  'archon-needs-maintainer': {
    color: 'FBCA04',
    description: 'Intake: an outside item waits for a maintainer to promote it',
  },
  'archon-triage': {
    color: '5319E7',
    description: 'Intake: a request to triage this item; intake removes it when done',
  },
} as const satisfies Record<string, LabelSpec>;

export type PackLabel = keyof typeof PACK_LABELS;

export function isPackLabel(name: string): name is PackLabel {
  return Object.hasOwn(PACK_LABELS, name);
}

// Labels an earlier version of the pack wrote. A write removes them from the item
// and never creates them, so re-triaging an item clears its old size label, and
// intake's next write on an item clears archon-issue, the investigate route's old name.
const RETIRED_LABELS = ['archon-small', 'archon-risky', 'archon-large', 'archon-issue'] as const;

/** A label the pack owns on an item: one it writes now, or one it retired. */
export type OwnedLabel = PackLabel | (typeof RETIRED_LABELS)[number];

export const OWNED_LABEL_NAMES: readonly OwnedLabel[] = [
  ...(Object.keys(PACK_LABELS) as PackLabel[]),
  ...RETIRED_LABELS,
];

export function isOwnedLabel(name: string): name is OwnedLabel {
  return (OWNED_LABEL_NAMES as readonly string[]).includes(name);
}

export type Contract = 'READY' | 'NEEDS_CONTRACT_WORK' | 'BLOCKED' | 'NO_ACTION';
export type WorkType = 'bug' | 'feature' | 'refactor' | 'maintenance' | 'docs' | 'question';
export type Size = 's' | 'm' | 'l';
export type Route = 'investigate' | 'plan' | 'deliver' | 'continue';

// Exactly one state label per item. A READY item's label names the route the run
// takes on it: archon-ready delivers (a new pull request, or the open one it
// continues), archon-plan plans then delivers, and archon-investigate investigates
// then delivers.
export const STATE_LABEL = {
  NEEDS_CONTRACT_WORK: 'archon-needs-contract',
  BLOCKED: 'archon-blocked',
  NO_ACTION: 'archon-close',
} as const satisfies Record<Exclude<Contract, 'READY'>, PackLabel>;
export const ROUTE_LABEL = {
  deliver: 'archon-ready',
  continue: 'archon-ready',
  plan: 'archon-plan',
  investigate: 'archon-investigate',
} as const satisfies Record<Route, PackLabel>;
// Of triage's five fields only type and size become labels, the two a person
// filters by; complexity, importance and urgency stay in the verdict.
export const TYPE_LABEL = {
  bug: 'archon-type-bug',
  feature: 'archon-type-feature',
  refactor: 'archon-type-refactor',
  maintenance: 'archon-type-maintenance',
  docs: 'archon-type-docs',
  question: 'archon-type-question',
} as const satisfies Record<WorkType, PackLabel>;
export const SIZE_LABEL = {
  s: 'archon-size-s',
  m: 'archon-size-m',
  l: 'archon-size-l',
} as const satisfies Record<Size, PackLabel>;

/**
 * The labels a person adds to ask intake for something: `archon-triage` asks for
 * triage, and a route label on an outside item promotes it. The pack's own write of
 * a route label is not a request; intake recognizes it as the work item's mirror.
 */
export const REQUEST_LABELS: readonly PackLabel[] = [
  'archon-triage',
  ...new Set(Object.values(ROUTE_LABEL)),
];

export function isRequestLabel(name: string): boolean {
  return (REQUEST_LABELS as readonly string[]).includes(name);
}

/** A triage verdict as far as labels read it: a READY item carries its route. */
export type LabelVerdict =
  | { readonly contract: 'READY'; readonly route: Route }
  | { readonly contract: Exclude<Contract, 'READY'> };

/**
 * The pack labels a verdict derives: one state label and one type label, plus a
 * size label while the item can still be worked; a close verdict carries none.
 */
export function wantedLabels(verdict: LabelVerdict, type: WorkType, size: Size): PackLabel[] {
  const wanted: PackLabel[] = [
    verdict.contract === 'READY' ? ROUTE_LABEL[verdict.route] : STATE_LABEL[verdict.contract],
    TYPE_LABEL[type],
  ];
  if (verdict.contract !== 'NO_ACTION') wanted.push(SIZE_LABEL[size]);
  return wanted;
}

/**
 * Add and remove labels on a Jira ticket as a delta, then read the result back. Jira labels
 * need no declaration, so every label is added as asked; an owned label is only ever removed.
 * Reading the ticket first verifies the key on Jira before anything is written.
 */
export async function writeTicketLabels(
  jira: Jira,
  key: string,
  add: readonly string[],
  remove: readonly OwnedLabel[]
): Promise<string[]> {
  const current = new Set((await jira.ticket(key)).labels);
  const applied = [...new Set(add)].sort();
  // A befund label opens the merge gate for its ticket (befund.ts), and triage names area labels
  // freely: only the owner or the repository's own jobs set one.
  const granting = applied.filter(name => !current.has(name) && needsBefund([name], jira.config));
  if (granting.length > 0) throw new Error(`the pack never adds a label with Befund-Pflicht: ${granting.join(', ')}`);
  const removing = new Set<string>(remove);
  const stale = [...current].filter(name => removing.has(name) && !applied.includes(name)).sort();
  const changes = [
    ...applied.filter(name => !current.has(name)).map(name => ({ add: name })),
    ...stale.map(name => ({ remove: name })),
  ];
  if (changes.length === 0) return applied;
  // Single add and remove operations, never the whole set, so labels another writer set survive.
  await jira.call('PUT', jira.issue(key), { update: { labels: changes } });
  const after = new Set((await jira.ticket(key)).labels);
  const missing = applied.filter(name => !after.has(name));
  const lingering = stale.filter(name => after.has(name));
  if (missing.length > 0 || lingering.length > 0) {
    throw new Error(
      `label read-back disagrees: missing=${JSON.stringify(missing)} lingering=${JSON.stringify(lingering)}`
    );
  }
  return applied;
}
