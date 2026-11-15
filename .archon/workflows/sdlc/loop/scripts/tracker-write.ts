/**
 * Check and apply one agent's tracker writes (its outbox).
 *
 * The agent left a JSON list in `$ARTIFACTS_DIR/tracker/outbox/<writer>.json`. The whole list
 * is checked before the first write (`checkOutbox`), so a refused entry fails this node with
 * nothing half written. Pick may write only to tickets that were on its snapshot (the keys
 * tracker-read recorded in the run's state directory) and that Jira, asked now, still puts
 * in the loop's hands (`writableJql`); build and review only to the lap's ticket. Tickets
 * filed here are recorded in the state directory by marker, for release and for a rerun of
 * this node. The outbox file is removed once applied, with a copy of what was written kept
 * in the state directory.
 *
 * Without `.archon/tracker.json` there is no outbox: nothing is read or written.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runState } from '../../.shared/claims.ts';
import { artifactsDir, emit, trimmed } from '../../.shared/io.ts';
import { Jira, trackerConfig } from '../../.shared/jira.ts';
import { applyOutbox, checkOutbox, outboxFile, readOutbox, writableJql } from '../../.shared/outbox.ts';
import { ticketKeyOf } from '../../.shared/tickets.ts';

const writer = trimmed(process.env.INPUTS_WRITER);
const target = trimmed(process.env.INPUTS_TARGET);
if (writer !== 'pick' && writer !== 'build' && writer !== 'review') {
  throw new Error(`tracker-write: writer must be pick, build or review, got '${writer}'`);
}

function snapshotKeys(state: string): string[] {
  const path = join(state, 'keys.json');
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(raw) || !raw.every(key => typeof key === 'string')) throw new Error(`${path} is not a list of keys`);
  return raw;
}

const config = trackerConfig();
if (config === null) {
  emit({ applied: '0', created: '{}' });
} else {
  const state = runState();
  const file = outboxFile(artifactsDir(), writer);
  const raw = readOutbox(file);
  let jira: Jira | undefined;
  let onBoard = new Set<string>();
  if (writer === 'pick' && Array.isArray(raw) && raw.length > 0) {
    jira = new Jira(config);
    const jql = writableJql(snapshotKeys(state), config);
    if (jql !== null) onBoard = new Set((await jira.search(jql, ['status'])).map(row => String(row.key)));
  }
  const ops = checkOutbox(raw, writer, ticketKeyOf(target, config), config.project, onBoard);
  // Where a filed ticket's remote link points: the lap's ticket or pull request, else the board.
  const runUrl = target.startsWith('https://')
    ? target
    : `${config.site}/jira/software/projects/${config.project}/boards/${config.board}`;
  const created = ops.length === 0 ? {} : await applyOutbox(jira ?? new Jira(config), ops, runUrl, state);
  if (ops.length > 0) writeFileSync(join(state, `applied-${writer}.json`), `${JSON.stringify(ops, null, 2)}\n`);
  rmSync(file, { force: true });
  emit({ applied: String(ops.length), created: JSON.stringify(created) });
}
