from __future__ import annotations

import json

import pytest

from podcast_mcp.edits import suggested_actions
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.edit import EditService
from test_apply_suggested_actions import _project as _sound_project
from test_apply_suggested_unsure import _apply, _open

NORMAL = (
    '{"operation": "apply_suggested_actions", "applied": {"lower": 1, "leave": 1, "cut": 1}, '
    '"applied_count": 3, "cut_over_speaker": 0, "held": [], "held_unsure": [], '
    '"lowered_to_leave": 0, "summary": "Applied 1 lower, 1 leave, 1 cut."}'
)
HELD_UNSURE = (
    '{"operation": "apply_suggested_actions", "applied": {"cut": 2}, "applied_count": 2, '
    '"cut_over_speaker": 0, "held": ["uncle"], "held_unsure": ["uncle"], '
    '"lowered_to_leave": 0, "summary": "Applied 2 cut; 1 still pending (1 over an unsure word)."}'
)
ALL_HELD = (
    '{"operation": "apply_suggested_actions", "applied": {}, "applied_count": 0, '
    '"cut_over_speaker": 0, "held": ["uncle", "well"], "held_unsure": ["uncle", "well"], '
    '"lowered_to_leave": 0, "summary": "Applied nothing; 2 still pending '
    '(2 over an unsure word)."}'
)
REVISE_OVERRIDES = (
    '{"operation": "apply_suggested_actions", "applied": {"lower": 1, "leave": 1, "cut": 1}, '
    '"applied_count": 3, "cut_over_speaker": 0, "held": [], "held_unsure": [], '
    '"lowered_to_leave": 0, "summary": "Applied 1 lower, 1 leave, 1 cut."}'
)
REVISE_HELD_SOUND = (
    '{"operation": "apply_suggested_actions", "applied": {"leave": 1, "cut": 1}, '
    '"applied_count": 2, "cut_over_speaker": 0, "held": ["uncle"], "held_unsure": ["uncle"], '
    '"lowered_to_leave": 0, "summary": "Applied 1 leave, 1 cut; 1 still pending '
    '(1 over an unsure word)."}'
)


@pytest.fixture(autouse=True)
def _grant():
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


def _dump(out) -> str:
    return json.dumps(out if isinstance(out, dict) else out.model_dump())


def test_a_normal_apply_pins_the_exact_payload(tmp_path, sample_wav, monkeypatch) -> None:
    path = _sound_project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: True)
    out = EditService(ProjectWorkspace.open(path)).apply_suggested_actions()
    assert _dump(out) == NORMAL
    assert list(out.model_dump()) == [
        "operation",
        "applied",
        "applied_count",
        "cut_over_speaker",
        "held",
        "held_unsure",
        "lowered_to_leave",
        "summary",
    ]


def test_a_bulk_apply_with_held_unsure_pins_the_exact_payload(tmp_path) -> None:
    ws = _open(tmp_path)
    out = EditService(ws).apply_suggested_actions(skip_unsure=True)
    assert _dump(out) == HELD_UNSURE


def test_the_all_held_early_return_pins_the_exact_payload(tmp_path) -> None:
    ws = _open(tmp_path, ("uncle", 3.0, 3.2), ("well", 5.0, 5.2))
    before = ws.path.read_bytes()
    out = EditService(ws).apply_suggested_actions(skip_unsure=True)
    assert _dump(out) == ALL_HELD
    assert ws.path.read_bytes() == before


def test_revise_with_overrides_pins_the_exact_payload(tmp_path, sample_wav, monkeypatch) -> None:
    path = _sound_project(tmp_path, sample_wav)
    monkeypatch.setattr(suggested_actions, "another_speaker_over", lambda *_, **_kw: True)
    EditService(ProjectWorkspace.open(path)).apply_suggested_actions()
    out = EditService(ProjectWorkspace.open(path)).apply_suggested_actions(
        overrides={"um": "leave", "word": "cut"}, revise=True
    )
    assert _dump(out) == REVISE_OVERRIDES


def test_revise_with_an_override_and_a_held_sound_pins_the_exact_payload(tmp_path) -> None:
    ws = _open(tmp_path)
    EditService(ws).apply_suggested_actions()
    out = EditService(ProjectWorkspace.open(ws.path)).apply_suggested_actions(
        overrides={"edge": "leave"}, revise=True, skip_unsure=True
    )
    assert _dump(out) == REVISE_HELD_SOUND


def test_the_document_sync_handler_pins_the_exact_payload(tmp_path) -> None:
    held = _open(tmp_path / "held")
    assert _dump(_apply(held, skip_unsure=True)) == HELD_UNSURE
    every = _open(tmp_path / "every", ("uncle", 3.0, 3.2), ("well", 5.0, 5.2))
    assert _dump(_apply(every, skip_unsure=True)) == ALL_HELD
