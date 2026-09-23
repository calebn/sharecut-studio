---
name: codex-issue-pipeline
description: >-
  Run the Sharecut Studio GitHub issue pipeline from Codex: triage, implement,
  review, address feedback, and verify a PR for merge. Use when the user asks
  Codex to run the issue pipeline or work an issue end to end.
---

# Codex issue pipeline

This is the Codex entry point for the same quality bar as the Claude Code
`issue-pipeline` workflow. It is a procedure, not a JavaScript runtime. Read
`AGENTS.md`, `.agents/rules/issue-claims.md`, and `docs/contributing.md`
before changing the repo. The issue-claims rule is the shared protocol for
Codex, Claude Code, and people. Keep the user's requested issue set and
authorization in view throughout the run.

## Modes and authorization

- **Dry run:** read-only triage. Report eligible issues, ranking, exclusions,
  live and stale claims, resumable `pipeline:stalled` PRs, and the proposed
  next issue. Do not release stale claims, claim issues, or create branches/PRs.
- **Build:** when asked to run on an issue, plan, implement, review, address
  feedback, and open a PR. A `noMerge` request uses this mode and reports the
  gate verdict without merging. This mode may post the plan, PR, review
  findings, replies, labels, and follow-up issues needed for the requested run.
- **Merge:** only when the user expressly asks Codex to merge or to run the
  pipeline through merge. The Claude Code workflow's standing merge exception
  does not transfer to this skill. Merge with `--rebase` only after the gate
  below passes on the current head.

If the user gives no issue number, triage first. Default eligibility follows
the Claude workflow: open issues by `calebn`, excluding `epic`,
`needs-user-input`, `deferred-v1`, `do-not-merge`, `wontfix`, and `duplicate`.
`in-progress` is **not** a static skip: inspect claim comments and the label
age using `.agents/rules/issue-claims.md`. Skip a live claim or an open
linked PR. A claim is stale after six hours without a heartbeat and no open
PR; a bare `in-progress` label is live for six hours after it was added.
Report stale claims in a dry run; release them with the rule's comment and
label updates only in a build run. Rank from issue text before reading code;
prefer an actionable, unblocked S/M issue. Explicit issue numbers still
require an author and claim check. Do not quietly expand the requested issue
set. Ask for a product decision only when the issue is genuinely blocked.

Also list open `pipeline:stalled` PRs by the allowed authors. Exclude any PR
with `needs-user-input` or `do-not-merge`. A backlog run resumes eligible
stalled PRs alongside new issues unless the user says `noResume`; an
explicit-issue run considers only that issue's stalled PR. Never start a
second PR for an issue with an open linked PR. A dry run lists resumable PRs
but changes none of them.

## Shared claim protocol

Before planning a selected issue, re-read its labels and comments and check
for an open linked PR. Follow `.agents/rules/issue-claims.md` to add
`in-progress` and `pipeline:planning`, post the two-line `pipeline-claim`
comment with a unique token and UTC heartbeat, and re-read comments. The
earliest **live** claim wins (created time, then comment ID). If another
claim wins, mark only your comment `released=lost-race`, leave its labels
alone, and stop this issue. Keep your token and comment ID in the run notes.

Move the issue label through `pipeline:implementing`, `pipeline:review`, and
`pipeline:merging`, mirror the current stage on the PR once it exists, and
refresh the claim comment's heartbeat at every transition and during a long
stage before six hours elapse. On merge, hold, abort, or failure, update your
comment to `released=<outcome>` and remove the issue/PR stage labels and
`in-progress` only if no other live claim owns them. At the end of the run,
check for any of your claims left by an interrupted issue and release them.
For `noMerge`, release the claim with a clear outcome after reporting the
gate; the open linked PR continues to keep the issue out of triage. Never
remove another claimant's labels.

## Stop and resume

- **Owner decision:** use `needs-user-input` only for a won't-do sign-off, a
  planner abort requiring a product choice, or an existing owner hold label.
  Release the claim and post a short **Automation hold — decision needed**
  comment with `Question:`, context, and how the owner can unblock it. Never
  merge while the hold label remains.
- **Technical stall:** for CI timeout or malformed data, an unavailable tool
  or merge permission, crashed work, or a failure to post/verify review
  feedback, release the claim and label the PR `pipeline:stalled`. Post a
  comment starting `<!-- pipeline-stalled resume=gate -->` when review and
  feedback finished, or `<!-- pipeline-stalled resume=review -->` otherwise.
  Head it **Automation stall — no decision needed**; state what failed and
  where the next run resumes. An issue with no PR gets a short stall comment
  but no `pipeline:stalled` PR label. Do not add `needs-user-input` for a
  technical stall.

To resume, re-read the PR, issue, labels, latest stall comment, review
threads, feedback, and current head. Re-claim the issue using the race check
before modifying the PR. Clear `pipeline:stalled` as the stage label moves.
Resume at the gate only when the latest stall marker says `resume=gate`
**and** posted review/feedback evidence covers the current head. If evidence
is incomplete or the head changed, resume at review and cover all eight
concerns before any merge. A `resume=review` marker always restarts review.
Technical stalls are bounded: report a repeated failure and the next safe
action; do not loop indefinitely.

## Work one issue

1. Fetch the latest `main`. Work in a feature branch or isolated worktree;
   preserve unrelated local files. In a new worktree run
   `make worktree-setup` before committing; the pre-commit hook also
   provisions it if needed. Read the issue's labels and comments, then claim
   it as above before researching code or planning. Inspect only the relevant
   code, callers, tests, and AGENTS.md rows, then post a concrete plan.
2. Move to `pipeline:implementing`. Implement through the domain, service,
   and adapter layers described in `docs/architecture.md`. Add tests and
   update docs in the same change. Run focused tests with `--no-cov` and the
   applicable static checks from `AGENTS.md` locally. GitHub Actions runs the
   required full suite and coverage gate on the PR's latest head; run a local
   full suite only for extensive changes or a specific diagnostic need.
3. Commit focused, conventional changes on the branch and open a PR to `main`
   when the run authorizes shipping. Use `Fixes #N` and `Related #M` lines as
   appropriate. Record the PR number, branch, and exact head SHA. Move the
   issue and PR to `pipeline:review`.
4. Build one review packet from the final diff: changed code with enough
   context, callers and second-hop callers where relevant, sibling CLI/MCP/GUI
   paths, related tests, and applicable rules. Reuse it for all review passes.
   Treat the packet as a starting point, never a boundary.
5. Check all eight concerns from `pr-multi-review`: bugs, risk, wiring, reuse,
   security, concurrency/resources, performance, and algorithms/patterns.
   For reuse search the whole repo for each new helper; for security inspect
   authorization helpers and threat docs; for wiring inspect sibling adapters;
   for concurrency trace task/thread lifetimes; for patterns follow at least
   two call hops. A concern may report no finding with a reason. Browser or
   live QA is required when the changed user-facing path can be exercised.
   Post actionable findings and verify they appear on the PR.
6. Classify every review item as fix, follow-up, or won't-do. Make safe fixes,
   add tests/docs, reply to each thread, and verify replies and resolutions.
   GitHub can leave thread replies inside a `PENDING` review even when the
   author sees them in a thread query. Submit each pending review with a
   `COMMENT` event, then verify its state is `COMMENTED` and re-read the
   threads. Do not count an author-visible pending reply as posted feedback.
   File real follow-up issues for deferred work and add `Related #M` to the PR.
   A won't-do item holds the PR for owner sign-off. Repeat review only on the
   changed surface and affected adjacent code; keep the same eight-concern
   coverage. Stop after two review/feedback rounds unless a concrete defect
   needs another pass.
7. Move the issue and PR to `pipeline:merging`, then wait for required CI on
   the *latest* head. If it fails, classify the cause from logs and diff as
   PR-caused, flaky, or unrelated. Fix PR-caused failures;
   rerun confirmed flaky jobs; stall on unrelated or unresolved technical
   failures. Never infer a check result or SHA from a prose report. A moved
   head requires a fresh gate run.

Read `pr-multi-review` and `feedback` skills when using their detailed review
or response procedure. Their autonomous modes belong to the Claude workflow;
this skill follows the user's current authorization and Codex's available
tools. Use subagents only when the user expressly requests delegation or
parallel agent work. One agent can cover the eight concerns in separate,
explicit passes over the shared packet.

## Gate and closeout

Keep a count of unresolved won't-do items from feedback. Run:

```bash
.venv/bin/python scripts/codex_issue_gate.py --repo calebn/sharecut-studio --pr <N> \
  --issue <issue-N> --claim-token <token> --wont-do <count>
```

The command reads GitHub's current head, required check rows, issue/PR stage
and hold labels, target branch, closing issue reference, the oldest live claim,
merge state, and paginated review threads; it
fails closed if collection fails, the claim is lost or stale, or the head
moves. Pass `--stale-hours <hours>` only when the run deliberately uses a
non-default claim lifetime. Also verify that review findings and feedback
replies were actually posted. For `noMerge`, report the verdict, release the
claim, and stop. For an expressly authorized merge, run the gate again
immediately before:

```bash
gh pr merge <N> -R calebn/sharecut-studio --rebase --match-head-commit <sha>
```
If the PR conflicts, rebase, push with `--force-with-lease`, wait for CI, and
repeat the gate. Never bypass a hold label or unresolved thread. Release the
claim on every exit, including a held or unmerged PR. Report the PR, tests,
review findings, follow-ups, CI, gate verdict, claim outcome, stall/resume
status, and merge result.

## Cost discipline

Choose a model for the actual difficulty when stage-specific subagents are
available **and the user has requested delegation**. The current Codex task
cannot change its own model mid-run. Use Luna with low effort for bounded
read-only triage and claim/CI inventory; Sol with medium effort for ordinary
planning, implementation, feedback fixes, and review; raise Sol's effort for
cross-layer or high-risk review. Use Astra only when architecture, security,
concurrency, or conflicting findings require deeper judgment. Keep claim
ownership and the final merge verdict in the deterministic protocol and gate,
regardless of model. For a small issue, one agent may cost less than handing
off several stages. Record the models and efforts actually used; if the run
stays in one task, report that model routing was not exercised. These choices
follow [OpenAI's model-selection guidance](https://developers.openai.com/api/docs/guides/model-selection);
recheck availability and guidance when making a future run.

Read issue text before code during triage. Gather shared review context once,
then read additional files only for concerns that require them. Reuse the
packet across rounds; focus later rounds on the fix diff and its callers.
Batch independent read-only searches and keep command output bounded. Preserve
every review concern and the final gate; do
not claim a percentage saving without measuring comparable runs. A verified
gate-only resume avoids redoing review; an unverified resume repeats review
because saving tokens cannot justify an unreviewed merge.
