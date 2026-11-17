import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TrackerConfig } from '../../workflows/sdlc/.shared/jira';
import { s4bGuard } from '../../workflows/sdlc/.shared/s4b-guard';
import { packScriptRunner } from './deliver-checks-harness';
import { trackTempRoots } from './temp-roots';

const { runPackScript } = packScriptRunner();
const trackTempRoot = trackTempRoots();
const PACK = resolve(import.meta.dir, '../../workflows/sdlc');

const CFG: TrackerConfig = {
  kind: 'jira',
  site: 'https://example.atlassian.net',
  project: 'CONC',
  board: 5,
  keychain: 'none',
  assignee: 'acc-archon',
  owner: 'acc-julian',
  status: { todo: '10015', progress: '3', review: '10016', staging: '10017', live: '10018', canceled: '10008' },
  flagField: 'customfield_10021',
  flagOn: '10019',
  sprintField: 'customfield_10020',
};

/** The workflows that still work on GitHub issues, by folder and workflow name (the manager and the backlog read Jira since S4b Task 7 and 8). */
const S4B: readonly (readonly [string, string])[] = [
  ['discoveries', 'archon-discoveries'],
  ['merge-queue', 'archon-merge-queue'],
];

test('a Jira tracker refuses an S4b workflow, no tracker lets it run', () => {
  expect(() => {
    s4bGuard('archon-manager', CFG);
  }).toThrow(
    'archon-manager does not run on Jira yet (S4b): .archon/tracker.json names Jira, and it would write to GitHub instead'
  );
  expect(() => {
    s4bGuard('archon-manager', null);
  }).not.toThrow();
});

/** A git checkout, with `.archon/tracker.json` naming Jira unless `tracker` is false. */
function checkout(tracker: boolean): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-s4b-guard-')));
  spawnSync('git', ['init', '-q', root]);
  if (tracker) {
    mkdirSync(join(root, '.archon'));
    writeFileSync(join(root, '.archon', 'tracker.json'), JSON.stringify(CFG));
  }
  return root;
}

test('each S4b guard script refuses its own workflow in a Jira checkout and passes in a plain one', () => {
  for (const [folder, name] of S4B) {
    const refused = runPackScript(`${folder}/scripts/tracker-guard`, { cwd: checkout(true) });
    expect({ folder, code: refused.code }).toEqual({ folder, code: 1 });
    expect(refused.stderr).toContain(`tracker-guard: ${name} does not run on Jira yet (S4b)`);

    const passed = runPackScript(`${folder}/scripts/tracker-guard`, { cwd: checkout(false) });
    expect({ folder, code: passed.code, stderr: passed.stderr }).toEqual({ folder, code: 0, stderr: '' });
  }
});

test('a broken tracker.json refuses the run too, it never reads as no tracker', () => {
  const root = checkout(false);
  mkdirSync(join(root, '.archon'));
  writeFileSync(join(root, '.archon', 'tracker.json'), JSON.stringify({ kind: 'jira' }));
  const run = runPackScript('discoveries/scripts/tracker-guard', { cwd: root });
  expect(run.code).toBe(1);
  expect(run.stderr).toContain('tracker-guard: .archon/tracker.json');
});

interface WorkflowNode {
  readonly id: string;
  readonly script?: string;
  readonly runtime?: string;
  readonly depends_on?: readonly string[];
}

test('in each S4b workflow every other node waits for tracker-guard', () => {
  for (const [folder, name] of S4B) {
    const doc = Bun.YAML.parse(readFileSync(join(PACK, folder, `${name}.yaml`), 'utf8')) as {
      name: string;
      nodes: WorkflowNode[];
    };
    expect(doc.name).toBe(name);
    const roots = doc.nodes.filter(node => (node.depends_on ?? []).length === 0);
    expect({ name, roots: roots.map(node => node.id) }).toEqual({ name, roots: ['tracker-guard'] });
    expect(roots[0]).toMatchObject({ script: 'tracker-guard', runtime: 'bun' });
  }
});
