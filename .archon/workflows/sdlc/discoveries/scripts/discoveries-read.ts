/**
 * The first node of archon-discoveries: the tracker check (AK18e), then every ticket for the
 * search (`tracker/board-all.md`). Without tracker.json the run ends here. When Jira does not
 * answer, the run goes on with `checked: false`: the proposals stay local and nothing is
 * published ("nicht geprüft"). `project` and `site` let the scripts after it check markers
 * and ticket addresses.
 */
import { loadBoardAll, writeBoardAll } from '../../.shared/board-all.ts';
import { runState } from '../../.shared/claims.ts';
import { artifactsDir, emit, note } from '../../.shared/io.ts';
import { Jira, pinTrackerConfig } from '../../.shared/jira.ts';
import { trackerCheck } from '../../.shared/tracker-check.ts';

trackerCheck('archon-discoveries');
const state = runState();
const config = pinTrackerConfig(state);
const ids = { project: config.project, site: config.site };
try {
  const all = await loadBoardAll(new Jira(config));
  emit({ checked: 'true', board: writeBoardAll(all, Date.now(), config, artifactsDir(), state), ...ids });
} catch (error) {
  note(`discoveries: the board could not be read (${error instanceof Error ? error.message : String(error)}); nothing will be published`);
  emit({ checked: 'false', board: '', ...ids });
}
