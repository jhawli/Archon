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
 * in the state directory. If a write fails the node fails and the file stays; a rerun goes on
 * behind the last write that worked (`applyOutbox`).
 */

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runState } from '../../.shared/claims.ts';
import { artifactsDir, emit, trimmed } from '../../.shared/io.ts';
import { Jira, requireTracker } from '../../.shared/jira.ts';
import { applyOutbox, checkOutbox, outboxFile, outboxProgress, readOutbox, writableNow } from '../../.shared/outbox.ts';
import { ticketKeyOf } from '../../.shared/tickets.ts';

const writer = trimmed(process.env.INPUTS_WRITER);
const target = trimmed(process.env.INPUTS_TARGET);
if (writer !== 'pick' && writer !== 'build' && writer !== 'review') {
  throw new Error(`tracker-write: writer must be pick, build or review, got '${writer}'`);
}

const config = requireTracker();
const state = runState();
const file = outboxFile(artifactsDir(), writer);
const raw = readOutbox(file);
let jira: Jira | undefined;
let onBoard = new Set<string>();
if (writer === 'pick' && Array.isArray(raw) && raw.length > 0) {
  jira = new Jira(config);
  onBoard = await writableNow(jira, state);
}
const ops = checkOutbox(raw, writer, ticketKeyOf(target, config), config.project, onBoard, outboxProgress(state, writer, raw));
// Where a filed ticket's remote link points: the lap's ticket or pull request, else the board.
const runUrl = target.startsWith('https://')
  ? target
  : `${config.site}/jira/software/projects/${config.project}/boards/${config.board}`;
const created = ops.length === 0 ? {} : await applyOutbox(jira ?? new Jira(config), ops, runUrl, state, { writer, raw });
if (ops.length > 0) writeFileSync(join(state, `applied-${writer}.json`), `${JSON.stringify(ops, null, 2)}\n`);
rmSync(file, { force: true });
emit({ applied: String(ops.length), created: JSON.stringify(created) });
