"""Wire pin for TimelineService.delete_clips: every return shape, byte for byte (key
order, key presence, values), at the service, the DeleteClip handler, the document
command route and the CLI, so a typed-result refactor must leave them unchanged."""

from __future__ import annotations

import json
import re
import wave
from pathlib import Path

import numpy as np
import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import (
    Clip,
    CutIntent,
    EditMode,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.document_sync.handlers import edits as edit_handlers

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()

SR = 16_000
DUR = 30.0


def _write_wav(path: Path, signal: np.ndarray) -> None:
    data = (np.clip(signal, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes(data.tobytes())


def _tone(freq: float) -> np.ndarray:
    t = np.arange(int(DUR * SR)) / SR
    return 0.1 * np.sin(2 * np.pi * freq * t)


def _words(*rows: tuple[str, float, float, bool]) -> list[TranscriptWord]:
    return [
        TranscriptWord(text=text, start=start, end=end, suppressed=suppressed)
        for text, start, end, suppressed in rows
    ]


@pytest.fixture
def episode(minimal_project: Path) -> Path:
    """Host talks throughout; Guest is room tone except "so the plan" (10.1 s) and an
    untranscribed remark at 13.0-13.5 s. A suppressed bleed word sits at 16 s.

    Host has clips h1 (0-8) and h2 (8-20, continuous source); Guest has g1 (0-20).
    """
    project = load_project(minimal_project)
    raw = project.raw_dir()
    _write_wav(raw / "host.wav", _tone(220))
    guest = np.random.default_rng(7).normal(0.0, 0.0003, int(DUR * SR))
    remark = _tone(330)
    for start, end in ((10.0, 11.0), (13.0, 13.5)):
        guest[int(start * SR) : int(end * SR)] = remark[int(start * SR) : int(end * SR)]
    _write_wav(raw / "guest.wav", guest)
    project.timeline.tracks = [
        Track(
            id=tid,
            label=name,
            speaker=name,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=DUR, sample_rate=SR),
        )
        for tid, name in (("host", "Host"), ("guest", "Guest"))
    ]
    project.timeline.clips = [
        Clip(id="h1", track_id="host", source_start=0.0, source_end=8.0, timeline_start=0.0),
        Clip(id="h2", track_id="host", source_start=8.0, source_end=20.0, timeline_start=8.0),
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=20.0, timeline_start=0.0),
    ]
    project.timeline.duration_sec = 20.0
    project.transcripts = [
        Transcript(
            track_id="host",
            words=_words(("hello", 1.0, 1.4, False), ("world", 9.0, 9.5, False)),
        ),
        Transcript(
            track_id="guest",
            words=_words(
                ("so", 10.1, 10.3, False),
                ("the", 10.35, 10.5, False),
                ("plan", 10.55, 10.9, False),
                ("bleed", 16.0, 16.3, True),
            ),
        ),
    ]
    save_project(project)
    return minimal_project


def _clips(path: Path) -> dict[str, tuple[str, float, float, float]]:
    return {
        c.id: (c.track_id, c.source_start, c.source_end, c.timeline_start)
        for c in load_project(path).clips
    }


CUT_SPEECH = {
    "spans": [{"start": 8.0, "end": 20.0}],
    "tracks": [
        {
            "track_id": "guest",
            "speaker": "Guest",
            "words": [
                {"text": "so", "timeline_start": 10.1, "timeline_end": 10.3},
                {"text": "the", "timeline_start": 10.35, "timeline_end": 10.5},
                {"text": "plan", "timeline_start": 10.55, "timeline_end": 10.9},
            ],
            "sound_spans": [],
        }
    ],
}
HELD = {
    "operation": "ripple_delete_clips",
    "unchanged": True,
    "needs_confirmation": {
        "status": "needs_confirmation",
        "reason": "cuts_other_speech",
        "message": (
            'This also cuts Guest\'s speech at 0:10.1 ("so the plan"). '
            "Review this cut in Studio, or leave a gap to keep it."
        ),
        "speech": CUT_SPEECH,
    },
    "apply_anyway": (
        "To apply it as is, repeat the call with override_audio_checks=true "
        "(CLI --override-audio-checks)."
    ),
}
GAP_APPLIED = {
    "operation": "delete_clips",
    "affected_tracks": ["host"],
    "clip_count": 2,
    "timeline_duration_sec": 20.0,
    "clip_ids": ["h1"],
    "mode": "gap",
}
RIPPLE_APPLIED = {
    "operation": "ripple_delete_clips",
    "affected_tracks": ["host", "guest"],
    "clip_count": 2,
    "timeline_duration_sec": 12.0,
    "clip_ids": ["h1"],
    "mode": "ripple",
}
RIPPLE_APPLIED_SPEECH = {
    "operation": "ripple_delete_clips",
    "affected_tracks": ["host", "guest"],
    "clip_count": 2,
    "timeline_duration_sec": 8.0,
    "clip_ids": ["h2"],
    "mode": "ripple",
    "cut_speech": CUT_SPEECH,
}
DECISION_KEYS = [
    "id",
    "track_id",
    "type",
    "start",
    "end",
    "crossfade_ms",
    "reason",
    "author",
    "review_required",
    "applied",
    "cut_confidence",
    "boundary_mode",
    "replace_gap_sec",
    "next_burst_sec",
    "scope",
    "cut_speech",
    "track_ids",
    "timebase",
    "source_id",
    "source_timeline_span",
    "exact_range",
    "proposal_origin",
    "boundary_intent",
    "bound_pad",
]


def _edit(track_id, start, end, reason, scope, *, author=None, cut_speech=None) -> dict:
    return {
        "id": "<id>",
        "track_id": track_id,
        "type": "remove",
        "start": start,
        "end": end,
        "crossfade_ms": 10,
        "reason": reason,
        "author": author,
        "review_required": True,
        "applied": False,
        "cut_confidence": None,
        "boundary_mode": None,
        "replace_gap_sec": None,
        "next_burst_sec": None,
        "scope": scope,
        "cut_speech": cut_speech,
        "track_ids": None,
        "timebase": "source",
        "source_id": None,
        "source_timeline_span": None,
        "exact_range": None,
        "proposal_origin": "programmatic",
        "boundary_intent": "programmatic",
        "bound_pad": None,
    }


def _proposal(mode: str, *edits: dict) -> dict:
    return {"operation": "propose_delete_clips", "mode": mode, "edits": list(edits)}


def _normalized(result) -> dict:
    value = json.loads(json.dumps(result))
    for edit in value.get("edits", []):
        assert re.fullmatch(r"cut_[0-9a-f]{8}", edit["id"])
        assert list(edit) == DECISION_KEYS
        edit["id"] = "<id>"
    return value


def _pin(result, expected: dict) -> None:
    if hasattr(result, "model_dump"):
        result = result.model_dump()
    assert type(result) is dict
    actual = _normalized(result)
    assert list(actual) == list(expected)
    assert json.dumps(actual) == json.dumps(expected)


def _geometry(path: Path) -> list[tuple[str, float, float, float]]:
    return sorted(
        (c.track_id, c.source_start, c.source_end, c.timeline_start)
        for c in load_project(path).clips
    )


def _service(episode: Path) -> TimelineService:
    return TimelineService(ProjectWorkspace.open(episode))


def _submit(episode: Path, payload: dict, **kwargs) -> dict:
    out = DocumentSyncService.open(episode).submit(
        DocumentCommand(
            type="DeleteClip", payload=payload, client_id="c", role="viewer", client_seq=None
        ),
        **kwargs,
    )
    return out["command"]["payload"]["result"]


def _cli(episode: Path, *args: str):
    return runner.invoke(app, ["edit", "delete-clips", "--project", str(episode), *args])


GAP_H1 = _edit("host", 0.0, 8.0, "guest:suggest_delete", "track")
GAP_G1 = _edit("guest", 0.0, 20.0, "guest:suggest_delete", "track")
RIPPLE_H1 = _edit("host", 0.0, 8.0, "guest:suggest_ripple_delete", "session")
RIPPLE_H2 = _edit(
    "host",
    8.0,
    20.0,
    "guest:suggest_ripple_delete:acoustic_review:peer_speech",
    "session",
    cut_speech=CUT_SPEECH,
)


def test_service_propose_gap_one_clip(episode):
    _pin(
        _service(episode).delete_clips(["h1"], mode=EditMode.GAP, propose=True),
        _proposal("gap", GAP_H1),
    )
    assert _geometry(episode) == [
        ("guest", 0.0, 20.0, 0.0),
        ("host", 0.0, 8.0, 0.0),
        ("host", 8.0, 20.0, 8.0),
    ]


def test_service_propose_gap_several_clips_reason_and_author(episode):
    result = _service(episode).delete_clips(
        ["h1", "g1"], mode=EditMode.GAP, propose=True, reason="r", author="me"
    )
    _pin(
        result,
        _proposal(
            "gap",
            _edit("host", 0.0, 8.0, "r", "track", author="me"),
            _edit("guest", 0.0, 20.0, "r", "track", author="me"),
        ),
    )


def test_service_propose_ripple_without_and_with_cut_speech(episode):
    result = _service(episode).delete_clips(["h1", "h2"], mode=EditMode.RIPPLE, propose=True)
    _pin(result, _proposal("ripple", RIPPLE_H1, RIPPLE_H2))


def test_service_propose_ripple_single_clip_with_cut_speech(episode):
    result = _service(episode).delete_clips(["h2"], mode=EditMode.RIPPLE, propose=True)
    _pin(result, _proposal("ripple", RIPPLE_H2))


def test_service_propose_ripple_custom_reason_and_author(episode):
    result = _service(episode).delete_clips(
        ["h1"], mode=EditMode.RIPPLE, propose=True, reason="why", author="ann"
    )
    _pin(result, _proposal("ripple", _edit("host", 0.0, 8.0, "why", "session", author="ann")))


def test_service_apply_gap(episode):
    _pin(_service(episode).delete_clips(["h1"], mode=EditMode.GAP), GAP_APPLIED)
    assert _geometry(episode) == [("guest", 0.0, 20.0, 0.0), ("host", 8.0, 20.0, 8.0)]


def test_service_apply_gap_several_clips(episode):
    result = _service(episode).delete_clips(["h1", "g1"], mode=EditMode.GAP)
    _pin(
        result,
        {
            "operation": "delete_clips",
            "affected_tracks": ["guest", "host"],
            "clip_count": 1,
            "timeline_duration_sec": 20.0,
            "clip_ids": ["h1", "g1"],
            "mode": "gap",
        },
    )


def test_service_apply_ripple_without_cut_speech(episode):
    _pin(_service(episode).delete_clips(["h1"], mode=EditMode.RIPPLE), RIPPLE_APPLIED)


def test_service_apply_ripple_with_cut_speech(episode):
    result = _service(episode).delete_clips(
        ["h2"], mode=EditMode.RIPPLE, application_intent=CutIntent.HUMAN_BOUNDARIES
    )
    _pin(result, RIPPLE_APPLIED_SPEECH)
    assert _geometry(episode) == [("guest", 0.0, 8.0, 0.0), ("host", 0.0, 8.0, 0.0)]


def test_service_held_confirmation(episode):
    before = _geometry(episode)
    _pin(_service(episode).delete_clips(["h2"], mode=EditMode.RIPPLE), HELD)
    assert _geometry(episode) == before


def test_handler_propose_and_apply(episode):
    ws = ProjectWorkspace.open(episode)
    proposed = edit_handlers.delete_clip(
        ws, {"clip_id": "h1", "mode": "gap", "_structural_mode": "propose", "_author": "ann"}
    )
    _pin(
        proposed,
        _proposal("gap", _edit("host", 0.0, 8.0, "guest:suggest_delete", "track", author="ann")),
    )
    _pin(edit_handlers.delete_clip(ws, {"clip_ids": ["h1"], "mode": "gap"}), GAP_APPLIED)


def test_handler_ripple_forms(episode):
    ws = ProjectWorkspace.open(episode)
    held = edit_handlers.delete_clip(ws, {"clip_ids": ["h2"], "mode": "ripple"})
    _pin(held, HELD)
    forced = edit_handlers.delete_clip(
        ws, {"clip_ids": ["h2"], "mode": "ripple", "_boundary_intent": "human_boundaries"}
    )
    _pin(forced, RIPPLE_APPLIED_SPEECH)


def test_command_route_commenter_proposes_gap_and_ripple(episode):
    commenter = {"capabilities": capabilities_for_role("commenter")}
    gap = _submit(episode, {"clip_id": "h1", "mode": "gap"}, **commenter)
    _pin(gap, _proposal("gap", GAP_H1))
    ripple = _submit(episode, {"clip_ids": ["h2"], "mode": "ripple"}, **commenter)
    _pin(ripple, _proposal("ripple", RIPPLE_H2))


def test_command_route_apply_gap(episode):
    _pin(_submit(episode, {"clip_ids": ["h1"], "mode": "gap"}), GAP_APPLIED)


def test_command_route_apply_ripple(episode):
    _pin(_submit(episode, {"clip_ids": ["h1"], "mode": "ripple"}), RIPPLE_APPLIED)


def test_command_route_held_confirmation(episode):
    before = _geometry(episode)
    _pin(_submit(episode, {"clip_ids": ["h2"], "mode": "ripple"}), HELD)
    assert _geometry(episode) == before


def test_cli_apply_gap(episode):
    result = _cli(episode, "--ids", "h1")
    assert result.exit_code == 0, result.output
    assert result.stdout == json.dumps(GAP_APPLIED, indent=2) + "\n"
    assert list(json.loads(result.stdout)) == list(GAP_APPLIED)


def test_cli_apply_ripple(episode):
    result = _cli(episode, "--ids", "h1", "--mode", "ripple")
    assert result.exit_code == 0, result.output
    assert result.stdout == json.dumps(RIPPLE_APPLIED, indent=2) + "\n"


def test_cli_apply_ripple_override_with_cut_speech(episode):
    result = _cli(episode, "--ids", "h2", "--mode", "ripple", "--override-audio-checks")
    assert result.exit_code == 0, result.output
    assert result.stdout == json.dumps(RIPPLE_APPLIED_SPEECH, indent=2) + "\n"
