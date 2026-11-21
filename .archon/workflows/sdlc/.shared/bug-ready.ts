/**
 * CONC-32 AK11, fix part: a bug joins the loop's queue only with an error description and the
 * example for its regression test, each a line `Fehler: …` and `Regressionstest: …` (any case)
 * with text on the label's own line. A slice is held by its statuses instead (Freigabe Plan).
 * What the loop filed itself (`Loop finding:`, outbox.ts) is its own finding and stays ready.
 */
import { questionText } from './questions.ts';

const SECTIONS = ['Fehler', 'Regressionstest'] as const;

function hasSection(body: string, name: string): boolean {
  // [ \t] instead of \s: the text must stand on the label's own line, not on the next one.
  // A bullet (`- `) and a bold label (`**Fehler:**`) are how plain() renders Jira's editor.
  return new RegExp(`^[ \\t]*(?:- )?(?:\\*\\*)?${name}[ \\t]*:(?:\\*\\*)?[ \\t]*[^\\s*]`, 'im').test(body);
}

export function missingSections(ticket: { type: string; body: string }, bugType: string): string[] {
  if (ticket.type !== bugType || /^\s*Loop finding:/.test(ticket.body)) return [];
  return SECTIONS.filter(name => !hasSection(ticket.body, name));
}

export function bugReady(ticket: { type: string; body: string }, bugType: string): boolean {
  return missingSections(ticket, bugType).length === 0;
}

/**
 * Claim's refusal for pick's ticket when it is an unready bug, or null. The gate holds such a bug
 * (no candidate, then the flag); this stops it too when the question failed and pick chose it anyway.
 */
export function unreadyRefusal(ticket: { key: string; type: string; body: string }, bugType: string): string | null {
  const missing = missingSections(ticket, bugType);
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
