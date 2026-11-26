import { describe, expect, it } from 'bun:test';
import { befundSection, BEFUND_SECTION, needsBefund, readBefund } from '../../workflows/sdlc/.shared/befund';
import { adf, plain } from '../../workflows/sdlc/.shared/jira';

const TRUSTED = new Set(['acc-archon', 'acc-julian']);
const FULL = 'Rote Zeile: testWoche failed\nLetzter grüner Lauf: a1b2c3d, Unterschied: Uhrzeit\nUrsache: Tag in UTC gerechnet\nGelockerte Tests: keine';
// As Jira hands a comment back: ADF, read with plain().
const row = (author: string, text: string): { author: string; body: string } => ({ author, body: plain(adf(text)) });

describe('the finding (CONC-109)', () => {
  it('ak21 four lines in one comment of the loop or the owner count', () => {
    expect(readBefund([row('acc-archon', FULL)], TRUSTED)).toEqual({ missing: [], loosened: '' });
    expect(readBefund([row('acc-julian', FULL)], TRUSTED).missing).toEqual([]);
  });
  it('ak21 counterexample: flake and restart is no finding', () => {
    expect(readBefund([row('acc-archon', 'Flake, neu gestartet')], TRUSTED).missing).toHaveLength(4);
  });
  it('ak21 a stranger, a split finding and an empty line do not count', () => {
    expect(readBefund([row('acc-other', FULL)], TRUSTED).missing).toHaveLength(4);
    expect(readBefund([row('acc-archon', FULL.replace('\nGelockerte Tests: keine', ''))], TRUSTED).missing).toEqual(['Gelockerte Tests']);
    const split = [row('acc-archon', 'Rote Zeile: x\nUrsache:\ny'), row('acc-archon', 'Letzter grüner Lauf: z\nGelockerte Tests: keine')];
    expect(readBefund(split, TRUSTED).missing.length).toBeGreaterThan(0);
  });
  it('ak22 the newest complete comment names what was loosened', () => {
    expect(readBefund([row('acc-archon', FULL.replace('keine', 'testWoche gelöscht'))], TRUSTED).loosened).toBe('testWoche gelöscht');
    const rows = [row('acc-archon', FULL.replace('keine', 'alt')), row('acc-archon', FULL), row('acc-archon', 'Der naechtliche Volllauf ist rot.')];
    expect(readBefund(rows, TRUSTED).loosened).toBe('');
  });
  it('only a ticket with a configured label needs it', () => {
    expect(needsBefund(['nightly-rot'], { befundLabels: ['nightly-rot'] })).toBe(true);
    expect(needsBefund(['nightly-rot'], {})).toBe(false);
    expect(needsBefund(['andere'], { befundLabels: ['nightly-rot'] })).toBe(false);
  });
  it('the section starts with the heading the prompts key on', () => {
    expect(befundSection()[0]).toBe(BEFUND_SECTION);
  });
});
