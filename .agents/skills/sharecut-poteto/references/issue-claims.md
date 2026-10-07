# Issue claims

Coordinate through the GitHub issue log. Recheck labels, comments, claim liveness,
and linked PRs immediately before claiming. The `pipeline-claim` marker and
`pipeline:*` labels are shared coordination conventions, not a workflow executor.

## Check whether an issue is taken

An issue is taken when it has an open linked PR or a live claim.
A live claim has `in-progress` plus a comment that starts with:

```text
<!-- pipeline-claim token=<unique token> stage=<stage> heartbeat=<UTC ISO> released=no -->
```

The heartbeat must be less than six hours old. `in-progress` without a claim
comment counts as live for six hours after the label was added.
Skip taken issues. Do not assume another agent's stale heartbeat frees an issue
with an open PR.

For an existing PR that the user's current grant authorizes you to resume,
exempt only that PR from the open-PR guard. Recheck the issue, PR, holds, and
competing live claims. A different active linked PR still blocks pickup.
Use the same claim race protocol before modifying or gating the resumed PR.
Native Poteto owns the pickup procedure and review-evidence assessment.

## Claim and maintain ownership

1. Add `in-progress` and `pipeline:planning`.
2. Post a claim comment with a unique token and current UTC heartbeat:

   ```text
   <!-- pipeline-claim token=<token> stage=planning heartbeat=<UTC ISO> released=no -->
   Claimed by <owner> <token>. Stage planning. Heartbeat <UTC ISO>.
   ```

3. Re-read the issue comments. The earliest live claim comment wins.
   If another claim wins, mark yours `released=lost-race` and stop.
   Do not remove the winner's labels.
4. Move your active stage through `pipeline:planning`, `pipeline:implementing`,
   `pipeline:review`, and `pipeline:merging`. Mirror the stage on the PR.
   Refresh your claim comment at each stage and before its six-hour lease expires.

## Release on every exit

On merge, completion, hold, abandon, or failure, mark your comment
`released=<outcome>`. Remove your `in-progress` and active stage labels only
while you still own the winning claim. Remove every `pipeline:*` label from
the claimed issue and the active stage label from its PR. Preserve another
owner's labels and independent owner holds.

For an owner decision, report the question and retain the applicable owner hold.
For a technical failure, report the blocker and retain `pipeline:stalled` on
the PR where appropriate. Clear that PR stall label when an authorized pickup
reclaims the issue and moves its stage. Release the claim even while a hold remains.
Native Poteto owns any later pickup procedure. An open linked PR remains taken.

Anyone may release a stale claim whose heartbeat is at least six hours old and
which has no open linked PR. Recheck those facts first. Leave a short release
comment and preserve any other live owner's labels.
