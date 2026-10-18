from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_conventional_commits.py"
_spec = importlib.util.spec_from_file_location("check_conventional_commits", SCRIPT)
assert _spec and _spec.loader
lint = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lint)


@pytest.mark.parametrize(
    "subject",
    [
        "feat: add a thing",
        "fix(gui): keep the drawer open (#1706)",
        "feat(api)!: drop the old route",
        "docs(release): name sign_updater",
    ],
)
def test_conventional_subjects_pass(subject: str) -> None:
    assert lint.SUBJECT.match(subject)


@pytest.mark.parametrize(
    "subject",
    [
        "Update stuff",
        "fix gui bug",
        "feat:missing space",
        "Fix: capitalised",
        "wip",
        "feat(): empty",
    ],
)
def test_other_subjects_fail(subject: str) -> None:
    assert not lint.SUBJECT.match(subject)


def test_revert_and_fixup_are_exempt() -> None:
    assert lint.EXEMPT.match('Revert "fix(x): y"')
    assert lint.EXEMPT.match("fixup! fix: y")


def test_release_as_footer_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    def git(*args: str) -> None:
        subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)

    git("init", "-q", "-b", "main")
    git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "chore: base",
    )
    git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "feat: x",
        "-m",
        "Release-As: 1.0.0",
    )
    git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "fix: ok",
    )
    monkeypatch.chdir(tmp_path)
    bad = lint.bad_subjects("HEAD~2..HEAD")
    assert len(bad) == 1 and "Release-As" in bad[0]
