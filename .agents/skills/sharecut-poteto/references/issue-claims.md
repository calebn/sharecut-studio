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
5. Skip an issue that carries `needs-user-input` unless its **Owner question:**
   comment has an answer.
6. Then run the taken check below.

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
   `pipeline:review`, and `pipeline:merging`. Mirror the first three stages on
   the PR. Keep the PR at `pipeline:review` while the issue and claim reach merging. After
   the standalone predicate passes and all other handoff gates pass, move the PR
   to `pipeline:merging`. Refresh your claim comment at each stage and before its
   six-hour lease expires.

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
This applies to every agent and lane (swarm, regression, live, audit),
including Codex. Brief lanes with a pointer to this section. Target: fewer than
1.0 new issues opened per issue closed. The merge lane reports it weekly.

Triage each finding in this order. Only step 4 files an issue.

1. Fix a defect your PR introduced, or a false claim in its docs or tests, in
   the PR.
2. Fix a small in-scope note in the PR. Drop nits.
3. For a finding with no reachable harm, if an `epic` issue with a `cause:`
   label covers the class, add a checklist line to its Ledger section.
   Synthetic-only and precision findings go on #1449 or the epic's Ledger.
   Otherwise drop it. A stale-spec finding goes on the spec-deviation list.
4. File a finding with reachable harm under the rules below. One PR files at
   most one issue, a combined one when it has several such findings.

A flaky test is not reachable harm. Re-run once. A test that fails
deterministically on develop and blocks the promote counts as reachable harm.

Filing rules:

1. File only reachable harm. It reproduces on a real recording or a real UI on
   a supported shell or device with an effect a user notices, or it loses data
   or exposes security.
2. Label the issue at filing. Use `beta:blocker`, `beta:quality` or
   `post-beta`, plus `journey:J#`, plus a `cause:` label when one fits.
3. If an `epic` issue with a `cause:` label covers the class, add a checklist
   line to its Ledger section and file no issue.
4. When a second issue shares a root cause, stop point fixes in that class,
   report it, and let the structural fix come first.
5. Fix test-quality and doc notes in the same PR, or drop them. Never file them.
6. A regression your PR caused blocks the PR. Never file it as a follow-up.

## Close issues

Closing keywords such as `Fixes #N` close an issue only when the commit reaches
`main`. Lanes merge to `develop`, so nothing closes the issue at merge unless
you do. This applies to every agent and lane, including Codex.

1. When your PR merges to `develop`, close each issue it fixes, with a comment
   that links the PR. Close first, then release the claim. If a check is still
   owed, such as an owner listening or device check, leave the issue open, add
   `needs-user-input` and post the **Owner question:** comment.
2. When a PR that changes a screen or stage merges, search the open issues with
   that `journey:J#` label and the screen or stage name. Close each one the PR
   fixed or made moot, with a comment that links the PR and says which. Moot
   means the control or screen the issue describes was removed or replaced, so
   its steps can no longer be followed. A defect that may survive in the
   replacement is not moot. When unsure, leave it open. A follow-up list with
   items left stays open. Note the done items in a comment.
3. Filing an issue creates a close you owe. File reachable harm at once under
   [File follow-ups](#file-follow-ups). Then, the same day, close one existing
   open issue by fixing it or by step 2. A verification lane with no PR of its
   own hands the owed close to the lane that owns the PR it verified, in its
   report. A close counts only when it meets step 4.
4. Close an issue only with evidence: the merged PR and the test or proof that
   shows the behaviour, or the removed control or screen. Never close a
   `needs-user-input` issue or an issue with another agent's live claim.
5. Whoever reverts a fix on `develop` reopens the issues that fix closed, in
   the same step, with a comment that links the revert.

## Ask the owner

Never wait on the owner and never message them. When work needs a product
call, listening, device feel, or a decision that proved harmful:

1. Add `needs-user-input` to the issue or PR.
2. Post one comment that starts with `**Owner question:**`. Include the
   question, the options, your recommendation, the default if nobody answers,
   and the evidence.
3. Keep the PR unmerged if the answer could change it. Otherwise proceed on the
   default and say so in the comment.
4. Move to other beta work.

The next coordinator or agent pass removes the label once the owner answers,
applies the answer, and records it.
