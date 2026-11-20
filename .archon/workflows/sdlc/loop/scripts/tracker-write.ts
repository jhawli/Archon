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
 *
 * For the review, once its writes are applied, it records the review's word in the lap record
 * (`addToLap`): its outcome, whether the change delivers the work item, and the tasks it
 * finishes. Release settles the slice's tasks and picks the status by it, also when land never
 * runs (VAULT-28). A refused or failed write records nothing: nothing merges then, and release
 * gives the ticket back to its queue.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addToLap, runState } from '../../.shared/claims.ts';
import { artifactsDir, emit, trimmed } from '../../.shared/io.ts';
import { Jira, requireTracker } from '../../.shared/jira.ts';
import { applyOutbox, checkOutbox, outboxFile, outboxProgress, readOutbox, writableNow } from '../../.shared/outbox.ts';
import { runLine } from '../../.shared/questions.ts';
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
const targetKey = ticketKeyOf(target, config);
const ops = checkOutbox(raw, writer, targetKey, config.project, onBoard, outboxProgress(state, writer, raw));
// Where a filed ticket's remote link points: the lap's target as pick named it (claim checks it
// after this writer), else the board.
const runUrl = target.startsWith('https://')
  ? target
  : `${config.site}/jira/software/projects/${config.project}/boards/${config.board}`;
// Tickets build and review file hang under the lap's ticket or relate to it (`lapLink`); pick files none.
const created = ops.length === 0 ? {} : await applyOutbox(jira ?? new Jira(config), ops, runUrl, runLine('archon-loop', process.env.WORKFLOW_ID ?? ''), state, {
    writer,
    raw,
  }, writer === 'pick' ? null : targetKey);
if (ops.length > 0) writeFileSync(join(state, `applied-${writer}.json`), `${JSON.stringify(ops, null, 2)}\n`);
rmSync(file, { force: true });
if (writer === 'review') {
  addToLap(state, {
    reviewed: trimmed(process.env.INPUTS_OUTCOME),
    delivers: trimmed(process.env.INPUTS_DELIVERS),
    tasks: trimmed(process.env.INPUTS_TASKS),
  });
}
emit({ applied: String(ops.length), created: JSON.stringify(created) });
