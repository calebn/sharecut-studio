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
    assert {"do-not-merge", "needs-user-input", "in-progress", "epic"} <= skip


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
    assert lens_fn.index("${packet.packet_md}") < lens_fn.index("${lens.key}")
    assert "If the packet shows no surface for your lens, return an empty findings list" in lens_fn
    review_fn = script[script.index("async function review(") :]
    assert review_fn.index("await reviewPacket(") < review_fn.index("lensReview(")


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
