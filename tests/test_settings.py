from __future__ import annotations

import re
from pathlib import Path

import pytest

from podcast_mcp import settings

_ROOT = Path(__file__).resolve().parents[1]
_SRC = _ROOT / "src" / "podcast_mcp"
# The only module allowed to touch the process environment directly.
_ENVIRON_ALLOWLIST = {"settings.py"}
_DIRECT_READ = re.compile(
    r"\bos\.environ\b|\bos\.getenv\b|\bgetenv\(|from os import[^\n]*\benviron\b"
)


def test_only_the_settings_module_reads_the_process_environment() -> None:
    offenders = sorted(
        str(path.relative_to(_SRC))
        for path in _SRC.rglob("*.py")
        if path.name not in _ENVIRON_ALLOWLIST and _DIRECT_READ.search(path.read_text("utf-8"))
    )
    assert offenders == []


def test_setup_doc_lists_every_declared_variable() -> None:
    text = (_ROOT / "docs" / "setup.md").read_text("utf-8")
    start, end = "<!-- settings:start -->\n", "<!-- settings:end -->"
    block = text.split(start, 1)[1].split(end, 1)[0]
    assert block == settings.markdown_table()
    for variable in settings.VARIABLES:
        assert f"`{variable.name}`" in block


def test_every_package_reference_to_a_podcast_variable_is_declared() -> None:
    declared = {v.name for v in settings.VARIABLES}
    reference = re.compile(r'"(PODCAST_[A-Z0-9_]+|WHISPER_CPP_[A-Z_]+)"')
    unknown: set[str] = set()
    for path in _SRC.rglob("*.py"):
        if path.name == "settings.py":
            continue
        for name in reference.findall(path.read_text("utf-8")):
            if name not in declared and f"{name}_RPM" not in declared and not name.endswith("_"):
                unknown.add(f"{path.relative_to(_SRC)}:{name}")
    assert sorted(unknown) == []


def test_undeclared_variable_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_NOT_A_THING", "1")
    with pytest.raises(KeyError, match="PODCAST_NOT_A_THING"):
        settings.raw("PODCAST_NOT_A_THING")


def test_reads_are_live_and_typed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PODCAST_BATCH", raising=False)
    assert settings.raw("PODCAST_BATCH") is None
    assert settings.flag("PODCAST_BATCH") is False
    monkeypatch.setenv("PODCAST_BATCH", " YES ")
    assert settings.flag("PODCAST_BATCH") is True
    assert settings.text("PODCAST_BATCH") == "YES"
    assert settings.value("PODCAST_BATCH") == " YES "
    monkeypatch.setenv("PODCAST_BATCH", "maybe")
    assert settings.flag("PODCAST_BATCH") is False
    assert settings.flag("PODCAST_BATCH", default=True) is False
    monkeypatch.setenv("PODCAST_BATCH", "  ")
    assert settings.flag("PODCAST_BATCH", default=True) is True


def test_numbers_fall_back_on_junk(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_RPM", "12.5")
    assert settings.number("PODCAST_RATE_LIMIT_READ_RPM", 3) == 12.5
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_RPM", "fast")
    assert settings.number("PODCAST_RATE_LIMIT_READ_RPM", 3) == 3.0
    monkeypatch.setenv("PODCAST_GUI_MAX_BODY_BYTES", "0")
    assert settings.max_bytes("PODCAST_GUI_MAX_BODY_BYTES", 99) == 1
    monkeypatch.setenv("PODCAST_GUI_MAX_BODY_BYTES", "")
    assert settings.max_bytes("PODCAST_GUI_MAX_BODY_BYTES", 99) == 99


def test_export_reaches_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PODCAST_SESSION_TOKEN", raising=False)
    settings.export("PODCAST_SESSION_TOKEN", "abc")
    assert settings.environ()["PODCAST_SESSION_TOKEN"] == "abc"
    monkeypatch.delenv("PODCAST_SESSION_TOKEN")
