import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  blocksPass,
  evidenceProblems,
  filesReadInLog,
  isApprovalLink,
  isTrackingIssue,
  jiraCommentLink,
  ownerApprovals,
  parseDispositions,
  parseJudgeChanges,
  readAppCheck,
  recordRefusals,
  shipFailuresInLog,
  trackingRefs,
  untestedMerge,
  type CheckLine,
  type CitedFile,
  type Proofs,
  type TrackingReaders,
} from '../../workflows/sdlc/.shared/merge-gate';
import type { TrackerConfig } from '../../workflows/sdlc/.shared/jira';
import { protectedFiles } from '../../workflows/sdlc/.shared/protected-paths';

const pack = resolve(import.meta.dir, '../../workflows/sdlc');
const STARTED = 1_000_000;
const fresh: CitedFile = { exists: true, mtimeMs: STARTED + 5000, opened: true };

function line(id: string, kind: CheckLine['kind'], verdict: string, more: Partial<CheckLine> = {}): CheckLine {
  return { id, kind, verdict, text: `${id} text`, evidence: [`/run/${id.toLowerCase()}.txt`], pre_existing: '', defect: '', carried_from: '', ...more };
}

const CLEAN_LINES = [
  line('C1', 'criterion', 'PASS'),
  line('H1', 'holdout', 'PASS', { evidence: ['/run/h1.txt', '/run/h1.png'] }),
  line('P1', 'probe', 'OK', { evidence: ['/run/p1.png'] }),
];

/** A structured report as the check-app node returns it, with lines replaced or added by id. */
function report(lines: CheckLine[] = [], overall = 'PASS'): string {
  const byId = new Map(CLEAN_LINES.map(l => [l.id, l]));
  for (const l of lines) byId.set(l.id, l);
  return JSON.stringify({ pr: 'https://github.com/o/r/pull/9', head: 'abc1234', merged_with: 'def5678', lines: [...byId.values()], overall, summary: '' });
}

const CLEAN = report();
const disp = (...entries: Record<string, string>[]): ReturnType<typeof parseDispositions> => parseDispositions(JSON.stringify(entries));

function gate(json: string, extra: Partial<Parameters<typeof recordRefusals>[0]> = {}): string[] {
  return recordRefusals({
    report: readAppCheck(json),
    evidenceProblems: [],
    dispositions: new Map(),
    shipFailures: [],
    judgeChanges: [],
    freshFile: () => false,
    issueExists: () => false,
    ...extra,
  });
}

const proven: Proofs = { namesFile: () => true, earlierCommit: () => true };
const problems = (json: string, look: (path: string) => CitedFile = () => fresh, proofs: Proofs = proven): string[] =>
  evidenceProblems(readAppCheck(json), STARTED, look, proofs);

describe('evidence check', () => {
  it('a clean report with fresh, opened evidence passes', () => {
    expect(problems(CLEAN)).toEqual([]);
  });

  it('a line that cites nothing, or a file that is not there, fails', () => {
    expect(problems(report([line('C1', 'criterion', 'PASS', { evidence: [] })]))).toEqual(['C1 cites no evidence']);
    expect(problems(CLEAN, path => (path === '/run/c1.txt' ? { exists: false, mtimeMs: 0, opened: null } : fresh))).toEqual([
      'C1 cites /run/c1.txt, which does not exist',
    ]);
  });

  it('a file written before the check began is not this check’s evidence', () => {
    expect(problems(CLEAN, path => (path === '/run/c1.txt' ? { ...fresh, mtimeMs: STARTED - 60_000 } : fresh))).toEqual([
      'C1 cites /run/c1.txt, written before this check began',
    ]);
  });

  it('an image cited but never opened is not evidence (seen live: North Star #399 screenshots)', () => {
    const look = (path: string): CitedFile => (path.endsWith('.png') ? { ...fresh, opened: false } : fresh);
    expect(problems(CLEAN, look)).toEqual([
      'H1 cites the image /run/h1.png, which the app check never opened',
      'P1 cites the image /run/p1.png, which the app check never opened',
    ]);
    // Without a run log nothing can say, so the rule does not apply.
    expect(problems(CLEAN, () => ({ ...fresh, opened: null }))).toEqual([]);
  });

  it('Overall PASS over a new defect is refused (the observed defect graded PASS)', () => {
    const lines = [line('P2', 'probe', 'SURPRISE', { defect: 'D1' }), line('D1', 'defect', 'DEFECT')];
    expect(problems(report(lines))).toEqual(['Overall says PASS over D1']);
    expect(problems(report(lines, 'FAIL'))).toEqual([]);
  });

  it('a probe surprise must name its defect line', () => {
    expect(problems(report([line('P2', 'probe', 'SURPRISE')]))).toEqual(['P2 is a surprise that names no defect line']);
  });

  it('a holdout the default branch cannot finish either leaves Overall PASS standing (seen live: #400 H2)', () => {
    const shared = line('H2', 'holdout', 'INCOMPLETE', { pre_existing: 'default-branch run under the same load: /run/main-h2.txt' });
    expect(problems(report([shared]))).toEqual([]);
    expect(problems(report([{ ...shared, pre_existing: '' }]))).toEqual(['Overall says PASS over H2']);
  });

  it('a carried line needs no new evidence; NO PR needs none at all', () => {
    expect(problems(report([line('C1', 'criterion', 'PASS', { evidence: [], carried_from: '0123abcd' })]))).toEqual([]);
    expect(problems(JSON.stringify({ pr: '', head: '', merged_with: '', lines: [], overall: 'NO PR', summary: 'nothing pushed' }))).toEqual([]);
  });

  it('an unreadable report never passes', () => {
    expect(problems('not json')).toEqual(['the report has no lines']);
  });

  it('reads which files the app check opened from the run log', () => {
    const log = [
      JSON.stringify({ step: 'check-app', type: 'provider_event', event: { type: 'tool_call', name: 'Read', rawInput: { file_path: 'C:\\run\\shot.png' } } }),
      JSON.stringify({ step: 'review', type: 'provider_event', event: { type: 'tool_call', name: 'Read', rawInput: { file_path: 'C:\\run\\other.png' } } }),
      '{"partial',
    ].join('\n');
    const key = (path: string): string => path.replace(/\\/g, '/').toLowerCase();
    expect([...(filesReadInLog(log, 'check-app', key) ?? [])]).toEqual(['c:/run/shot.png']);
  });

  it('cannot say what a node opened when its log names no tool calls (a Codex node)', () => {
    // Codex logs commands as subtasks and does not log its image views, so every cited image
    // read as unopened and every screen lap failed on Codex (mission control, 2026-10-26).
    const log = [
      JSON.stringify({ step: 'check-app', type: 'provider_event', event: { type: 'subtask', taskType: 'command_execution', description: 'bun run check' } }),
      JSON.stringify({ step: 'check-app', type: 'provider_event', event: { type: 'agent_message_chunk', text: 'viewed shot.png' } }),
    ].join('\n');
    expect(filesReadInLog(log, 'check-app', (path: string): string => path)).toBeNull();
  });
});

describe('merge gate', () => {
  const defect = report([line('D1', 'defect', 'DEFECT')], 'FAIL');

  it('a clean, evidenced report merges', () => {
    expect(gate(CLEAN)).toEqual([]);
  });

  it('an evidence check that failed refuses the merge', () => {
    expect(gate(CLEAN, { evidenceProblems: ['C1 cites no evidence'] })).toEqual([
      "the app check's report did not hold up: C1 cites no evidence",
    ]);
  });

  it('a decided question needs no evidence; an undecided one still refuses', () => {
    const question = report([...CLEAN_LINES, line('D1', 'defect', 'QUESTION', { evidence: [] })]);
    const problems = ['D1 cites no evidence'];
    expect(gate(question, { evidenceProblems: problems })[0]).toContain('D1 cites no evidence');
    const accepted = disp({ line: 'D1', action: 'accepted', file: '', issue: '', reason: 'the work item settles it already' });
    expect(gate(question, { evidenceProblems: problems, dispositions: accepted })).toEqual([]);
    const filed = disp({ line: 'D1', action: 'issue', file: '', issue: '#42', reason: '' });
    expect(gate(question, { evidenceProblems: problems, dispositions: filed, issueExists: () => true })).toEqual([]);
    expect(gate(CLEAN, { evidenceProblems: ['C1 cites no evidence'], dispositions: accepted })).toHaveLength(1);
  });

  it('a new defect blocks unless the reviewer re-checked it with a file it wrote', () => {
    expect(gate(defect)).toEqual(['D1 (DEFECT) has no re-check or default-branch proof the reviewer wrote']);
    const claimed = disp({ line: 'd1', action: 'rechecked', file: '/run/review-d1.txt', issue: '', reason: '' });
    expect(gate(defect, { dispositions: claimed })).toHaveLength(1);
    expect(gate(defect, { dispositions: claimed, freshFile: path => path === '/run/review-d1.txt' })).toEqual([]);
  });

  it('a defect the reviewer shows is on the default branch needs a tracking issue too', () => {
    const noIssue = disp({ line: 'D1', action: 'pre-existing', file: '/run/main.txt', issue: '', reason: '' });
    expect(gate(defect, { dispositions: noIssue, freshFile: () => true })).toEqual([
      "D1 is pre-existing by the reviewer's run, but no issue that exists tracks it",
    ]);
    const tracked = disp({ line: 'D1', action: 'pre-existing', file: '/run/main.txt', issue: '#41', reason: '' });
    expect(gate(defect, { dispositions: tracked, freshFile: () => true, issueExists: ref => ref === '#41' })).toEqual([]);
  });

  it('a failure the default branch already has merges only with an issue that exists', () => {
    const json = report([line('H1', 'holdout', 'FAIL', { pre_existing: 'baseline row 2' })]);
    expect(gate(json)).toEqual(['H1 is a failure the default branch has too, but no issue that exists tracks it']);
    // Seen live: the reviewer named the issue under either action; the issue is what counts.
    for (const action of ['issue', 'pre-existing']) {
      const linked = disp({ line: 'H1', action, file: '', issue: '#12', reason: '' });
      expect(gate(json, { dispositions: linked })).toHaveLength(1);
      expect(gate(json, { dispositions: linked, issueExists: ref => ref === '#12' })).toEqual([]);
    }
  });

  it('a failed criterion is never pre-existing (seen live: North Star #399 C2)', () => {
    const json = report([line('C1', 'criterion', 'FAIL', { pre_existing: 'the default branch lacks it too' })], 'FAIL');
    expect(blocksPass(readAppCheck(json).lines[0])).toBe(true);
    const unmet = 'C1 (FAIL): a criterion of this work item is not met. Deliver it in this pull request, or ask the owner to narrow the work item';
    const preExisting = disp({ line: 'C1', action: 'pre-existing', file: '/run/main.txt', issue: '#404', reason: '' });
    expect(gate(json, { dispositions: preExisting, freshFile: () => true, issueExists: () => true })).toEqual([unmet]);
    const blocks = disp({ line: 'C1', action: 'blocks', file: '', issue: '', reason: '' });
    expect(gate(json, { dispositions: blocks, freshFile: () => true })).toEqual([unmet]);
    // The reviewer's own re-check showing it met still clears it.
    const rechecked = disp({ line: 'C1', action: 'rechecked', file: '/run/recheck.md', issue: '', reason: '' });
    expect(gate(json, { dispositions: rechecked, freshFile: () => true })).toEqual([]);
  });

  it('a shipping pipeline whose review step failed never merges (the #362 case)', () => {
    const log = [
      JSON.stringify({ step: 'ship__deliver__review__code', type: 'node_complete' }),
      JSON.stringify({ step: 'ship__deliver__review__synthesize', type: 'node_error', error: 'the artifact pointer at $.report refers to a file that does not exist' }),
      JSON.stringify({ step: 'check-app', type: 'node_error', error: 'not a ship node' }),
    ].join('\n');
    const failures = shipFailuresInLog(log);
    expect(failures).toEqual(['ship__deliver__review__synthesize: the artifact pointer at $.report refers to a file that does not exist']);
    expect(gate(CLEAN, { shipFailures: failures })).toEqual([`the shipping pipeline's ${failures[0]} failed`]);
  });

  it('a question does not fail the check, but the review must decide it', () => {
    const json = report([line('D1', 'defect', 'QUESTION')]);
    expect(problems(json)).toEqual([]);
    expect(gate(json)).toEqual(['D1 is an open question the review did not decide (an issue, or accepted with a reason)']);
    expect(gate(json, { dispositions: disp({ line: 'D1', action: 'accepted', file: '', issue: '', reason: 'fine' }) })).toHaveLength(1);
    const reasoned = disp({ line: 'D1', action: 'accepted', file: '', issue: '', reason: 'a locked note cannot be saved, so nothing savable is lost' });
    expect(gate(json, { dispositions: reasoned })).toEqual([]);
    const filed = disp({ line: 'D1', action: 'issue', file: '', issue: '#60', reason: '' });
    expect(gate(json, { dispositions: filed, issueExists: ref => ref === '#60' })).toEqual([]);
  });

  it('a disposition that quotes the whole report line is matched by its id (seen live)', () => {
    const quoted = disp({ line: 'D1 NEW Export leaves out a note’s locked state', action: 'blocks', file: '', issue: '', reason: '' });
    expect([...quoted.keys()]).toEqual(['D1']);
    expect(disp({ line: 'D12 x', action: 'issue', file: '', issue: '#1', reason: '' }).has('D12')).toBe(true);
  });

  it('a line the evidence check flagged is cleared only by the reviewer’s own re-check', () => {
    const flagged = ['C1 cites /run/town.png, which does not exist', 'H1 cites /run/h1.txt, which does not exist'];
    const recheck = (id: string): Record<string, string> => ({ line: id, action: 'rechecked', file: '/run/recheck.md', issue: '', reason: '' });
    const base = { evidenceProblems: flagged, dispositions: disp(recheck('C1'), recheck('H1')) };
    expect(gate(CLEAN, { ...base, freshFile: () => true })).toEqual([]);
    expect(gate(CLEAN, { ...base, freshFile: () => false })).toHaveLength(1);
    expect(gate(CLEAN, { ...base, dispositions: disp(recheck('C1')), freshFile: () => true })).toEqual([
      `the app check's report did not hold up: ${flagged[1]}`,
    ]);
    // A problem with the report as a whole has no re-check that clears it.
    expect(gate(CLEAN, { ...base, evidenceProblems: ['Overall says PASS over D1'], freshFile: () => true })).toHaveLength(1);
  });

  it('malformed dispositions are ignored, never trusted', () => {
    expect(parseDispositions('not json').size).toBe(0);
    expect(parseDispositions('{"line":"D1"}').size).toBe(0);
    expect(parseDispositions('[null, {"line": 3}, {"line":"h1","action":"issue","issue":"#2"}]').get('H1')).toEqual({
      action: 'issue',
      file: '',
      issue: '#2',
      reason: '',
    });
  });
});

describe('what the record proves (2026-10-19 audit)', () => {
  it('a default-branch failure must name the file that shows it', () => {
    const json = report([line('H2', 'holdout', 'FAIL', { pre_existing: 'yes' })]);
    expect(problems(json, () => fresh, { ...proven, namesFile: () => false })).toEqual([
      'H2 says the default branch fails the same way but names no file that shows it',
    ]);
    expect(problems(json)).toEqual([]);
  });

  it('a carried line must come from an earlier commit of the tested head', () => {
    const json = report([line('C1', 'criterion', 'PASS', { evidence: [], carried_from: 'x' })]);
    expect(problems(json, () => fresh, { ...proven, earlierCommit: sha => sha !== 'x' })).toEqual([
      'C1 is carried from x, which is not an earlier commit of the tested head',
    ]);
  });

  it('only an open issue tracks anything: not a pull request, not a closed issue', () => {
    expect(isTrackingIssue({ state: 'OPEN', url: 'https://github.com/o/r/issues/12' })).toBe(true);
    expect(isTrackingIssue({ state: 'MERGED', url: 'https://github.com/o/r/pull/409' })).toBe(false);
    expect(isTrackingIssue({ state: 'OPEN', url: 'https://github.com/o/r/pull/430' })).toBe(false);
    expect(isTrackingIssue({ state: 'CLOSED', url: 'https://github.com/o/r/issues/12' })).toBe(false);
  });

  it('the merged commit must be what the check tested, or that plus a clean merge of the base away from this change', () => {
    const facts = { shaTree: 't1', testedTree: 't1', withBaseTree: 't2', fromBase: ['b.cs'], prFiles: ['a.cs'] };
    expect(untestedMerge(facts)).toBeNull();
    expect(untestedMerge({ ...facts, shaTree: 't2' })).toBeNull();
    expect(untestedMerge({ ...facts, shaTree: 't3' })).toContain('not what the app check tested');
    expect(untestedMerge({ ...facts, shaTree: 't2', fromBase: ['a.cs'] })).toContain('a.cs');
    expect(untestedMerge({ ...facts, shaTree: 't2', withBaseTree: '' })).toContain('not what the app check tested');
    expect(untestedMerge({ ...facts, testedTree: '' })).toContain('did not record');
  });

  it('a ship step that failed and then completed on resume is not a failure', () => {
    const log = [
      JSON.stringify({ step: 'ship__deliver__pr__publish', type: 'node_error', error: 'bad escape' }),
      JSON.stringify({ step: 'ship__deliver__pr__publish', type: 'node_complete' }),
      JSON.stringify({ step: 'ship__deliver__review__code', type: 'node_error', error: 'crashed' }),
    ].join('\n');
    expect(shipFailuresInLog(log)).toEqual(['ship__deliver__review__code: crashed']);
  });

  it('a change to what a check judges needs an approval named', () => {
    const changes = parseJudgeChanges(
      JSON.stringify([
        { file: 'game/harness/AllegianceCheck.cs', change: 'ghost pixels left out of foe samples', approval: '' },
        { file: 'game/harness/SceneryViewCheck.cs', change: 'new check', approval: 'C1' },
        {
          file: 'game/harness/HudCheck.cs',
          change: 'exceptions for foes',
          approval: 'https://github.com/o/r/issues/502#issuecomment-6303074947',
        },
      ])
    );
    expect(gate(CLEAN, { judgeChanges: changes })).toEqual([
      'game/harness/AllegianceCheck.cs changes what a check judges (ghost pixels left out of foe samples) with no approval named',
      "game/harness/SceneryViewCheck.cs changes what a check judges (new check), and its approval (C1) is not a link to the owner's words",
    ]);
    expect(parseJudgeChanges('not json')).toEqual([]);
  });
});

describe('loop wiring', () => {
  // A Windows checkout carries CRLF; the node boundaries below are matched on LF.
  const yaml = readFileSync(resolve(pack, 'loop/archon-loop.yaml'), 'utf8').replace(/\r\n/g, '\n');
  const node = (id: string): string => {
    const start = yaml.indexOf(`  - id: ${id}\n`);
    const next = yaml.indexOf('\n  - id: ', start + 1);
    expect(start).toBeGreaterThan(-1);
    return yaml.slice(start, next === -1 ? undefined : next);
  };

  it('the app check is given facts, never the builder report or the shipping summary', () => {
    const checkApp = node('check-app');
    expect(checkApp).not.toContain('$build.output');
    expect(checkApp).not.toContain('$ship.output');
    expect(checkApp).toContain('output_format');
    const prompt = readFileSync(resolve(pack, 'loop/commands/loop-check-app.md'), 'utf8');
    expect(prompt).not.toContain('$INPUTS.builder');
    expect(prompt).not.toContain('$INPUTS.ship');
    expect(prompt).toContain('## How deep: $INPUTS.depth');
    expect(prompt).toContain('`noticed`');
    expect(prompt).not.toContain('When unsure, test more');
    expect(prompt).toContain('QUESTION');
    expect(prompt.replace(/\r\n/g, '\n')).toContain("What the default\nbranch brought in is not this change's");
    expect(prompt).toContain('change no code at all (only the pull request');
  });

  it('a lap that changes no code checks nothing again, and pick follows the critical path', () => {
    const work = readFileSync(resolve(pack, 'loop/commands/loop-work.md'), 'utf8');
    expect(work).toContain('A run that changes no code runs no checks either');
    expect(work).toContain('a green CI run on the commit you push is that full run');
    const pick = readFileSync(resolve(pack, 'loop/commands/loop-pick.md'), 'utf8');
    expect(pick).toContain('that unblocks the most other open work');
    expect(pick).toContain('an open issue labeled `priority`');
    expect(pick).toContain('asked for no code change (only the record, the evidence, or merging the default branch) is `light`');
    expect(pick).not.toContain('lowest number first unless');
  });

  it('the merge goes through the gate: review decides, land merges, deploy follows land', () => {
    expect(node('evidence')).toContain('script: evidence');
    expect(node('land')).toContain('script: land');
    expect(node('land')).toContain("$review.output.outcome == 'merge'");
    expect(node('deploy')).toContain("$land.output.outcome == 'merged'");
    const review = readFileSync(resolve(pack, 'loop/commands/loop-review.md'), 'utf8');
    expect(review).toContain('Never run `gh pr merge` yourself');
    expect(review).not.toMatch(/gh pr merge <n> --squash/);
  });

  it('shared pack text names no particular wrapper around Archon', () => {
    for (const file of ['manager/commands/manage.md', 'loop/commands/loop-review.md', 'loop/commands/loop-check-app.md']) {
      expect(readFileSync(resolve(pack, file), 'utf8')).not.toMatch(/consumer\.py|factory\//);
    }
  });

  it('every builder and checker iterates on the smallest run and samples the deciding states', () => {
    for (const file of ['implement/commands/implement.md', 'loop/commands/loop-work.md']) {
      const text = readFileSync(resolve(pack, file), 'utf8');
      expect(text).toContain('Make every check you run as small as the question it answers');
      expect(text).toContain('is never an iteration step');
    }
    const check = readFileSync(resolve(pack, 'loop/commands/loop-check-app.md'), 'utf8');
    expect(check).toContain('never every tick, frame or combination of inputs');
    const pick = readFileSync(resolve(pack, 'loop/commands/loop-pick.md'), 'utf8');
    expect(pick).not.toContain('tries every user action');
    expect(pick).toContain('A `complex` item a user can see is `normal`');
    expect(pick).not.toContain('A `complex` item is `light` too');
    expect(check).toContain('a few sampled moments miss a change that lasts one to three steps');
    for (const file of ['implement/commands/implement.md', 'loop/commands/loop-work.md']) {
      expect(readFileSync(resolve(pack, file), 'utf8')).toContain('read the app\'s state at every step');
    }
    const manage = readFileSync(resolve(pack, 'manager/commands/manage.md'), 'utf8');
    expect(manage).toContain('Run every check the repository commits on the default branch each pass');
    expect(manage).toContain('Ask the owner only about product direction, scope, how the game feels to play, how it looks');
    expect(manage).toContain('`Manager decision`');
    const review = readFileSync(resolve(pack, 'loop/commands/loop-review.md'), 'utf8');
    expect(review).toContain('A change that would let the check stop catching something a player would see');
  });

  it('the manager runs the holdouts once per pass, not again each time the default branch moves', () => {
    const manage = readFileSync(resolve(pack, 'manager/commands/manage.md'), 'utf8');
    expect(manage).toContain('When the default branch moves during your pass, do not rerun anything');
  });
});

describe('holdouts behind a fence', () => {
  it('owner-only paths are matched from the repository root', () => {
    const declared = '.factory/**,MISSION.md,.claude/settings.json';
    expect(protectedFiles(declared, ['.factory/holdout/HOLDOUT.md', 'src/app.ts', 'MISSION.md', 'docs/MISSION.md']))
      .toEqual(['.factory/holdout/HOLDOUT.md', 'MISSION.md']);
    expect(protectedFiles('none', ['MISSION.md'])).toEqual([]);
    expect(protectedFiles('a,,b', ['a'])).toBe('invalid');
  });

  it('the merge gate is given the protected paths', () => {
    const yaml = readFileSync(resolve(pack, 'loop/archon-loop.yaml'), 'utf8');
    expect(yaml).toContain('protected_paths: "$INPUTS.protected_paths"');
    expect(readFileSync(resolve(pack, 'loop/scripts/land.ts'), 'utf8')).toContain('INPUTS_PROTECTED_PATHS');
  });

  it('the app check, the reviewer and the manager reach the scenarios only through the holdout agents', () => {
    for (const file of ['loop/archon-loop.yaml', 'manager/archon-manager.yaml', 'holdouts/archon-holdouts.yaml']) {
      const yaml = readFileSync(resolve(pack, file), 'utf8');
      expect(yaml).toContain('script: briefs');
      expect(yaml).toContain('$ARTIFACTS_DIR/agents/holdout-');
    }
    for (const file of ['loop/commands/loop-check-app.md', 'loop/commands/loop-review.md', 'manager/commands/manage.md']) {
      const prompt = readFileSync(resolve(pack, file), 'utf8');
      expect(prompt).toContain('`holdout-verifier` agent');
      expect(prompt).not.toContain('holdout-baseline.md');
    }
    for (const brief of ['holdout-verifier', 'holdout-writer']) {
      expect(readFileSync(resolve(pack, `holdouts/commands/${brief}.md`), 'utf8')).toContain('whoever asks');
    }
  });

  it('takes an approval link with a label after it, never text without a link', () => {
    // Reviewers wrote "<url> (Manager decision, ...)" and the gate refused correct approvals.
    const url = 'https://github.com/o/r/issues/74#issuecomment-123';
    expect(isApprovalLink(url)).toBe(true);
    expect(isApprovalLink(`${url} (Owner decision, 2026-10-26)`)).toBe(true);
    expect(isApprovalLink('https://github.com/o/r/pull/145 (Manager decision, manager pass 675828cb)')).toBe(true);
    expect(isApprovalLink('Owner decision on #74')).toBe(false);
    expect(isApprovalLink('see https://github.com/o/r/issues/74')).toBe(false);
    expect(isApprovalLink('https://example.com/o/r/issues/74')).toBe(false);
  });
});

describe('the merge gate with Jira', () => {
  const SITE = 'https://example.atlassian.net';
  const CFG: TrackerConfig = {
    kind: 'jira',
    site: SITE,
    project: 'CONC',
    board: 5,
    keychain: 'none',
    assignee: 'acc-archon',
    owner: 'acc-julian',
    status: { todo: '10015', progress: '3', review: '10016', staging: '10017', live: '10018', canceled: '10008' },
    flagField: 'customfield_10021',
    flagOn: '10019',
    sprintField: 'customfield_10020',
  };

  it('a Jira ticket URL tracks a pre-existing failure only while it is open', () => {
    expect(isTrackingIssue({ state: 'OPEN', url: `${SITE}/browse/CONC-41` })).toBe(true);
    expect(isTrackingIssue({ state: 'CLOSED', url: `${SITE}/browse/CONC-41` })).toBe(false);
    expect(isTrackingIssue({ state: 'OPEN', url: `${SITE}/browse/CONC-41?focusedCommentId=1` })).toBe(false);
  });

  it('a link to a comment on a ticket of the configured site, label allowed, site compared as text', () => {
    const link = `${SITE}/browse/CONC-5?focusedCommentId=10042`;
    expect(jiraCommentLink(link, SITE)).toEqual({ key: 'CONC-5', comment: 10042 });
    // The label a reviewer adds after the link (mission control #102/#145) holds here too.
    expect(jiraCommentLink(`${link} (Owner decision, 2026-11-15)`, SITE)).toEqual({ key: 'CONC-5', comment: 10042 });
    expect(jiraCommentLink(`${SITE}/browse/CONC-5`, SITE)).toBeNull();
    expect(jiraCommentLink('https://evil.example/browse/CONC-5?focusedCommentId=1', SITE)).toBeNull();
    // The site's dots are literal: a look-alike host is not the site.
    expect(jiraCommentLink('https://example-atlassian-net/browse/CONC-5?focusedCommentId=1', SITE)).toBeNull();
    expect(jiraCommentLink(`${SITE}.evil.example/browse/CONC-5?focusedCommentId=1`, SITE)).toBeNull();
    expect(jiraCommentLink(`see ${link}`, SITE)).toBeNull();
    expect(isApprovalLink(link)).toBe(false);
  });

  it('the gate takes a Jira approval only once land found it the owner\'s comment', () => {
    const approval = `${SITE}/browse/CONC-5?focusedCommentId=10042`;
    const judgeChanges = [{ file: 'tests/a.test.ts', change: 'loosened', approval }];
    expect(gate(CLEAN, { judgeChanges, ownerApprovals: new Set([approval]) })).toEqual([]);
    expect(gate(CLEAN, { judgeChanges })[0]).toContain('is not a link to the owner');
  });

  type Rows = { id: number; author: string }[];
  const comments = (rows: Rows): (() => Promise<Rows>) => async () => rows;

  it('an approval counts only as a comment the owner wrote, never the loop\'s own', async () => {
    const seen: string[] = [];
    const owner = `${SITE}/browse/CONC-5?focusedCommentId=10042`;
    const archon = `${SITE}/browse/CONC-5?focusedCommentId=10043 (Owner decision)`;
    const found = await ownerApprovals(
      [owner, archon, `${SITE}/browse/CONC-5`, `${SITE}/browse/VAULT-3?focusedCommentId=1`, `${SITE}/browse/CONC-5?focusedCommentId=99`, 'https://github.com/o/r/issues/74'],
      {
        config: CFG,
        comments: async key => (seen.push(key), [{ id: 10042, author: CFG.owner }, { id: 10043, author: CFG.assignee }]),
      }
    );
    expect(found.approved).toEqual(new Set([owner]));
    expect(found.problems).toEqual([]);
    // One read per ticket; a foreign project's key is never read.
    expect(seen).toEqual(['CONC-5']);
    expect((await ownerApprovals([owner], { config: CFG, comments: comments([]) })).approved.size).toBe(0);
  });

  it('a comment Jira cannot read approves nothing, with the reason kept for the refusal', async () => {
    const found = await ownerApprovals([`${SITE}/browse/CONC-5?focusedCommentId=10042`], {
      config: CFG,
      comments: async () => {
        throw new Error('Jira GET /rest/api/3/issue/CONC-5/comment -> 503: down');
      },
    });
    expect(found.approved.size).toBe(0);
    expect(found.problems).toEqual(['could not read the comments of CONC-5 from Jira: Jira GET /rest/api/3/issue/CONC-5/comment -> 503: down']);
  });

  type ReadTicket = NonNullable<TrackingReaders['jira']>['ticket'];
  const ticket = (status: string): ReadTicket => async key => ({ status, url: `${SITE}/browse/${key}` });
  const readers = (over: Partial<TrackingReaders> = {}, jira: Partial<NonNullable<TrackingReaders['jira']>> = {}): TrackingReaders => ({
    prUrl: 'https://github.com/o/r/pull/9',
    githubIssue: () => null,
    jira: { config: CFG, created: {}, target: 'CONC-5', ticket: ticket(CFG.status.todo), ...jira },
    ...over,
  });

  it('an open ticket tracks; one on Staging, Live or Canceled does not', async () => {
    expect((await trackingRefs(['CONC-41'], readers())).open).toEqual(new Set(['CONC-41']));
    const onNew = await trackingRefs(['CONC-41'], readers({}, { ticket: ticket('10014') }));
    expect(onNew.open).toEqual(new Set(['CONC-41']));
    for (const done of [CFG.status.staging, CFG.status.live, CFG.status.canceled]) {
      expect((await trackingRefs(['CONC-41'], readers({}, { ticket: ticket(done) }))).open.size).toBe(0);
    }
  });

  it('new:<marker> is the ticket this run filed for it, checked like any other', async () => {
    const r = readers({}, { created: { 'flaky-login': 'CONC-60' } });
    const found = await trackingRefs(['new:flaky-login', 'new:never-filed'], r);
    expect(found.open).toEqual(new Set(['new:flaky-login']));
    const closed = await trackingRefs(['new:flaky-login'], readers({}, { created: { 'flaky-login': 'CONC-60' }, ticket: ticket(CFG.status.canceled) }));
    expect(closed.open.size).toBe(0);
  });

  it('the lap\'s own ticket, a foreign key or a pull request never tracks anything', async () => {
    const seen: string[] = [];
    const r = readers({ githubIssue: n => (seen.push(n), { state: 'OPEN', url: 'https://github.com/o/r/issues/12' }) }, {
      ticket: async key => (seen.push(key), { status: CFG.status.todo, url: `${SITE}/browse/${key}` }),
    });
    const found = await trackingRefs(['CONC-5', 'VAULT-3', 'CONC-0', '#9', '9', 'new:'], r);
    expect(found.open.size).toBe(0);
    expect(seen).toEqual([]);
  });

  it('a GitHub issue number tracks as before, a ticket URL like its key', async () => {
    const r = readers({ githubIssue: n => ({ state: 'OPEN', url: `https://github.com/o/r/issues/${n}` }) });
    expect((await trackingRefs(['#12', '13', `${SITE}/browse/CONC-41`], r)).open).toEqual(new Set(['#12', '13', `${SITE}/browse/CONC-41`]));
  });

  it('without Jira a key or marker tracks nothing and nothing asks Jira', async () => {
    const r = readers({ jira: undefined, githubIssue: n => ({ state: 'OPEN', url: `https://github.com/o/r/issues/${n}` }) });
    expect((await trackingRefs(['CONC-41', 'new:x-y-z', '#12'], r)).open).toEqual(new Set(['#12']));
  });

  it('a ticket Jira cannot read is untracked, with the reason kept for the refusal', async () => {
    const r = readers({}, { ticket: async () => { throw new Error('Jira GET /rest/api/3/issue/CONC-41 -> 503: down'); } });
    const found = await trackingRefs(['CONC-41'], r);
    expect(found.open.size).toBe(0);
    expect(found.problems).toEqual(['could not read CONC-41 from Jira: Jira GET /rest/api/3/issue/CONC-41 -> 503: down']);
  });
});
