# Discoveries

Revalidate findings, search related work among the Jira tickets (and pull requests),
and prepare proposals. Use
`discovery_artifact` with an explicit discoveries JSON file produced by review or
implementation. This path works on existing Archon and needs no new engine API.
Optional `run_id` lookup requires a CLI exposing `artifacts_dir`; it is not a
requirement of this workflow. Prefer an explicit artifact when using the base engine.

The first node (`tracker-read`) needs `.archon/tracker.json` and refuses the run
without it, before any agent. It writes every ticket to `tracker/board-all.md` for the
search; when Jira does not answer, the run goes on with `checked: false`, the proposals
stay local ("Publication unavailable: nicht geprüft") and nothing is published.

`publication=preview` is read-only (default). `publication=approve` uses a native
approval node. `publication=auto` explicitly authorizes this run's publication,
subject to project guidance. Publication is a script (`publish-discoveries.ts`), not
an agent: an actionable new finding becomes a ticket with its marker `disc-…` as a
remote link (a rerun finds it instead of filing it again) and a `Related:` line for
the work found beside it; new evidence for a ticket that is still open becomes one
comment there, its text and labels untouched. Every ticket a proposal names must be
on the board, and the checkout must still be at the revalidated revision.

The return remains the proposal counts for existing consumers. Publication URLs
and partial failures are recorded by the publish node and discovery-publication.md.
The proposal document itself is evidence, never an authorization receipt.

The evidence checks and classification fixtures cover proposal creation;
`publish-auto` covers the auto path to the publish node, and
`discoveries-publish.test.ts` what the script writes in Jira.
