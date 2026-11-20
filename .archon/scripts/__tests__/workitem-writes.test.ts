 
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jira, NEEDS_TRACKER, type TrackerConfig, type Transport } from '../../workflows/sdlc/.shared/jira';
import { OWNED_LABEL_NAMES, writeTicketLabels } from '../../workflows/sdlc/.shared/labels';
import type { Closure } from '../../workflows/sdlc/triage/scripts/verdict';
import { PR, packScriptRunner } from './deliver-checks-harness';
import { STATUS, TYPES } from './jira-fixtures';
import { trackTempRoots } from './temp-roots';

const { runPackScript } = packScriptRunner();
const trackTempRoot = trackTempRoots();

// Work items live in Jira: `item` is always the empty sentinel, a ticket comes in as the target.
const SENTINEL = '{"repo":{"host":"","path":""},"number":0}';

const inputs = {
  INPUTS_ITEM: SENTINEL,
  INPUTS_PUBLISH: 'true',
  INPUTS_DECISION: JSON.stringify({ contract: 'READY', route: 'deliver' }),
  INPUTS_TYPE: '{"value":"feature","reason":"new behavior"}',
  INPUTS_SIZE: '{"value":"s","reason":"one script"}',
  INPUTS_COMPLEXITY: '{"value":"low","reason":"clear change"}',
  INPUTS_IMPORTANCE: '{"value":"medium","reason":"on direction"}',
  INPUTS_URGENCY: '{"value":"none","reason":"nothing waits on it"}',
  INPUTS_SUMMARY: 'Ready',
  INPUTS_AREA_LABELS: '["area","nonexistent"]',
  INPUTS_RELATED: '[]',
  INPUTS_REPORT: '{"path":"triage.md"}',
};
test('unpublished triage, or a target that is no ticket, never writes labels anywhere', () => {
  const patches: Record<string, string>[] = [
    { INPUTS_PUBLISH: 'false' },
    { INPUTS_TARGET: 'https://ghe.example.com/example/repo/issues/7' },
  ];
  for (const patch of patches) {
    const run = runPackScript('triage/scripts/verdict', {
      source: 'invalid',
      inputs: { ...inputs, ...patch },
    });
    expect(run.code).toBe(0);
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([]);
    expect(JSON.parse(run.stdout).published).toBe(false);
  }
});

test('a ready item is labelled with the route the run takes on it', () => {
  for (const [decision, label] of [
    [{ contract: 'READY', route: 'plan' }, 'archon-plan'],
    [{ contract: 'READY', route: 'investigate' }, 'archon-investigate'],
    [{ contract: 'READY', route: 'continue', pull_request: 3 }, 'archon-ready'],
  ] as const) {
    const run = runPackScript('triage/scripts/verdict', {
      inputs: { ...inputs, INPUTS_PUBLISH: 'false', INPUTS_DECISION: JSON.stringify(decision) },
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).labels).toEqual(
      [label, 'archon-size-s', 'archon-type-feature', 'area', 'nonexistent'].sort()
    );
  }
});

test('the verdict passes all five triage fields through unchanged', () => {
  const run = runPackScript('triage/scripts/verdict', {
    inputs: {
      ...inputs,
      INPUTS_PUBLISH: 'false',
      INPUTS_COMPLEXITY: '{"value":"high","reason":"unknown design"}',
      INPUTS_IMPORTANCE: '{"value":"low","reason":"off direction"}',
      INPUTS_URGENCY: '{"value":"soon","reason":"release next week"}',
    },
  });
  expect(run.code).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({
    type: { value: 'feature', reason: 'new behavior' },
    size: { value: 's', reason: 'one script' },
    complexity: { value: 'high', reason: 'unknown design' },
    importance: { value: 'low', reason: 'off direction' },
    urgency: { value: 'soon', reason: 'release next week' },
  });
});

const DELIVERED: Closure = { kind: 'delivered', url: 'https://ghe.example.com/example/repo/pull/5' };

test('a close verdict keeps the type label, drops the size label, and carries its closure', () => {
  const run = runPackScript('triage/scripts/verdict', {
    inputs: {
      ...inputs,
      INPUTS_PUBLISH: 'false',
      INPUTS_DECISION: JSON.stringify({ contract: 'NO_ACTION', closure: DELIVERED }),
      INPUTS_REPORT: '{"type":"archon_artifact","run_id":"r","path":"triage.md"}',
    },
  });
  expect(run.code).toBe(0);
  const output = JSON.parse(run.stdout);
  expect(output.labels).toEqual(['archon-close', 'archon-type-feature', 'area', 'nonexistent']);
  expect(output.closure).toEqual(DELIVERED);
});

test('a published close verdict labels the ticket and closes nothing; pick cancels it by its outbox', () => {
  const run = runPackScript('triage/scripts/verdict', {
    source: 'gh',
    cwd: jiraCheckout(),
    inputs: {
      ...inputs,
      INPUTS_TARGET: TICKET,
      INPUTS_DECISION: JSON.stringify({ contract: 'NO_ACTION', closure: DELIVERED }),
    },
    preload: jiraPreload([]),
  });
  expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
  expect(JSON.parse(run.stdout).published).toBe(true);
  // Labels only: no transition, no comment on Jira, and nothing on GitHub.
  expect(jiraLog(run.artifacts).map(([method, path]) => `${method} ${path.split('?')[0]}`)).toEqual([
    'GET /rest/api/3/issue/CONC-5',
    'PUT /rest/api/3/issue/CONC-5',
    'GET /rest/api/3/issue/CONC-5',
  ]);
  expect([...run.gh, ...run.closes, ...run.comments]).toEqual([]);
});

test('a close link that is not a qualified URL is refused, so a guess never reaches intake', () => {
  const run = runPackScript('triage/scripts/verdict', {
    inputs: {
      ...inputs,
      INPUTS_PUBLISH: 'false',
      INPUTS_DECISION: JSON.stringify({
        contract: 'NO_ACTION',
        closure: { kind: 'delivered', url: 'pull 5' },
      }),
    },
  });
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain('closure.url must be a fully qualified');
});

test('related work reaches the verdict as declared, and a related link that is not a qualified URL is refused', () => {
  const related = [{ url: 'https://ghe.example.com/example/repo/pull/5', relation: 'merged change on the same surface' }];
  const passed = runPackScript('triage/scripts/verdict', {
    inputs: { ...inputs, INPUTS_PUBLISH: 'false', INPUTS_RELATED: JSON.stringify(related) },
  });
  expect({ code: passed.code, stderr: passed.stderr }).toEqual({ code: 0, stderr: '' });
  expect((JSON.parse(passed.stdout) as { related: unknown }).related).toEqual(related);

  const refused = runPackScript('triage/scripts/verdict', {
    inputs: { ...inputs, INPUTS_PUBLISH: 'false', INPUTS_RELATED: '[{"url":"issue 5","relation":"overlaps"}]' },
  });
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain('related urls must be fully qualified');
});

test('an item other than the empty sentinel is refused before anything is written', () => {
  for (const item of [
    { repo: PR.repo, number: 7 },
    { repo: { host: '', path: 'repo' }, number: 1 },
    { repo: PR.repo, number: 0 },
    { repo: PR.repo, number: 1.5 },
  ]) {
    const run = runPackScript('triage/scripts/verdict', {
      source: 'forge',
      inputs: { ...inputs, INPUTS_ITEM: JSON.stringify(item) },
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('item must be the empty repo and zero sentinel');
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([]);
  }
});

test('a retired size label is never accepted as an area label', () => {
  const run = runPackScript('triage/scripts/verdict', {
    inputs: { ...inputs, INPUTS_AREA_LABELS: '["archon-small"]' },
  });
  expect(run.code).not.toBe(0);
  expect(run.gh).toEqual([]);
  expect(run.stderr).toContain('may not name a pack label');
});

// --- Labels on a Jira ticket (S4a Task 7b) ---

const JIRA: TrackerConfig = {
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

type LabelChange = { add: string } | { remove: string };

/** One ticket, CONC-5, whose labels take each PUT's delta; with `lose`, a PUT changes nothing. */
function labelJira(start: string[], lose = false): { jira: Jira; calls: [string, string, unknown][] } {
  let labels = [...start];
  const calls: [string, string, unknown][] = [];
  const send: Transport = async (method, path, body) => {
    calls.push([method, path, body]);
    if (method === 'GET' && path.startsWith('/rest/api/3/issue/CONC-5?')) {
      return { status: 200, text: JSON.stringify({ key: 'CONC-5', fields: { labels } }) };
    }
    if (method === 'PUT' && path === '/rest/api/3/issue/CONC-5') {
      const changes = (body as { update: { labels: LabelChange[] } }).update.labels;
      for (const change of lose ? [] : changes) {
        labels = 'add' in change ? [...labels, change.add] : labels.filter(name => name !== change.remove);
      }
      return { status: 204, text: '' };
    }
    return { status: 404, text: '{}' };
  };
  return { jira: new Jira(JIRA, send), calls };
}

test('a Jira ticket takes the label delta in one write, so labels another writer set stay', async () => {
  const { jira, calls } = labelJira(['archon-plan', 'thema:x']);
  const applied = await writeTicketLabels(jira, 'CONC-5', ['archon-ready', 'archon-type-bug', 'thema:x'], OWNED_LABEL_NAMES);
  expect(applied).toEqual(['archon-ready', 'archon-type-bug', 'thema:x']);
  expect(calls.map(([method]) => method)).toEqual(['GET', 'PUT', 'GET']);
  expect(calls[1]).toEqual([
    'PUT',
    '/rest/api/3/issue/CONC-5',
    { update: { labels: [{ add: 'archon-ready' }, { add: 'archon-type-bug' }, { remove: 'archon-plan' }] } },
  ]);
});

test('a Jira label write that does not read back is refused', async () => {
  const { jira } = labelJira(['archon-plan'], true);
  let message = '';
  try {
    await writeTicketLabels(jira, 'CONC-5', ['archon-ready'], OWNED_LABEL_NAMES);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBe('label read-back disagrees: missing=["archon-ready"] lingering=["archon-plan"]');
});

test('a Jira ticket that already carries the labels gets no write', async () => {
  const { jira, calls } = labelJira(['archon-ready', 'someone-elses']);
  expect(await writeTicketLabels(jira, 'CONC-5', ['archon-ready'], OWNED_LABEL_NAMES)).toEqual(['archon-ready']);
  expect(calls.map(([method]) => method)).toEqual(['GET']);
});

test('a key outside the project never reaches Jira', async () => {
  const { jira, calls } = labelJira([]);
  let message = '';
  try {
    await writeTicketLabels(jira, 'CONC-5/../../myself', ['archon-ready'], OWNED_LABEL_NAMES);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('not a CONC ticket key');
  expect(calls).toEqual([]);
});

/** A checkout whose `.archon/tracker.json` says Jira, or a plain one with `tracker: false`. */
function jiraCheckout(tracker = true): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-jira-labels-')));
  spawnSync('git', ['init', '-q', root]);
  if (tracker) {
    mkdirSync(join(root, '.archon'));
    writeFileSync(join(root, '.archon', 'tracker.json'), JSON.stringify(JIRA));
  }
  return root;
}

/**
 * Fakes the keychain and Jira for one script run: CONC-5 starts with `start` and takes each
 * PUT's delta (none with `lose`). Every request is logged to `{ARTIFACTS}/jira.log`; the site is
 * example.atlassian.net and the keychain item `none`, so a fake that fails to apply reaches nothing real.
 */
function jiraPreload(start: string[], lose = false): string {
  return `
import { appendFileSync as appendJiraLog } from 'node:fs';
const jiraSpawn = Bun.spawnSync.bind(Bun);
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  if (argv[0] !== '/usr/bin/security') return jiraSpawn(argv, settings);
  const out = argv.includes('-w') ? 'token\\n' : 'keychain: "acct"<blob>="archon@example.com"\\n';
  return { exitCode: 0, stdout: Buffer.from(out), stderr: Buffer.from('') };
} });
let jiraLabels = ${JSON.stringify(start)};
globalThis.fetch = async (url, init) => {
  const path = String(url).replace('https://example.atlassian.net', '');
  const body = init.body === undefined ? null : JSON.parse(init.body);
  appendJiraLog('{ARTIFACTS}/jira.log', JSON.stringify([init.method, path, body]) + '\\n');
  if (init.method === 'PUT') {
    for (const change of ${lose ? '[]' : 'body.update.labels'}) {
      jiraLabels = 'add' in change ? [...jiraLabels, change.add] : jiraLabels.filter(name => name !== change.remove);
    }
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify({ key: 'CONC-5', fields: { labels: jiraLabels } }), { status: 200 });
};
`;
}

function jiraLog(artifacts: string): [string, string, unknown][] {
  const path = join(artifacts, 'jira.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as [string, string, unknown]);
}

const TICKET = 'https://example.atlassian.net/browse/CONC-5';

test('a published triage of a Jira ticket labels the ticket, not a GitHub issue', () => {
  const targets: Record<string, string>[] = [{ INPUTS_TARGET: TICKET }, { INPUTS_TARGET: '', ARGUMENTS: TICKET }];
  for (const target of targets) {
    const run = runPackScript('triage/scripts/verdict', {
      source: 'gh',
      cwd: jiraCheckout(),
      inputs: { ...inputs, ...target, INPUTS_ITEM: SENTINEL },
      preload: jiraPreload(['archon-plan', 'someone-elses']),
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    const labels = ['archon-ready', 'archon-size-s', 'archon-type-feature', 'area', 'nonexistent'];
    expect(JSON.parse(run.stdout)).toMatchObject({ published: true, labels });
    expect(jiraLog(run.artifacts).map(([method, path]) => `${method} ${path.split('?')[0]}`)).toEqual([
      'GET /rest/api/3/issue/CONC-5',
      'PUT /rest/api/3/issue/CONC-5',
      'GET /rest/api/3/issue/CONC-5',
    ]);
    expect(jiraLog(run.artifacts)[1]?.[2]).toEqual({
      update: { labels: [...labels.map(name => ({ add: name })), { remove: 'archon-plan' }] },
    });
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([]);
  }
});

test('a Jira ticket is labelled only when publishing, and only one of the configured project', () => {
  for (const [patch, cwd] of [
    [{ INPUTS_PUBLISH: 'false' }, jiraCheckout()],
    [{ INPUTS_TARGET: 'https://example.atlassian.net/browse/VAULT-3' }, jiraCheckout()],
    [{ INPUTS_TARGET: 'https://other.atlassian.net/browse/CONC-5' }, jiraCheckout()],
  ] as const) {
    const run = runPackScript('triage/scripts/verdict', {
      source: 'gh',
      cwd,
      inputs: { ...inputs, INPUTS_TARGET: TICKET, ...patch, INPUTS_ITEM: SENTINEL },
      preload: jiraPreload(['archon-plan']),
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(run.stdout).published).toBe(false);
    expect(jiraLog(run.artifacts)).toEqual([]);
    expect(run.gh).toEqual([]);
  }
});

test('a Jira label write that does not read back refuses the verdict', () => {
  const run = runPackScript('triage/scripts/verdict', {
    source: 'gh',
    cwd: jiraCheckout(),
    inputs: { ...inputs, INPUTS_TARGET: TICKET, INPUTS_ITEM: SENTINEL },
    preload: jiraPreload(['archon-plan'], true),
  });
  expect(run.code).not.toBe(0);
  expect(run.stdout).toBe('');
  expect(run.stderr).toContain('triage labels: label read-back disagrees');
});

test('publishing a ticket without .archon/tracker.json refuses the verdict (AK18e)', () => {
  const run = runPackScript('triage/scripts/verdict', {
    source: 'gh',
    cwd: jiraCheckout(false),
    inputs: { ...inputs, INPUTS_TARGET: TICKET },
    preload: jiraPreload(['archon-plan']),
  });
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain(NEEDS_TRACKER);
  expect(jiraLog(run.artifacts)).toEqual([]);
  expect(run.gh).toEqual([]);
});
