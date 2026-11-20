# Backlog

`archon-backlog` turns a product document into an ordered Jira backlog. It works
for new and existing libraries, CLIs, desktop applications, services, and other
projects without imposing a runtime shape.

Inputs are `prd` (a path inside the checkout), `publication` (`preview` renders
`backlog.md` locally, `approve` pauses on a native approval, `auto` publishes this
run) and `max_issues` (default 12; a larger document is sliced again later).

The composition is one planner and one publisher with a deterministic check
between them. The planner (large tier) decomposes the way `plan-create-stories`
does: each implementation phase is a ticket group, each user story a ticket, every
ticket traceable to the document, small, with acceptance criteria a verifier can
check. The first ticket is the smallest runnable, testable increment appropriate to
the project and its native guidance; the pack does not invent service endpoints or
mandatory project documents. `check-backlog` refuses a slice with duplicate keys,
forward dependencies, a first ticket that depends on anything, or more tickets than
the bound. The publisher is a script (`publish-backlog.ts`), not an agent: it
writes only on `auto` or an approval, and files each ticket through the pack's Jira
client with the marker `backlog-<document>-<key>` as its remote link, as a slice
on Startklar under the feature the caller names (`feature`, checked by the first
node: an open feature of the project) in the active sprint, the phase as a `Phase:` line and dependencies as
`Depends on: CONC-n`. A ticket whose marker Jira already knows, or one of the same
document with the same title, counts as existing, so re-running on the same
document never duplicates the backlog. Without `.archon/tracker.json` the first
node (`tracker-read`) refuses the run before any agent.

After publication the tickets sit in the active sprint on Startklar, where
`archon-loop` takes them up in sprint order (and waits on `Depends on:`).
