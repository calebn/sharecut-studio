"""The automated issue pipeline keeps its merge gate, posting guarantees, and docs in sync."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".claude" / "workflows" / "issue-pipeline.js"
CONTRIBUTING = ROOT / "docs" / "contributing.md"
TEST_WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"
SECRET_SCAN = ROOT / ".github" / "workflows" / "secret-scan.yml"


def _script() -> str:
    return WORKFLOW.read_text(encoding="utf-8")


def _js_string_list(name: str) -> list[str]:
    match = re.search(rf"const {name} = (?:[^\[\n]*\|\| )?\[([^\]]*)\]", _script())
    assert match, f"{name} not found"
    return re.findall(r"'([^']+)'", match.group(1))


def test_meta_is_named_and_first() -> None:
    script = _script()
    assert script.startswith("export const meta = {")
    assert "name: 'issue-pipeline'" in script


def test_required_checks_exist_as_ci_jobs() -> None:
    required = _js_string_list("REQUIRED_CHECKS")
    assert required == ["pytest", "frontend", "frontend-e2e", "gitleaks-history"]
    ci_text = TEST_WORKFLOW.read_text(encoding="utf-8") + SECRET_SCAN.read_text(encoding="utf-8")
    for job in required:
        assert re.search(rf"^\s+(?:{re.escape(job)}:|name: {re.escape(job)}\s*$)", ci_text, re.M), (
            job
        )


def test_merge_gate_holds_on_owner_labels_and_wont_do() -> None:
    assert _js_string_list("HOLD_LABELS") == ["needs-user-input", "do-not-merge"]
    script = _script()
    assert "unresolved review thread" in script
    assert "won't-do item(s) need owner sign-off" in script
    assert "--match-head-commit" in script
    assert "--rebase --delete-branch" in script
    assert "--squash" not in script
    assert "completed the pipeline's review gate" in script
    assert "merge permission denied:" in script


def test_triage_never_picks_held_or_claimed_issues() -> None:
    skip = set(_js_string_list("SKIP_LABELS"))
    assert {"do-not-merge", "needs-user-input", "epic"} <= skip
    # in-progress is handled by claim liveness, not a static skip.
    assert "in-progress" not in skip
    script = _script()
    assert "Live claim → exclude" in script
    assert "Stale claim with no open PR → release it" in script


def test_claims_coordinate_through_github_labels() -> None:
    script = _script()
    assert "const CLAIM_LABEL = 'in-progress'" in script
    assert "const STALE_HOURS = A.staleHours ?? 6" in script
    labels = re.search(r"const STAGE_LABELS = \{([^}]*)\}", script)
    assert labels
    assert re.findall(r"'(pipeline:[a-z]+)'", labels.group(1)) == [
        "pipeline:planning",
        "pipeline:implementing",
        "pipeline:review",
        "pipeline:merging",
    ]
    # Oldest live claim wins; a loser never strips the winner's labels.
    assert "the winner is the earliest created_at" in script
    assert "WITHOUT removing labels" in script
    # The lane claims before planning and stops when it loses.
    lane = script[script.index("const results = await pipeline(") :]
    assert lane.index("await claimIssue(issue)") < lane.index("You are the planner")
    # Every exit releases: merge, hold, and crashed lanes at the end of the run.
    assert "await releaseClaim(issue, pr, 'merged')" in script
    assert "await releaseClaim(issue, pr, 'needs-decision')" in script
    assert "await releaseClaim(issue, pr, 'stalled')" in script
    assert "releaseClaim({ number: n }, null, 'crashed')" in script
    for key in ("implementing", "review"):
        assert f"'{key}')" in lane, key
    finish = script[script.index("async function finishLane(") :]
    assert "await setStage(issue, pr, 'merging')" in finish


def test_only_owner_authored_issues_are_eligible() -> None:
    assert _js_string_list("AUTHORS") == ["calebn"]
    script = _script()
    assert "--author <login>" in script
    assert ".filter((s) => AUTHORS.includes(s.author))" in script


def test_review_and_feedback_run_skills_in_autonomous_mode() -> None:
    script = _script()
    assert "pr-multi-review/SKILL.md" in script
    assert "feedback/SKILL.md" in script
    assert script.count("AUTONOMOUS MODE") >= 3
    assert "POSTING IS MANDATORY" in script
    assert "verifyPosted(" in script
    assert "verifyReplies(" in script


def test_pr_body_links_issues_with_fixes_and_related() -> None:
    script = _script()
    assert "`Fixes #${fixes}`" in script
    assert "`Related #${n}`" in script
    assert '"Related #<new issue>"' in script


def test_local_checks_are_targeted_and_ci_is_the_full_gate() -> None:
    script = _script()
    assert "TARGETED local checks only" in script
    assert "Do NOT run make test, make test-web, make ci" in script
    assert "make test-fast" not in script
    assert "make worktree-setup" in script
    # CI is awaited once, at the merge gate (plus bounded fix attempts), not per round.
    assert script.count("await ensureGreen(") == 1
    assert "uv sync --all-extras" not in script


def test_cheap_tier_never_writes_code() -> None:
    """Haiku-tier agents only watch, verify, post and merge; code changes are sonnet/opus."""
    calls = re.findall(r"\{ label: [^\n]*model: M\.(\w+)[^\n]*\}", _script())
    assert calls, "no agent option blocks found"
    for line in re.findall(r"\{ label: [^\n]*model: M\.cheap[^\n]*\}", _script()):
        assert "isolation: 'worktree'" not in line, line


def test_ci_failures_are_classified_before_fixing() -> None:
    script = _script()
    assert "cause: { enum: ['pr', 'flaky', 'unrelated']" in script
    assert "--failed" in script


def test_no_merge_stops_before_the_merge_agent() -> None:
    script = _script()
    assert "const NO_MERGE = !!A.noMerge" in script
    assert script.index("if (NO_MERGE) {") < script.index("const m = await merge(")


def test_review_lenses_fan_out_from_the_script() -> None:
    """Workflow agents cannot spawn subagents, so the script runs the skill's lenses."""
    script = _script()
    keys = re.findall(r"\{ key: '(\w+)', section: '(\d)\. ", script)
    assert [k for k, _ in keys] == [
        "bugbot",
        "risk",
        "wiring",
        "reuse",
        "security",
        "concurrency",
        "performance",
        "patterns",
    ]
    skill_sections = [
        "1. Bugbot",
        "2. Risk hunt",
        "3. Wiring",
        "4. DRY",
        "5. Security",
        "6. Concurrency",
        "7. Performance",
        "8. Algorithms",
    ]
    for section in skill_sections:
        assert f"section: '{section}" in script, section
    assert "lenses=supplied" in script
    # Lenses are read-only and share one cwd (no worktree) so their prompts cache together.
    assert "phase: 'Review', model: M.worker, schema: S_LENS" in script
    assert len(re.findall(r"prompt: ['\"]", script)) == 8


def test_lenses_share_one_review_packet_prefix() -> None:
    script = _script()
    lens_fn = script[script.index("function lensReview(") : script.index("async function review(")]
    # The shared packet comes before anything lens-specific.
    assert lens_fn.index("${packetRead(packet)}") < lens_fn.index("${lens.key}")
    assert "If the packet shows no surface for your lens, return an empty findings list" in lens_fn
    review_fn = script[script.index("async function review(") :]
    assert review_fn.index("await reviewPacket(") < review_fn.index("lensReview(")


def test_context_hungry_lenses_have_required_reading() -> None:
    script = _script()
    lenses = script[script.index("const LENSES = [") : script.index("// Round 2+ only")]
    for key in ("wiring", "reuse", "security", "concurrency", "patterns"):
        block = lenses[lenses.index(f"key: '{key}'") :]
        block = block[: block.index("},")]
        assert "context: 'Required reading" in block, key
    assert "The packet is a starting point, not the boundary" in script
    packet_script = (ROOT / "scripts" / "review_packet.py").read_text(encoding="utf-8")
    assert "Twin paths (CLI / MCP / GUI adapters)" in packet_script


def test_packet_is_built_by_script_not_retyped() -> None:
    """Agents retyping a 30-40k-char packet cost more than lenses saved and sometimes failed."""
    script = _script()
    fn = script[script.index("function reviewPacket(") : script.index("const packetRead")]
    assert "git show origin/main:scripts/review_packet.py" in fn
    assert "model: M.cheap" in fn
    assert "PACKET_PATH_RE.test(p.path) && p.chars > 0" in fn
    assert "packet_md" not in script
    # A missing packet degrades to lenses exploring themselves, never to no review.
    assert "packet unavailable; lenses gather context themselves" in script


def test_ci_state_is_derived_from_raw_rows() -> None:
    script = _script()
    assert "const SHA_RE = /^[0-9a-f]{40}$/" in script
    assert "function ciState(ci)" in script
    assert "COPY its rows verbatim" in script
    # A moved head at the gate re-checks CI instead of holding the PR.
    assert "head moved to ${g.head_sha.slice(0, 8)}; re-checking CI" in script


def test_cleanup_counts_are_cross_checked() -> None:
    script = _script()
    assert "cleanup.before - cleanup.after !== cleanup.removed.length" in script
    assert "git branch -a --contains <sha>" in script


def test_triage_is_batched_text_only() -> None:
    script = _script()
    assert "const TRIAGE_BATCH = 10" in script
    assert "from their text only (do not read code)" in script
    assert "skim the code it touches" not in script


def test_prompts_state_provenance_without_authority_claims() -> None:
    """Authority claims read as prompt injection to subagents; state provenance instead."""
    script = _script()
    assert "which the user started from chat" in script
    for phrase in ("PRE-AUTHORIZED", "pre-authorized", "no human in this loop"):
        assert phrase not in script, phrase
    text = CONTRIBUTING.read_text(encoding="utf-8")
    assert "Launch every run with a chat message that names it" in text


def test_finished_worktrees_are_cleaned_up_safely() -> None:
    script = _script()
    # Cleanup runs after every lane finished, and only removes pushed, clean wf_ worktrees.
    assert script.index("const results = await pipeline(") < script.index("phase('Cleanup')")
    assert '"/.claude/worktrees/wf_"' in script
    assert "uncommitted changes" in script
    assert "unpushed commits" in script


def test_executing_agents_get_token_hygiene_guidance() -> None:
    script = _script()
    assert "const LEAN_TURNS = " in script
    # Implementer and feedback executor both get it; planners must quote snippets so they can.
    assert script.count("${LEAN_TURNS}") >= 2
    assert "quote the current snippet for each edit" in script
    assert "with the current snippet quoted" in script


def test_every_agent_gets_the_stage_context() -> None:
    """Stages without context tried to launch the pipeline from the user's chat message."""
    script = _script()
    # agent() is only called inside stage(), which prefixes provenance + stage-only guard.
    assert len(re.findall(r"\bagent\(", script)) == 1
    assert "return agent(`${AUTH}\\n${STAGE_ONLY}" in script
    assert (
        "never start, re-run or invoke the issue-pipeline or any other workflow yourself" in script
    )


def test_only_owner_questions_block_merging() -> None:
    """needs-user-input means a real question; technical failures stall and resume."""
    script = _script()
    assert "function hold(" not in script
    decision = script[
        script.index("async function holdForDecision(") : script.index("async function stall(")
    ]
    assert "needs-user-input" in decision
    assert "**Question:**" in decision
    stall_fn = script[script.index("async function stall(") : script.index("// pr-multi-review")]
    assert "needs-user-input" not in stall_fn
    assert "no decision needed" in stall_fn
    # Decision holds come only from won't-do, planner abort, or owner hold labels.
    assert script.count("holdForDecision(") == 3
    assert (
        "const decision = wontDo > 0 || (facts && facts.labels.some((l) => HOLD_LABELS.includes(l)))"
        in script
    )


def test_stalled_prs_resume_without_skipping_review() -> None:
    script = _script()
    assert "const STALL_LABEL = 'pipeline:stalled'" in script
    # Review-stage stalls resume at review; only gate stalls skip straight to the gate.
    assert script.count("'review')") >= 5
    assert "stall(issue, pr, blockers.join('; '), 'gate')" in script
    assert (
        "finishLane(issue, r.pr, r.branch, r.head_sha, { gateOnly: r.resume === 'gate' })" in script
    )
    assert "!gateOnly && round <= MAX_ROUNDS" in script
    # Resumed lanes re-claim the issue and never pick up PRs with owner hold labels.
    resume = script[script.index("async function resumeLane(") :]
    assert resume.index("await claimIssue(issue)") < resume.index("finishLane(")
    assert "that do NOT carry ${HOLD_LABELS.join(' or ')}" in script


def test_outages_do_not_mark_prs_stalled() -> None:
    script = _script()
    fn = script[
        script.index("async function stallOrInterrupt(") : script.index(
            "// A decision only the owner can make"
        )
    ]
    # A trivial probe tells a real agent failure from an outage that fails every agent.
    assert fn.index("Health check") < fn.index("return stall(")
    assert "interrupted.add(issue.number)" in fn
    # Every "agent returned nothing" path goes through the probe.
    for died in (
        "review round ${round} agent died",
        "feedback plan round ${round} agent died",
        "feedback execute round ${round} agent died",
        "'gate agent died'",
        "'planner agent died'",
    ):
        line = next(ln for ln in script.splitlines() if died in ln and "return" in ln)
        assert "stallOrInterrupt" in line, died
    # Interrupted lanes keep their claims (the crash sweep skips them).
    assert "[...claims.keys()].filter((k) => !interrupted.has(k))" in script


def test_orphaned_prs_from_dead_runs_are_adopted() -> None:
    script = _script()
    assert "(b) ORPHANED by a run that died" in script
    assert "Orphans always resume = review." in script
    assert "if the issue has no claim comment, treat it as live (skip)" in script


def test_model_tiers() -> None:
    script = _script()
    assert "const M = { cheap: 'haiku', worker: 'sonnet', senior: 'opus' }" in script


def test_contributing_documents_pipeline() -> None:
    text = CONTRIBUTING.read_text(encoding="utf-8")
    assert "### Automated issue pipeline" in text
    assert ".claude/workflows/issue-pipeline.js" in text
    for label in _js_string_list("HOLD_LABELS"):
        assert f"`{label}`" in text
    for check in _js_string_list("REQUIRED_CHECKS"):
        assert f"`{check}`" in text
    assert "Related #" in text
