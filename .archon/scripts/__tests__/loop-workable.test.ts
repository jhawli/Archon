import { describe, expect, it } from 'bun:test';
import { dependencyKeys, referencedKeys } from '../../workflows/sdlc/.shared/tickets';
import { jiraLinks } from '../../workflows/sdlc/.shared/tracker-board';
import {
  workability as workabilityOf,
  type Board,
  type BoardItem,
  type Workability,
} from '../../workflows/sdlc/.shared/workable';

const now = Date.parse('2026-10-17T12:00:00Z');
const hoursAgo = (h: number): string => new Date(now - h * 3_600_000).toISOString();

/** A ticket `CONC-n` on the board. Work items live in Jira; pull requests stay on GitHub. */
function ticket(n: number, extra: Partial<BoardItem> = {}): BoardItem {
  const labels = extra.labels ?? [];
  return {
    id: `CONC-${n}`,
    title: `ticket ${n}`,
    body: '',
    comments: [],
    candidate: true,
    ...extra,
    labels,
    owner: extra.owner ?? labels.includes('needs-owner'),
  };
}

/** A pull request `#n` on the board. */
function pull(n: number, extra: Partial<BoardItem> = {}): BoardItem {
  return { ...ticket(n, extra), id: `#${n}`, title: `pull ${n}` };
}

/** Every item on the board still blocks a `Depends on`, as an open sprint would. */
function workability(
  board: Omit<Board, 'open'>,
  expiryHours: number,
  at: number,
  endedRuns: ReadonlySet<string> = new Set()
): Workability {
  const open = new Set([...board.issues, ...board.pulls].map(i => i.id));
  return workabilityOf({ ...board, open }, expiryHours, at, endedRuns, jiraLinks('CONC'));
}

const keys = (refs: readonly { kind: string; key?: string }[]): (string | undefined)[] => refs.map(r => r.key);

const claim = (run: string, h = 1): BoardItem['comments'][number] => ({
  body: `Loop claim: run ${run}\n\nRoute: simple\nArea: a`,
  createdAt: hoursAgo(h),
});

describe('loop launch gate', () => {
  it('reads Depends on lines and closing keywords the way pick does', () => {
    expect(dependencyKeys('Intro\nDepends on: CONC-3, CONC-5\n- **Depends on:** CONC-9', 'CONC')).toEqual([
      'CONC-3',
      'CONC-5',
      'CONC-9',
    ]);
    expect(dependencyKeys('This depends on nothing; see CONC-4', 'CONC')).toEqual([]);
    // `#n` is a pull request, never a work item.
    expect(dependencyKeys('Depends on: #3', 'CONC')).toEqual([]);
    expect(referencedKeys('Closes CONC-12. Also fixes CONC-13 and Resolves CONC-14', 'CONC')).toEqual([
      'CONC-12',
      'CONC-13',
      'CONC-14',
    ]);
  });

  it('ein Ticket im Sprint ohne Claim, Flag oder offene Abhängigkeit ist wählbar', () => {
    const result = workability({ issues: [ticket(1), ticket(2, { body: 'Depends on: CONC-9' })], pulls: [] }, 6, now);
    // CONC-9 is not on the board, so it is done: CONC-2 is free too.
    expect(result.workable).toEqual([
      { kind: 'ticket', key: 'CONC-1' },
      { kind: 'ticket', key: 'CONC-2' },
    ]);
  });

  it('a serial chain leaves only its head workable', () => {
    const result = workability(
      {
        issues: [ticket(1), ticket(2, { body: 'Depends on: CONC-1' }), ticket(3, { body: 'Depends on: CONC-2' })],
        pulls: [],
      },
      6,
      now
    );
    expect(result.workable).toEqual([{ kind: 'ticket', key: 'CONC-1' }]);
    expect(result.waiting.map(w => w.why)).toEqual(['depends on CONC-1', 'depends on CONC-2']);
  });

  it('live claims take tickets; released, withdrawn and expired claims do not', () => {
    const result = workability(
      {
        issues: [
          ticket(1, { comments: [claim('run-a')] }),
          ticket(2, { comments: [{ body: 'Loop claim released: run run-b ended.', createdAt: hoursAgo(1) }] }),
          ticket(3, { comments: [{ body: 'Loop claim withdrawn: run run-c', createdAt: hoursAgo(1) }] }),
          ticket(4, { comments: [claim('run-d', 7)] }),
        ],
        pulls: [],
      },
      6,
      now
    );
    expect(result.claims).toEqual([{ kind: 'ticket', key: 'CONC-1', run: 'run-a' }]);
    expect(keys(result.workable)).toEqual(['CONC-2', 'CONC-3', 'CONC-4']);
  });

  it('a claim held by a run the scheduler knows has ended is dead and returned for release', () => {
    const dead = { ...claim('run-gone'), url: 'https://example.atlassian.net/browse/CONC-1?focusedCommentId=77' };
    const result = workability(
      { issues: [ticket(1, { comments: [dead, claim('run-live')] })], pulls: [] },
      6,
      now,
      new Set(['run-gone'])
    );
    // The next live claim holds the ticket; the dead one is released, not counted.
    expect(result.claims).toEqual([{ kind: 'ticket', key: 'CONC-1', run: 'run-live' }]);
    expect(result.ended).toEqual([{ kind: 'ticket', key: 'CONC-1', run: 'run-gone', url: dead.url }]);
    expect(result.workable).toEqual([]);

    const alone = workability({ issues: [ticket(2, { comments: [dead] })], pulls: [] }, 6, now, new Set(['run-gone']));
    expect(alone.workable).toEqual([{ kind: 'ticket', key: 'CONC-2' }]);
  });

  it('owner decisions are not work: a flagged ticket, or one labelled needs-owner', () => {
    const result = workability(
      { issues: [ticket(1, { labels: ['needs-owner'] }), ticket(2, { owner: true })], pulls: [] },
      6,
      now
    );
    expect(result.workable).toEqual([]);
    expect(result.waiting.map(w => w.why)).toEqual(['needs-owner', 'needs-owner']);
  });

  it('an open pull request is the work for the ticket it closes, and shares its claim', () => {
    const free = workability({ issues: [ticket(1)], pulls: [pull(20, { body: 'Closes CONC-1' })] }, 6, now);
    expect(free.workable).toEqual([{ kind: 'pull', number: 20 }]);

    const held = workability(
      { issues: [ticket(1, { comments: [claim('run-a')] })], pulls: [pull(20, { body: 'Closes CONC-1' })] },
      6,
      now
    );
    expect(held.workable).toEqual([]);

    const parked = workability(
      { issues: [ticket(1, { labels: ['needs-owner'] })], pulls: [pull(20, { body: 'Closes CONC-1' })] },
      6,
      now
    );
    expect(parked.workable).toEqual([]);
  });

  it('a pull request that only references its ticket (Refs CONC-n, until its final review) shares the claim too', () => {
    expect(referencedKeys('Refs CONC-1. Relates to CONC-2; see also CONC-3', 'CONC')).toEqual(['CONC-1', 'CONC-2']);
    const held = workability(
      { issues: [ticket(1, { comments: [claim('run-a')] })], pulls: [pull(28, { body: 'Refs CONC-1' })] },
      6,
      now
    );
    expect(held.workable).toEqual([]);
    const free = workability({ issues: [ticket(1)], pulls: [pull(28, { body: 'Refs CONC-1' })] }, 6, now);
    expect(free.workable).toEqual([{ kind: 'pull', number: 28 }]);
  });
});
