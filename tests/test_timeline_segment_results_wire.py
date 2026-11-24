from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.timeline_ops import PasteRejectedError
from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    EditMode,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document_sync import submit_paste_segment
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.handlers import edits as edit_handlers
from podcast_mcp.services.document_sync.service import DocumentSyncService
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()


@pytest.fixture
def ws(minimal_project) -> ProjectWorkspace:
    opened = ProjectWorkspace.open(minimal_project)
    opened.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=40.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            speaker="Guest",
            media=MediaAsset(path="raw/guest.wav", duration_sec=40.0),
        ),
    ]
    opened.project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=10.0, source_end=15.0, timeline_start=5.0),
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=4.0, timeline_start=1.0),
    ]
    opened.project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.5, confidence=0.9),
                TranscriptWord(text="world", start=10.0, end=10.5, confidence=0.9),
            ],
        )
    ]
    opened.project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(track_id="host", speaker="Host", start=0.0, end=0.5, text="hello"),
            CombinedUtterance(track_id="host", speaker="Host", start=10.0, end=10.5, text="world"),
        ]
    )
    save_project(opened.project, opened.path)
    return ProjectWorkspace.open(minimal_project)


def _wire(result) -> dict:
    return dict(result) if isinstance(result, dict) else result.model_dump()


def _pin(value: dict, keys: list[str], text: str) -> None:
    assert list(value) == keys
    assert json.dumps(value) == text


def _labels(ws: ProjectWorkspace) -> list[str]:
    return [e.label for e in ProjectWorkspace.open(ws.path).project.history.entries]


def _cli(minimal_project, *args: str):
    return runner.invoke(app, ["edit", *args, "--project", str(minimal_project)])


DUP_KEYS = ["operation", "affected_tracks", "clip_count", "timeline_duration_sec"]
PASTE_KEYS = [*DUP_KEYS, "insert_at", "duration", "mode"]

EXTRACTS = [
    {
        "track_id": "host",
        "source_start": 0.0,
        "source_end": 2.0,
        "relative_timeline_start": 0.0,
        "source_id": None,
        "fade_in_ms": 0,
        "fade_out_ms": 0,
        "join_in_mode": "fade",
        "mute_regions": [],
    },
    {
        "track_id": "guest",
        "source_start": 0.0,
        "source_end": 1.0,
        "relative_timeline_start": 1.0,
        "source_id": None,
        "fade_in_ms": 0,
        "fade_out_ms": 0,
        "join_in_mode": "fade",
        "mute_regions": [],
    },
]
CLIPBOARD = {"duration": 2.0, "extracts": EXTRACTS}


@pytest.fixture
def empty_ws(minimal_project) -> ProjectWorkspace:
    return ProjectWorkspace.open(minimal_project)


def _wire(result) -> dict:
    return dict(result) if isinstance(result, dict) else result.model_dump()


def _pin(value: dict, keys: list[str], text: str) -> None:
    assert list(value) == keys
    assert json.dumps(value) == text


def _labels(ws: ProjectWorkspace) -> list[str]:
    return [e.label for e in ProjectWorkspace.open(ws.path).project.history.entries]


def _cli(minimal_project, *args: str):
    return runner.invoke(app, ["edit", *args, "--project", str(minimal_project)])


def _submit(minimal_project, type_: str, payload: dict) -> dict:
    out = DocumentSyncService.open(minimal_project).submit(
        DocumentCommand(type=type_, payload=payload, client_id="c", role="viewer", client_seq=1)
    )
    return out["command"]["payload"]["result"]


def test_service_duplicate_segment_int_args(ws):
    result = _wire(TimelineService(ws).duplicate_segment(0, 2, 8))
    _pin(
        result,
        DUP_KEYS,
        '{"operation": "duplicate_segment", "affected_tracks": ["host", "guest"], '
        '"clip_count": 6, "timeline_duration_sec": 12.0}',
    )
    assert type(result["timeline_duration_sec"]) is float
    assert _labels(ws) == ["before duplicate segment", "after duplicate segment"]


def test_service_duplicate_segment_float_args_same_wire(ws):
    result = _wire(TimelineService(ws).duplicate_segment(0.0, 2.0, 8.0))
    _pin(
        result,
        DUP_KEYS,
        '{"operation": "duplicate_segment", "affected_tracks": ["host", "guest"], '
        '"clip_count": 6, "timeline_duration_sec": 12.0}',
    )


def test_service_duplicate_segment_empty_range_error(ws):
    for start, end in ((3.0, 1.0), (1.0, 1.0)):
        with pytest.raises(CodedValueError) as raised:
            TimelineService(ws).duplicate_segment(start, end, 8.0)
        assert raised.value.code == "out_of_range"
    assert _labels(ws) == []


def test_service_duplicate_segment_empty_project(empty_ws):
    result = _wire(TimelineService(empty_ws).duplicate_segment(0, 2, 8))
    _pin(
        result,
        DUP_KEYS,
        '{"operation": "duplicate_segment", "affected_tracks": [], '
        '"clip_count": 0, "timeline_duration_sec": null}',
    )


def test_service_paste_segment_ripple_int_args_echo_ints(ws):
    result = _wire(TimelineService(ws).paste_segment(2, 2, EXTRACTS, mode=EditMode.RIPPLE))
    _pin(
        result,
        PASTE_KEYS,
        '{"operation": "paste_segment", "affected_tracks": ["host", "guest"], "clip_count": 7, '
        '"timeline_duration_sec": 12.0, "insert_at": 2, "duration": 2, "mode": "ripple"}',
    )
    assert type(result["insert_at"]) is int
    assert type(result["duration"]) is int
    assert type(result["mode"]) is str
    assert _labels(ws) == ["before paste segment", "after paste segment"]


def test_service_paste_segment_gap_float_args(ws):
    result = _wire(TimelineService(ws).paste_segment(2.0, 2.0, EXTRACTS, mode=EditMode.GAP))
    _pin(
        result,
        PASTE_KEYS,
        '{"operation": "paste_segment", "affected_tracks": ["guest", "host"], "clip_count": 7, '
        '"timeline_duration_sec": 10.0, "insert_at": 2.0, "duration": 2.0, "mode": "gap"}',
    )
    assert type(result["insert_at"]) is float


def test_service_paste_segment_empty_project_no_extracts(empty_ws):
    result = _wire(TimelineService(empty_ws).paste_segment(0, 2, [], mode=EditMode.RIPPLE))
    _pin(
        result,
        PASTE_KEYS,
        '{"operation": "paste_segment", "affected_tracks": [], "clip_count": 0, '
        '"timeline_duration_sec": null, "insert_at": 0, "duration": 2, "mode": "ripple"}',
    )
    gap = _wire(TimelineService(empty_ws).paste_segment(0.0, 2.0, [], mode=EditMode.GAP))
    _pin(
        gap,
        PASTE_KEYS,
        '{"operation": "paste_segment", "affected_tracks": [], "clip_count": 0, '
        '"timeline_duration_sec": null, "insert_at": 0.0, "duration": 2.0, "mode": "gap"}',
    )


def test_service_paste_segment_duration_errors(ws):
    for duration in (0, -1.0, float("nan"), float("inf")):
        with pytest.raises(CodedValueError) as raised:
            TimelineService(ws).paste_segment(2.0, duration, EXTRACTS, mode=EditMode.GAP)
        assert raised.value.code == "out_of_range"
    assert _labels(ws) == []


@pytest.mark.parametrize(
    ("extract", "code", "message"),
    [
        (
            {"track_id": "nope", "source_start": 0, "source_end": 1},
            "paste_unknown_track",
            "paste_unknown_track: extract 0 names unknown track 'nope'",
        ),
        (
            {"track_id": "host", "source_start": 0, "source_end": 1, "source_id": "zz"},
            "paste_unknown_source",
            "paste_unknown_source: extract 0 names unknown source 'zz'",
        ),
        (
            {"track_id": "host", "source_start": 0, "source_end": 99},
            "paste_bad_range",
            "paste_bad_range: extract 0 source range [0.0, 99.0) with timeline offset 0.0 "
            "does not fit track 'host' (source length 40.0)",
        ),
        (
            {"track_id": "host", "source_start": 0},
            "paste_bad_extract",
            "paste_bad_extract: extract 0 requires a numeric source_end",
        ),
        (
            {"track_id": "host", "source_start": 0, "source_end": 1, "fade_in_curve": "zz"},
            "paste_bad_extract",
            "paste_bad_extract: extract 0 has an unknown fade_in_curve 'zz'",
        ),
        (
            {"track_id": "host", "source_start": 0, "source_end": 1, "bleed_restore": 5},
            "paste_bad_extract",
            "paste_bad_extract: extract 0 has invalid automatic mute or bleed Restore",
        ),
    ],
)
def test_service_paste_segment_rejected_extracts(ws, extract, code, message):
    with pytest.raises(PasteRejectedError) as raised:
        TimelineService(ws).paste_segment(2.0, 2.0, [extract], mode=EditMode.GAP)
    assert raised.value.code == code
    assert str(raised.value) == message
    assert _labels(ws) == []


def test_handler_duplicate_segment(ws):
    result = edit_handlers.duplicate_segment(
        ws, {"source_start": 0, "source_end": 2, "insert_at": 8}
    )
    _pin(
        result,
        DUP_KEYS,
        '{"operation": "duplicate_segment", "affected_tracks": ["host", "guest"], '
        '"clip_count": 6, "timeline_duration_sec": 12.0}',
    )


def test_handler_paste_segment_ints_become_floats(ws):
    result = edit_handlers.paste_segment(
        ws, {"insert_at": 2, "duration": 2, "extracts": EXTRACTS, "mode": "ripple"}
    )
    _pin(
        result,
        PASTE_KEYS,
        '{"operation": "paste_segment", "affected_tracks": ["host", "guest"], "clip_count": 7, '
        '"timeline_duration_sec": 12.0, "insert_at": 2.0, "duration": 2.0, "mode": "ripple"}',
    )


def test_handler_paste_segment_errors(ws):
    with pytest.raises(CodedValueError) as not_list:
        edit_handlers.paste_segment(
            ws, {"insert_at": 2, "duration": 2, "extracts": "nope", "mode": "gap"}
        )
    assert not_list.value.code == "extracts_not_list"
    with pytest.raises(PasteRejectedError) as rejected:
        edit_handlers.paste_segment(
            ws,
            {
                "insert_at": 2,
                "duration": 2,
                "extracts": [{"track_id": "nope", "source_start": 0, "source_end": 1}],
                "mode": "gap",
            },
        )
    assert rejected.value.code == "paste_unknown_track"


def test_handler_paste_segment_empty_project(empty_ws):
    result = edit_handlers.paste_segment(empty_ws, {"insert_at": 0, "duration": 2, "mode": "gap"})
    _pin(
        result,
        PASTE_KEYS,
        '{"operation": "paste_segment", "affected_tracks": [], "clip_count": 0, '
        '"timeline_duration_sec": null, "insert_at": 0.0, "duration": 2.0, "mode": "gap"}',
    )


def test_submit_duplicate_segment_result_wire(ws, minimal_project):
    result = _submit(
        minimal_project,
        "DuplicateSegment",
        {"source_start": 0, "source_end": 2, "insert_at": 8},
    )
    _pin(
        result,
        DUP_KEYS,
        '{"operation": "duplicate_segment", "affected_tracks": ["host", "guest"], '
        '"clip_count": 6, "timeline_duration_sec": 12.0}',
    )


def test_submit_paste_segment_result_wire(ws, minimal_project):
    result = _submit(
        minimal_project,
        "PasteSegment",
        {"insert_at": 2, "duration": 2, "extracts": EXTRACTS, "mode": "gap"},
    )
    _pin(
        result,
        PASTE_KEYS,
        '{"operation": "paste_segment", "affected_tracks": ["guest", "host"], "clip_count": 7, '
        '"timeline_duration_sec": 10.0, "insert_at": 2.0, "duration": 2.0, "mode": "gap"}',
    )


def test_host_submit_paste_segment_round_trip(ws, minimal_project):
    result = submit_paste_segment(minimal_project, 2, CLIPBOARD, mode=EditMode.RIPPLE)
    _pin(
        result,
        PASTE_KEYS,
        '{"operation": "paste_segment", "affected_tracks": ["host", "guest"], "clip_count": 7, '
        '"timeline_duration_sec": 12.0, "insert_at": 2.0, "duration": 2.0, "mode": "ripple"}',
    )
    assert _labels(ws) == ["before paste segment", "after paste segment"]


def test_cli_copy_then_paste_segment(ws, minimal_project):
    copied = _cli(minimal_project, "copy-segment", "--start", "0", "--end", "2")
    assert copied.exit_code == 0, copied.output
    assert json.loads(copied.stdout) == {"duration": 2, "extracts": EXTRACTS}
    pasted = runner.invoke(
        app,
        [
            "edit",
            "paste-segment",
            "--project",
            str(minimal_project),
            "--at",
            "2",
            "--clipboard",
            "-",
            "--mode",
            "gap",
        ],
        input=copied.stdout,
    )
    assert pasted.exit_code == 0, pasted.output
    assert pasted.stdout == (
        '{\n  "operation": "paste_segment",\n  "affected_tracks": [\n    "guest",\n    "host"\n'
        '  ],\n  "clip_count": 7,\n  "timeline_duration_sec": 10.0,\n  "insert_at": 2.0,\n'
        '  "duration": 2.0,\n  "mode": "gap"\n}\n'
    )
    assert list(json.loads(pasted.stdout)) == PASTE_KEYS
    assert _labels(ws) == ["before paste segment", "after paste segment"]


def test_cli_paste_segment_default_mode_is_ripple(ws, minimal_project):
    result = runner.invoke(
        app,
        [
            "edit",
            "paste-segment",
            "--project",
            str(minimal_project),
            "--at",
            "2",
            "--clipboard",
            "-",
        ],
        input=json.dumps(CLIPBOARD),
    )
    assert result.exit_code == 0, result.output
    assert result.stdout == (
        '{\n  "operation": "paste_segment",\n  "affected_tracks": [\n    "host",\n    "guest"\n'
        '  ],\n  "clip_count": 7,\n  "timeline_duration_sec": 12.0,\n  "insert_at": 2.0,\n'
        '  "duration": 2.0,\n  "mode": "ripple"\n}\n'
    )


def test_cli_paste_segment_errors(ws, minimal_project):
    not_object = runner.invoke(
        app,
        [
            "edit",
            "paste-segment",
            "--project",
            str(minimal_project),
            "--at",
            "2",
            "--clipboard",
            "-",
        ],
        input="[]",
    )
    assert not_object.exit_code == 2
    assert not_object.stdout == ""
    bad = runner.invoke(
        app,
        [
            "edit",
            "paste-segment",
            "--project",
            str(minimal_project),
            "--at",
            "2",
            "--clipboard",
            "-",
            "--mode",
            "gap",
        ],
        input=json.dumps(
            {"duration": 2, "extracts": [{"track_id": "nope", "source_start": 0, "source_end": 1}]}
        ),
    )
    assert bad.exit_code != 0
    assert bad.stdout == ""
    assert _labels(ws) == []


def test_no_cli_duplicate_segment_command(ws, minimal_project):
    result = _cli(minimal_project, "duplicate-segment")
    assert result.exit_code == 2
    assert result.stdout == ""
