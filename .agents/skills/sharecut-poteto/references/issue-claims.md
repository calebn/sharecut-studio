# Issue claims

Coordinate through the GitHub issue log. Recheck labels, comments, claim liveness,
and linked PRs immediately before claiming. The `pipeline-claim` marker and
`pipeline:*` labels are shared coordination conventions, not a workflow executor.

## Choose what to pick up

Scope is [docs/beta-plan.md](../../../../docs/beta-plan.md). Labels decide
eligibility, and the plan page decides what the labels mean.

1. Pick `beta:blocker` issues first, then `beta:quality` issues ordered by
   milestone. Both belong to the Beta milestone.
2. Skip `post-beta` issues. Two exceptions apply. The owner names the issue, or
   it is D5 CI-cost work (`cause:test-time-waits`).
3. Skip an issue with no beta label. Add the label that fits from the plan, or
   ask the owner, before you start it.
4. Check the result against the bar of the issue's `journey:J#` label.
5. Then run the taken check below.

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

## File follow-ups

Read the filing rules in [docs/beta-plan.md](../../../../docs/beta-plan.md#filing-rules).

1. File only reachable harm. It reproduces on a real recording or a real UI on
   a supported shell or device with an effect a user notices, or it loses data
   or exposes security.
2. Label the issue at filing. Use `beta:blocker`, `beta:quality` or
   `post-beta`, plus `journey:J#`, plus a `cause:` label when one fits.
3. If an `epic` issue with a `cause:` label covers the class, add a checklist
   line to its Ledger section and file no issue. Synthetic-only and precision
   findings go on #1449 or the epic's Ledger.
4. When a second issue shares a root cause, stop point fixes in that class,
   report it, and let the structural fix come first.
5. Fix test-quality and doc notes in the same PR, or drop them. Never file them.
6. A regression your PR caused blocks the PR. Never file it as a follow-up.
