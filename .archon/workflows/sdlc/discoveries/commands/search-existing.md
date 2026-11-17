# Find existing work

Read only. Never create, edit, close, comment on, or label tickets or pull requests.
Keep the checkout unchanged. Store any temporary query results or helper files
under $ARTIFACTS_DIR/discoveries/, using absolute paths, never in the checkout.
Read $ARTIFACTS_DIR/discoveries/normalized.json, discoveries/context.json,
and evidence-check.json under the same artifact root.

Board read: $tracker-read.output.checked

The work items are Jira tickets, all of them in `$ARTIFACTS_DIR/tracker/board-all.md`:
every ticket of the project in every status (Live and Canceled included), each with its
`URL:`, its comments and where it came from (`Herkunft: eigen (<marker>)` for a ticket
this pack filed). You hold no Jira token: never call Jira yourself (no curl, no acli).
If the board read above is `false`, the board is missing: return
tracker_checked: false and matches: [] for each item.

Otherwise, for every item not disproved:

1. Look for the item's marker on the board (`Herkunft: eigen (<marker>)`): that ticket
   carries this very finding.
2. Read the tickets for the same or a closely related problem. Judge the underlying
   problem, not shared words.
3. If context.forge.available is true, read the pull requests too, open and closed:
   `gh pr list --repo <context.forge.host>/<context.forge.path> --state all --limit 200 --json number,url,title,body`.
   Write the output to a file under $ARTIFACTS_DIR/discoveries/ and read it from there.

Only include matches you judge to cover the same or closely related work. If a read is
incomplete or fails, say tracker_checked: false and return no matches; an incomplete
search is not evidence of new work.

Return an object with entries, exactly one per item_index:
- tracker_checked: whether you completed the reads above
- matches: key, url, title, and similarity_note for each relevant item. For a ticket,
  key is its key (`CONC-5`) and url the `URL:` the board shows for it; for a pull
  request, key is empty and url is the pull request's URL.

Disproved items may use tracker_checked: false and matches: [].
