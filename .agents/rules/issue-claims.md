# Issue claims (coordinating agents on the GitHub issue log)

Several agents (the `issue-pipeline` workflow, Cursor/Claude sessions, people) may work the same
issues. Coordinate through GitHub only — never assume you are alone.

## Before starting work on an issue

1. Read the issue's labels and comments.
2. It is **taken** when it has a **live claim**: an `in-progress` label plus a comment starting with
   `<!-- pipeline-claim token=… stage=… heartbeat=<UTC ISO> released=no -->` whose heartbeat is less
   than **6 hours** old. `in-progress` without a claim comment counts as live for 6 hours after the
   label was added. An issue with an open linked PR is also taken.
3. If it is taken, pick something else (or ask the claim owner in a comment).

## Claiming

1. Add `in-progress` and the stage label `pipeline:planning`.
2. Post the claim comment (two lines):
   `<!-- pipeline-claim token=<unique token> stage=planning heartbeat=<UTC ISO> released=no -->`
   `🤖 Claimed by <who> \`<token>\` · stage: planning · heartbeat: <UTC ISO>`
3. Re-read the comments. Among live claims the **earliest** comment wins. If it is not yours, mark
   yours `released=lost-race` and stop — do not remove labels (they belong to the winner).

## While working

- Move the stage label as you progress (`pipeline:planning` → `pipeline:implementing` →
  `pipeline:review` → `pipeline:merging`, mirrored on the PR) and refresh the claim comment's
  heartbeat at each stage (at least every 6 hours).

## Releasing (always)

On merge, hold, abandon or failure: remove `in-progress` and every `pipeline:*` label, and set the
claim comment to `released=<outcome>`. Anyone may release a **stale** claim (heartbeat 6+ hours old,
no open PR) with a short comment saying so.

The `issue-pipeline` workflow implements this protocol; see
[docs/contributing.md § Automated issue pipeline](../../docs/contributing.md#automated-issue-pipeline).
