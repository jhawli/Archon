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

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addToLap, lapWritesLines, recordPassed, runState } from '../../.shared/claims.ts';
import { artifactsDir, emit, note, trimmed } from '../../.shared/io.ts';
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
const checked = checkOutbox(raw, writer, targetKey, config.project, onBoard, outboxProgress(state, writer, raw));
// A task the reviewer files is work this change leaves open; on `delivers: all` release would close it
// as done (CONC-146 AK9). So the reviewer files tasks only with a partial delivery, where they go to the
// rest; otherwise the task is dropped with a note, and the rest of its list (its verdict) still applies.
const partial = trimmed(process.env.INPUTS_DELIVERS) === 'part';
const ops = checked.filter(op => writer !== 'review' || op.op !== 'task' || partial);
if (ops.length < checked.length) note('tracker-write: the review filed a task without delivers: part; dropped');
const filed: string[] = [];
// Progress reports passed over (CONC-176 AK3): their reasons go into release's `Loop result:`.
const passed: string[] = [];
// Where a filed ticket's remote link points: the lap's target as pick named it (claim checks it
// after this writer), else the board.
const runUrl = target.startsWith('https://')
  ? target
  : `${config.site}/jira/software/projects/${config.project}/boards/${config.board}`;
// Tickets build and review file hang under the lap's ticket or relate to it (`lapLink`); pick files none.
let created: Record<string, string> = {};
try {
  created = ops.length === 0 ? {} : await applyOutbox(jira ?? new Jira(config), ops, runUrl, runLine('archon-loop', process.env.WORKFLOW_ID ?? ''), state, {
      writer,
      raw,
    }, writer === 'pick' ? null : targetKey, filed, passed);
} finally {
  // Also when a later write fails: release may still run, and its `Loop result:` is written once.
  recordPassed(state, writer, passed);
}
// The reviewer reads item.md after the builder: it names the new tasks' numbers in `Tasks done`.
const item = join(artifactsDir(), 'tracker', 'item.md');
if (filed.length > 0 && existsSync(item)) {
  // A rerun of this node finds the same tasks again: each line and the heading go in once.
  const heading = '## Tasks, die dieser Lauf angelegt hat';
  const before = readFileSync(item, 'utf8');
  const fresh = filed.map(task => `- ${task} (offen)`).filter(line => !before.includes(line));
  if (fresh.length > 0) appendFileSync(item, ['', ...(before.includes(heading) ? [] : [heading, '']), ...fresh, ''].join('\n'));
}
if (writer === 'build' && existsSync(item)) {
  const block = lapWritesLines(ops.flatMap(op => (op.op === 'comment' || op.op === 'ask' ? [op] : []))).join('\n');
  if (block !== '' && !readFileSync(item, 'utf8').includes(block)) appendFileSync(item, `${block}\n`);
}
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
