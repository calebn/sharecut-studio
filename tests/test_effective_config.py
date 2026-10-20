from __future__ import annotations

import ast
from pathlib import Path

import pytest

from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document import EditService, PlayService
from podcast_mcp.services.pipeline.config import config_store


@pytest.fixture
def staged_ceiling(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    store = config_store()
    store.put(
        ws.path,
        config={"mix": {"premix_peak_ceiling_db": -3.5}, "tighten": {"edit_mode": "mute"}},
    )
    try:
        yield ws
    finally:
        store._by_path.pop(store._key(ws.path), None)


def test_propose_tighten_reads_the_staged_working_set(staged_ceiling, monkeypatch):
    seen: dict = {}

    def capture(project, defaults, **_kwargs):
        seen.update(defaults)
        raise RuntimeError("stop after capture")

    monkeypatch.setattr("podcast_mcp.services.document.edit.propose_tighten_edits", capture)
    with pytest.raises(RuntimeError, match="stop after capture"):
        EditService(staged_ceiling).propose_tighten()
    assert seen["tighten"]["edit_mode"] == "mute"


def test_play_service_reads_the_staged_working_set(staged_ceiling):
    assert PlayService(staged_ceiling)._defaults["mix"]["premix_peak_ceiling_db"] == -3.5


_DOMAIN_PACKAGES = ("edits", "engines")


def _load_defaults_calls(source: str) -> list[int]:
    return [
        node.lineno
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Call)
        and getattr(node.func, "id", getattr(node.func, "attr", None)) == "load_defaults"
    ]


def test_domain_packages_never_read_the_shipped_defaults() -> None:
    root = Path(__file__).resolve().parents[1] / "src" / "podcast_mcp"
    offenders = {
        str(path.relative_to(root)): lines
        for package in _DOMAIN_PACKAGES
        for path in sorted((root / package).rglob("*.py"))
        if (lines := _load_defaults_calls(path.read_text(encoding="utf-8")))
    }
    assert offenders == {}


def test_the_governance_check_sees_a_fallback() -> None:
    assert _load_defaults_calls("cfg = defaults or load_defaults()") == [1]
    assert _load_defaults_calls("cfg = config.load_defaults()") == [1]
    assert _load_defaults_calls("cfg = defaults") == []
