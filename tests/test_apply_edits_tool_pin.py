"""apply_edits keeps its replies, errors and effects (#1847)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from pause_policy_public_helpers import (
    add_bed,
    configure,
    defaults,
    pause,
    project,
    room,
    voice,
    workspace,
    write_wav,
)
from podcast_mcp.cli.main import app
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.mcp.tools import edits as mcp_edits
from podcast_mcp.mcp.tools.history import history_status_tool, history_undo
from podcast_mcp.models import Clip, Transcript, TranscriptWord, load_project, save_project
from podcast_mcp.util.coded_error import CodedError

_runner = CliRunner()


def _filler(edit_id: str = "filler", *, start: float = 3.0, end: float = 3.4):
    return pause(edit_id, start=start, end=end, gap=None).model_copy(update={"reason": "filler:um"})


def _path(tmp_path: Path, edits: list, *, refined: bool = True) -> str:
    root = tmp_path / "ws"
    root.mkdir()
    result = project(root)
    add_bed(result, root)
    result.edit_decisions = edits
    if refined:
        return str(workspace(result).path)
    return str(save_project(result))


def _normalised(path: str) -> list[tuple]:
    rows = (
        (
            c.track_id,
            c.source_id,
            round(c.source_start, 6),
            round(c.source_end, 6),
            round(c.timeline_start, 6),
        )
        for c in load_project(Path(path)).clips
    )
    return sorted(rows, key=lambda row: (row[0], row[4], row[2]))


def _pending_ids(path: str) -> list[str]:
    return [e.id for e in load_project(Path(path)).edit_decisions]


def _history(path: str) -> dict:
    return json.loads(history_status_tool(path))


def _held_path(tmp_path: Path, edits: list) -> str:
    result = project(tmp_path, guest="quiet")
    for index, track in enumerate(result.tracks):
        audio = room(seed=1240 + index)
        for start, end in ((0, 0.2), (5, 5.2), (5.4, 5.8)):
            voice(audio, start, end)
        write_wav(tmp_path / "raw" / f"{track.id}.wav", audio)
    result.transcripts = [
        Transcript(
            track_id=track.id,
            words=[
                TranscriptWord(text="before", start=0, end=0.2),
                TranscriptWord(text="after", start=5, end=5.2),
                TranscriptWord(text="reference", start=5.4, end=5.8),
            ],
        )
        for track in result.tracks
    ]
    result.clips.append(
        Clip(
            id="replayed-host",
            track_id="host",
            source_start=0.3,
            source_end=4.45,
            timeline_start=9,
        )
    )
    result.timeline.duration_sec = 13.15
    result.edit_decisions = edits
    return str(workspace(result).path)


@pytest.fixture(autouse=True)
def _config(monkeypatch):
    configure(monkeypatch, defaults())


def test_reply_keeps_operation_and_applied_count_for_applied_edits(tmp_path):
    path = _path(tmp_path, [pause("pause", start=0.3, end=2.0), _filler()])
    reply = json.loads(mcp_edits.apply_edits(path))
    assert reply == {"operation": "apply_auto_edits", "applied_count": 2}


def test_reply_keeps_its_shape_when_nothing_applies(tmp_path):
    path = _path(tmp_path, [])
    reply = json.loads(mcp_edits.apply_edits(path))
    assert reply == {"operation": "apply_auto_edits", "applied_count": 0}


def test_applied_edits_become_ripple_removals_in_the_clip_list(tmp_path):
    path = _path(tmp_path, [pause("pause", start=0.3, end=2.0), _filler()])
    assert _normalised(path) == [("host", None, 0.0, 6.0, 0.0)]
    mcp_edits.apply_edits(path)
    assert _normalised(path) == [
        ("host", None, 0.0, 0.3, 0.0),
        ("host", None, 2.0, 3.0, 0.3),
        ("host", None, 3.4, 6.0, 1.3),
    ]
    assert _pending_ids(path) == []


def test_only_unreviewed_filler_and_pause_edits_apply(tmp_path):
    reviewed = pause("reviewed", start=0.3, end=1.0).model_copy(update={"review_required": True})
    other = pause("other", start=4.0, end=4.5).model_copy(update={"reason": "manual:cut"})
    path = _path(tmp_path, [reviewed, other, _filler()])
    reply = json.loads(mcp_edits.apply_edits(path))
    assert reply["applied_count"] == 1
    assert _pending_ids(path) == ["reviewed", "other"]
    assert _normalised(path) == [
        ("host", None, 0.0, 3.0, 0.0),
        ("host", None, 3.4, 6.0, 3.0),
    ]


def test_applied_edits_are_one_history_step_and_undo_restores_the_clips(tmp_path):
    path = _path(tmp_path, [pause("pause", start=0.3, end=2.0), _filler()])
    before = _normalised(path)
    total = _history(path)["total"]
    mcp_edits.apply_edits(path)
    status = _history(path)
    assert status["total"] == total + 2
    assert status["current_label"] == "after apply auto edits"
    assert _normalised(path) != before
    history_undo(path)
    assert _normalised(path) == before
    assert _pending_ids(path) == ["pause", "filler"]


def test_nothing_to_apply_adds_no_history_step_and_changes_nothing(tmp_path):
    path = _path(tmp_path, [])
    before_bytes = Path(path).read_bytes()
    before_history = _history(path)
    reply = json.loads(mcp_edits.apply_edits(path))
    assert reply["applied_count"] == 0
    assert _history(path) == before_history
    assert Path(path).read_bytes() == before_bytes


def test_a_second_call_after_applying_adds_no_history_step(tmp_path):
    path = _path(tmp_path, [_filler()])
    mcp_edits.apply_edits(path)
    before_bytes = Path(path).read_bytes()
    before_history = _history(path)
    reply = json.loads(mcp_edits.apply_edits(path))
    assert reply["applied_count"] == 0
    assert _history(path) == before_history
    assert Path(path).read_bytes() == before_bytes


@pytest.mark.refine_gate
def test_unrefined_transcript_keeps_transcript_refine_required(tmp_path):
    path = _path(tmp_path, [_filler()], refined=False)
    assert not REFINE_GATE.is_clear(load_project(Path(path)))
    before_bytes = Path(path).read_bytes()
    with pytest.raises(CodedError) as raised:
        mcp_edits.apply_edits(path)
    assert raised.value.code == "transcript_refine_required"
    assert Path(path).read_bytes() == before_bytes
    assert _history(path)["total"] == 0


def test_a_cut_the_checks_hold_stays_pending_without_error_or_history(tmp_path, monkeypatch):
    configure(monkeypatch, defaults(acoustic=True))
    path = _held_path(tmp_path, [pause("held", start=0.2, end=4.7)])
    before_bytes = Path(path).read_bytes()
    reply = json.loads(mcp_edits.apply_edits(path))
    assert reply == {"operation": "apply_auto_edits", "applied_count": 0}
    assert _pending_ids(path) == ["held"]
    assert _history(path)["total"] == 0
    assert Path(path).read_bytes() == before_bytes


def test_a_held_cut_does_not_stop_the_eligible_cut_beside_it(tmp_path, monkeypatch):
    configure(monkeypatch, defaults(acoustic=True))
    eligible = pause("eligible", start=0.3, end=4.45, gap=None, track_id="guest")
    path = _held_path(tmp_path, [pause("held", start=0.2, end=4.7), eligible])
    reply = json.loads(mcp_edits.apply_edits(path))
    assert reply == {"operation": "apply_auto_edits", "applied_count": 1}
    assert _pending_ids(path) == ["held"]
    assert _history(path)["total"] == 2


def test_cli_apply_edits_command_applies_the_same_cuts(tmp_path):
    path = _path(tmp_path, [_filler()])
    result = _runner.invoke(app, ["apply-edits", "--project", path])
    assert result.exit_code == 0, result.output
    assert "Applied 1 auto edit decisions." in result.stdout
    assert _pending_ids(path) == []
    assert _normalised(path) == [
        ("host", None, 0.0, 3.0, 0.0),
        ("host", None, 3.4, 6.0, 3.0),
    ]
