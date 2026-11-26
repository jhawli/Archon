/**
 * Tickets with one of the repository's `befundLabels` (tracker.json): the finding comes before
 * the fix, and the owner's standing approval opens changes to what a check judges for them.
 */
import { bare, hasSection } from './bug-ready.ts';
import { loosenedNote } from './questions.ts';

export const BEFUND_LINES = ['Rote Zeile', 'Letzter grüner Lauf', 'Ursache', 'Gelockerte Tests'] as const;
const LOOSENED = BEFUND_LINES[3];
export const BEFUND_SECTION = '## Eigentümer-Regel für dieses Ticket (Befund-Pflicht)';
/** The line the manager's board carries for such a ticket (board-all.ts); manage.md keys on it. */
export const BEFUND_BOARD_LINE = 'Befund-Pflicht: ja';

export function needsBefund(labels: readonly string[], config: { readonly befundLabels?: readonly string[] }): boolean {
  return labels.some(label => config.befundLabels?.includes(label) === true);
}

export interface Befund {
  /** The lines no single comment of a trusted author carries; empty when the finding is there. */
  readonly missing: string[];
  /** What the finding names under `Gelockerte Tests:`; '' for „keine“ or no finding. */
  readonly loosened: string;
}

const LIST_ITEM = /^[ \t]*(?:- |\d+\. )(.*)$/;
const labelLine = (name: string): RegExp => new RegExp(`^[ \\t]*(?:- |\\d+\\. )?${name}[ \\t]*:(.*)$`, 'i');

/**
 * What stands under `Gelockerte Tests:`: the rest of its line and the list right after it, as one
 * line; '' for a label with nothing under it. Jira makes such a list a block of its own, so blank
 * lines may stand between an empty label and its list.
 */
function loosenedText(body: string): string {
  const lines = body.split('\n');
  const label = labelLine(LOOSENED);
  const at = lines.findIndex(line => label.test(line));
  if (at < 0) return '';
  const parts = [(label.exec(lines[at] ?? '')?.[1] ?? '').trim()];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '' && parts.every(part => part === '')) continue;
    const item = LIST_ITEM.exec(line)?.[1];
    // An item that is the next label ends the list: a finding may be written as one list.
    if (item === undefined || BEFUND_LINES.some(name => labelLine(name).test(item))) break;
    parts.push(item.trim());
  }
  return parts.filter(part => part !== '').join('; ');
}

/** The newest comment of a trusted author with all lines counts. `rows`: lowest id first. */
export function readBefund(
  rows: readonly { readonly author: string; readonly body: string }[],
  trusted: ReadonlySet<string>
): Befund {
  let closest: string[] = [...BEFUND_LINES];
  for (const row of [...rows].reverse()) {
    if (!trusted.has(row.author)) continue;
    const body = bare(row.body);
    const loosened = loosenedText(body);
    const missing = BEFUND_LINES.filter(name => (name === LOOSENED ? loosened === '' : !hasSection(body, name)));
    if (missing.length === 0) return { missing: [], loosened: /^keine\.?$/i.test(loosened) ? '' : loosened };
    if (missing.length < closest.length) closest = missing;
  }
  return { missing: closest, loosened: '' };
}

/**
 * What the owner hears after a merge under the Befund-Pflicht, or null: what the finding names as
 * loosened, and every change to a check the review reported, so a „keine“ over a changed check is
 * not silent.
 */
export function mergeNote(
  befund: Befund | undefined,
  changes: readonly { readonly file: string; readonly change: string }[]
): string | null {
  if (befund === undefined || (befund.loosened === '' && changes.length === 0)) return null;
  const note = loosenedNote(befund.loosened === '' ? 'laut Befund keine' : befund.loosened);
  if (changes.length === 0) return note;
  return `${note}\nPrüf-Änderungen laut Review: ${changes.map(c => [c.file, c.change].filter(Boolean).join(': ')).join('; ')}`;
}

/** The lines itemMarkdown adds for such a ticket; the loop's prompts key on the heading. */
export function befundSection(): string[] {
  return [
    BEFUND_SECTION,
    '',
    'Julian hat für dieses Ticket dauerhaft entschieden (26.11.2026):',
    '',
    '- Erst der Befund, dann der Fix. Wer baut, legt in `$ARTIFACTS_DIR/tracker/outbox/build.json` einen `comment` an dieses Ticket mit je einer Zeile `Rote Zeile:`, `Letzter grüner Lauf:`, `Ursache:` und `Gelockerte Tests:` (oder `Gelockerte Tests: keine`). Ohne diesen Kommentar mergt das Merge-Gate nicht.',
    '- Freigegeben ist, Prüfungen im Repository zu ändern, zu lockern, abzuschalten, in Quarantäne zu nehmen oder zu löschen, wenn der Befund es begründet. Das ersetzt für dieses Ticket die Rückfrage zu allem, was ändert, was eine Prüfung beurteilt. Jede solche Änderung steht unter `Gelockerte Tests:` und in `judge_changes`.',
    '- Titel und Branch des Pull Requests nennen keinen anderen Ticket-Schlüssel als diesen, sonst bleiben die CI-Sperren zu.',
    '- Nicht freigegeben sind geschützte Dateien. Liegt die Ursache dort oder lässt sie sich nicht belegen: `ask` mit dem Befund, kein PR. Das Ticket geht dann an Julian; Flagge und Bearbeiter setzt das Skript.',
    '',
  ];
}
