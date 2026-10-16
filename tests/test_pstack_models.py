"""Committed pstack bake-in: never Fast, never xhigh/max effort."""

from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PSTACK_RELATIVE = (
    ".agents/rules/pstack-models.mdc",
    ".cursor/rules/pstack-models.mdc",
)
_FORBIDDEN_EFFORT = frozenset({"fast", "xhigh", "max"})


def _pstack_text() -> str:
    bodies = [(ROOT / relative).read_text(encoding="utf-8") for relative in PSTACK_RELATIVE]
    assert bodies[0] == bodies[1]
    return bodies[0]


def _role_slugs(text: str) -> list[str]:
    slugs: list[str] = []
    in_frontmatter = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped == "---":
            in_frontmatter = not in_frontmatter
            continue
        if in_frontmatter or not stripped or stripped.startswith("#"):
            continue
        _role, sep, values = line.partition(":")
        assert sep, f"expected role line with a colon: {line!r}"
        slugs.extend(part.strip() for part in values.split(",") if part.strip())
    return slugs


def test_pstack_models_files_exist_with_budget_and_swarm() -> None:
    text = _pstack_text()
    assert "description: pstack per-role model choices (overrides skill defaults)" in text
    assert "alwaysApply: true" in text
    assert "# budget: medium (high)" in text
    assert "swarm workers: grok-4.7-high" in text
    tracked = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-z", "--", *PSTACK_RELATIVE],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split("\0")
    assert [path for path in tracked if path] == list(PSTACK_RELATIVE)


def test_pstack_models_forbid_fast_xhigh_max_effort() -> None:
    for slug in _role_slugs(_pstack_text()):
        tokens = set(slug.split("-"))
        forbidden = sorted(tokens & _FORBIDDEN_EFFORT)
        assert forbidden == [], f"{slug} uses forbidden effort {forbidden}"
        assert "-fast" not in slug


def test_cursor_pstack_models_is_tracked_not_gitignored() -> None:
    tracked = subprocess.run(
        [
            "git",
            "-C",
            str(ROOT),
            "check-ignore",
            "--no-index",
            "-q",
            "--",
            ".cursor/rules/pstack-models.mdc",
        ],
        check=False,
    )
    assert tracked.returncode == 1
    ignored = subprocess.run(
        [
            "git",
            "-C",
            str(ROOT),
            "check-ignore",
            "--no-index",
            "-q",
            "--",
            ".cursor/not-pstack.json",
        ],
        check=False,
    )
    assert ignored.returncode == 0
