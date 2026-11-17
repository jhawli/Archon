/**
 * Files the checked slice in Jira (AK18f): only when the caller chose `auto`, or chose
 * `approve` and a person approved. Otherwise it writes nothing and never calls Jira. The
 * output keeps the shape of the old publishing agent: published, the created and existing
 * ticket keys, a summary; the list also goes to `backlog-publication.md`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { mayPublish, publishBacklog, type Sliced } from '../../.shared/backlog-publish.ts';
import { snapshotAll } from '../../.shared/board-all.ts';
import { runState } from '../../.shared/claims.ts';
import { artifactsDir, emit, nullableJson, trimmed } from '../../.shared/io.ts';
import { Jira, pinTrackerConfig } from '../../.shared/jira.ts';
import { trackerCheck } from '../../.shared/tracker-check.ts';

trackerCheck('archon-backlog');
const mode = trimmed(process.env.INPUTS_MODE);
if (!mayPublish(mode, nullableJson(process.env.INPUTS_APPROVAL))) {
  emit({ published: false, created: [], existing: [], summary: `${mode}: nichts geschrieben` });
} else {
  const state = runState();
  const config = pinTrackerConfig(state);
  const artifacts = artifactsDir();
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  // check-backlog.py checked the shape; `depends_on` may be left out there.
  const raw = JSON.parse(readFileSync(join(artifacts, 'backlog.json'), 'utf8')) as Record<string, unknown>[];
  const tickets: Sliced[] = raw.map(t => ({
    key: str(t.key),
    title: str(t.title),
    phase: str(t.phase),
    body: str(t.body),
    depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(str) : [],
  }));
  const boardUrl = `${config.site}/jira/software/projects/${config.project}/boards/${config.board}`;
  // The document as read-prd.py admitted it, relative to the checkout: `./x.md` and `x.md` are one document.
  const doc = relative(process.cwd(), resolve(process.cwd(), trimmed(process.env.INPUTS_PRD)));
  const { created, existing } = await publishBacklog(new Jira(config), tickets, doc, snapshotAll(state), state, boardUrl);
  const summary = `${created.length} angelegt (${created.join(', ') || 'keins'}), ${existing.length} schon da (${existing.join(', ') || 'keins'})`;
  writeFileSync(join(artifacts, 'backlog-publication.md'), `# Backlog in Jira\n\n${summary}\n`);
  emit({ published: true, created, existing, summary });
}
