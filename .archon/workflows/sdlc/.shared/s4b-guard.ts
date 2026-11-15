/**
 * The stop for the workflows Jira does not reach yet (S4b): manager, backlog, discoveries and
 * merge-queue still read and write GitHub issues and pull requests. In a repository whose
 * `.archon/tracker.json` names Jira they would put work where no one looks, so their first node
 * (`tracker-guard`) refuses the run before any agent spends. Without a tracker they run as before.
 */
import type { TrackerConfig } from './jira.ts';

/** Throws when the repository tracks its work in Jira; `workflow` is the refused workflow's name. */
export function s4bGuard(workflow: string, config: TrackerConfig | null): void {
  if (config === null) return;
  throw new Error(
    `${workflow} does not run on Jira yet (S4b): .archon/tracker.json names Jira, and it would write to GitHub instead`
  );
}
