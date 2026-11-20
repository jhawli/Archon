import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinTrackerConfig, requireTracker } from '../../workflows/sdlc/.shared/jira';
import { trackerCheck } from '../../workflows/sdlc/.shared/tracker-check';
import { STATUS, TYPES } from './jira-fixtures';

const VALID = {
  kind: 'jira', site: 'https://example.atlassian.net', project: 'CONC', board: 5, keychain: 'none',
  assignee: 'acc-archon', owner: 'acc-julian',
  status: STATUS,
  types: TYPES,
  flagField: 'customfield_10021', flagOn: '10019', sprintField: 'customfield_10020',
};

function repo(tracker?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'tracker-check-'));
  mkdirSync(join(root, '.archon'));
  if (tracker !== undefined) writeFileSync(join(root, '.archon', 'tracker.json'), JSON.stringify(tracker));
  return root;
}

describe('AK18e: every workflow needs .archon/tracker.json', () => {
  it('a repository without tracker.json is refused with the reason', () => {
    expect(() => { trackerCheck('archon-loop', repo()); }).toThrow('archon-loop braucht .archon/tracker.json');
  });
  it('a Jira tracker passes and is returned', () => {
    expect(requireTracker(repo(VALID)).project).toBe('CONC');
  });
  it('a broken tracker.json is refused, never read as "no tracker"', () => {
    expect(() => { trackerCheck('archon-manager', repo({ kind: 'github' })); }).toThrow('kind must be "jira"');
  });
  it('pinning refuses a missing tracker instead of pinning null', () => {
    const root = repo();
    const state = mkdtempSync(join(tmpdir(), 'state-'));
    expect(() => pinTrackerConfig(state, root)).toThrow('braucht .archon/tracker.json');
  });
});
