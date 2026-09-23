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
    { title: 'Merge', detail: 'gate facts, rebase on conflict, rebase-merge', model: 'haiku' },
    { title: 'Cleanup', detail: 'remove finished workflow worktrees', model: 'haiku' },
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
// noMerge: run every stage but stop at the gate and report the verdict (A/B comparisons).
const NO_MERGE = !!A.noMerge
// baseRef: commit/ref new branches start from (default origin/main).
const BASE = A.baseRef || 'origin/main'
const TRIAGE_BATCH = 10
// in-progress is not a static skip: triage honours live claims and releases stale ones.
const SKIP_LABELS = A.labelsSkip || ['epic', 'needs-user-input', 'deferred-v1', 'do-not-merge', 'wontfix', 'duplicate']
// Coordination with other runs/agents over GitHub (see .agents/rules/issue-claims.md).
const CLAIM_LABEL = 'in-progress'
const STAGE_LABELS = { planning: 'pipeline:planning', implementing: 'pipeline:implementing', review: 'pipeline:review', merging: 'pipeline:merging' }
const STALE_HOURS = A.staleHours ?? 6
const CLAIM_MARK = '<!-- pipeline-claim'
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

// Every stage prompt starts with the same provenance line. Stages without it compared their
// task with the user's chat message ("Run the issue-pipeline on …") and tried to launch the
// pipeline themselves, then reported that as fake CI data.
const STAGE_ONLY = 'Do exactly this stage and nothing else: never start, re-run or invoke the issue-pipeline or any other workflow yourself, and never write workflow scripts.'
function stage(prompt, opts) {
  return agent(`${AUTH}\n${STAGE_ONLY}\n\n${prompt}`, opts)
}

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

// Token hygiene for executing agents: cost scales with turns × context, so every extra
// exploratory read or one-step shell call is re-billed on each later turn.
const LEAN_TURNS = `Work efficiently: the plan already locates the code — go straight to the listed files/lines instead of re-exploring with grep/cat; read only the ranges you edit; chain related shell steps in one command (e.g. \`git add … && git commit … && git push …\`); pipe long command output through \`tail -n 40\`.`

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
// The watcher only copies raw GitHub data; the script derives pass/fail from it, because a
// cheap model once invented both a check name and a head SHA.
const S_CI = {
  type: 'object',
  properties: {
    head_sha: { type: 'string', description: 'exact 40-char headRefOid from gh pr view' },
    timed_out: { type: 'boolean' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, state: { type: 'string', description: 'bucket/state from gh pr checks --json, verbatim' } },
        required: ['name', 'state'],
      },
    },
  },
  required: ['head_sha', 'timed_out', 'checks'],
}
const SHA_RE = /^[0-9a-f]{40}$/
// Pure: classify a watcher report. Invalid data never counts as pass or fail.
function ciState(ci) {
  if (!ci || !SHA_RE.test(ci.head_sha || '')) return { state: 'invalid', failing: [], reason: `watcher returned head ${ci ? JSON.stringify(ci.head_sha) : 'nothing'}` }
  const byName = new Map(ci.checks.map((c) => [c.name, String(c.state).toLowerCase()]))
  const missing = REQUIRED_CHECKS.filter((n) => !byName.has(n))
  const failing = REQUIRED_CHECKS.filter((n) => ['fail', 'failure', 'cancel', 'cancelled', 'error', 'timed_out', 'action_required'].includes(byName.get(n)))
  if (failing.length) return { state: 'fail', failing, head_sha: ci.head_sha }
  if (!missing.length && REQUIRED_CHECKS.every((n) => ['pass', 'success'].includes(byName.get(n)))) return { state: 'pass', failing: [], head_sha: ci.head_sha }
  if (ci.timed_out) return { state: 'timeout', failing: [], head_sha: ci.head_sha }
  return { state: 'invalid', failing: [], head_sha: ci.head_sha, reason: `required checks missing or unfinished: ${REQUIRED_CHECKS.filter((n) => !['pass', 'success'].includes(byName.get(n))).join(', ')}` }
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
  return stage(
    `Wait for GitHub required checks on ${REPO} PR #${pr}. Read-only; change nothing.
Expected head SHA: ${expectSha || '(read it with gh pr view)'}.
1. Confirm \`gh pr view ${pr} -R ${REPO} --json headRefOid -q .headRefOid\` matches the expected SHA (if a newer SHA exists, use the newer one and report it).
2. Loop \`gh pr checks ${pr} -R ${REPO} --required --watch --interval 30\` with a Bash timeout of 590000 ms. If checks are not registered yet, retry. Give up after ~60 minutes total → state "timeout".
3. Only count check runs on the PR head SHA. Required checks: ${REQUIRED_CHECKS.join(', ')}.
Then run \`gh pr checks ${pr} -R ${REPO} --required --json name,bucket,state\` once more and COPY its rows verbatim into checks (name + bucket). Copy the exact 40-character headRefOid into head_sha. Set timed_out=true only if you gave up waiting. Do not summarize or invent values.`,
    { label: `ci:${tag(issue)}`, phase: 'CI', model: M.cheap, effort: 'low', schema: S_CI },
  )
}

function fixCi(issue, pr, branch, ci) {
  return stage(
    `CI failed on ${REPO} PR #${pr} (branch ${branch}, head ${ci.head_sha}). Failing required checks: ${(ci.failing || []).join(', ')}.
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
async function watch(issue, pr, sha) {
  let ci = ciState(await waitCi(issue, pr, sha))
  if (ci.state === 'invalid') {
    log(`${tag(issue)} CI watcher data invalid (${ci.reason}); re-watching once`)
    ci = ciState(await waitCi(issue, pr, sha))
  }
  return ci
}

async function ensureGreen(issue, pr, branch, sha) {
  let ci = await watch(issue, pr, sha)
  let note = ''
  for (let i = 0; ci && ci.state === 'fail' && i < CI_FIX_ATTEMPTS; i++) {
    const fix = await fixCi(issue, pr, branch, ci)
    if (!fix || !fix.ok) { note = fix ? `CI ${fix.cause}: ${fix.summary}` : ''; break }
    if (fix.cause === 'flaky') log(`${tag(issue)} CI flaky (${fix.summary}); re-ran failed jobs`)
    ci = await watch(issue, pr, fix.cause === 'pr' ? fix.head_sha : ci.head_sha)
  }
  if (ci.state === 'invalid') return { ok: false, head_sha: sha, reason: `CI state unknown: ${ci.reason}` }
  if (note && ci.state !== 'pass') return { ok: false, head_sha: ci.head_sha, reason: note }
  const ok = ci.state === 'pass'
  return { ok, head_sha: ci.head_sha, reason: ok ? '' : `CI ${ci.state}: ${(ci.failing || []).join(', ')}` }
}

// ---------------------------------------------------------------------------
// Issue claims: label + claim comment (token, stage, heartbeat); oldest live claim wins.
// ---------------------------------------------------------------------------
const S_CLAIM = {
  type: 'object',
  properties: {
    won: { type: 'boolean' },
    token: { type: 'string' },
    comment_id: { type: 'integer' },
    reason: { type: 'string' },
  },
  required: ['won', 'reason'],
}
const claims = new Map() // issue number -> { token, comment_id }
const CLAIM_FORMAT = `The claim comment body is exactly two lines:
${CLAIM_MARK} token=<token> stage=<stage> heartbeat=<UTC ISO time> released=<no|outcome> -->
🤖 Claimed by issue-pipeline run \`<token>\` · stage: <stage> · heartbeat: <UTC ISO time>
A claim is LIVE when released=no and its heartbeat is less than ${STALE_HOURS} hours old.`

function claimIssue(issue) {
  return stage(
    `Claim ${REPO} issue #${issue.number} for this pipeline run, safely against other runs/agents.
${CLAIM_FORMAT}
1. Make a token: \`echo "$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM$RANDOM"\`.
2. List comments: \`gh api repos/${REPO}/issues/${issue.number}/comments --paginate --jq '.[] | {id, created_at, body}'\`. If any LIVE claim exists, do not claim: return won=false, reason naming its token.
3. \`gh issue edit ${issue.number} -R ${REPO} --add-label ${CLAIM_LABEL} --add-label ${STAGE_LABELS.planning}\` and post the claim comment (stage=planning, heartbeat=now, released=no) with \`gh api repos/${REPO}/issues/${issue.number}/comments -f body=…\`; note its id.
4. Re-list comments. Among LIVE claims the winner is the earliest created_at (tie: lowest id). If the winner is not yours, edit yours to released=lost-race (\`gh api -X PATCH repos/${REPO}/issues/comments/<id> -f body=…\`) WITHOUT removing labels (they belong to the winner), and return won=false.
Return won, token, comment_id, reason.`,
    { label: `claim:${tag(issue)}`, phase: 'Plan', model: M.worker, effort: 'low', schema: S_CLAIM },
  ).then((c) => {
    if (c && c.won && c.token && c.comment_id) claims.set(issue.number, { token: c.token, comment_id: c.comment_id })
    return c
  })
}

// Move the issue (and PR) to a stage label and refresh the claim heartbeat.
function setStage(issue, pr, key) {
  const c = claims.get(issue.number)
  if (!c) return Promise.resolve(null)
  const others = Object.values(STAGE_LABELS).filter((l) => l !== STAGE_LABELS[key])
  return stage(
    `Update the pipeline claim on ${REPO} issue #${issue.number} to stage "${key}".
1. \`gh issue edit ${issue.number} -R ${REPO} --add-label ${STAGE_LABELS[key]} ${others.map((l) => `--remove-label ${l}`).join(' ')}\`${pr ? ` and the same label edit on PR #${pr} (\`gh pr edit ${pr} -R ${REPO} …\`), also removing ${STALL_LABEL} there` : ''}.
2. Rewrite claim comment ${c.comment_id} (token ${c.token}) with stage=${key} and heartbeat=$(date -u +%Y-%m-%dT%H:%M:%SZ), released=no, via \`gh api -X PATCH repos/${REPO}/issues/comments/${c.comment_id} -f body=…\`.
${CLAIM_FORMAT}
Return ok=true when both are done.`,
    { label: `stage:${key}:${tag(issue)}`, phase: 'Plan', model: M.cheap, effort: 'low', schema: S_DONE },
  )
}

// Release on every exit: merged, held, aborted, crashed.
function releaseClaim(issue, pr, outcome) {
  const c = claims.get(issue.number)
  if (!c) return Promise.resolve(null)
  claims.delete(issue.number)
  const labels = [CLAIM_LABEL, ...Object.values(STAGE_LABELS)]
  return stage(
    `Release this pipeline run's claim on ${REPO} issue #${issue.number} (outcome: ${outcome}).
1. \`gh issue edit ${issue.number} -R ${REPO} ${labels.map((l) => `--remove-label ${l}`).join(' ')}\` (ignore "not found" for labels already absent)${pr ? `; on PR #${pr} remove the ${Object.values(STAGE_LABELS).join(', ')} labels` : ''}.
2. Rewrite claim comment ${c.comment_id} (token ${c.token}) with released=${outcome} and a fresh heartbeat.
${CLAIM_FORMAT}
Return ok=true when done.`,
    { label: `release:${tag(issue)}`, phase: 'Merge', model: M.cheap, effort: 'low', schema: S_DONE },
  )
}

// Two kinds of stop. Only a real question for the owner blocks merging with
// needs-user-input; technical failures are "stalled" and the next run resumes them.
const STALL_LABEL = 'pipeline:stalled'
const STALL_MARK = '<!-- pipeline-stalled'

// An agent returning nothing is either a real failure or an outage (usage/session limit,
// API down) that fails every agent. Probe with a trivial agent: if that fails too, it is an
// outage — keep the claim and labels as they are (the run is resumable with its run ID, and
// a later run adopts the PR once the claim goes stale) instead of marking the PR stalled.
const interrupted = new Set() // issue numbers whose lanes stopped on an outage
async function stallOrInterrupt(issue, pr, reason, resumeAt) {
  const probe = await stage('Health check: return ok=true and nothing else.', { label: `probe:${tag(issue)}`, phase: 'Merge', model: M.cheap, effort: 'low', schema: S_DONE })
  if (!probe) {
    interrupted.add(issue.number)
    log(`${tag(issue)} INTERRUPTED (agents failing, likely a usage limit): ${reason}`)
    return { issue: issue.number, pr, merged: false, interrupted: true, resumeAt, reason: `${reason}; agents are failing (likely a usage/session limit). Resume this run with Workflow resumeFromRunId; otherwise a later run adopts the PR once its claim is ${STALE_HOURS}h stale.` }
  }
  return stall(issue, pr, reason, resumeAt)
}

// A decision only the owner can make (won't-do sign-off, planner abort, owner hold).
async function holdForDecision(issue, pr, question, detail) {
  log(`${tag(issue)} DECISION NEEDED: ${question}`)
  await releaseClaim(issue, pr, 'needs-decision')
  return stage(
    `The issue pipeline needs an owner decision on ${pr ? `PR #${pr}` : `issue #${issue.number}`} (${REPO}) and must not merge until it is answered.
1. ${pr ? `\`gh pr edit ${pr} -R ${REPO} --add-label needs-user-input --remove-label ${STALL_LABEL}\`` : `\`gh issue edit ${issue.number} -R ${REPO} --add-label needs-user-input\``} (ignore "not found").
2. Post one comment, exactly this shape (fill in, keep it short):
## Automation hold — decision needed
**Question:** ${question}
**Context:** ${detail || '(summarize the relevant facts in 1-3 bullets)'}
**To unblock:** answer here, then remove \`needs-user-input\` (or merge yourself).
Return ok=true once both are done.`,
    { label: `hold:${tag(issue)}`, phase: 'Merge', model: M.cheap, effort: 'low', schema: S_DONE },
  ).then(() => ({ issue: issue.number, pr, merged: false, held: true, decision: true, reason: question }))
}

// Technical problem, no decision needed. resumeAt: 'gate' when review+feedback finished,
// 'review' otherwise (a resumed PR is never merged without a completed review).
async function stall(issue, pr, reason, resumeAt) {
  log(`${tag(issue)} STALLED (${resumeAt || 'retriage'}): ${reason}`)
  await releaseClaim(issue, pr, 'stalled')
  return stage(
    `The issue pipeline stalled on a technical problem on ${pr ? `PR #${pr}` : `issue #${issue.number}`} (${REPO}). No owner decision is needed.
1. ${pr ? `\`gh pr edit ${pr} -R ${REPO} --add-label ${STALL_LABEL}\`` : `(issue-level stall: add no label; the next triage picks the issue up again)`}
2. Post one comment, exactly this shape:
${pr ? `${STALL_MARK} resume=${resumeAt} -->\n` : ''}## Automation stall — no decision needed
**What happened:** ${reason}
**Next:** ${pr ? `the next issue-pipeline run resumes this PR from the ${resumeAt === 'gate' ? 'merge gate (CI + threads re-checked, then merge)' : 'review stage (review is completed before any merge)'}. You may also merge it yourself if the gate conditions hold.` : 'the next issue-pipeline run can pick this issue up again.'}
Return ok=true once done.`,
    { label: `stall:${tag(issue)}`, phase: 'Merge', model: M.cheap, effort: 'low', schema: S_DONE },
  ).then(() => ({ issue: issue.number, pr, merged: false, held: true, stalled: true, resumeAt, reason }))
}

// pr-multi-review's reviewer lenses (SKILL.md § Launch). Workflow subagents cannot spawn
// subagents, so the script fans the lenses out itself and hands their reports to the
// Opus review parent, which merges, dedupes and posts (the skill's remaining steps).
const LENSES = [
  { key: 'bugbot', section: '1. Bugbot', checklist: '~/.agents/skills/multi-review/defect-checklist.md',
    prompt: 'Focus on bugs, regressions, a11y breaks, contrast/theme mistakes, broken CSS selectors, missing tests for new behavior, and anything Bugbot typically flags. Ignore pure style nits.' },
  { key: 'risk', section: '2. Risk hunt',
    prompt: 'Bug-hunt the diff for things Bugbot/CI reviewers flag. Check especially: theme/contrast tokens, interaction CSS specificity, a11y, test gaps, CI failures (gh pr checks), deploy/copy drift, docs claims vs code, and incomplete migrations. If truly nothing, say so but list residual risks.' },
  { key: 'wiring', section: '3. Wiring / migration review',
    context: 'Required reading: the packet\'s "Twin paths" section; for every touched service/domain call, open each sibling CLI (cli/), MCP (mcp/tools/) and GUI (gui/routes/, gui/web/) adapter and confirm it was updated or still matches.',
    prompt: "Review component/CSS/service migrations for regressions, Bugbot-style. Look for: missing aria attributes, rest-spread clobbering controlled props, hover that fires wrongly on touch, className merges dropping shared primitives, leftover CSS fighting new primitives, twin paths (CLI/MCP/GUI) left unmigrated, tests that do not assert what they claim." },
  { key: 'reuse', section: '4. DRY / SOLID / reuse / conventions', checklist: '~/.agents/skills/pr-multi-review/reuse-solid-checklist.md',
    context: 'Required reading: docs/architecture.md and the relevant docs/contributing.md sections (layering, where code belongs). For EVERY new function, helper, constant or repeated snippet in the diff, search the whole repo (`git grep -n` on the PR branch, by name and by a distinctive fragment of its logic) for an existing equivalent; each finding or clearance cites the search you ran.',
    prompt: "DRY / SOLID / reuse / repo conventions (AGENTS.md). Require grep/search evidence for every reuse claim: name the existing symbol/file, or state 'searched, none found'." },
  { key: 'security', section: '5. Security', checklist: '~/.agents/skills/multi-review/security-checklist.md',
    context: 'Required reading when the diff touches routes, auth, shares, uploads, relay or remote MCP: the authz helpers it relies on (e.g. require_authz, services/share_auth/), how the route is registered, and the security notes in docs/host-online-relay.md and docs/share-tokens.md. Evaluate guest/share-token vs owner access explicitly.',
    prompt: 'Trace untrusted input to sinks. Flag injection, path traversal, authz bypass (including guest/share vs owner), secrets in logs/source, SSRF, unsafe deserialization, and validation dropped on a twin path (MCP/CLI/GUI/relay). Ignore style and theoretical hardening with no exploit path.' },
  { key: 'concurrency', section: '6. Concurrency / errors / resources', checklist: '~/.agents/skills/multi-review/concurrency-checklist.md',
    context: 'Required reading: for each changed function, trace its callers until you know which thread/task/event loop runs it (worker threads, asyncio, GUI server, browser main thread) and what else touches the same state.',
    prompt: 'Flag races, check-then-act, lock inversion, unawaited async, missing cancellation, shared mutable state without an owner, resource leaks, swallowed errors, and partial failure with no cleanup. Ignore happy-path logic (other lenses cover it).' },
  { key: 'performance', section: '7. Performance', checklist: '~/.agents/skills/multi-review/performance-checklist.md',
    prompt: 'Flag only work that plausibly hurts a hot path or unbounded input: quadratic loops, N+1 queries/fetches, unbounded reads, blocking I/O on UI/async threads, repeated parse/fetch per row/frame, caches without eviction. No micro-optimizations; if there is no hot or unbounded path, return none.' },
  { key: 'patterns', section: '8. Algorithms / contracts', checklist: '~/.agents/skills/pr-multi-review/patterns-antipatterns.md',
    context: 'Required reading: follow each changed control flow at least two hops upstream (producers) and downstream (consumers) so every Require/Guarantee in your inventory is grounded in code you read.',
    prompt: 'For every queue, cache, retry, debounce/coalesce, snapshot vs delta, poll, merge, or similar control flow: write Require (what the data must be) and Guarantee (what the next consumer gets), check the composition chain, and flag where this diff breaks it or a "fix" is a sibling algorithm with the same false require. Findings use Trigger → Path → Expected vs actual.' },
]
// Round 2+ only re-reviews the (small) feedback-fix diff.
const FOLLOWUP_LENSES = ['bugbot', 'risk', 'reuse']
const S_LENS = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { enum: ['high', 'medium', 'low'] },
          path: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string' },
          detail: { type: 'string', description: 'evidence (file:line, grep results) and suggested fix' },
        },
        required: ['severity', 'title', 'detail'],
      },
    },
    residual_risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['lens', 'findings'],
}

const S_PACKET = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'absolute path of the packet file, exactly as the script printed it' },
    chars: { type: 'integer' },
  },
  required: ['path', 'chars'],
}
const PACKET_PATH_RE = /\/pipeline-packets\/pr\d+-r\d+\.md$/

// Built once per round and shared by every lens: removes 8x duplicated setup/exploration,
// and gives all lens prompts an identical prefix so the prompt cache can reuse it.
// Built once per round by scripts/review_packet.py (plain git, no model) into a file under the
// shared .git dir; a cheap agent only runs it. Agents retyping a 30-40k-char packet cost more
// than the lenses saved and sometimes failed to return it at all.
function reviewPacket(issue, pr, branch, round, since) {
  const diff = round > 1 ? `${since}..origin/${branch}` : `origin/main...origin/${branch}`
  return stage(
    `Build the review packet for ${REPO} PR #${pr} by running one script; do not write or edit it yourself.
\`cd "$(git rev-parse --show-toplevel)" && git fetch -q origin --prune && python3 <(git show origin/main:scripts/review_packet.py) --ref origin/${branch} --range ${diff} --out "$(cd "$(git rev-parse --git-common-dir)" && pwd)/pipeline-packets/pr${pr}-r${round}.md"\`
It prints "<path> <chars>". Return exactly that path and char count. If the command fails, return path "" and chars 0.`,
    { label: `packet:${tag(issue)}:r${round}`, phase: 'Review', model: M.cheap, effort: 'low', schema: S_PACKET },
  ).then((p) => (p && PACKET_PATH_RE.test(p.path) && p.chars > 0 ? p : null))
}

// Lenses (and the Opus parent) read the packet file themselves; without one they explore.
const packetRead = (packet) => packet
  ? `REVIEW PACKET: first run \`cat ${packet.path}\` (${packet.chars} chars, identical for every lens): diff with context, callers, importers, twin CLI/MCP/GUI paths, related tests, applicable AGENTS.md rows.`
  : 'REVIEW PACKET: unavailable this round; gather the diff (`git diff origin/main...origin/<branch>`) and context yourself.'

function lensReview(issue, pr, branch, round, packet, lens) {
  // Identical prefix across lenses (cache-friendly); lens-specific text last.
  return stage(
    `You are one reviewer lens for ${REPO} PR #${pr} (branch ${branch}), review round ${round}. Read-only: do not check out, post, push or edit. Read any further code with \`git show origin/${branch}:<path>\` or \`git grep -n <pattern> origin/${branch}\`.
${round > 1 ? 'This round covers only the feedback-fix diff; do not re-raise resolved threads.\n' : ''}${packetRead(packet)}
---
YOUR LENS: "${lens.key}" (pr-multi-review § Launch → ${lens.section}).
${lens.prompt}${lens.checklist ? `\nChecklist: read and follow ${lens.checklist}.` : ''}${lens.context ? `\n${lens.context}` : ''}
The packet is a starting point, not the boundary: complete your required reading and follow any lead outside it before concluding. If the packet shows no surface for your lens, return an empty findings list with a one-line residual_risks entry saying why. Otherwise return every concrete finding (severity, path, line, title, detail with evidence) and residual risks.`,
    { label: `lens:${lens.key}:${tag(issue)}:r${round}`, phase: 'Review', model: M.worker, schema: S_LENS },
  )
}

async function review(issue, pr, branch, round, since) {
  const lenses = round > 1 ? LENSES.filter((l) => FOLLOWUP_LENSES.includes(l.key)) : LENSES
  const packet = await reviewPacket(issue, pr, branch, round, since)
  if (!packet) log(`${tag(issue)} review r${round}: packet unavailable; lenses gather context themselves`)
  const reports = (await parallel(lenses.map((l) => () => lensReview(issue, pr, branch, round, packet, l)))).filter(Boolean)
  if (reports.length < lenses.length) log(`${tag(issue)} review r${round}: ${lenses.length - reports.length} lens(es) returned nothing`)
  return stage(
    `AUTONOMOUS MODE: round=${round}${since ? `, since=${since}` : ''}, lenses=supplied
Read ${SKILLS.review} (and the checklists it references) and execute it for ${REPO} PR #${pr}, following its "AUTONOMOUS MODE (pipeline)" section, which overrides every other gate in that file.
The reviewer lenses have ALREADY RUN (reports below), so skip § Launch. Do § Browser QA (when the diff has a GUI/HTTP surface), then § Merge + present over the union of these reports and your own reading of the diff (drop a finding only when the diff refutes it), then § Posting comments.
${packetRead(packet)} It is the same packet the lenses used; start from it instead of re-exploring.
Lens reports (JSON): ${JSON.stringify(reports)}
POSTING IS MANDATORY. Every unrebutted High/Medium/Low finding must be posted to the PR before you return: inline threads (one COMMENT review) where a RIGHT-side line attaches, otherwise one top-level \`gh pr comment\` per finding. Never APPROVE or REQUEST_CHANGES. An unposted finding is a pipeline failure.
${round > 1 ? `Round ${round}: review ONLY \`git diff ${since}..<PR head>\` (the feedback fixes). Do not re-raise resolved threads.` : ''}
Return every finding with the URL of its posted comment, the SHA you reviewed, and any environment blockers (those are NOT posted).`,
    { label: `review:${tag(issue)}:r${round}`, phase: 'Review', model: M.senior, effort: 'high', isolation: 'worktree', schema: S_REVIEW },
  )
}

function verifyPosted(issue, pr, rev) {
  return stage(
    `Verify that every review finding below was posted to ${REPO} PR #${pr}, and post any that are missing. You are the safety net: posting missing ones is REQUIRED.
Findings (JSON): ${JSON.stringify(rev.findings)}
1. Fetch review threads (GraphQL reviewThreads: path, line, comments.body, comments.url; paginate) and issue comments (\`gh api repos/${REPO}/issues/${pr}/comments --paginate\`).
2. A finding counts as posted if its comment_url is a comment on this PR, or an inline thread / top-level comment contains its body text (whitespace-insensitive).
3. For each missing finding: post it inline via \`gh api repos/${REPO}/pulls/${pr}/reviews --method POST\` (event COMMENT, commit_id = PR head SHA, side RIGHT); on HTTP 422 post it as a top-level \`gh pr comment ${pr} -R ${REPO}\` instead.
4. Re-fetch and recount.
Return expected, found_before, posted_now, missing_after, missing_ids.`,
    { label: `post-verify:${tag(issue)}`, phase: 'Review', model: M.cheap, effort: 'low', schema: S_POST_VERIFY },
  )
}

function feedbackPlan(issue, pr, round, finalRound) {
  return stage(
    `AUTONOMOUS MODE: mode=plan, round=${round}${finalRound ? ', final=true' : ''}
Read ${SKILLS.feedback} and execute Phases 1–2 for ${REPO} PR #${pr}, following its "AUTONOMOUS MODE (pipeline)" section (no approval gate; nothing is posted in plan mode).
Include EVERY unresolved review thread and every top-level PR comment that still needs a response (not only this round's findings; human comments too).
For each item choose exactly one action:
- implement: valid and fits this PR. Give precise step-level instructions a cheaper model can follow without judgment calls or re-exploring: exact files and line ranges with the current snippet quoted, the replacement, tests to add, docs to update per AGENTS.md. When one change repeats across call sites, list every site.
- follow_up: valid but out of scope, large, or risky${finalRound ? ' (FINAL ROUND: anything not trivially safe to finish now MUST be follow_up)' : ''}. Provide followup_title and a self-contained followup_body (file paths, link to the PR comment).
- wont_do: ONLY when the finding is wrong or the change would be harmful; give the technical rationale. A wont_do holds the PR for the owner, so prefer follow_up when in doubt.
Return the items.`,
    { label: `fb-plan:${tag(issue)}:r${round}`, phase: 'Feedback', model: M.senior, effort: 'high', isolation: 'worktree', schema: S_FB_PLAN },
  )
}

function feedbackExec(issue, pr, branch, plan) {
  return stage(
    `AUTONOMOUS MODE: mode=execute
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
   Post all replies/resolutions in as few commands as possible (e.g. one shell loop over the items).
4. Do one final re-fetch to confirm every reply exists and every non-wont_do thread is resolved (a separate verifier re-checks, so do not re-verify item by item).
${LEAN_TURNS}
Return head_sha (after push, or the unchanged head), shas, per-item reply_body/reply_url/resolved/followup_issue, and wont_do_count.`,
    { label: `fb-exec:${tag(issue)}`, phase: 'Feedback', model: M.worker, isolation: 'worktree', schema: S_FB_EXEC },
  )
}

function verifyReplies(issue, pr, exec) {
  return stage(
    `Verify feedback replies on ${REPO} PR #${pr}. Items (JSON): ${JSON.stringify(exec.items)}
For each item: thread → a reply containing its reply_body exists in the thread, and the thread is resolved unless action is wont_do. Top-level comment → a later PR comment containing its reply_body exists.
Fix anything missing: post the reply_body (GraphQL addPullRequestReviewThreadReply, or \`gh pr comment\`) and resolve non-wont_do threads (resolveReviewThread). Re-fetch and recount.
Return expected, fixed_now, missing_after.`,
    { label: `reply-verify:${tag(issue)}`, phase: 'Feedback', model: M.cheap, effort: 'low', schema: S_REPLY_VERIFY },
  )
}

function gateFacts(issue, pr) {
  return stage(
    `Collect merge-gate facts for ${REPO} PR #${pr}. Read-only; change nothing.
Use \`gh pr view ${pr} -R ${REPO} --json state,headRefOid,mergeStateStatus,labels,statusCheckRollup\` and GraphQL pullRequest.reviewThreads(first:100){nodes{isResolved}} (paginate).
Return state, head_sha, merge_state_status (verbatim), checks (name, conclusion, and the commit SHA it ran on when available, for every check run), unresolved_threads (count), labels (names).`,
    { label: `gate:${tag(issue)}`, phase: 'Merge', model: M.cheap, effort: 'low', schema: S_GATE },
  )
}

function rebase(issue, pr, branch) {
  return stage(
    `${REPO} PR #${pr} (branch ${branch}) conflicts with main because another PR merged.
${DETACHED(`origin/${branch}`)}
${SETUP}
\`git rebase origin/main\`, resolving conflicts by preserving both intents; run ${VERIFY} Then \`git push --force-with-lease=refs/heads/${branch}:origin/${branch} origin HEAD:refs/heads/${branch}\`. Return ok and the new head SHA. If conflicts cannot be resolved safely, \`git rebase --abort\` and return ok=false with a summary.`,
    { label: `rebase:${tag(issue)}`, phase: 'Merge', model: M.worker, isolation: 'worktree', schema: S_PUSH },
  )
}

function merge(issue, pr, sha, evidence) {
  return stage(
    `This PR has completed the pipeline's review gate. Evidence (verify it before merging):
${evidence}
1. Show the review record: \`gh pr view ${pr} -R ${REPO} --json reviews,comments,statusCheckRollup,headRefOid\` and confirm the head is ${sha}, every required check succeeded, and there are no unresolved review threads (GraphQL reviewThreads isResolved). If anything disagrees with the evidence, do NOT merge; return ok=false with the discrepancy.
2. Merge: \`gh pr merge ${pr} -R ${REPO} --rebase --delete-branch --match-head-commit ${sha}\` (ignore local-branch cleanup errors). Confirm \`gh pr view ${pr} -R ${REPO} --json state -q .state\` is MERGED. Return ok=true only if merged; otherwise ok=false with the error in detail. If the merge command is denied by a tool-permission check, return ok=false with detail starting "merge permission denied:".`,
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

// Review/feedback rounds (skipped for gate-only resumes), then the merge gate.
async function finishLane(issue, pr, branch, head, { gateOnly = false } = {}) {
  // GitHub CI runs while review/feedback proceed; it is waited on once, at the
  // merge gate, against the final head (the gate enforces green).
  let green = { ok: false, head_sha: head, reason: 'CI not yet checked' }

  let wontDo = 0
  let findingsTotal = 0
  let since = ''
  let rounds = 0
  const followups = []
  for (let round = 1; !gateOnly && round <= MAX_ROUNDS; round++) {
    rounds = round
    const rev = await review(issue, pr, branch, round, since)
    if (!rev) return stallOrInterrupt(issue, pr, `review round ${round} agent died`, 'review')
    findingsTotal += rev.findings.length
    if (rev.findings.length) {
      const pv = await verifyPosted(issue, pr, rev)
      if (!pv || pv.missing_after > 0) {
        return (pv ? stall : stallOrInterrupt)(issue, pr, `could not post ${pv ? pv.missing_after : '?'} review finding(s): ${pv ? (pv.missing_ids || []).join(', ') : 'verifier died'}`, 'review')
      }
    }
    since = rev.reviewed_sha

    const plan = await feedbackPlan(issue, pr, round, round === MAX_ROUNDS)
    if (!plan) return stallOrInterrupt(issue, pr, `feedback plan round ${round} agent died`, 'review')
    if (!plan.items.length) break

    const exec = await feedbackExec(issue, pr, branch, plan)
    if (!exec) return stallOrInterrupt(issue, pr, `feedback execute round ${round} agent died`, 'review')
    const rv = await verifyReplies(issue, pr, exec)
    if (!rv || rv.missing_after > 0) return (rv ? stall : stallOrInterrupt)(issue, pr, `could not post ${rv ? rv.missing_after : '?'} feedback repl(ies)`, 'review')
    wontDo += exec.wont_do_count
    followups.push(...exec.items.filter((i) => i.followup_issue).map((i) => i.followup_issue))

    const changed = !!exec.head_sha && exec.head_sha !== head
    if (changed) head = exec.head_sha
    // No new code → nothing new to re-review.
    if (!changed) break
  }

  await setStage(issue, pr, 'merging')
  // Gate: merge as soon as this lane is done and CI is green on the latest head.
  let blockers = []
  let lastGate = null
  for (let attempt = 1; attempt <= GATE_ATTEMPTS; attempt++) {
    if (!green.ok || green.head_sha !== head) {
      green = await ensureGreen(issue, pr, branch, head)
      head = green.head_sha
    }
    const g = await gateFacts(issue, pr)
    lastGate = g
    if (!g) return stallOrInterrupt(issue, pr, 'gate agent died', 'gate')
    if (g.merge_state_status === 'DIRTY') {
      const rb = await rebase(issue, pr, branch)
      if (!rb || !rb.ok) { blockers = [`rebase onto main failed: ${rb ? rb.summary : 'agent died'}`]; break }
      head = rb.head_sha
      green = { ok: false, head_sha: head }
      continue
    }
    // A push landed after the last CI wait (e.g. a late feedback fix): re-check that head.
    if (SHA_RE.test(g.head_sha) && g.head_sha !== head && attempt < GATE_ATTEMPTS) {
      log(`${tag(issue)} head moved to ${g.head_sha.slice(0, 8)}; re-checking CI`)
      head = g.head_sha
      green = { ok: false, head_sha: head }
      continue
    }
    blockers = gateBlockers(g, wontDo, head)
    if (!green.ok) blockers.push(green.reason || 'CI not green')
    if (NO_MERGE) {
      log(`${tag(issue)} PR #${pr} noMerge: gate ${blockers.length ? `would HOLD (${blockers.join('; ')})` : 'would MERGE'}`)
      return { issue: issue.number, pr, merged: false, wouldMerge: !blockers.length, blockers, rounds, findings: findingsTotal, followups }
    }
    if (!blockers.length) {
      const evidence = [
        gateOnly ? '- review and feedback completed in an earlier run (resumed at the merge gate; all threads re-checked below)' : `- review rounds: ${rounds}; findings posted: ${findingsTotal} (post-verified)`,
        `- feedback: every item replied to (reply-verified); follow-up issues: ${followups.map((n) => `#${n}`).join(', ') || 'none'}; won't-do: ${wontDo}`,
        `- unresolved review threads: ${g.unresolved_threads}; labels: ${g.labels.join(', ') || 'none'}`,
        `- required checks on ${g.head_sha}: ${REQUIRED_CHECKS.join(', ')} all SUCCESS`,
      ].join('\n')
      const m = await merge(issue, pr, g.head_sha, evidence)
      if (m && m.ok) {
        await releaseClaim(issue, pr, 'merged')
        log(`${tag(issue)} PR #${pr} merged`)
        return { issue: issue.number, pr, merged: true, rounds, findings: findingsTotal, followups }
      }
      blockers = [`merge failed: ${m ? m.detail : 'agent died'}`]
    }
    break // only a conflict (DIRTY) or a moved head earns another attempt
  }
  // Owner-facing reasons block merging; everything else is a technical stall that resumes.
  const facts = lastGate
  const decision = wontDo > 0 || (facts && facts.labels.some((l) => HOLD_LABELS.includes(l)))
  const held = decision
    ? await holdForDecision(issue, pr,
        wontDo > 0 ? `Accept the ${wontDo} won't-do reply(ies) on the unresolved review thread(s)? Resolve a thread to accept its rationale, or reply asking for the change.` : 'This PR carries an owner hold label (needs-user-input / do-not-merge). Merge when you are satisfied.',
        blockers.join('; '))
    : await stall(issue, pr, blockers.join('; '), 'gate')
  return { ...held, rounds, findings: findingsTotal, followups }
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
  const listed = await stage(
    `List open issues on ${REPO} opened by ${AUTHORS.join(' or ')}: run \`gh issue list -R ${REPO} --state open --author <login> --limit 200 --json number,title,labels,author\` once per login (${AUTHORS.join(', ')}). Read-only. Never include issues opened by anyone else.
Exclude any issue that (a) has one of these labels: ${SKIP_LABELS.join(', ')}; or (b) already has an OPEN pull request that links or references it (\`gh pr list -R ${REPO} --state open --limit 200 --json number,body,closingIssuesReferences\`).
(c) Claims: for each remaining issue labelled ${CLAIM_LABEL}, find its latest comment starting with "${CLAIM_MARK}". ${CLAIM_FORMAT}
If there is no claim comment, the claim time is when ${CLAIM_LABEL} was last added (\`gh api repos/${REPO}/issues/<n>/timeline --paginate --jq '[.[] | select(.event=="labeled" and .label.name=="${CLAIM_LABEL}")] | last | .created_at'\`) and it is live if that is less than ${STALE_HOURS} hours ago.
- Live claim → exclude (reason: claimed by <token or "label">).
- Stale claim with no open PR → release it: remove ${CLAIM_LABEL} and ${Object.values(STAGE_LABELS).join(', ')}, mark any claim comment released=stale, post a comment "Stale claim released by issue-pipeline (no heartbeat for ${STALE_HOURS}+ hours).", then treat the issue as a candidate.
Compute ages with \`date -u\`. Return the remaining issues and the excluded ones with reasons.`,
    { label: 'triage:list', phase: 'Triage', model: M.worker, effort: 'low', schema: S_CANDIDATES },
  )
  if (!listed) return { error: 'triage list agent died' }
  candidates = listed.issues
  log(`${candidates.length} candidate issue(s); ${listed.excluded.length} excluded`)
}

const SCORE_RUBRIC = `actionable = the desired outcome is clear enough to implement without asking the owner. size: S (<~150 LOC, one area), M (a few files / one subsystem), L (multi-subsystem, design decision, or epic-like). priority 1–5 (5 = security/data-loss bug). area = primary code area. blockers = dependency on another open issue or a needed product decision ("" when none).`
// One cheap agent per batch of issues, issue text only: per-issue code skims cost ~50k
// tokens each, and the Opus planner still catches (and aborts) a bad pick.
const batches = []
for (let i = 0; i < candidates.length; i += TRIAGE_BATCH) batches.push(candidates.slice(i, i + TRIAGE_BATCH))
const scores = (await parallel(batches.map((b, bi) => () => stage(
  `Triage these ${REPO} issues from their text only (do not read code): ${b.map((c) => `#${c.number}`).join(', ')}. Read-only. For each: \`gh issue view <n> -R ${REPO} --comments --json number,title,body,author,labels,comments\` (report author.login).
${SCORE_RUBRIC}
Return one score per issue.`,
  { label: `triage:batch${bi + 1}`, phase: 'Triage', model: M.cheap, effort: 'low', schema: { type: 'object', properties: { scores: { type: 'array', items: S_SCORE } }, required: ['scores'] } },
)))).filter(Boolean).flatMap((r) => r.scores)

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

// ---------------------------------------------------------------------------
// Resume PRs an earlier run left as technical stalls, or orphaned by dying mid-lane
// (stage label but a stale claim). Never decision holds.
// ---------------------------------------------------------------------------
const S_STALLED = {
  type: 'object',
  properties: {
    prs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pr: { type: 'integer' },
          issue: { type: 'integer' },
          branch: { type: 'string' },
          head_sha: { type: 'string' },
          resume: { enum: ['gate', 'review'] },
        },
        required: ['pr', 'issue', 'branch', 'head_sha', 'resume'],
      },
    },
  },
  required: ['prs'],
}
const stalled = A.noResume ? { prs: [] } : await stage(
  `List stalled issue-pipeline PRs to resume. Read-only.
\`gh pr list -R ${REPO} --state open --limit 200 --json number,author,headRefName,headRefOid,labels,closingIssuesReferences\`. Keep only PRs authored by ${AUTHORS.join(' or ')} that do NOT carry ${HOLD_LABELS.join(' or ')}, and that are either:
(a) STALLED: labelled ${STALL_LABEL} → resume = the value of resume= in its latest comment starting with "${STALL_MARK}" (\`gh api repos/${REPO}/issues/<pr>/comments --paginate\`), defaulting to review; or
(b) ORPHANED by a run that died: labelled with any of ${Object.values(STAGE_LABELS).join(', ')} but not ${STALL_LABEL}, AND the linked issue's claim is not live. ${CLAIM_FORMAT}
  Read the issue's latest comment starting with "${CLAIM_MARK}"; the claim is not live if it is released or its heartbeat is ${STALE_HOURS}+ hours old (compute with \`date -u\`); if the issue has no claim comment, treat it as live (skip). Orphans always resume = review.
For each kept PR: issue = the first closingIssuesReferences number (skip the PR if none); head_sha = headRefOid; branch = headRefName.`,
  { label: 'resume:list', phase: 'Triage', model: M.worker, effort: 'low', schema: S_STALLED },
)
const toResume = (stalled ? stalled.prs : []).filter((r) => SHA_RE.test(r.head_sha))
if (toResume.length) log(`Resuming stalled/orphaned PRs: ${toResume.map((r) => `#${r.pr}(${r.resume})`).join(' ')}`)

if (A.dryRun || (!selected.length && !toResume.length)) {
  return { dryRun: !!A.dryRun, selected, skipped, resumable: toResume }
}

async function resumeLane(r) {
  const issue = { number: r.issue }
  const claim = await claimIssue(issue)
  if (!claim || !claim.won) return { issue: r.issue, pr: r.pr, merged: false, skipped: true, reason: `not claimed: ${claim ? claim.reason : 'claim agent died'}` }
  await setStage(issue, r.pr, r.resume === 'gate' ? 'merging' : 'review')
  return finishLane(issue, r.pr, r.branch, r.head_sha, { gateOnly: r.resume === 'gate' })
}
// Resumed lanes run alongside the new ones.
const resumedDone = parallel(toResume.map((r) => () => resumeLane(r)))

// ---------------------------------------------------------------------------
// Lanes: one pipeline item per issue, no barrier between issues
// ---------------------------------------------------------------------------
const results = await pipeline(
  selected,

  // 1. Claim (label + claim comment, oldest live claim wins), then plan (opus)
  async (issue) => {
    const claim = await claimIssue(issue)
    if (!claim || !claim.won) {
      log(`${tag(issue)} not claimed: ${claim ? claim.reason : 'claim agent died'}`)
      return { issue, done: { issue: issue.number, pr: null, merged: false, skipped: true, reason: `not claimed: ${claim ? claim.reason : 'claim agent died'}` } }
    }
    const plan = await stage(
    `You are the planner for ${REPO} issue #${issue.number}. Do not modify code. (This run already claimed the issue.)
${DETACHED(BASE)}
1. Read the issue and comments. Research the code thoroughly (AGENTS.md, docs/architecture.md, docs/contributing.md, the relevant layers). Find existing helpers to reuse.
2. Write a DETAILED implementation plan a cheaper model can follow mechanically: exact files, symbols and line ranges to change (quote the current snippet for each edit), code-level steps, tests to add (tests/… or gui/web Vitest), docs to update per the AGENTS.md "Docs in sync" table, and verify_cmds: concrete targeted commands naming the exact files/tests for this change, following: ${VERIFY}
3. List related_issues: other open issues this work touches, overlaps or partially addresses but does NOT fully close (\`gh issue list -R ${REPO} --search <keywords>\`).
4. Choose a branch name type/short-kebab (feat|fix|docs|chore|refactor|test).
5. Post the plan on the issue as a comment wrapped in <details><summary>Implementation plan</summary>…</details>.
If the issue needs an owner decision or is too large for one PR, set abort=true with abort_reason instead of planning.`,
    { label: `plan:${tag(issue)}`, phase: 'Plan', model: M.senior, effort: 'high', isolation: 'worktree', schema: S_PLAN },
    )
    return { issue, plan }
  },

  // 2. Implement + open PR (sonnet)
  async ({ issue, plan, done }) => {
    if (done) return { issue, done }
    if (!plan) return { issue, done: await stallOrInterrupt(issue, null, 'planner agent died') }
    if (plan.abort) return { issue, done: await holdForDecision(issue, null, plan.abort_reason || 'The planner could not plan this issue without an owner decision.', 'Planner aborted before implementation; see its comment on the issue.') }
    await setStage(issue, null, 'implementing')
    const pr = await stage(
      `Implement ${REPO} issue #${issue.number} by following this plan EXACTLY. Do not redesign; if the plan is impossible, return ok=false with the reason.
${DETACHED(BASE)}
${SETUP}
Branch: ${plan.branch} (if it already exists on origin, append -2, -3, …).
PLAN:
${plan.plan_md}
${LEAN_TURNS}
Steps: implement code + tests + docs; run ${plan.verify_cmds.join(' && ')}; fix failures; commit (conventional message, repo style); \`git push origin HEAD:refs/heads/<branch>\`; then \`gh pr create -R ${REPO} --base main --head <branch>\` with a summary, a test plan, and these issue-link lines verbatim, each on its own line:
${LINKS(issue.number, plan.related_issues)}
End the PR body with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".
Return ok, pr number, branch, head_sha.`,
      { label: `impl:${tag(issue)}`, phase: 'Implement', model: M.worker, isolation: 'worktree', schema: S_PR },
    )
    if (!pr || !pr.ok) return { issue, done: await (pr ? stall : stallOrInterrupt)(issue, null, `implementation failed: ${pr ? pr.error : 'agent died'}`) }
    log(`${tag(issue)} → PR #${pr.pr}`)
    await setStage(issue, pr.pr, 'review')
    return { issue, pr }
  },

  // 3. CI → review/feedback rounds → gate → merge
  (lane) => (lane.done ? lane.done : finishLane(lane.issue, lane.pr.pr, lane.pr.branch, lane.pr.head_sha)),
)

// Code-changing agents keep their isolated worktrees (.claude/worktrees/wf_*), each with its
// own .venv / node_modules. Once every lane has merged or been held, remove the ones whose
// work is safely on origin; anything with unpushed or uncommitted work is left and reported.
const resumed = await resumedDone
phase('Cleanup')
// Lanes that crashed never reached release; free their issues for other runs/agents.
for (const n of [...claims.keys()].filter((k) => !interrupted.has(k))) {
  log(`#${n}: releasing claim left by a crashed lane`)
  await releaseClaim({ number: n }, null, 'crashed')
}
const S_CLEANUP = {
  type: 'object',
  properties: {
    before: { type: 'integer' },
    after: { type: 'integer' },
    removed: { type: 'array', items: { type: 'string' } },
    kept: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'reason'] } },
  },
  required: ['before', 'after', 'removed', 'kept'],
}
const cleanup = await stage(
  `Clean up finished issue-pipeline worktrees in this repository. Only touch worktrees whose path contains "/.claude/worktrees/wf_" (from \`git worktree list --porcelain\`); never touch any other worktree or the main checkout.
First record before = the number of wf_ worktrees. For each wf_ worktree:
- If \`git -C <path> status --porcelain\` is non-empty → keep it (reason: uncommitted changes).
- Else if its HEAD commit is on no branch at all (\`git branch -a --contains <sha>\` is empty) → keep it (reason: unpushed commits). A squash-merged PR's commits count as fine when a local or remote branch still contains them.
- Else \`git worktree remove <path>\`.
Then \`git worktree prune\` and record after = the number of wf_ worktrees left. Return before, after, removed paths and kept paths with reasons. Actually run the commands; the caller checks that before - after equals the number removed.`,
  { label: 'cleanup:worktrees', phase: 'Cleanup', model: M.worker, effort: 'low', schema: S_CLEANUP },
)
if (cleanup && cleanup.before - cleanup.after !== cleanup.removed.length) {
  log(`Cleanup counts do not add up (before ${cleanup.before}, after ${cleanup.after}, removed ${cleanup.removed.length}); check \`git worktree list\``)
}
if (cleanup) {
  log(`Cleanup: removed ${cleanup.removed.length} worktree(s)${cleanup.kept.length ? `; kept ${cleanup.kept.map((k) => `${k.path} (${k.reason})`).join(', ')}` : ''}`)
}

return {
  worktrees: cleanup ? { removed: cleanup.removed.length, kept: cleanup.kept } : 'cleanup agent died',
  selected: selected.map((s) => s.number),
  skipped: skipped.map((s) => ({ number: s.number, actionable: s.actionable, size: s.size, reason: s.reason })),
  lanes: results.map((r, i) => r || { issue: selected[i].number, merged: false, held: true, reason: 'lane crashed' }),
  resumed: resumed.map((r, i) => r || { pr: toResume[i].pr, merged: false, held: true, reason: 'resume lane crashed' }),
}
