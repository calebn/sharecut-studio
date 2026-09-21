"""Local hooks do not gate public pushes on the full CI suite."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_pre_push_ci_gate_is_not_installed() -> None:
    assert not (ROOT / ".githooks" / "pre-push").exists()


def test_hooks_target_installs_only_pre_commit() -> None:
    text = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert "chmod +x .githooks/pre-commit" in text
    assert "chmod +x .githooks/pre-commit .githooks/pre-push" not in text


def test_installer_installs_only_pre_commit() -> None:
    text = (ROOT / "install.sh").read_text(encoding="utf-8")
    assert "chmod +x .githooks/pre-commit" in text
    assert "chmod +x .githooks/pre-commit .githooks/pre-push" not in text


def test_make_ci_is_an_unstamped_local_mirror() -> None:
    text = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert "ci:\n\t@$(MAKE) --no-print-directory ci-body" in text
    assert "ci-stamp" not in text
