/**
 * The backlog's first node: the tracker check (AK18e) and the feature the slices go under
 * (VAULT-28; a run without one ends here, before any agent), then every ticket for the slicer
 * (`tracker/board-all.md`; a ticket already there is not sliced again). It also leaves the
 * board's allowlist in the state directory, where publish-backlog reads the origins.
 */
import { backlogFeature } from '../../.shared/backlog-publish.ts';
import { loadBoardAll, writeBoardAll } from '../../.shared/board-all.ts';
import { runState } from '../../.shared/claims.ts';
import { artifactsDir, emit, trimmed } from '../../.shared/io.ts';
import { Jira, pinTrackerConfig } from '../../.shared/jira.ts';
import { trackerCheck } from '../../.shared/tracker-check.ts';

trackerCheck('archon-backlog');
const state = runState();
const config = pinTrackerConfig(state);
await backlogFeature(new Jira(config), trimmed(process.env.INPUTS_FEATURE));
const all = await loadBoardAll(new Jira(config));
emit({ board: writeBoardAll(all, Date.now(), config, artifactsDir(), state) });
