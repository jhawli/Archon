/**
 * The lap's board from Jira, before pick reads it.
 *
 * Without `.archon/tracker.json` the pack works on GitHub issues and this writes nothing.
 * With Jira it loads the same board as the launch gate (the open sprint's tickets in rank
 * order, flagged ones included so pick may lift a bookkeeping flag, and the tickets open
 * pull requests name) and writes it for the agents to `$ARTIFACTS_DIR/tracker/board.md`.
 * The keys pick may write to go into the run's state directory, where agents cannot write
 * (`writableKeys`). It also prunes old runs' state directories.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expiryHours, pruneRunStates, runState } from '../../.shared/claims.ts';
import { artifactsDir, emit, trimmed } from '../../.shared/io.ts';
import { Jira, trackerConfig } from '../../.shared/jira.ts';
import { boardMarkdown, writableKeys } from '../../.shared/outbox.ts';
import { loadJiraBoard, openPulls } from '../../.shared/tracker-board.ts';
import { workability } from '../../.shared/workable.ts';

/** Well past any claim and any lap; the records are kept this long for a look after the fact. */
const KEEP_RUN_STATE_MS = 14 * 86_400_000;

const hours = expiryHours(trimmed(process.env.INPUTS_CLAIM_HOURS));
const config = trackerConfig();
if (config === null) {
  emit({ ready: 'github', board: '' });
} else {
  const state = runState();
  pruneRunStates(process.env.STATE_DIR ?? '', KEEP_RUN_STATE_MS);
  const loaded = await loadJiraBoard(new Jira(config), openPulls());
  const waiting = new Map<string, string>();
  for (const entry of workability(loaded.board, hours, Date.now(), new Set(), loaded.links).waiting) {
    if (entry.kind === 'ticket') waiting.set(entry.key, entry.why);
  }
  const dir = join(artifactsDir(), 'tracker');
  mkdirSync(dir, { recursive: true });
  const board = join(dir, 'board.md');
  writeFileSync(board, boardMarkdown(loaded.tickets, loaded.comments, waiting, config));
  writeFileSync(join(state, 'keys.json'), `${JSON.stringify([...writableKeys(loaded.tickets, config)])}\n`);
  emit({ ready: 'jira', board });
}
