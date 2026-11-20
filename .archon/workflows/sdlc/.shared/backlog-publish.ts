/**
 * Files a sliced backlog (`backlog.json`, checked by check-backlog.py) in Jira (AK18f). Each
 * ticket goes through `createTicket` (AK18c) as a slice on Startklar under the feature the
 * caller named (VAULT-28, Julian 2026-11-20): the loop takes slices and bugs only. Its marker
 * `backlog-<document>-<key>` makes a rerun find it, and a ticket of the same document with the
 * same title also counts as there already (the slicer may name the same ticket differently
 * twice). Dependencies of the same run become `Depends on: CONC-n`; check-backlog.py lets a
 * ticket depend only on earlier ones.
 */
import { createHash } from 'node:crypto';
import { basename, extname, posix } from 'node:path';
import type { Snapshot } from './board-all.ts';
import { doneStatuses, type Jira } from './jira.ts';
import { createTicket } from './outbox.ts';
import { reservedText } from './questions.ts';

export interface Sliced { readonly key: string; readonly title: string; readonly phase: string; readonly body: string; readonly depends_on: readonly string[] }

/** AK18f: only `auto`, chosen by the caller, or `approve` with the native decision `approve`, writes. */
export function mayPublish(mode: string, approval: unknown): boolean {
  if (mode === 'auto') return true;
  return mode === 'approve' && typeof approval === 'object' && approval !== null && (approval as { decision?: unknown }).decision === 'approve';
}

/**
 * The document's part of a marker: up to 16 letters of its name, readable, and a hash of its
 * whole path, so `Ideas/a/PRD.md` and `Ideas/b/PRD.md`, or two names alike in their first 16
 * letters, never share markers (nor `backlog-prd-` the tickets of `prd-extra`).
 */
export function documentSlug(path: string): string {
  const name = basename(path, extname(path)).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 16).replace(/^-+|-+$/g, '') || 'prd';
  return `${name}-${createHash('sha256').update(posix.normalize(path.replaceAll('\\', '/'))).digest('hex').slice(0, 6)}`;
}

/** check-backlog.py's key; checked again here, since a marker goes into a Jira query. */
const KEY = /^[a-z0-9][a-z0-9-]{1,60}$/;

export function backlogMarker(doc: string, key: string): string {
  const marker = `backlog-${documentSlug(doc)}-${key}`;
  return marker.length <= 60 ? marker : `backlog-${documentSlug(doc)}-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

const norm = (title: string): string => title.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The feature the backlog's slices go under, checked before any agent runs: a key of this
 * project, open, and neither a slice, a bug, a plain ticket nor a sub-task (the tracker names
 * those types; a feature is what is left).
 */
export async function backlogFeature(jira: Jira, key: string): Promise<string> {
  const c = jira.config;
  jira.issue(key);
  const own = await jira.family(key);
  if (own.subtask || [c.types.slice, c.types.bug, c.types.filing].includes(own.type)) {
    throw new Error(`archon-backlog: ${key} is not a feature; the backlog's slices go under a feature`);
  }
  if (doneStatuses(c.status).has(own.status)) throw new Error(`archon-backlog: ${key} is done; name an open feature`);
  return key;
}

export async function publishBacklog(
  jira: Jira,
  tickets: readonly Sliced[],
  doc: string,
  snapshot: Readonly<Record<string, Snapshot>>,
  state: string,
  runUrl: string,
  feature: string
): Promise<{ created: string[]; existing: string[] }> {
  for (const t of tickets) {
    if (!KEY.test(t.key)) throw new Error(`backlog ticket ${JSON.stringify(t.key)}: key must be lowercase letters, digits and dashes`);
    if ([t.title, t.phase, t.body].some(reservedText)) throw new Error(`backlog ticket ${t.key}: text opens like a loop record or the owner, which is reserved`);
  }
  const prefix = `backlog-${documentSlug(doc)}-`;
  const keys = new Map<string, string>();
  const created: string[] = [];
  const existing: string[] = [];
  for (const t of tickets) {
    const same = Object.entries(snapshot).find(([, s]) => s.own.startsWith(prefix) && norm(s.title) === norm(t.title));
    if (same !== undefined) {
      keys.set(t.key, same[0]);
      existing.push(same[0]);
      continue;
    }
    const deps = t.depends_on.map(dep => {
      const key = keys.get(dep);
      if (key === undefined) throw new Error(`backlog ticket ${t.key}: depends on ${dep}, which is not an earlier ticket`);
      return key;
    });
    const text = `Phase: ${t.phase}\n\n${t.body}${deps.length > 0 ? `\n\nDepends on: ${deps.join(', ')}` : ''}`;
    const filed = await createTicket(jira, { op: 'create', marker: backlogMarker(doc, t.key), title: t.title, text }, runUrl, state, { feature });
    keys.set(t.key, filed.key);
    (filed.existed ? existing : created).push(filed.key);
  }
  return { created, existing };
}
