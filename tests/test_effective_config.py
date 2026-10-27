from __future__ import annotations

import ast
from pathlib import Path

import pytest

from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document import AlignAcceptService, EditService, PlayService
from podcast_mcp.services.media import TranscriptRefineService
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


@pytest.mark.parametrize(
    ("service_type", "mode_path"),
    [
        (TranscriptRefineService, ("analysis", "transcript_refine", "mode")),
        (AlignAcceptService, ("align", "accept", "mode")),
    ],
)
@pytest.mark.refine_gate
def test_review_gate_reports_use_project_effective_config_and_isolation(
    minimal_project: Path, tmp_path: Path, service_type, mode_path
):
    first = ProjectWorkspace.open(minimal_project)
    second = ProjectWorkspace.create(tmp_path / "other")
    store = config_store()

    def stage(workspace: ProjectWorkspace, mode: str) -> None:
        config = {mode_path[0]: {mode_path[1]: {mode_path[2]: mode}}}
        store.put(workspace.path, config=config)

    try:
        first_service = service_type(first)
        second_service = service_type(second)
        for report in (first_service.status(), first_service.brief()["status"]):
            assert report["mode"] == "waive_unattended"
            assert report["hint"]

        stage(first, "off")
        stage(second, "require")
        assert first.path != second.path
        assert first.effective_config()[mode_path[0]][mode_path[1]][mode_path[2]] == "off"
        assert second.effective_config()[mode_path[0]][mode_path[1]][mode_path[2]] == "require"

        for report in (first_service.status(), first_service.brief()["status"]):
            assert report["mode"] == "off"
            assert report["hint"] is None
        for report in (second_service.status(), second_service.brief()["status"]):
            assert report["mode"] == "require"
            assert report["hint"]
    finally:
        store._by_path.pop(store._key(first.path), None)
        store._by_path.pop(store._key(second.path), None)


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
