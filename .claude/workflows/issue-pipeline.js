export const meta = {
  name: 'issue-pipeline',
  description: 'Triage open issues, then per issue: plan, implement, PR, multi-review, feedback, green CI, merge',
  whenToUse: 'Autonomously work the GitHub issue backlog end-to-end. Pre-approved to merge when the gate passes. Docs: docs/contributing.md § Automated issue pipeline.',
  phases: [
    { title: 'Triage', detail: 'list + score open issues, pick lanes', model: 'haiku' },
    { title: 'Plan', detail: 'research issue, write implementation plan', model: 'opus' },
    { title: 'Implement', detail: 'follow plan, open PR', model: 'sonnet' },
    { title: 'CI', detail: 'wait once, at the gate, for required checks on the final head SHA', model: 'haiku' },
    { title: 'Review', detail: 'pr-multi-review AUTONOMOUS MODE + post verification', model: 'opus' },
    { title: 'Feedback', detail: 'feedback AUTONOMOUS MODE plan (opus) + execute (sonnet)' },
    { title: 'Merge', detail: 'gate facts, rebase on conflict, squash-merge', model: 'haiku' },
  ],
}

// ---------------------------------------------------------------------------
// Config (override via Workflow args)
// ---------------------------------------------------------------------------
const A = args || {}
const REPO = A.repo || 'calebn/sharecut-studio'
// Only issues opened by these GitHub users are eligible (applies to explicit `issues` too).
const AUTHORS = A.authors || ['calebn']
const LANES = A.lanes ?? 4
const MAX_ROUNDS = A.maxRounds ?? 2
const CI_FIX_ATTEMPTS = A.ciFixAttempts ?? 1
const GATE_ATTEMPTS = A.gateAttempts ?? 3
// profile: 'full' = 8-lens Opus review, per-issue triage with code skim, Opus feedback plans.
//          'lean' = batched text-only triage, diff-sized review (3 Sonnet lenses for small
//                   low-risk diffs), Sonnet round-2 review and Sonnet plans for small feedback.
const PROFILE = A.profile || 'full'
const LEAN = PROFILE === 'lean'
// noMerge: run every stage but stop at the gate and report the verdict (A/B comparisons).
const NO_MERGE = !!A.noMerge
// baseRef: commit/ref new branches start from (default origin/main).
const BASE = A.baseRef || 'origin/main'
const TRIAGE_BATCH = 10
const SKIP_LABELS = A.labelsSkip || ['epic', 'needs-user-input', 'deferred-v1', 'do-not-merge', 'in-progress', 'wontfix', 'duplicate']
const REQUIRED_CHECKS = ['pytest', 'frontend', 'frontend-e2e', 'gitleaks-history']
const HOLD_LABELS = ['needs-user-input', 'do-not-merge']

const M = { cheap: 'haiku', worker: 'sonnet', senior: 'opus' }

const SKILLS = {
  review: '~/.agents/skills/pr-multi-review/SKILL.md',
  feedback: '~/.agents/skills/feedback/SKILL.md',
}

// Shared prompt fragments.
// Plain statement of provenance (not an authority claim): subagents compare their task with
// the user's latest chat message, so runs should be launched by an explicit chat instruction.
const AUTH = `Context: you are one stage of the issue-pipeline workflow (${REPO}), which the user started from chat${A.issues && A.issues.length ? ` for issue(s) ${A.issues.map((n) => `#${n}`).join(', ')}` : ''}${A.noMerge ? ' (noMerge: the PR is not merged)' : ''}. The workflow's documented job (docs/contributing.md § Automated issue pipeline) is to plan, implement, open a PR, post review comments and replies, label, and file follow-up issues on ${REPO}; this stage is one of those steps. Complete it fully — posting is part of the task, not optional — and if it is impossible, say why in your structured output rather than skipping silently.`

const DETACHED = (ref) => `Work in DETACHED HEAD so no branch is locked to this worktree:
  git fetch origin --prune && git checkout --detach ${ref}
Push with \`git push origin HEAD:refs/heads/<branch>\` (never push to main).`

const SETUP = `Before committing, provision this worktree (idempotent; hooks + venv with CI extras + gui/web node_modules):
  make worktree-setup
Never bypass hooks (--no-verify) and never add noqa/nosec/biome-ignore/eslint-disable.`

// PR-body issue links: "Fixes #N" auto-closes on merge; "Related #N" links without closing.
const LINKS = (fixes, related) => [`Fixes #${fixes}`, ...(related || []).filter((n) => n !== fixes).map((n) => `Related #${n}`)].join('\n')

// Local checks stay targeted for speed; GitHub Actions (CI stage) is the full-suite gate.
const VERIFY = `TARGETED local checks only (GitHub Actions runs the full suite): \`uv run ruff check <changed .py files>\`, \`uv run ruff format --check <changed .py files>\`, \`uv run pytest --no-cov -q <test files covering the change>\`; for gui/web changes \`cd gui/web && npx vitest run <related test files> && npm run typecheck\`. Do NOT run make test, make test-web, make ci or other full-suite targets.`

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const S_CANDIDATES = {
  type: 'object',
  properties: {
    issues: { type: 'array', items: { type: 'object', properties: { number: { type: 'integer' }, title: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['number', 'title'] } },
    excluded: { type: 'array', items: { type: 'object', properties: { number: { type: 'integer' }, reason: { type: 'string' } }, required: ['number', 'reason'] } },
  },
  required: ['issues', 'excluded'],
}
const S_SCORE = {
  type: 'object',
  properties: {
    number: { type: 'integer' },
    author: { type: 'string', description: 'login of the user who opened the issue' },
    actionable: { type: 'boolean' },
    size: { enum: ['S', 'M', 'L'] },
    priority: { type: 'integer', minimum: 1, maximum: 5, description: '5 = most urgent (security/data-loss bugs), 1 = nice-to-have' },
    area: { type: 'string', description: 'primary code area, e.g. gui/web, services/share, recording, pipeline, docs' },
    blockers: { type: 'string', description: 'empty string when none' },
    reason: { type: 'string' },
  },
  required: ['number', 'author', 'actionable', 'size', 'priority', 'area', 'reason'],
}
const S_PLAN = {
  type: 'object',
  properties: {
    abort: { type: 'boolean' },
    abort_reason: { type: 'string' },
    branch: { type: 'string', description: 'type/short-kebab per AGENTS.md' },
    plan_md: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'string' } },
    docs: { type: 'array', items: { type: 'string' } },
    verify_cmds: { type: 'array', items: { type: 'string' } },
    related_issues: { type: 'array', items: { type: 'integer' }, description: 'other issue numbers this work touches but does not close' },
    plan_comment_url: { type: 'string' },
  },
  required: ['abort', 'branch', 'plan_md', 'verify_cmds'],
}
const S_PR = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    pr: { type: 'integer' },
    branch: { type: 'string' },
    head_sha: { type: 'string' },
  },
  required: ['ok'],
}
const S_CI = {
  type: 'object',
  properties: {
    state: { enum: ['pass', 'fail', 'timeout'] },
    head_sha: { type: 'string' },
    failing: { type: 'array', items: { type: 'string' } },
  },
  required: ['state', 'head_sha'],
}
const S_CI_FIX = {
  type: 'object',
  properties: {
    cause: { enum: ['pr', 'flaky', 'unrelated'], description: 'pr = caused by this PR diff (fixed and pushed); flaky = nondeterministic, failed jobs re-run; unrelated = broken on main / infra (nothing pushed)' },
    ok: { type: 'boolean', description: 'cause=pr: fix pushed; cause=flaky: rerun queued' },
    head_sha: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['cause', 'ok', 'summary'],
}
const S_PUSH = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, head_sha: { type: 'string' }, summary: { type: 'string' } },
  required: ['ok', 'head_sha'],
}
const FINDING = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    severity: { enum: ['high', 'medium', 'low'] },
    path: { type: 'string' },
    line: { type: 'integer' },
    body: { type: 'string', description: 'exact Conventional Comment text posted' },
    surface: { enum: ['inline', 'top-level'] },
    comment_url: { type: 'string', description: 'URL of the posted GitHub comment; empty only if posting failed' },
  },
  required: ['id', 'severity', 'body', 'surface', 'comment_url'],
}
const S_REVIEW = {
  type: 'object',
  properties: {
    reviewed_sha: { type: 'string' },
    review_id: { type: 'string' },
    findings: { type: 'array', items: FINDING },
    env_blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['reviewed_sha', 'findings'],
}
const S_POST_VERIFY = {
  type: 'object',
  properties: {
    expected: { type: 'integer' },
    found_before: { type: 'integer' },
    posted_now: { type: 'integer' },
    missing_after: { type: 'integer' },
    missing_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['expected', 'missing_after'],
}
const FB_ITEM = {
  type: 'object',
  properties: {
    kind: { enum: ['thread', 'comment'] },
    id: { type: 'string', description: 'review thread node id, or issue comment URL' },
    location: { type: 'string' },
    summary: { type: 'string' },
    action: { enum: ['implement', 'follow_up', 'wont_do'] },
    rationale: { type: 'string' },
    steps: { type: 'string', description: 'implement: exact step-level instructions (files, symbols, tests)' },
    followup_title: { type: 'string' },
    followup_body: { type: 'string' },
  },
  required: ['kind', 'id', 'action', 'rationale'],
}
const S_FB_PLAN = {
  type: 'object',
  properties: { items: { type: 'array', items: FB_ITEM } },
  required: ['items'],
}
const S_FB_EXEC = {
  type: 'object',
  properties: {
    head_sha: { type: 'string' },
    shas: { type: 'array', items: { type: 'string' } },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { enum: ['implement', 'follow_up', 'wont_do'] },
          reply_body: { type: 'string' },
          reply_url: { type: 'string' },
          resolved: { type: 'boolean' },
          followup_issue: { type: 'integer' },
        },
        required: ['id', 'action', 'reply_body'],
      },
    },
    wont_do_count: { type: 'integer' },
  },
  required: ['head_sha', 'items', 'wont_do_count'],
}
const S_REPLY_VERIFY = {
  type: 'object',
  properties: { expected: { type: 'integer' }, fixed_now: { type: 'integer' }, missing_after: { type: 'integer' } },
  required: ['expected', 'missing_after'],
}
const S_GATE = {
  type: 'object',
  properties: {
    state: { enum: ['OPEN', 'CLOSED', 'MERGED'] },
    head_sha: { type: 'string' },
    merge_state_status: { type: 'string', description: 'mergeStateStatus verbatim, e.g. CLEAN, BEHIND, DIRTY, BLOCKED, UNSTABLE' },
    checks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, conclusion: { type: 'string' }, sha: { type: 'string' } }, required: ['name', 'conclusion'] } },
    unresolved_threads: { type: 'integer' },
    labels: { type: 'array', items: { type: 'string' } },
  },
  required: ['state', 'head_sha', 'merge_state_status', 'checks', 'unresolved_threads', 'labels'],
}
const S_DONE = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
  required: ['ok'],
}

// ---------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------
const tag = (issue) => `#${issue.number}`

function waitCi(issue, pr, expectSha) {
  return agent(
    `Wait for GitHub required checks on ${REPO} PR #${pr}. Read-only; change nothing.
Expected head SHA: ${expectSha || '(read it with gh pr view)'}.
1. Confirm \`gh pr view ${pr} -R ${REPO} --json headRefOid -q .headRefOid\` matches the expected SHA (if a newer SHA exists, use the newer one and report it).
2. Loop \`gh pr checks ${pr} -R ${REPO} --required --watch --interval 30\` with a Bash timeout of 590000 ms. If checks are not registered yet, retry. Give up after ~60 minutes total → state "timeout".
3. Only count check runs on the PR head SHA. Required checks: ${REQUIRED_CHECKS.join(', ')}.
Return state pass (all required succeeded), fail (any failed/cancelled; list names in failing), or timeout, plus head_sha.`,
    { label: `ci:${tag(issue)}`, phase: 'CI', model: M.cheap, effort: 'low', schema: S_CI },
  )
}

function fixCi(issue, pr, branch, ci) {
  return agent(
    `${AUTH}
CI failed on ${REPO} PR #${pr} (branch ${branch}, head ${ci.head_sha}). Failing required checks: ${(ci.failing || []).join(', ')}.
${DETACHED(`origin/${branch}`)}
${SETUP}
Read logs: \`gh run list -R ${REPO} --branch ${branch} --limit 10\` then \`gh run view <id> -R ${REPO} --log-failed\`. Compare with the PR diff (\`git diff origin/main...HEAD\`) and recent main runs (\`gh run list -R ${REPO} --branch main --limit 5\`).
First classify the cause:
- pr: this diff causes it → fix the root cause (never skip/xfail tests, never lower coverage below 95%), verify with the failing tests plus ${VERIFY} commit (conventional message), push to ${branch}, return ok=true and the new head SHA.
- flaky: nondeterministic and the failing code is untouched by this PR → do not change code; \`gh run rerun <id> -R ${REPO} --failed\` for each failed run on the head; return ok=true.
- unrelated: main itself is broken or infrastructure failed → change nothing; return ok=false with a summary.`,
    { label: `ci-fix:${tag(issue)}`, phase: 'CI', model: M.worker, isolation: 'worktree', schema: S_CI_FIX },
  )
}

// Wait for green with bounded fix attempts. Returns {ok, head_sha, reason}.
async function ensureGreen(issue, pr, branch, sha) {
  let ci = await waitCi(issue, pr, sha)
  let note = ''
  for (let i = 0; ci && ci.state === 'fail' && i < CI_FIX_ATTEMPTS; i++) {
    const fix = await fixCi(issue, pr, branch, ci)
    if (!fix || !fix.ok) { note = fix ? `CI ${fix.cause}: ${fix.summary}` : ''; break }
    if (fix.cause === 'flaky') log(`${tag(issue)} CI flaky (${fix.summary}); re-ran failed jobs`)
    ci = await waitCi(issue, pr, fix.cause === 'pr' ? fix.head_sha : ci.head_sha)
  }
  if (!ci) return { ok: false, head_sha: sha, reason: 'CI watcher died' }
  if (note && ci.state !== 'pass') return { ok: false, head_sha: ci.head_sha, reason: note }
  const ok = ci.state === 'pass'
  return { ok, head_sha: ci.head_sha, reason: ok ? '' : `CI ${ci.state}: ${(ci.failing || []).join(', ')}` }
}

function hold(issue, pr, reason) {
  log(`${tag(issue)} HOLD: ${reason}`)
  return agent(
    `${AUTH}
The automated issue pipeline is HOLDING ${pr ? `PR #${pr}` : `issue #${issue.number}`} on ${REPO} for a human decision.
Reason: ${reason}
1. ${pr ? `\`gh pr edit ${pr} -R ${REPO} --add-label needs-user-input\`` : `\`gh issue edit ${issue.number} -R ${REPO} --add-label needs-user-input --remove-label in-progress\``}
2. Post one comment on the ${pr ? 'PR' : 'issue'} headed "Automation hold" that states the reason and exactly what the owner needs to decide or do. Keep it short.
Return ok=true once both are done.`,
    { label: `hold:${tag(issue)}`, phase: 'Merge', model: M.cheap, effort: 'low', schema: S_DONE },
  ).then(() => ({ issue: issue.number, pr, merged: false, held: true, reason }))
}

function review(issue, pr, round, since) {
  return agent(
    `${AUTH}
AUTONOMOUS MODE: round=${round}${since ? `, since=${since}` : ''}
Read ${SKILLS.review} (and the checklists it references) and execute it for ${REPO} PR #${pr}, following its "AUTONOMOUS MODE (pipeline)" section, which overrides every other gate in that file.
POSTING IS MANDATORY. Every unrebutted High/Medium/Low finding must be posted to the PR before you return: inline threads (one COMMENT review) where a RIGHT-side line attaches, otherwise one top-level \`gh pr comment\` per finding. Never APPROVE or REQUEST_CHANGES. An unposted finding is a pipeline failure.
${round > 1 ? `Round ${round}: review ONLY \`git diff ${since}..<PR head>\` (the feedback fixes). Do not re-raise resolved threads.` : ''}
${LEAN ? `REVIEW PROFILE: lean. ${round > 1 ? 'Round 2+: review the fix diff yourself in a single pass (no subagents).' : 'Size the review to the diff: if `git diff origin/main...HEAD --stat` is <= 150 changed lines AND no path touches auth, share tokens, uploads/recording landing, relay or remote MCP, run only 3 lenses — Bugbot/risk, reuse/SOLID + test gaps, patterns — as subagents with model "sonnet". Otherwise run the full set of lenses. You (the parent) still merge, dedupe and post.'}` : ''}
Return every finding with the URL of its posted comment, the SHA you reviewed, and any environment blockers (those are NOT posted).`,
    { label: `review:${tag(issue)}:r${round}`, phase: 'Review', model: LEAN && round > 1 ? M.worker : M.senior, effort: 'high', isolation: 'worktree', schema: S_REVIEW },
  )
}

function verifyPosted(issue, pr, rev) {
  return agent(
    `${AUTH}
Verify that every review finding below was posted to ${REPO} PR #${pr}, and post any that are missing. You are the safety net: posting missing ones is REQUIRED.
Findings (JSON): ${JSON.stringify(rev.findings)}
1. Fetch review threads (GraphQL reviewThreads: path, line, comments.body, comments.url; paginate) and issue comments (\`gh api repos/${REPO}/issues/${pr}/comments --paginate\`).
2. A finding counts as posted if its comment_url is a comment on this PR, or an inline thread / top-level comment contains its body text (whitespace-insensitive).
3. For each missing finding: post it inline via \`gh api repos/${REPO}/pulls/${pr}/reviews --method POST\` (event COMMENT, commit_id = PR head SHA, side RIGHT); on HTTP 422 post it as a top-level \`gh pr comment ${pr} -R ${REPO}\` instead.
4. Re-fetch and recount.
Return expected, found_before, posted_now, missing_after, missing_ids.`,
    { label: `post-verify:${tag(issue)}`, phase: 'Review', model: M.cheap, effort: 'low', schema: S_POST_VERIFY },
  )
}

function feedbackPlan(issue, pr, round, finalRound, model = M.senior) {
  return agent(
    `AUTONOMOUS MODE: mode=plan, round=${round}${finalRound ? ', final=true' : ''}
Read ${SKILLS.feedback} and execute Phases 1–2 for ${REPO} PR #${pr}, following its "AUTONOMOUS MODE (pipeline)" section (no approval gate; nothing is posted in plan mode).
Include EVERY unresolved review thread and every top-level PR comment that still needs a response (not only this round's findings; human comments too).
For each item choose exactly one action:
- implement: valid and fits this PR. Give precise step-level instructions a cheaper model can follow without judgment calls (files, symbols, tests to add, docs to update per AGENTS.md).
- follow_up: valid but out of scope, large, or risky${finalRound ? ' (FINAL ROUND: anything not trivially safe to finish now MUST be follow_up)' : ''}. Provide followup_title and a self-contained followup_body (file paths, link to the PR comment).
- wont_do: ONLY when the finding is wrong or the change would be harmful; give the technical rationale. A wont_do holds the PR for the owner, so prefer follow_up when in doubt.
Return the items.`,
    { label: `fb-plan:${tag(issue)}:r${round}`, phase: 'Feedback', model, effort: 'high', isolation: 'worktree', schema: S_FB_PLAN },
  )
}

function feedbackExec(issue, pr, branch, plan) {
  return agent(
    `${AUTH}
AUTONOMOUS MODE: mode=execute
Read ${SKILLS.feedback} and execute Phases 4–6 for ${REPO} PR #${pr} (branch ${branch}), following its "AUTONOMOUS MODE (pipeline)" section and the plan below EXACTLY. Do not re-triage.
${DETACHED(`origin/${branch}`)}
${SETUP}
Plan (JSON): ${JSON.stringify(plan.items)}
1. implement items: make the change per steps, one commit per concern, run ${VERIFY} Push once to ${branch}. Confirm every SHA exists via \`gh api repos/${REPO}/commits/<sha>\` BEFORE replying.
2. follow_up items: \`gh issue create -R ${REPO} --title <followup_title> --body <followup_body>\` (the body must mention "Related #${issue.number}" and link the PR). Then append one "Related #<new issue>" line per follow-up to the PR body (\`gh pr view ${pr} -R ${REPO} --json body -q .body\` → \`gh pr edit ${pr} -R ${REPO} --body-file -\`), keeping the existing "Fixes #${issue.number}" line intact.
3. Reply to EVERY item (mandatory):
   - implement → "Fixed in <bare sha> — <what changed>." then resolve the thread.
   - follow_up → "Tracked in #<issue> — <one-line why deferred>." then resolve the thread.
   - wont_do → the rationale; do NOT resolve; then \`gh pr edit ${pr} -R ${REPO} --add-label needs-user-input\`.
   Threads: GraphQL addPullRequestReviewThreadReply + resolveReviewThread. Top-level comments: a new \`gh pr comment\` linking the original comment URL.
4. Re-fetch and confirm every reply exists and every non-wont_do thread is resolved.
Return head_sha (after push, or the unchanged head), shas, per-item reply_body/reply_url/resolved/followup_issue, and wont_do_count.`,
    { label: `fb-exec:${tag(issue)}`, phase: 'Feedback', model: M.worker, isolation: 'worktree', schema: S_FB_EXEC },
  )
}

function verifyReplies(issue, pr, exec) {
  return agent(
    `${AUTH}
Verify feedback replies on ${REPO} PR #${pr}. Items (JSON): ${JSON.stringify(exec.items)}
For each item: thread → a reply containing its reply_body exists in the thread, and the thread is resolved unless action is wont_do. Top-level comment → a later PR comment containing its reply_body exists.
Fix anything missing: post the reply_body (GraphQL addPullRequestReviewThreadReply, or \`gh pr comment\`) and resolve non-wont_do threads (resolveReviewThread). Re-fetch and recount.
Return expected, fixed_now, missing_after.`,
    { label: `reply-verify:${tag(issue)}`, phase: 'Feedback', model: M.cheap, effort: 'low', schema: S_REPLY_VERIFY },
  )
}

function gateFacts(issue, pr) {
  return agent(
    `Collect merge-gate facts for ${REPO} PR #${pr}. Read-only; change nothing.
Use \`gh pr view ${pr} -R ${REPO} --json state,headRefOid,mergeStateStatus,labels,statusCheckRollup\` and GraphQL pullRequest.reviewThreads(first:100){nodes{isResolved}} (paginate).
Return state, head_sha, merge_state_status (verbatim), checks (name, conclusion, and the commit SHA it ran on when available, for every check run), unresolved_threads (count), labels (names).`,
    { label: `gate:${tag(issue)}`, phase: 'Merge', model: M.cheap, effort: 'low', schema: S_GATE },
  )
}

function rebase(issue, pr, branch) {
  return agent(
    `${AUTH}
${REPO} PR #${pr} (branch ${branch}) conflicts with main because another PR merged.
${DETACHED(`origin/${branch}`)}
${SETUP}
\`git rebase origin/main\`, resolving conflicts by preserving both intents; run ${VERIFY} Then \`git push --force-with-lease=refs/heads/${branch}:origin/${branch} origin HEAD:refs/heads/${branch}\`. Return ok and the new head SHA. If conflicts cannot be resolved safely, \`git rebase --abort\` and return ok=false with a summary.`,
    { label: `rebase:${tag(issue)}`, phase: 'Merge', model: M.worker, isolation: 'worktree', schema: S_PUSH },
  )
}

function merge(issue, pr, sha, evidence) {
  return agent(
    `${AUTH}
This PR has completed the pipeline's review gate. Evidence (verify it before merging):
${evidence}
1. Show the review record: \`gh pr view ${pr} -R ${REPO} --json reviews,comments,statusCheckRollup,headRefOid\` and confirm the head is ${sha}, every required check succeeded, and there are no unresolved review threads (GraphQL reviewThreads isResolved). If anything disagrees with the evidence, do NOT merge; return ok=false with the discrepancy.
2. Merge: \`gh pr merge ${pr} -R ${REPO} --squash --delete-branch --match-head-commit ${sha}\` (ignore local-branch cleanup errors). Confirm \`gh pr view ${pr} -R ${REPO} --json state -q .state\` is MERGED, then \`gh issue edit ${issue.number} -R ${REPO} --remove-label in-progress\`. Return ok=true only if merged; otherwise ok=false with the error in detail. If the merge command is denied by a tool-permission check, return ok=false with detail starting "merge permission denied:".`,
    { label: `merge:${tag(issue)}`, phase: 'Merge', model: M.cheap, effort: 'low', schema: S_DONE },
  )
}

// Pure decision: reasons this PR may not merge (empty list = merge).
function gateBlockers(g, wontDo, headSha) {
  const out = []
  if (g.state !== 'OPEN') out.push(`PR is ${g.state}`)
  if (headSha && g.head_sha !== headSha) out.push(`head moved to ${g.head_sha}`)
  for (const name of REQUIRED_CHECKS) {
    const run = g.checks.find((c) => c.name === name && (!c.sha || c.sha === g.head_sha))
    if (!run) out.push(`required check ${name} missing on head`)
    else if (String(run.conclusion).toUpperCase() !== 'SUCCESS') out.push(`required check ${name} is ${run.conclusion}`)
  }
  if (g.unresolved_threads > 0) out.push(`${g.unresolved_threads} unresolved review thread(s)`)
  for (const l of HOLD_LABELS) if (g.labels.includes(l)) out.push(`label ${l}`)
  if (wontDo > 0) out.push(`${wontDo} won't-do item(s) need owner sign-off`)
  return out
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------
phase('Triage')
let candidates
if (A.issues && A.issues.length) {
  candidates = A.issues.map((n) => ({ number: n, title: '', labels: [] }))
  log(`Explicit issues: ${A.issues.join(', ')}`)
} else {
  const listed = await agent(
    `List open issues on ${REPO} opened by ${AUTHORS.join(' or ')}: run \`gh issue list -R ${REPO} --state open --author <login> --limit 200 --json number,title,labels,author\` once per login (${AUTHORS.join(', ')}). Read-only. Never include issues opened by anyone else.
Exclude any issue that (a) has one of these labels: ${SKIP_LABELS.join(', ')}; or (b) already has an OPEN pull request that links or references it (\`gh pr list -R ${REPO} --state open --limit 200 --json number,body,closingIssuesReferences\`).
Return the remaining issues and the excluded ones with reasons.`,
    { label: 'triage:list', phase: 'Triage', model: M.cheap, effort: 'low', schema: S_CANDIDATES },
  )
  if (!listed) return { error: 'triage list agent died' }
  candidates = listed.issues
  log(`${candidates.length} candidate issue(s); ${listed.excluded.length} excluded`)
}

const SCORE_RUBRIC = `actionable = the desired outcome is clear enough to implement without asking the owner. size: S (<~150 LOC, one area), M (a few files / one subsystem), L (multi-subsystem, design decision, or epic-like). priority 1–5 (5 = security/data-loss bug). area = primary code area. blockers = dependency on another open issue or a needed product decision ("" when none).`
let scores
if (LEAN) {
  // One cheap agent per batch, issue text only (the Opus planner can still abort a bad pick).
  const batches = []
  for (let i = 0; i < candidates.length; i += TRIAGE_BATCH) batches.push(candidates.slice(i, i + TRIAGE_BATCH))
  scores = (await parallel(batches.map((b, bi) => () => agent(
    `Triage these ${REPO} issues from their text only (do not read code): ${b.map((c) => `#${c.number}`).join(', ')}. Read-only. For each: \`gh issue view <n> -R ${REPO} --comments --json number,title,body,author,labels,comments\` (report author.login).
${SCORE_RUBRIC}
Return one score per issue.`,
    { label: `triage:batch${bi + 1}`, phase: 'Triage', model: M.cheap, effort: 'low', schema: { type: 'object', properties: { scores: { type: 'array', items: S_SCORE } }, required: ['scores'] } },
  )))).filter(Boolean).flatMap((r) => r.scores)
} else {
  scores = (await parallel(candidates.map((c) => () => agent(
    `Triage ${REPO} issue #${c.number}. Read-only. Read it with \`gh issue view ${c.number} -R ${REPO} --comments --json number,title,body,author,labels,comments\` (report author.login) and skim the code it touches (grep; no deep dive).
${SCORE_RUBRIC}`,
    { label: `triage:#${c.number}`, phase: 'Triage', model: M.cheap, effort: 'low', schema: S_SCORE },
  )))).filter(Boolean)
}

// Barrier: choose lanes across all scores; distinct areas avoid parallel conflicts.
const explicit = !!(A.issues && A.issues.length)
const foreign = scores.filter((s) => !AUTHORS.includes(s.author))
if (foreign.length) log(`Ignored (not opened by ${AUTHORS.join('/')}): ${foreign.map((s) => `#${s.number}(${s.author})`).join(' ')}`)
const ranked = scores
  .filter((s) => AUTHORS.includes(s.author))
  .filter((s) => explicit || (s.actionable && s.size !== 'L' && !s.blockers))
  .sort((a, b) => b.priority - a.priority || a.size.localeCompare(b.size))
const selected = []
const areas = new Set()
for (const s of ranked) {
  if (selected.length >= LANES) break
  if (!explicit && areas.has(s.area)) continue
  areas.add(s.area)
  selected.push(s)
}
const skipped = scores.filter((s) => !selected.includes(s) && !foreign.includes(s))
log(`Selected: ${selected.map((s) => `#${s.number}(${s.size},p${s.priority},${s.area})`).join(' ') || 'none'}`)
if (skipped.length) log(`Not selected this run: ${skipped.map((s) => `#${s.number}[${s.actionable ? '' : 'not-actionable '}${s.size}${s.blockers ? ' blocked' : ''}]`).join(' ')}`)

if (A.dryRun || !selected.length) {
  return { dryRun: !!A.dryRun, selected, skipped }
}

// ---------------------------------------------------------------------------
// Lanes: one pipeline item per issue, no barrier between issues
// ---------------------------------------------------------------------------
const results = await pipeline(
  selected,

  // 1. Plan (opus)
  (issue) => agent(
    `${AUTH}
You are the planner for ${REPO} issue #${issue.number}. Do not modify code.
${DETACHED(BASE)}
1. Claim it: \`gh issue edit ${issue.number} -R ${REPO} --add-label in-progress\` and comment "Picked up by the automated issue pipeline."
2. Read the issue and comments. Research the code thoroughly (AGENTS.md, docs/architecture.md, docs/contributing.md, the relevant layers). Find existing helpers to reuse.
3. Write a DETAILED implementation plan a cheaper model can follow mechanically: exact files and symbols to change, code-level steps, tests to add (tests/… or gui/web Vitest), docs to update per the AGENTS.md "Docs in sync" table, and verify_cmds: concrete targeted commands naming the exact files/tests for this change, following: ${VERIFY}
4. List related_issues: other open issues this work touches, overlaps or partially addresses but does NOT fully close (\`gh issue list -R ${REPO} --search <keywords>\`).
5. Choose a branch name type/short-kebab (feat|fix|docs|chore|refactor|test).
6. Post the plan on the issue as a comment wrapped in <details><summary>Implementation plan</summary>…</details>.
If the issue needs an owner decision or is too large for one PR, set abort=true with abort_reason instead of planning.`,
    { label: `plan:${tag(issue)}`, phase: 'Plan', model: M.senior, effort: 'high', isolation: 'worktree', schema: S_PLAN },
  ).then((plan) => ({ issue, plan })),

  // 2. Implement + open PR (sonnet)
  async ({ issue, plan }) => {
    if (!plan) return { issue, done: await hold(issue, null, 'planner agent died') }
    if (plan.abort) return { issue, done: await hold(issue, null, `planner aborted: ${plan.abort_reason || 'no reason given'}`) }
    const pr = await agent(
      `${AUTH}
Implement ${REPO} issue #${issue.number} by following this plan EXACTLY. Do not redesign; if the plan is impossible, return ok=false with the reason.
${DETACHED(BASE)}
${SETUP}
Branch: ${plan.branch} (if it already exists on origin, append -2, -3, …).
PLAN:
${plan.plan_md}
Steps: implement code + tests + docs; run ${plan.verify_cmds.join(' && ')}; fix failures; commit (conventional message, repo style); \`git push origin HEAD:refs/heads/<branch>\`; then \`gh pr create -R ${REPO} --base main --head <branch>\` with a summary, a test plan, and these issue-link lines verbatim, each on its own line:
${LINKS(issue.number, plan.related_issues)}
End the PR body with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".
Return ok, pr number, branch, head_sha.`,
      { label: `impl:${tag(issue)}`, phase: 'Implement', model: M.worker, isolation: 'worktree', schema: S_PR },
    )
    if (!pr || !pr.ok) return { issue, done: await hold(issue, null, `implementation failed: ${pr ? pr.error : 'agent died'}`) }
    log(`${tag(issue)} → PR #${pr.pr}`)
    return { issue, pr }
  },

  // 3. CI → review/feedback rounds → gate → merge
  async (lane) => {
    if (lane.done) return lane.done
    const { issue } = lane
    const { pr, branch } = lane.pr
    let head = lane.pr.head_sha

    // GitHub CI runs while review/feedback proceed; it is waited on once, at the
    // merge gate, against the final head (the gate enforces green).
    let green = { ok: false, head_sha: head, reason: 'CI not yet checked' }

    let wontDo = 0
    let findingsTotal = 0
    let since = ''
    let rounds = 0
    const followups = []
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      rounds = round
      const rev = await review(issue, pr, round, since)
      if (!rev) return hold(issue, pr, `review round ${round} agent died`)
      findingsTotal += rev.findings.length
      if (rev.findings.length) {
        const pv = await verifyPosted(issue, pr, rev)
        if (!pv || pv.missing_after > 0) {
          return hold(issue, pr, `could not post ${pv ? pv.missing_after : '?'} review finding(s): ${pv ? (pv.missing_ids || []).join(', ') : 'verifier died'}`)
        }
      }
      since = rev.reviewed_sha

      // Lean: small, non-High feedback is planned by Sonnet; anything weightier stays on Opus.
      const simple = LEAN && rev.findings.length <= 5 && !rev.findings.some((f) => f.severity === 'high')
      const plan = await feedbackPlan(issue, pr, round, round === MAX_ROUNDS, simple ? M.worker : M.senior)
      if (!plan) return hold(issue, pr, `feedback plan round ${round} agent died`)
      if (!plan.items.length) break

      const exec = await feedbackExec(issue, pr, branch, plan)
      if (!exec) return hold(issue, pr, `feedback execute round ${round} agent died`)
      const rv = await verifyReplies(issue, pr, exec)
      if (!rv || rv.missing_after > 0) return hold(issue, pr, `could not post ${rv ? rv.missing_after : '?'} feedback repl(ies)`)
      wontDo += exec.wont_do_count
      followups.push(...exec.items.filter((i) => i.followup_issue).map((i) => i.followup_issue))

      const changed = !!exec.head_sha && exec.head_sha !== head
      if (changed) head = exec.head_sha
      // No new code → nothing new to re-review.
      if (!changed) break
    }

    // Gate: merge as soon as this lane is done and CI is green on the latest head.
    let blockers = []
    for (let attempt = 1; attempt <= GATE_ATTEMPTS; attempt++) {
      if (!green.ok || green.head_sha !== head) {
        green = await ensureGreen(issue, pr, branch, head)
        head = green.head_sha
      }
      const g = await gateFacts(issue, pr)
      if (!g) { blockers = ['gate agent died']; break }
      if (g.merge_state_status === 'DIRTY') {
        const rb = await rebase(issue, pr, branch)
        if (!rb || !rb.ok) { blockers = [`rebase onto main failed: ${rb ? rb.summary : 'agent died'}`]; break }
        head = rb.head_sha
        green = { ok: false, head_sha: head }
        continue
      }
      blockers = gateBlockers(g, wontDo, head)
      if (!green.ok) blockers.push(green.reason || 'CI not green')
      if (NO_MERGE) {
        log(`${tag(issue)} PR #${pr} noMerge: gate ${blockers.length ? `would HOLD (${blockers.join('; ')})` : 'would MERGE'}`)
        return { issue: issue.number, pr, merged: false, wouldMerge: !blockers.length, blockers, rounds, findings: findingsTotal, followups, profile: PROFILE }
      }
      if (!blockers.length) {
        const evidence = [
          `- review rounds: ${rounds}; findings posted: ${findingsTotal} (post-verified)`,
          `- feedback: every item replied to (reply-verified); follow-up issues: ${followups.map((n) => `#${n}`).join(', ') || 'none'}; won't-do: ${wontDo}`,
          `- unresolved review threads: ${g.unresolved_threads}; labels: ${g.labels.join(', ') || 'none'}`,
          `- required checks on ${g.head_sha}: ${REQUIRED_CHECKS.join(', ')} all SUCCESS`,
        ].join('\n')
        const m = await merge(issue, pr, g.head_sha, evidence)
        if (m && m.ok) {
          log(`${tag(issue)} PR #${pr} merged`)
          return { issue: issue.number, pr, merged: true, rounds, findings: findingsTotal, followups, profile: PROFILE }
        }
        blockers = [`merge failed: ${m ? m.detail : 'agent died'}`]
      }
      break // only a conflict (DIRTY) earns another attempt
    }
    const held = await hold(issue, pr, blockers.join('; '))
    return { ...held, rounds, findings: findingsTotal, followups }
  },
)

return {
  selected: selected.map((s) => s.number),
  skipped: skipped.map((s) => ({ number: s.number, actionable: s.actionable, size: s.size, reason: s.reason })),
  lanes: results.map((r, i) => r || { issue: selected[i].number, merged: false, held: true, reason: 'lane crashed' }),
}
