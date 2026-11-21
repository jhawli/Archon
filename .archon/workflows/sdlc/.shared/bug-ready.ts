/**
 * CONC-32 AK11, fix part: a bug joins the loop's queue only with an error description and the
 * example for its regression test, each a line `Fehler: …` and `Regressionstest: …` (any case)
 * with text on the label's own line. A slice is held by its statuses instead (Freigabe Plan).
 * What the loop filed itself (`Loop finding:`, outbox.ts) is its own finding and stays ready.
 */
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
