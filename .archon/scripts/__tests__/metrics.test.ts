import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendMetrics, checkMetrics, lastHoldoutLine, METRICS_FILE, writeBaseResults } from '../../workflows/sdlc/.shared/metrics';

const LINE = '2026-11-20T10:00Z | merged since last pass: 3 (simple 2, complex 1, continue 0) | open PRs: 1 | loop send-backs since last pass: 0 | merge-gate refusals: 0 | ship correction rounds: 0 | flagged open: 2 | owner questions open: 1 | default branch checks: green (local gate) | laps since last pass: 5 (empty 1, failed 0) | health actions: 0';
const HOLD = '2026-11-20T10:00Z | holdouts at abc123: H-01 PASS, H-02 FAIL CONC-44';

describe('AK18n: metrics go to a file, never to Jira', () => {
  it('a pass line and a holdout line are appended', () => {
    const state = mkdtempSync(join(tmpdir(), 'state-'));
    appendMetrics(state, checkMetrics({ line: LINE, holdouts: HOLD }));
    expect(readFileSync(join(state, METRICS_FILE), 'utf8')).toBe(`${LINE}\n${HOLD}\n`);
  });
  it('without holdouts only the pass line', () => {
    expect(checkMetrics({ line: LINE, holdouts: '' }).holdouts).toBe('');
  });
  it('a holdout line with a scenario title is refused (ids and keys only)', () => {
    expect(() => checkMetrics({ line: LINE, holdouts: '2026-11-20T10:00Z | holdouts at abc123: H-02 FAIL Einkaufsliste leer' })).toThrow('ids');
  });
  it('the loop gets the latest holdout line, freshly written before the app check', () => {
    const state = mkdtempSync(join(tmpdir(), 'state-'));
    const art = mkdtempSync(join(tmpdir(), 'art-'));
    writeFileSync(join(state, METRICS_FILE), `${HOLD.replace('abc123', 'aaa111')}\n${LINE}\n${HOLD}\n`);
    expect(lastHoldoutLine(state)).toBe(HOLD);
    writeBaseResults(art, state);
    expect(readFileSync(join(art, 'holdout-runs', 'base-results.txt'), 'utf8')).toBe(`${HOLD}\n`);
  });
  it('no file, no holdout line: the lap runs without a comparison value, and an agent’s copy goes', () => {
    const art = mkdtempSync(join(tmpdir(), 'art-'));
    mkdirSync(join(art, 'holdout-runs'));
    writeFileSync(join(art, 'holdout-runs', 'base-results.txt'), '2026-11-20T10:00Z | holdouts at abc123: H-01 FAIL\n');
    writeBaseResults(art, mkdtempSync(join(tmpdir(), 'state-')));
    expect(existsSync(join(art, 'holdout-runs', 'base-results.txt'))).toBe(false);
  });
});
