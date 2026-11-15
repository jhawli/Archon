/** Refuses the run while the repository tracks its work in Jira; see `.shared/s4b-guard.ts`. */

import { refuse } from '../../.shared/io.ts';
import { trackerConfig } from '../../.shared/jira.ts';
import { s4bGuard } from '../../.shared/s4b-guard.ts';

try {
  s4bGuard('archon-merge-queue', trackerConfig());
} catch (error) {
  refuse(`tracker-guard: ${error instanceof Error ? error.message : String(error)}`);
}
