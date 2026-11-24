"""Pin the wire output of ``TimelineService.trim_clip_edge``.

The service, the ``trim_clip_edge`` document handler, the ``TrimClipEdge`` document command,
the ``edit trim-clip`` CLI command (``json.dumps(indent=2)``) and ``trim_clip_edge_tool``
(``to_json``) return the same dict. Nothing is normalized: the projects are built in code over
generated sine tones, the clip times are explicit and only integers, strings and the clip
times themselves are pinned (no audio-derived floats).
"""

from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np
import pytest
from typer.testing import CliRunner

from history_helpers import history_move
from podcast_mcp.cli.main import app
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.mcp.tools.timeline import trim_clip_edge_tool
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
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document.boundary import TrimBoundaryTarget, boundary_context
from podcast_mcp.services.document_sync import (
    INTERACTIVE_COMMAND,
    DocumentCommand,
    DocumentSyncService,
)
from podcast_mcp.services.document_sync.handlers import edits as handlers
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()

SR = 16_000
DUR = 30.0
RIPPLE = EditMode.RIPPLE
GAP = EditMode.GAP

APPLIED_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "clip_id",
    "edge",
    "source_sec",
    "mode",
    "clip_ids",
]
SPEECH_KEYS = [*APPLIED_KEYS, "cut_speech"]
HELD_KEYS = ["operation", "unchanged", "needs_confirmation", "apply_anyway"]
APPLY_ANYWAY = (
    "To apply it as is, repeat the call with override_audio_checks=true "
    "(CLI --override-audio-checks)."
)
REVIEW = "Review this cut in Studio, or leave a gap to keep it."
GUEST_WORDS = 'This also cuts Guest\'s speech at 0:10.1 ("so the plan"). '
UNCHANGED = {"operation": "trim_clip_edge", "unchanged": True}
STALE = "boundary preview is stale; reload and listen again"

# (id, track, source_start, source_end, timeline_start)
BASE = [
    ("h1", "host", 0.0, 8.0, 0.0),
    ("h2", "host", 8.0, 20.0, 8.0),
    ("g1", "guest", 0.0, 20.0, 0.0),
]
SOURCE_GAP = [
    ("h1", "host", 0.0, 8.0, 0.0),
    ("h2", "host", 10.0, 20.0, 8.0),
    ("g1", "guest", 0.0, 20.0, 0.0),
]
SESSION_JOIN = [
    ("h1", "host", 0.0, 8.0, 0.0),
    ("h2", "host", 10.0, 20.0, 8.0),
    ("g1", "guest", 0.0, 8.0, 0.0),
    ("g2", "guest", 10.0, 20.0, 8.0),
]
TIMELINE_GAP = [
    ("h1", "host", 0.0, 8.0, 0.0),
    ("h2", "host", 10.0, 20.0, 9.0),
    ("g1", "guest", 0.0, 20.0, 0.0),
]
GUEST_PAST = [
    ("h1", "host", 0.0, 8.0, 0.0),
    ("h2", "host", 8.0, 20.0, 8.0),
    ("g1", "guest", 0.0, 25.0, 0.0),
]
LAYOUTS = {
    "base": BASE,
    "source_gap": SOURCE_GAP,
    "session_join": SESSION_JOIN,
    "timeline_gap": TIMELINE_GAP,
    "guest_past": GUEST_PAST,
}


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


def _build(minimal_project: Path, layout: str = "base") -> Path:
    """Host talks throughout; Guest is silent except "so the plan" (10.1 s) and an
    untranscribed remark at 13.0-13.5 s. A suppressed bleed word sits at 16 s."""
    project = load_project(minimal_project)
    raw = project.raw_dir()
    _write_wav(raw / "host.wav", _tone(220))
    guest = np.zeros(int(DUR * SR))
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
        Clip(id=cid, track_id=tid, source_start=s, source_end=e, timeline_start=ts)
        for cid, tid, s, e, ts in LAYOUTS[layout]
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


@pytest.fixture
def build(minimal_project):
    return lambda layout="base": _build(minimal_project, layout)


def _token(path: Path, clip: str, edge: str, mode: EditMode) -> str:
    return boundary_context(
        load_project(path),
        TrimBoundaryTarget(clip_id=clip, edge=edge, mode=mode),
        defaults=load_defaults(),
    ).token


def _service_trim(path: Path, clip: str, edge: str, sec: float, mode: EditMode, **kw) -> dict:
    return TimelineService(ProjectWorkspace.open(path)).trim_clip_edge(
        clip, edge, sec, mode=mode, expected_token=_token(path, clip, edge, mode), **kw
    )


def _human(path: Path, clip: str, edge: str, sec: float, mode: EditMode) -> dict:
    return _service_trim(path, clip, edge, sec, mode, application_intent=CutIntent.HUMAN_BOUNDARIES)


def _text(value) -> str:
    return json.dumps(value)


def _geometry(path: Path) -> list[tuple]:
    return sorted(
        (c.track_id, c.id, c.source_start, c.source_end, c.timeline_start)
        for c in load_project(path).clips
    )


def _history_len(path: Path) -> int:
    return len(load_project(path).history.entries)


def _applied(
    *,
    tracks: list[str],
    count: int,
    duration: float,
    clip: str,
    edge: str,
    sec: float,
    mode: str,
    ids: list[str],
    speech: dict | None = None,
) -> dict:
    out = {
        "operation": "trim_clip_edge",
        "affected_tracks": tracks,
        "clip_count": count,
        "timeline_duration_sec": duration,
        "clip_id": clip,
        "edge": edge,
        "source_sec": sec,
        "mode": mode,
        "clip_ids": ids,
    }
    if speech is not None:
        out["cut_speech"] = speech
    return out


def _both(count: int, duration: float, clip: str, edge: str, sec: float, ids=None) -> dict:
    return _applied(
        tracks=["host", "guest"],
        count=count,
        duration=duration,
        clip=clip,
        edge=edge,
        sec=sec,
        mode="ripple",
        ids=ids or [clip],
    )


def _host_gap(count: int, duration: float, clip: str, edge: str, sec: float) -> dict:
    return _applied(
        tracks=["host"],
        count=count,
        duration=duration,
        clip=clip,
        edge=edge,
        sec=sec,
        mode="gap",
        ids=[clip],
    )


def _guest_speech(start: float, end: float) -> dict:
    words = [
        {"text": "so", "timeline_start": 10.1, "timeline_end": 10.3},
        {"text": "the", "timeline_start": 10.35, "timeline_end": 10.5},
        {"text": "plan", "timeline_start": 10.55, "timeline_end": 10.9},
    ]
    return {
        "spans": [{"start": start, "end": end}],
        "tracks": [
            {
                "track_id": "guest",
                "speaker": "Guest",
                "words": words,
                "sound_spans": [],
            }
        ],
    }


def _held(start: float, end: float, *, message: str, words=True, sounds=()) -> dict:
    speech = _guest_speech(start, end)
    if not words:
        speech["tracks"][0]["words"] = []
        speech["tracks"][0]["sound_spans"] = [{"start": a, "end": b} for a, b in sounds]
    return {
        "operation": "trim_clip_edge",
        "unchanged": True,
        "needs_confirmation": {
            "status": "needs_confirmation",
            "reason": "cuts_other_speech",
            "message": message,
            "speech": speech,
        },
        "apply_anyway": APPLY_ANYWAY,
    }


# (case id, layout, clip, edge, source_sec, mode, expected)
APPLIED_CASES = [
    ("ripple-out-shrink", "base", "h1", "out", 6.0, RIPPLE, _both(4, 18.0, "h1", "out", 6.0)),
    ("ripple-in-shrink", "base", "h2", "in", 9.0, RIPPLE, _both(4, 19.0, "h2", "in", 9.0)),
    (
        "ripple-out-extend",
        "source_gap",
        "h1",
        "out",
        9.0,
        RIPPLE,
        _both(4, 21.0, "h1", "out", 9.0),
    ),
    (
        "ripple-in-extend",
        "source_gap",
        "h2",
        "in",
        9.0,
        RIPPLE,
        _both(4, 21.0, "h2", "in", 9.0),
    ),
    (
        "ripple-out-extend-session-join",
        "session_join",
        "h1",
        "out",
        9.0,
        RIPPLE,
        _both(4, 19.0, "h1", "out", 9.0, ["h1", "g1"]),
    ),
    (
        "ripple-out-clamped-to-min-clip",
        "base",
        "h1",
        "out",
        -5.0,
        RIPPLE,
        _both(4, 12.05, "h1", "out", 0.05),
    ),
    (
        "ripple-no-bleed-confirmation",
        "base",
        "h2",
        "out",
        14.0,
        RIPPLE,
        _both(3, 14.0, "h2", "out", 14.0, ["h2", "g1"]),
    ),
    ("gap-out-shrink", "base", "h2", "out", 18.0, GAP, _host_gap(3, 20.0, "h2", "out", 18.0)),
    ("gap-in-shrink", "base", "h2", "in", 9.0, GAP, _host_gap(3, 20.0, "h2", "in", 9.0)),
    (
        "gap-out-extend",
        "timeline_gap",
        "h1",
        "out",
        8.5,
        GAP,
        _host_gap(3, 20.0, "h1", "out", 8.5),
    ),
    (
        "gap-out-extend-clamped",
        "timeline_gap",
        "h1",
        "out",
        12.0,
        GAP,
        _host_gap(3, 20.0, "h1", "out", 9.0),
    ),
    (
        "gap-in-extend",
        "timeline_gap",
        "h2",
        "in",
        9.5,
        GAP,
        _host_gap(3, 20.0, "h2", "in", 9.5),
    ),
    (
        "gap-in-extend-clamped",
        "timeline_gap",
        "h2",
        "in",
        2.0,
        GAP,
        _host_gap(3, 20.0, "h2", "in", 9.0),
    ),
]
APPLIED_IDS = [case[0] for case in APPLIED_CASES]

UNCHANGED_CASES = [
    ("ripple-same-edge", "base", "h1", "out", 8.0, RIPPLE),
    ("gap-no-room-out", "base", "h1", "out", 9.0, GAP),
    ("gap-no-room-out-far", "source_gap", "h1", "out", 12.0, GAP),
    ("gap-no-room-in", "source_gap", "h2", "in", 9.0, GAP),
]
UNCHANGED_IDS = [case[0] for case in UNCHANGED_CASES]

HELD_CASES = [
    (
        "words-out",
        "base",
        "h2",
        "out",
        10.0,
        _held(10.0, 20.0, message=GUEST_WORDS + REVIEW),
    ),
    (
        "words-in",
        "guest_past",
        "h2",
        "in",
        12.0,
        _held(8.0, 12.0, message=GUEST_WORDS + REVIEW),
    ),
    (
        "sound-without-words",
        "base",
        "h2",
        "out",
        12.5,
        _held(
            12.5,
            20.0,
            message="This also cuts Guest's speech at 0:13.0. " + REVIEW,
            words=False,
            sounds=[(13.0, 13.5)],
        ),
    ),
]
HELD_IDS = [case[0] for case in HELD_CASES]

CONFIRMED_CASES = [
    (
        "out-peer-edge-moves",
        "base",
        "h2",
        "out",
        10.0,
        _applied(
            tracks=["host", "guest"],
            count=3,
            duration=10.0,
            clip="h2",
            edge="out",
            sec=10.0,
            mode="ripple",
            ids=["h2", "g1"],
            speech=_guest_speech(10.0, 20.0),
        ),
    ),
    (
        "out-guest-continues",
        "guest_past",
        "h2",
        "out",
        10.0,
        _applied(
            tracks=["host", "guest"],
            count=4,
            duration=15.0,
            clip="h2",
            edge="out",
            sec=10.0,
            mode="ripple",
            ids=["h2"],
            speech=_guest_speech(10.0, 20.0),
        ),
    ),
    (
        "in-edge",
        "guest_past",
        "h2",
        "in",
        12.0,
        _applied(
            tracks=["host", "guest"],
            count=4,
            duration=21.0,
            clip="h2",
            edge="in",
            sec=12.0,
            mode="ripple",
            ids=["h2"],
            speech=_guest_speech(8.0, 12.0),
        ),
    ),
]
CONFIRMED_IDS = [case[0] for case in CONFIRMED_CASES]


def _cli(path: Path, clip: str, edge: str, sec: str, *extra: str):
    return runner.invoke(
        app,
        [
            "edit",
            "trim-clip",
            "--project",
            str(path),
            "--clip",
            clip,
            "--edge",
            edge,
            "--source-sec",
            sec,
            *extra,
        ],
    )


def _submit(path: Path, command_type: str, payload: dict, **kwargs) -> dict:
    return DocumentSyncService.open(path).submit(
        DocumentCommand(
            type=command_type, payload=payload, client_id="t", client_seq=None, role="viewer"
        ),
        **kwargs,
    )


def _payload(path: Path, clip: str, edge: str, sec: float, mode: EditMode, **extra) -> dict:
    return {
        "clip_id": clip,
        "edge": edge,
        "source_sec": sec,
        "mode": mode.value,
        "expected_token": _token(path, clip, edge, mode),
        **extra,
    }


# ------------------------------------------------------------------ service: applied shapes


@pytest.mark.parametrize(
    ("layout", "clip", "edge", "sec", "mode", "expected"),
    [case[1:] for case in APPLIED_CASES],
    ids=APPLIED_IDS,
)
def test_service_applied_shapes(build, layout, clip, edge, sec, mode, expected):
    path = build(layout)
    result = _service_trim(path, clip, edge, sec, mode)
    assert list(result) == APPLIED_KEYS
    assert _text(result) == _text(expected)
    assert isinstance(result["clip_count"], int)
    assert isinstance(result["source_sec"], float)


def test_service_ripple_shrink_pinned_text(build):
    result = _service_trim(build(), "h1", "out", 6.0, RIPPLE)
    assert _text(result) == (
        '{"operation": "trim_clip_edge", "affected_tracks": ["host", "guest"], '
        '"clip_count": 4, "timeline_duration_sec": 18.0, "clip_id": "h1", "edge": "out", '
        '"source_sec": 6.0, "mode": "ripple", "clip_ids": ["h1"]}'
    )


def test_service_gap_extend_pinned_text(build):
    result = _service_trim(build("timeline_gap"), "h2", "in", 9.5, GAP)
    assert _text(result) == (
        '{"operation": "trim_clip_edge", "affected_tracks": ["host"], "clip_count": 3, '
        '"timeline_duration_sec": 20.0, "clip_id": "h2", "edge": "in", "source_sec": 9.5, '
        '"mode": "gap", "clip_ids": ["h2"]}'
    )


def test_service_applied_geometry(build):
    path = build()
    _service_trim(path, "h1", "out", 6.0, RIPPLE)
    assert sorted((t, s, e, ts) for t, _, s, e, ts in _geometry(path)) == [
        ("guest", 0.0, 6.0, 0.0),
        ("guest", 8.0, 20.0, 6.0),
        ("host", 0.0, 6.0, 0.0),
        ("host", 8.0, 20.0, 6.0),
    ]


def test_service_applied_records_a_before_and_after_history_pair(build):
    path = build()
    before = _history_len(path)
    _service_trim(path, "h1", "out", 6.0, RIPPLE)
    assert _history_len(path) == before + 2


# ------------------------------------------------------------------ service: unchanged


@pytest.mark.parametrize(
    ("layout", "clip", "edge", "sec", "mode"),
    [case[1:] for case in UNCHANGED_CASES],
    ids=UNCHANGED_IDS,
)
def test_service_unchanged_shortcut(build, layout, clip, edge, sec, mode):
    path = build(layout)
    before, entries = _geometry(path), _history_len(path)
    result = _service_trim(path, clip, edge, sec, mode)
    assert list(result) == ["operation", "unchanged"]
    assert _text(result) == '{"operation": "trim_clip_edge", "unchanged": true}'
    assert result["unchanged"] is True
    assert _geometry(path) == before
    assert _history_len(path) == entries


# ------------------------------------------------------------------ service: speech guard


@pytest.mark.parametrize(
    ("layout", "clip", "edge", "sec", "expected"),
    [case[1:] for case in HELD_CASES],
    ids=HELD_IDS,
)
def test_service_speech_guard_holds_and_changes_nothing(build, layout, clip, edge, sec, expected):
    path = build(layout)
    before, entries = _geometry(path), _history_len(path)
    result = _service_trim(path, clip, edge, sec, RIPPLE)
    assert list(result) == HELD_KEYS
    assert list(result["needs_confirmation"]) == ["status", "reason", "message", "speech"]
    assert _text(result) == _text(expected)
    assert "cut_speech" not in result
    assert _geometry(path) == before
    assert _history_len(path) == entries


def test_service_speech_guard_pinned_text(build):
    result = _service_trim(build(), "h2", "out", 10.0, RIPPLE)
    assert _text(result) == (
        '{"operation": "trim_clip_edge", "unchanged": true, "needs_confirmation": '
        '{"status": "needs_confirmation", "reason": "cuts_other_speech", "message": '
        '"This also cuts Guest\'s speech at 0:10.1 (\\"so the plan\\"). Review this cut in '
        'Studio, or leave a gap to keep it.", "speech": {"spans": [{"start": 10.0, "end": '
        '20.0}], "tracks": [{"track_id": "guest", "speaker": "Guest", "words": [{"text": '
        '"so", "timeline_start": 10.1, "timeline_end": 10.3}, {"text": "the", '
        '"timeline_start": 10.35, "timeline_end": 10.5}, {"text": "plan", "timeline_start": '
        '10.55, "timeline_end": 10.9}], "sound_spans": []}]}}, "apply_anyway": "To apply it '
        'as is, repeat the call with override_audio_checks=true (CLI --override-audio-checks)."}'
    )


@pytest.mark.parametrize(
    ("layout", "clip", "edge", "sec", "expected"),
    [case[1:] for case in CONFIRMED_CASES],
    ids=CONFIRMED_IDS,
)
def test_service_human_intent_applies_and_adds_cut_speech(build, layout, clip, edge, sec, expected):
    path = build(layout)
    result = _human(path, clip, edge, sec, RIPPLE)
    assert list(result) == SPEECH_KEYS
    assert _text(result) == _text(expected)
    assert "needs_confirmation" not in result
    record = load_project(path).editorial.edit_log[-1]
    assert record.operation == "trim_clip_edge"
    assert list(record.params["cut_speech"]) == ["spans", "tracks"]


def test_service_human_intent_without_speech_has_no_cut_speech_key(build):
    result = _human(build(), "h1", "out", 6.0, RIPPLE)
    assert list(result) == APPLIED_KEYS
    assert _text(result) == _text(_both(4, 18.0, "h1", "out", 6.0))


def test_service_gap_mode_never_asks(build):
    path = build()
    result = _service_trim(path, "h2", "out", 10.0, GAP)
    assert list(result) == APPLIED_KEYS
    assert _text(result) == _text(_host_gap(3, 20.0, "h2", "out", 10.0))


def test_service_confirmed_pinned_text(build):
    result = _human(build("guest_past"), "h2", "out", 10.0, RIPPLE)
    assert _text(result) == (
        '{"operation": "trim_clip_edge", "affected_tracks": ["host", "guest"], '
        '"clip_count": 4, "timeline_duration_sec": 15.0, "clip_id": "h2", "edge": "out", '
        '"source_sec": 10.0, "mode": "ripple", "clip_ids": ["h2"], "cut_speech": {"spans": '
        '[{"start": 10.0, "end": 20.0}], "tracks": [{"track_id": "guest", "speaker": "Guest", '
        '"words": [{"text": "so", "timeline_start": 10.1, "timeline_end": 10.3}, {"text": '
        '"the", "timeline_start": 10.35, "timeline_end": 10.5}, {"text": "plan", '
        '"timeline_start": 10.55, "timeline_end": 10.9}], "sound_spans": []}]}}'
    )


# ------------------------------------------------------------------ service: errors


def _raised(call) -> pytest.ExceptionInfo:
    with pytest.raises(Exception) as raised:
        call()
    return raised


def test_service_stale_token(build):
    path = build()
    service = TimelineService(ProjectWorkspace.open(path))
    raised = _raised(
        lambda: service.trim_clip_edge("h1", "out", 6.0, mode=RIPPLE, expected_token="bad")
    )
    assert type(raised.value).__name__ == "DocumentConflictError"
    assert raised.value.code == "document_conflict"
    assert str(raised.value) == STALE


def test_service_empty_token_is_stale(build):
    path = build()
    service = TimelineService(ProjectWorkspace.open(path))
    raised = _raised(
        lambda: service.trim_clip_edge("h1", "out", 6.0, mode=RIPPLE, expected_token="")
    )
    assert type(raised.value).__name__ == "DocumentConflictError"
    assert raised.value.code == "document_conflict"
    assert str(raised.value) == STALE


def test_service_token_goes_stale_after_the_edit(build):
    path = build()
    token = _token(path, "h1", "out", RIPPLE)
    service = TimelineService(ProjectWorkspace.open(path))
    service.trim_clip_edge("h1", "out", 6.0, mode=RIPPLE, expected_token=token)
    before = _geometry(path)
    raised = _raised(
        lambda: service.trim_clip_edge("h1", "out", 5.0, mode=RIPPLE, expected_token=token)
    )
    assert type(raised.value).__name__ == "DocumentConflictError"
    assert raised.value.code == "document_conflict"
    assert str(raised.value) == STALE
    assert _geometry(path) == before


def test_service_token_of_another_edge_or_mode_is_stale(build):
    path = build()
    service = TimelineService(ProjectWorkspace.open(path))
    other_edge = _token(path, "h1", "in", RIPPLE)
    other_mode = _token(path, "h1", "out", GAP)
    for token, edge, mode in ((other_edge, "out", RIPPLE), (other_mode, "out", RIPPLE)):
        raised = _raised(
            lambda t=token, e=edge, m=mode: service.trim_clip_edge(
                "h1", e, 6.0, mode=m, expected_token=t
            )
        )
        assert raised.value.code == "document_conflict"
        assert str(raised.value) == STALE


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_service_non_finite_source_sec(build, value):
    path = build()
    service = TimelineService(ProjectWorkspace.open(path))
    token = _token(path, "h1", "out", RIPPLE)
    raised = _raised(
        lambda: service.trim_clip_edge("h1", "out", value, mode=RIPPLE, expected_token=token)
    )
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "source_sec_not_finite"
    assert str(raised.value) == "source_sec must be finite"


def test_service_non_finite_is_checked_before_the_token(build):
    service = TimelineService(ProjectWorkspace.open(build()))
    raised = _raised(
        lambda: service.trim_clip_edge("h1", "out", float("nan"), mode=RIPPLE, expected_token="bad")
    )
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "source_sec_not_finite"


def test_service_unknown_clip(build):
    path = build()
    service = TimelineService(ProjectWorkspace.open(path))
    token = _token(path, "h1", "out", RIPPLE)
    raised = _raised(
        lambda: service.trim_clip_edge("zz", "out", 6.0, mode=RIPPLE, expected_token=token)
    )
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "clip_not_found"
    assert str(raised.value) == "unknown clip_id: 'zz'"


def test_service_unknown_clip_is_reported_before_a_stale_token(build):
    service = TimelineService(ProjectWorkspace.open(build()))
    raised = _raised(
        lambda: service.trim_clip_edge("zz", "out", 6.0, mode=RIPPLE, expected_token="bad")
    )
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "clip_not_found"
    assert str(raised.value) == "unknown clip_id: 'zz'"


def test_service_invalid_edge_is_a_validation_error(build):
    service = TimelineService(ProjectWorkspace.open(build()))
    raised = _raised(
        lambda: service.trim_clip_edge("h1", "mid", 6.0, mode=RIPPLE, expected_token="x")
    )
    assert type(raised.value).__name__ == "ValidationError"
    (error,) = raised.value.errors()
    assert error["type"] == "literal_error"
    assert error["loc"] == ("edge",)


def test_service_errors_change_nothing(build):
    path = build()
    before, entries = _geometry(path), _history_len(path)
    service = TimelineService(ProjectWorkspace.open(path))
    with pytest.raises(Exception, match="stale"):
        service.trim_clip_edge("h1", "out", 6.0, mode=RIPPLE, expected_token="bad")
    with pytest.raises(CodedValueError):
        service.trim_clip_edge("h1", "out", float("nan"), mode=RIPPLE, expected_token="bad")
    assert _geometry(path) == before
    assert _history_len(path) == entries


# ------------------------------------------------------------------ undo


@pytest.mark.parametrize(
    ("layout", "clip", "edge", "sec", "mode"),
    [
        ("base", "h1", "out", 6.0, RIPPLE),
        ("base", "h2", "in", 9.0, RIPPLE),
        ("source_gap", "h1", "out", 9.0, RIPPLE),
        ("session_join", "h1", "out", 9.0, RIPPLE),
        ("base", "h2", "out", 18.0, GAP),
        ("timeline_gap", "h2", "in", 9.5, GAP),
    ],
    ids=[
        "ripple-out-shrink",
        "ripple-in-shrink",
        "ripple-out-extend",
        "ripple-session-join",
        "gap-out-shrink",
        "gap-in-extend",
    ],
)
def test_undo_restores_the_prior_timeline(build, layout, clip, edge, sec, mode):
    path = build(layout)
    before = _geometry(path)
    duration = load_project(path).timeline.duration_sec
    _service_trim(path, clip, edge, sec, mode)
    assert _geometry(path) != before

    _submit(path, "UndoHistory", history_move(path))

    assert _geometry(path) == before
    assert load_project(path).timeline.duration_sec == duration


def test_undo_restores_a_confirmed_speech_cut(build):
    path = build("guest_past")
    before = _geometry(path)
    words = [w.text for t in load_project(path).transcripts for w in t.words]
    _human(path, "h2", "out", 10.0, RIPPLE)
    assert _geometry(path) != before

    _submit(path, "UndoHistory", history_move(path))

    assert _geometry(path) == before
    assert [w.text for t in load_project(path).transcripts for w in t.words] == words


def test_redo_reapplies_the_trim(build):
    path = build()
    _service_trim(path, "h1", "out", 6.0, RIPPLE)
    after = _geometry(path)
    _submit(path, "UndoHistory", history_move(path))
    _submit(path, "RedoHistory", history_move(path))
    assert _geometry(path) == after


# ------------------------------------------------------------------ handler


@pytest.mark.parametrize(
    ("layout", "clip", "edge", "sec", "mode", "expected"),
    [case[1:] for case in APPLIED_CASES],
    ids=APPLIED_IDS,
)
def test_handler_applied_equals_service(build, layout, clip, edge, sec, mode, expected):
    path = build(layout)
    params = _payload(path, clip, edge, sec, mode)
    result = handlers.trim_clip_edge(ProjectWorkspace.open(path), params)
    assert list(result) == APPLIED_KEYS
    assert _text(result) == _text(expected)


@pytest.mark.parametrize(
    ("layout", "clip", "edge", "sec", "mode"),
    [case[1:] for case in UNCHANGED_CASES],
    ids=UNCHANGED_IDS,
)
def test_handler_unchanged(build, layout, clip, edge, sec, mode):
    path = build(layout)
    params = _payload(path, clip, edge, sec, mode)
    result = handlers.trim_clip_edge(ProjectWorkspace.open(path), params)
    assert _text(result) == _text(UNCHANGED)


@pytest.mark.parametrize(
    ("layout", "clip", "edge", "sec", "expected"),
    [case[1:] for case in HELD_CASES],
    ids=HELD_IDS,
)
def test_handler_without_intent_holds(build, layout, clip, edge, sec, expected):
    path = build(layout)
    params = _payload(path, clip, edge, sec, RIPPLE)
    result = handlers.trim_clip_edge(ProjectWorkspace.open(path), params)
    assert _text(result) == _text(expected)


@pytest.mark.parametrize(
    ("layout", "clip", "edge", "sec", "expected"),
    [case[1:] for case in CONFIRMED_CASES],
    ids=CONFIRMED_IDS,
)
def test_handler_human_boundary_intent_applies(build, layout, clip, edge, sec, expected):
    path = build(layout)
    params = _payload(
        path, clip, edge, sec, RIPPLE, _boundary_intent=CutIntent.HUMAN_BOUNDARIES.value
    )
    result = handlers.trim_clip_edge(ProjectWorkspace.open(path), params)
    assert list(result) == SPEECH_KEYS
    assert _text(result) == _text(expected)


def test_handler_invalid_mode(build):
    path = build()
    params = _payload(path, "h1", "out", 6.0, RIPPLE) | {"mode": "wobble"}
    raised = _raised(lambda: handlers.trim_clip_edge(ProjectWorkspace.open(path), params))
    assert type(raised.value) is ValueError
    assert str(raised.value) == "'wobble' is not a valid EditMode"


def test_handler_stale_token(build):
    path = build()
    params = _payload(path, "h1", "out", 6.0, RIPPLE) | {"expected_token": "bad"}
    raised = _raised(lambda: handlers.trim_clip_edge(ProjectWorkspace.open(path), params))
    assert raised.value.code == "document_conflict"
    assert str(raised.value) == STALE


# ------------------------------------------------------------------ document command


def test_document_command_applied_result_text(build):
    path = build()
    payload = _payload(path, "h1", "out", 6.0, RIPPLE)
    reply = _submit(path, "TrimClipEdge", payload)
    assert reply["ok"] is True
    assert reply["type"] == "Applied"
    result = reply["command"]["payload"]["result"]
    assert list(result) == APPLIED_KEYS
    assert _text(result) == _text(_both(4, 18.0, "h1", "out", 6.0))


def test_document_command_unchanged_result_text(build):
    path = build()
    reply = _submit(path, "TrimClipEdge", _payload(path, "h1", "out", 8.0, RIPPLE))
    assert reply["ok"] is True
    assert _text(reply["command"]["payload"]["result"]) == _text(UNCHANGED)


def test_document_command_holds_without_trusted_context(build):
    path = build()
    before = _geometry(path)
    reply = _submit(path, "TrimClipEdge", _payload(path, "h2", "out", 10.0, RIPPLE))
    assert _text(reply["command"]["payload"]["result"]) == _text(HELD_CASES[0][-1])
    assert _geometry(path) == before


def test_document_command_interactive_context_applies(build):
    path = build("guest_past")
    reply = _submit(
        path,
        "TrimClipEdge",
        _payload(path, "h2", "out", 10.0, RIPPLE),
        trusted_context=INTERACTIVE_COMMAND,
    )
    assert _text(reply["command"]["payload"]["result"]) == _text(CONFIRMED_CASES[1][-1])


def test_document_command_override_audio_checks_applies(build):
    path = build()
    payload = _payload(path, "h2", "out", 10.0, RIPPLE, override_audio_checks=True)
    reply = _submit(path, "TrimClipEdge", payload)
    assert _text(reply["command"]["payload"]["result"]) == _text(CONFIRMED_CASES[0][-1])


def test_document_command_stale_token(build):
    path = build()
    payload = _payload(path, "h1", "out", 6.0, RIPPLE) | {"expected_token": "bad"}
    raised = _raised(lambda: _submit(path, "TrimClipEdge", payload))
    assert type(raised.value).__name__ == "DocumentConflictError"
    assert raised.value.code == "document_conflict"
    assert str(raised.value) == STALE


def test_document_command_unknown_clip(build):
    path = build()
    payload = _payload(path, "h1", "out", 6.0, RIPPLE) | {"clip_id": "zz"}
    raised = _raised(lambda: _submit(path, "TrimClipEdge", payload))
    assert type(raised.value).__name__ == "DocumentConflictError"
    assert raised.value.code == "clip_not_found"
    assert str(raised.value) == "unknown clip_id: 'zz'"


def test_document_command_non_finite_source_sec(build):
    path = build()
    payload = _payload(path, "h1", "out", 6.0, RIPPLE) | {"source_sec": float("nan")}
    raised = _raised(lambda: _submit(path, "TrimClipEdge", payload))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "source_sec_not_finite"
    assert str(raised.value) == "source_sec must be finite"


# ------------------------------------------------------------------ CLI


@pytest.mark.parametrize(
    ("layout", "clip", "edge", "sec", "mode", "expected"),
    [case[1:] for case in APPLIED_CASES],
    ids=APPLIED_IDS,
)
def test_cli_applied(build, minimal_project, layout, clip, edge, sec, mode, expected):
    build(layout)
    result = _cli(minimal_project, clip, edge, str(sec), "--mode", mode.value)
    assert result.exit_code == 0, result.output
    assert result.stdout == json.dumps(expected, indent=2) + "\n"


def test_cli_ripple_shrink_pinned_text(build, minimal_project):
    build()
    result = _cli(minimal_project, "h1", "out", "6")
    assert result.exit_code == 0, result.output
    assert result.stdout == (
        "{\n"
        '  "operation": "trim_clip_edge",\n'
        '  "affected_tracks": [\n'
        '    "host",\n'
        '    "guest"\n'
        "  ],\n"
        '  "clip_count": 4,\n'
        '  "timeline_duration_sec": 18.0,\n'
        '  "clip_id": "h1",\n'
        '  "edge": "out",\n'
        '  "source_sec": 6.0,\n'
        '  "mode": "ripple",\n'
        '  "clip_ids": [\n'
        '    "h1"\n'
        "  ]\n"
        "}\n"
    )


@pytest.mark.parametrize(
    ("layout", "clip", "edge", "sec", "mode"),
    [case[1:] for case in UNCHANGED_CASES],
    ids=UNCHANGED_IDS,
)
def test_cli_unchanged(build, minimal_project, layout, clip, edge, sec, mode):
    build(layout)
    result = _cli(minimal_project, clip, edge, str(sec), "--mode", mode.value)
    assert result.exit_code == 0, result.output
    assert result.stdout == ('{\n  "operation": "trim_clip_edge",\n  "unchanged": true\n}\n')


def test_cli_holds_without_the_override_flag(build, minimal_project):
    path = build()
    before = _geometry(path)
    result = _cli(minimal_project, "h2", "out", "10")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.stderr == (
        'This also cuts Guest\'s speech at 0:10.1 ("so the plan"). '
        "Review this cut in Studio, or leave a gap to keep it.\n"
        "Nothing changed. To apply this cut as is, repeat the command with "
        "--override-audio-checks.\n"
    )
    assert _geometry(path) == before


def test_cli_override_audio_checks_applies(build, minimal_project):
    build()
    result = _cli(minimal_project, "h2", "out", "10", "--override-audio-checks")
    assert result.exit_code == 0, result.output
    assert result.stdout == json.dumps(CONFIRMED_CASES[0][-1], indent=2) + "\n"
    assert '\n  "clip_ids": [\n    "h2",\n    "g1"\n  ],\n  "cut_speech": {\n' in result.stdout


def test_cli_override_in_edge(build, minimal_project):
    build("guest_past")
    result = _cli(minimal_project, "h2", "in", "12", "--override-audio-checks")
    assert result.exit_code == 0, result.output
    assert result.stdout == json.dumps(CONFIRMED_CASES[2][-1], indent=2) + "\n"


def test_cli_unknown_clip(build, minimal_project):
    build()
    result = _cli(minimal_project, "zz", "out", "5")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.output == (
        "Error: unknown clip_id: 'zz' (code clip_not_found) "
        "(set PODCAST_DEBUG=1 for the traceback)\n"
    )
    assert isinstance(result.exception, SystemExit)


def test_cli_non_finite_source_sec(build, minimal_project):
    build()
    result = _cli(minimal_project, "h1", "out", "nan")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.output == (
        "Error: source_sec must be finite (code source_sec_not_finite) "
        "(set PODCAST_DEBUG=1 for the traceback)\n"
    )


def test_cli_invalid_edge(build, minimal_project):
    build()
    result = _cli(minimal_project, "h1", "mid", "5")
    assert result.exit_code == 2
    assert result.stdout == ""
    assert "Invalid value: --edge must be in or out" in result.stderr


def test_cli_invalid_mode(build, minimal_project):
    build()
    result = _cli(minimal_project, "h1", "out", "5", "--mode", "x")
    assert result.exit_code == 2
    assert result.stdout == ""
    assert "Invalid value for '--mode': Value error, 'x' is not one of 'ripple', 'gap'." in (
        result.stderr
    )


def test_cli_undo_restores_the_prior_timeline(build, minimal_project):
    path = build()
    before = _geometry(path)
    assert _cli(minimal_project, "h1", "out", "6").exit_code == 0
    assert _geometry(path) != before
    _submit(path, "UndoHistory", history_move(path))
    assert _geometry(path) == before


# ------------------------------------------------------------------ MCP tool


def _tool(path: Path, clip: str, edge: str, sec: float, mode: str = "ripple", **kw) -> str:
    return trim_clip_edge_tool(str(path), clip, edge, sec, mode, **kw)


@pytest.mark.parametrize(
    ("layout", "clip", "edge", "sec", "mode", "expected"),
    [case[1:] for case in APPLIED_CASES],
    ids=APPLIED_IDS,
)
def test_mcp_applied(build, layout, clip, edge, sec, mode, expected):
    path = build(layout)
    out = _tool(path, clip, edge, sec, mode.value)
    assert json.loads(out) == expected
    assert list(json.loads(out)) == APPLIED_KEYS
    assert out == json.dumps(expected, indent=2)


def test_mcp_unchanged(build):
    out = _tool(build(), "h1", "out", 8.0)
    assert out == '{\n  "operation": "trim_clip_edge",\n  "unchanged": true\n}'


def test_mcp_held_and_override(build):
    path = build()
    before = _geometry(path)
    held = _tool(path, "h2", "out", 10.0)
    assert held == json.dumps(HELD_CASES[0][-1], indent=2)
    assert list(json.loads(held)) == HELD_KEYS
    assert _geometry(path) == before

    applied = _tool(path, "h2", "out", 10.0, override_audio_checks=True)
    assert applied == json.dumps(CONFIRMED_CASES[0][-1], indent=2)
    assert list(json.loads(applied)) == SPEECH_KEYS


def test_mcp_unknown_clip(build):
    raised = _raised(lambda: _tool(build(), "zz", "out", 5.0))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "clip_not_found"
    assert str(raised.value) == "unknown clip_id: 'zz'"


def test_mcp_non_finite_source_sec(build):
    raised = _raised(lambda: _tool(build(), "h1", "out", float("nan")))
    assert type(raised.value).__name__ == "ValidationError"
    (error,) = raised.value.errors()
    assert error["type"] == "finite_number"
    assert error["loc"] == ("source_sec",)


def test_mcp_undo_restores_the_prior_timeline(build):
    path = build()
    before = _geometry(path)
    _tool(path, "h1", "out", 6.0)
    assert _geometry(path) != before
    _submit(path, "UndoHistory", history_move(path))
    assert _geometry(path) == before
