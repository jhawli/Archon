/**
 * Tickets with one of the repository's `befundLabels` (tracker.json): the finding comes before
 * the fix, and the owner's standing approval opens changes to what a check judges for them.
 */
import { bare, hasSection } from './bug-ready.ts';

export const BEFUND_LINES = ['Rote Zeile', 'Letzter grüner Lauf', 'Ursache', 'Gelockerte Tests'] as const;
const LOOSENED = BEFUND_LINES[3];
export const BEFUND_SECTION = '## Eigentümer-Regel für dieses Ticket (Befund-Pflicht)';

export function needsBefund(labels: readonly string[], config: { readonly befundLabels?: readonly string[] }): boolean {
  return labels.some(label => config.befundLabels?.includes(label) === true);
}

export interface Befund {
  /** The lines no single comment of a trusted author carries; empty when the finding is there. */
  readonly missing: string[];
  /** What the finding names under `Gelockerte Tests:`; '' for „keine“ or no finding. */
  readonly loosened: string;
}

/** The newest comment of a trusted author with all lines counts. `rows`: lowest id first. */
export function readBefund(
  rows: readonly { readonly author: string; readonly body: string }[],
  trusted: ReadonlySet<string>
): Befund {
  let closest: string[] = [...BEFUND_LINES];
  for (const row of [...rows].reverse()) {
    if (!trusted.has(row.author)) continue;
    const missing = BEFUND_LINES.filter(name => !hasSection(bare(row.body), name));
    if (missing.length === 0) {
      const line = new RegExp(`^[ \\t]*(?:- |\\d+\\. )?${LOOSENED}[ \\t]*:[ \\t]*(.+)$`, 'im').exec(bare(row.body));
      const value = (line?.[1] ?? '').trim();
      return { missing: [], loosened: /^keine\.?$/i.test(value) ? '' : value };
    }
    if (missing.length < closest.length) closest = missing;
  }
  return { missing: closest, loosened: '' };
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
