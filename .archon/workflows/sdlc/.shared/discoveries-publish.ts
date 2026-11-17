/**
 * Files checked findings in Jira (AK18g). A new finding becomes a ticket through `createTicket`
 * (AK18c, its marker `disc-…` makes a rerun find it), with a `Related:` line for the work the
 * search found beside it; new evidence for an open ticket becomes one comment there, its text
 * and labels untouched. Nothing is written when the ticket search was incomplete.
 */
import type { Snapshot } from './board-all.ts';
import type { Jira } from './jira.ts';
import { createTicket } from './outbox.ts';
import { reservedText, runLine } from './questions.ts';

export interface ItemRef { readonly key: string; readonly url?: string }

export interface Proposal {
  readonly marker: string | null;
  readonly classification: string;
  readonly actionable: boolean;
  readonly target_item: ItemRef | null;
  readonly related_items: readonly ItemRef[];
  readonly public_title: string;
  readonly public_summary: string;
  readonly evidence: readonly string[];
}

export interface Published { created: string[]; existing: string[]; commented: string[]; skipped: string[]; summary: string }

const MARKER = /^disc-[0-9a-f]{16}$/;

export async function publishDiscoveries(
  jira: Jira, proposals: readonly Proposal[], checked: boolean, snapshot: Readonly<Record<string, Snapshot>>, state: string, runUrl: string
): Promise<Published> {
  const result: Published = { created: [], existing: [], commented: [], skipped: [], summary: '' };
  if (!checked) return { ...result, summary: 'nicht geprüft: die Ticket-Suche war unvollständig, nichts geschrieben' };
  // Every proposal before the first write: text, marker, and every ticket it names on the board.
  for (const [i, p] of proposals.entries()) {
    if ([p.public_title, p.public_summary].some(reservedText)) throw new Error(`finding ${i}: text opens like a loop record or the owner, which is reserved`);
    if (p.actionable && p.classification === 'new' && (p.marker === null || !MARKER.test(p.marker))) throw new Error(`finding ${i}: marker must be disc- and 16 hex digits`);
    // A pull request carries no key: only tickets are checked against the board.
    const named = [p.target_item, ...p.related_items].flatMap(ref => (ref === null || ref.key === '' ? [] : [ref.key]));
    const unknown = named.find(key => snapshot[key] === undefined);
    if (unknown !== undefined) throw new Error(`finding ${i}: ${unknown} is not on the board`);
  }
  const s = jira.config.status;
  const closed = new Set([s.staging, s.live, s.canceled]);
  const line = runLine('archon-discoveries', process.env.WORKFLOW_ID ?? '');
  for (const p of proposals) {
    if (!p.actionable) continue;
    if (p.classification === 'new' && p.marker !== null) {
      const related = p.related_items.map(ref => (ref.key !== '' ? ref.key : ref.url ?? '')).filter(ref => ref !== '');
      const text = `${p.public_summary}\n\nBeleg: ${p.evidence.join(', ')}${related.length > 0 ? `\n\nRelated: ${related.join(', ')}` : ''}`;
      const filed = await createTicket(jira, { op: 'create', marker: p.marker, title: p.public_title, text }, runUrl, state);
      (filed.existed ? result.existing : result.created).push(filed.key);
    } else if (p.classification === 'update-existing') {
      const key = p.target_item?.key ?? '';
      if (key === '') {
        result.skipped.push(`${p.target_item?.url ?? 'ohne Ziel'}: kein Ticket, der Beleg bleibt im Vorschlag`);
        continue;
      }
      const now = await jira.ticket(key);
      if (closed.has(now.status)) {
        result.skipped.push(`${key}: nicht mehr offen, kein Kommentar`);
        continue;
      }
      // A rerun (this node again, or the same report once more) posts the same evidence once.
      const head = `Neuer Beleg: ${p.public_summary}`;
      const proof = `Beleg: ${p.evidence.join(', ')}`;
      if ((await jira.comments(key)).some(c => c.body.trimStart().startsWith(head) && c.body.includes(proof))) {
        result.existing.push(key);
        continue;
      }
      await jira.comment(key, `${head}\n${proof}\n\n${line}`);
      result.commented.push(key);
    }
  }
  const named = (label: string, keys: readonly string[]): string => `${keys.length} ${label}${keys.length > 0 ? ` (${keys.join(', ')})` : ''}`;
  result.summary = [named('angelegt', result.created), named('schon da', result.existing), named('kommentiert', result.commented), named('übersprungen', result.skipped)].join(', ');
  return result;
}
