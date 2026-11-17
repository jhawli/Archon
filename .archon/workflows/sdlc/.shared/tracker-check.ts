/**
 * The first node of every workflow someone starts (AK18e): without `.archon/tracker.json`
 * the run ends here, before any agent spends and before anything reads GitHub issues.
 */
import { requireTracker } from './jira.ts';

export function trackerCheck(workflow: string, root?: string): void {
  try {
    requireTracker(root);
  } catch (error) {
    throw new Error(`${workflow} ${error instanceof Error ? error.message : String(error)}`);
  }
}
