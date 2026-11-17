/**
 * The merge queue's first node (AK18e): without .archon/tracker.json the run ends here, before
 * any agent. It pins the tracker for this run and records the run's start, the anchor against
 * which ticket-status confirms each merge (`confirmMerge`), as a claim is for the loop.
 */
import { runState } from '../../.shared/claims.ts';
import { report } from '../../.shared/io.ts';
import { pinTrackerConfig } from '../../.shared/jira.ts';
import { recordStart } from '../../.shared/queue-status.ts';
import { trackerCheck } from '../../.shared/tracker-check.ts';

trackerCheck('archon-merge-queue');
const state = runState();
pinTrackerConfig(state);
recordStart(state, Date.now());
report('tracker checked, run start recorded');
