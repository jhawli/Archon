/**
 * The manager's numbers per pass (AK18n), kept in `$STATE_DIR/loop-metrics.log`: per project,
 * across runs, readable by agents (sandbox `allowRead`), written only by scripts. The latest
 * holdout line is what a loop lap compares its own holdout results with.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const METRICS_FILE = 'loop-metrics.log';
const STAMP = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\dZ`;
const PASS_LINE = new RegExp(String.raw`^${STAMP} \| merged since last pass: \d+ \(simple \d+, complex \d+, continue \d+\) \| [^\n]+$`);
const KEY_REF = String.raw`[A-Z][A-Z0-9]+-\d+`;
const MARKER_REF = String.raw`mgr-[a-z0-9-]{3,56}`;
function holdoutLine(ref: string): RegExp {
  const result = String.raw`H-\d+ (?:PASS|FAIL|INCOMPLETE)(?: ${ref})?`;
  return new RegExp(String.raw`^${STAMP} \| holdouts at [0-9a-f]{6,40}: ${result}(?:, ${result})*$`);
}
/** The line in the log: ticket keys only. */
const HOLDOUT_LINE = holdoutLine(KEY_REF);
/** The line a pass writes: a ticket it creates itself has no key yet, so it names its marker. */
const HOLDOUT_DRAFT = holdoutLine(String.raw`(?:${KEY_REF}|${MARKER_REF})`);

export interface Metrics { readonly line: string; readonly holdouts: string }

export function checkMetrics(raw: unknown): Metrics {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('manager/metrics.json must be an object');
  const r = raw as Record<string, unknown>;
  const line = typeof r.line === 'string' ? r.line.trim() : '';
  const holdouts = typeof r.holdouts === 'string' ? r.holdouts.trim() : '';
  if (!PASS_LINE.test(line)) throw new Error(`the metrics line does not have the agreed form: ${line.slice(0, 120)}`);
  if (holdouts !== '' && !HOLDOUT_DRAFT.test(holdouts)) {
    throw new Error(`the holdout line may hold only ids, results and ticket keys: ${holdouts.slice(0, 120)}`);
  }
  return { line, holdouts };
}

/**
 * The holdout line with each `mgr-…` marker replaced by the key this pass filed for it
 * (`managerPass` → `created`). A marker with no ticket (over the cap, or never filed) loses its
 * reference rather than name a guessed key.
 */
export function resolveHoldouts(m: Metrics, created: Readonly<Record<string, string>>): Metrics {
  const holdouts = m.holdouts.replace(new RegExp(String.raw` (${MARKER_REF})(?=,|$)`, 'g'), (_all, marker: string) => {
    const key = created[marker];
    return key === undefined ? '' : ` ${key}`;
  });
  return { line: m.line, holdouts };
}

export function appendMetrics(stateDir: string, m: Metrics): void {
  appendFileSync(join(stateDir, METRICS_FILE), `${m.line}\n${m.holdouts === '' ? '' : `${m.holdouts}\n`}`);
}

export function lastHoldoutLine(stateDir: string): string {
  const path = join(stateDir, METRICS_FILE);
  if (stateDir === '' || !existsSync(path)) return '';
  return readFileSync(path, 'utf8').split('\n').filter(l => HOLDOUT_LINE.test(l)).at(-1) ?? '';
}

/** `holdout-runs/base-results.txt` for the app check, written fresh (an agent's copy never stands). */
export function writeBaseResults(artifacts: string, stateDir: string): void {
  const path = join(artifacts, 'holdout-runs', 'base-results.txt');
  rmSync(path, { force: true });
  const line = lastHoldoutLine(stateDir);
  if (line === '') return;
  mkdirSync(join(artifacts, 'holdout-runs'), { recursive: true });
  writeFileSync(path, `${line}\n`);
}
