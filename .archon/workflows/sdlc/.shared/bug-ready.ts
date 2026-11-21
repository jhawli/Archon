/**
 * CONC-32 AK11, fix part: a bug joins the loop's queue only with an error description and the
 * example for its regression test, each a line `Fehler: …` and `Regressionstest: …` (any case)
 * with text on the label's own line. A slice is held by its statuses instead (Freigabe Plan).
 * What the loop filed itself (`LOOP_FINDING`, outbox.ts) is its own finding and stays ready.
 */
import type { TrackerConfig } from './jira.ts';
import { questionText } from './questions.ts';
import { LOOP_FINDING } from './tickets.ts';

const SECTIONS = ['Fehler', 'Regressionstest'] as const;

/**
 * The text as the rule reads it: plain() keeps Jira's bold (`**`) and code (backticks) marks and
 * its no-break spaces, which the editor puts around a label as often as not.
 */
function bare(body: string): string {
  return body.replace(/\*\*|`/g, '').replace(/\u00a0/g, ' ');
}

function hasSection(body: string, name: string): boolean {
  // [ \t] instead of \s: the text must stand on the label's own line, not on the next one.
  // A list item (`- `, `1. `) is how plain() renders Jira's lists.
  return new RegExp(`^[ \\t]*(?:- |\\d+\\. )?${name}[ \\t]*:[ \\t]*\\S`, 'im').test(body);
}

export function missingSections(ticket: { type: string; body: string }, bugType: string): string[] {
  if (ticket.type !== bugType || ticket.body.trimStart().startsWith(LOOP_FINDING)) return [];
  const body = bare(ticket.body);
  return SECTIONS.filter(name => !hasSection(body, name));
}

export function bugReady(ticket: { type: string; body: string }, bugType: string): boolean {
  return missingSections(ticket, bugType).length === 0;
}

/**
 * Claim's refusal for pick's ticket when it is an unready bug on its queue, or null. The gate holds
 * such a bug (no candidate, then the flag); this stops it too when the question failed and pick
 * chose it anyway. A bug on Review is left alone: the gate never asks there, so a refusal would
 * leave its pull request hanging without a word.
 */
export function unreadyRefusal(
  ticket: { key: string; type: string; body: string; status: string },
  config: Pick<TrackerConfig, 'status' | 'types'>
): string | null {
  if (ticket.status !== config.status.todoBug) return null;
  const missing = missingSections(ticket, config.types.bug);
  return missing.length === 0 ? null : `${ticket.key} is an unready bug: no ${missing.map(name => `${name}:`).join(' and no ')} line (CONC-32 AK11)`;
}

/**
 * The launch gate's question for each unready bug (decision 5): the flag keeps the loop off it, and
 * a flagged ticket is no longer listed as unready, so it is asked once. The kind is "Produkt": the
 * manager lifts the flag of a run's question without a kind by itself (`mayUnflag`), and the gate
 * would then ask again every lap. One ticket failing is reported and does not stop the gate.
 */
export async function askUnready(
  client: { ask(key: string, text: string): Promise<void> },
  unready: readonly { key: string; missing: string[] }[],
  line: string
): Promise<string[]> {
  const out: string[] = [];
  for (const { key, missing } of unready) {
    try {
      const want = missing.map(name => `\`${name}:\``).join(' und ');
      const text = `Bug ohne ${want}. Bitte ergänzen und die Flagge wegnehmen, dann nimmt ihn der Loop.`;
      await client.ask(key, `${questionText('produkt', text, '', Date.now())}\n\n${line}`);
      out.push(`${key}: unready bug, asked the owner (${missing.join(', ')})`);
    } catch (error) {
      out.push(`${key}: could not ask (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return out;
}
