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
    assert "--squash" in script
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
