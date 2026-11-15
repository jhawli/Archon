/**
 * Check and apply one agent's tracker writes (its outbox).
 *
 * The agent left a JSON list in `$ARTIFACTS_DIR/tracker/outbox/<writer>.json`. The whole list
 * is checked before the first write (`checkOutbox`), so a refused entry fails this node with
 * nothing half written. Pick may write only to the keys tracker-read recorded in the run's
 * state directory; build and review only to the lap's ticket. Tickets filed here are recorded
 * there too, by marker, for release and for a rerun of this node.
 *
 * Without `.archon/tracker.json` there is no outbox: nothing is read or written.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runState } from '../../.shared/claims.ts';
import { artifactsDir, emit, trimmed } from '../../.shared/io.ts';
import { Jira, trackerConfig } from '../../.shared/jira.ts';
import { applyOutbox, checkOutbox, readOutbox, type Writer } from '../../.shared/outbox.ts';
import { ticketKeyOf } from '../../.shared/tickets.ts';

const writer = trimmed(process.env.INPUTS_WRITER);
const target = trimmed(process.env.INPUTS_TARGET);
if (writer !== 'pick' && writer !== 'build' && writer !== 'review') {
  throw new Error(`tracker-write: writer must be pick, build or review, got '${writer}'`);
}

function boardKeys(state: string): Set<string> {
  const path = join(state, 'keys.json');
  if (!existsSync(path)) return new Set();
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(raw) || !raw.every(key => typeof key === 'string')) throw new Error(`${path} is not a list of keys`);
  return new Set(raw);
}

const config = trackerConfig();
if (config === null) {
  emit({ applied: '0', created: '{}' });
} else {
  const state = runState();
  const raw = readOutbox(join(artifactsDir(), 'tracker', 'outbox', `${writer}.json`));
  const ops = checkOutbox(raw, writer as Writer, ticketKeyOf(target, config), config.project, boardKeys(state));
  // Where a filed ticket's remote link points: the lap's ticket or pull request, else the board.
  const runUrl = target.startsWith('https://') ? target : `${config.site}/jira/software/projects/${config.project}/boards/${config.board}`;
  const created = ops.length === 0 ? {} : await applyOutbox(new Jira(config), ops, runUrl, state);
  emit({ applied: String(ops.length), created: JSON.stringify(created) });
}
