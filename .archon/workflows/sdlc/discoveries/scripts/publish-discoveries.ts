/**
 * Files the checked proposals in Jira (AK18g): only on `auto`, or on `approve` with a person's
 * approval (`mayPublish`, as for the backlog); otherwise it writes nothing and never calls Jira.
 * It reads `discovery-proposals.json` as render-proposals left it and refuses when the checkout
 * moved since. Outcomes go to `discovery-publication.md`; the output keeps the old node's shape.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mayPublish } from '../../.shared/backlog-publish.ts';
import { snapshotAll } from '../../.shared/board-all.ts';
import { runState } from '../../.shared/claims.ts';
import { type ItemRef, type Proposal, publishDiscoveries } from '../../.shared/discoveries-publish.ts';
import { artifactsDir, emit, nullableJson, trimmed } from '../../.shared/io.ts';
import { Jira, pinTrackerConfig } from '../../.shared/jira.ts';
import { trackerCheck } from '../../.shared/tracker-check.ts';

trackerCheck('archon-discoveries');
const mode = trimmed(process.env.INPUTS_MODE);
if (!mayPublish(mode, nullableJson(process.env.INPUTS_APPROVAL))) {
  emit({ published: false, urls: [], summary: `${mode}: nichts geschrieben` });
} else {
  const state = runState();
  const config = pinTrackerConfig(state);
  const artifacts = artifactsDir();
  const doc = JSON.parse(readFileSync(join(artifacts, 'discovery-proposals.json'), 'utf8')) as Record<string, unknown>;
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
  if (head.exitCode !== 0 || head.stdout.toString().trim() !== doc.revision) {
    throw new Error('publish-discoveries: the checkout moved since the proposals were rendered; run the workflow again');
  }
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const ref = (value: unknown): ItemRef | null => {
    if (typeof value !== 'object' || value === null) return null;
    const r = value as Record<string, unknown>;
    return { key: str(r.key), url: str(r.url) };
  };
  const rows = Array.isArray(doc.proposals) ? (doc.proposals as Record<string, unknown>[]) : [];
  const proposals: Proposal[] = rows.map(r => ({
    marker: typeof r.marker === 'string' ? r.marker : null,
    classification: str(r.classification),
    actionable: r.actionable === true,
    target_item: ref(r.target_item),
    related_items: Array.isArray(r.related_items) ? r.related_items.map(ref).filter((x): x is ItemRef => x !== null) : [],
    public_title: str(r.title),
    public_summary: str(r.summary),
    evidence: Array.isArray(r.evidence_refs)
      ? (r.evidence_refs as Record<string, unknown>[]).map(e => `${str(e.path)}:${typeof e.line === 'number' ? e.line : 0}`)
      : [],
  }));
  const checked = trimmed(process.env.INPUTS_CHECKED) === 'true';
  const boardUrl = `${config.site}/jira/software/projects/${config.project}/boards/${config.board}`;
  const result = await publishDiscoveries(new Jira(config), proposals, checked, snapshotAll(state), state, boardUrl);
  const urls = [...result.created, ...result.existing, ...result.commented].map(key => `${config.site}/browse/${key}`);
  const lines = ['# Discovery publication', '', result.summary, '', ...urls.map(url => `- ${url}`), ...result.skipped.map(why => `- übersprungen: ${why}`)];
  writeFileSync(join(artifacts, 'discovery-publication.md'), `${lines.join('\n')}\n`);
  emit({ published: checked, urls, summary: result.summary });
}
