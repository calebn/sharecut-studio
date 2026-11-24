from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.handlers import edits as edit_handlers
from podcast_mcp.services.document_sync.service import DocumentSyncService
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()

GAP_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "at_time",
    "duration_sec",
]
MOVE_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "source_start",
    "source_end",
    "insert_at",
]
CLIPS_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "clip_ids",
]


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


def test_service_insert_gap_int_args(ws):
    result = _wire(TimelineService(ws).insert_gap(2, 1))
    _pin(
        result,
        GAP_KEYS,
        '{"operation": "insert_gap", "affected_tracks": ["host", "guest"], "clip_count": 5, '
        '"timeline_duration_sec": 11.0, "at_time": 2, "duration_sec": 1}',
    )
    assert type(result["at_time"]) is int
    assert type(result["duration_sec"]) is int
    assert type(result["timeline_duration_sec"]) is float
    assert _labels(ws) == ["before insert gap", "after insert gap"]


def test_service_insert_gap_float_args_and_default_duration(ws):
    result = _wire(TimelineService(ws).insert_gap(2.5, 1.5))
    _pin(
        result,
        GAP_KEYS,
        '{"operation": "insert_gap", "affected_tracks": ["host", "guest"], "clip_count": 5, '
        '"timeline_duration_sec": 11.5, "at_time": 2.5, "duration_sec": 1.5}',
    )
    assert type(result["at_time"]) is float


def test_service_insert_gap_default_duration(ws):
    result = _wire(TimelineService(ws).insert_gap(2.0))
    _pin(
        result,
        GAP_KEYS,
        '{"operation": "insert_gap", "affected_tracks": ["host", "guest"], "clip_count": 5, '
        '"timeline_duration_sec": 11.0, "at_time": 2.0, "duration_sec": 1.0}',
    )


def test_service_move_segment_int_args(ws):
    result = _wire(TimelineService(ws).move_segment(0, 2, 8))
    _pin(
        result,
        MOVE_KEYS,
        '{"operation": "move_segment", "affected_tracks": ["host", "guest"], "clip_count": 6, '
        '"timeline_duration_sec": 10.0, "source_start": 0, "source_end": 2, "insert_at": 8}',
    )
    assert type(result["source_start"]) is int
    assert type(result["insert_at"]) is int
    assert _labels(ws) == ["before move segment", "after move segment"]


def test_service_move_segment_float_args(ws):
    result = _wire(TimelineService(ws).move_segment(0.0, 2.0, 8.0))
    _pin(
        result,
        MOVE_KEYS,
        '{"operation": "move_segment", "affected_tracks": ["host", "guest"], "clip_count": 6, '
        '"timeline_duration_sec": 10.0, "source_start": 0.0, "source_end": 2.0, "insert_at": 8.0}',
    )
    assert type(result["source_start"]) is float


def test_service_move_segment_range_end_before_start(ws):
    with pytest.raises(CodedValueError) as raised:
        TimelineService(ws).move_segment(3.0, 1.0, 8.0)
    assert raised.value.code == "range_end_before_start"
    assert _labels(ws) == []


def test_service_move_by_text(ws):
    result = _wire(TimelineService(ws).move_by_text("hello", "world", "after"))
    _pin(
        result,
        MOVE_KEYS,
        '{"operation": "move_segment", "affected_tracks": ["host", "guest"], "clip_count": 5, '
        '"timeline_duration_sec": 10.0, "source_start": 0.0, "source_end": 0.5, "insert_at": 5.5}',
    )
    assert _labels(ws) == ["before move by text", "after move by text"]


def test_service_move_by_text_no_match_code(ws):
    with pytest.raises(CodedValueError) as raised:
        TimelineService(ws).move_by_text("zzznomatchzzz", "world", "after")
    assert raised.value.code == "no_transcript_match"


def test_service_move_clips_two_tracks(ws):
    result = _wire(
        TimelineService(ws).move_clips(
            [
                {"clip_id": "c1", "timeline_start": 20.0, "track_id": "host"},
                {"clip_id": "g1", "timeline_start": 3.0, "track_id": "guest"},
            ]
        )
    )
    _pin(
        result,
        CLIPS_KEYS,
        '{"operation": "move_clips", "affected_tracks": ["guest", "host"], "clip_count": 3, '
        '"timeline_duration_sec": 25.0, "clip_ids": ["c1", "g1"]}',
    )
    assert _labels(ws) == ["before move clips", "after move clips"]


def test_service_move_clips_inter_track_int_start(ws):
    result = _wire(
        TimelineService(ws).move_clips(
            [{"clip_id": "c1", "timeline_start": 20, "track_id": "guest"}]
        )
    )
    _pin(
        result,
        CLIPS_KEYS,
        '{"operation": "move_clips", "affected_tracks": ["guest", "host"], "clip_count": 3, '
        '"timeline_duration_sec": 25.0, "clip_ids": ["c1"]}',
    )


def test_service_move_clips_errors(ws):
    svc = TimelineService(ws)
    with pytest.raises(CodedValueError) as empty:
        svc.move_clips([])
    assert empty.value.code == "missing_argument"
    with pytest.raises(CodedValueError) as unknown:
        svc.move_clips([{"clip_id": "nope", "timeline_start": 1.0, "track_id": "host"}])
    assert unknown.value.code == "clip_not_found"
    with pytest.raises(CodedValueError) as invalid:
        svc.move_clips(["nope"])
    assert invalid.value.code == "clip_move_invalid"
    assert _labels(ws) == []


def test_handler_insert_gap(ws):
    result = edit_handlers.insert_gap(ws, {"at_time": 2, "duration_sec": 1})
    _pin(
        _wire(result),
        GAP_KEYS,
        '{"operation": "insert_gap", "affected_tracks": ["host", "guest"], "clip_count": 5, '
        '"timeline_duration_sec": 11.0, "at_time": 2.0, "duration_sec": 1.0}',
    )
    assert _labels(ws) == ["before insert gap", "after insert gap"]


def test_handler_insert_gap_default_duration(ws):
    result = edit_handlers.insert_gap(ws, {"at_time": "2.5"})
    _pin(
        _wire(result),
        GAP_KEYS,
        '{"operation": "insert_gap", "affected_tracks": ["host", "guest"], "clip_count": 5, '
        '"timeline_duration_sec": 11.0, "at_time": 2.5, "duration_sec": 1.0}',
    )


def test_handler_move_segment(ws):
    result = edit_handlers.move_segment(ws, {"source_start": 0, "source_end": 2, "insert_at": 8})
    _pin(
        _wire(result),
        MOVE_KEYS,
        '{"operation": "move_segment", "affected_tracks": ["host", "guest"], "clip_count": 6, '
        '"timeline_duration_sec": 10.0, "source_start": 0.0, "source_end": 2.0, "insert_at": 8.0}',
    )
    assert _labels(ws) == ["before move segment", "after move segment"]


def test_handler_move_segment_range_end_before_start(ws):
    with pytest.raises(CodedValueError) as raised:
        edit_handlers.move_segment(ws, {"source_start": 3, "source_end": 1, "insert_at": 8})
    assert raised.value.code == "range_end_before_start"


def test_handler_move_by_text(ws):
    result = edit_handlers.move_by_text(
        ws, {"source_query": "hello", "destination_query": "world", "position": "after"}
    )
    _pin(
        _wire(result),
        MOVE_KEYS,
        '{"operation": "move_segment", "affected_tracks": ["host", "guest"], "clip_count": 5, '
        '"timeline_duration_sec": 10.0, "source_start": 0.0, "source_end": 0.5, "insert_at": 5.5}',
    )
    assert _labels(ws) == ["before move by text", "after move by text"]


def test_handler_move_clips(ws):
    result = edit_handlers.move_clips(
        ws, {"clips": [{"clip_id": "c1", "timeline_start": 20, "track_id": "guest"}]}
    )
    _pin(
        _wire(result),
        CLIPS_KEYS,
        '{"operation": "move_clips", "affected_tracks": ["guest", "host"], "clip_count": 3, '
        '"timeline_duration_sec": 25.0, "clip_ids": ["c1"]}',
    )
    assert _labels(ws) == ["before move clips", "after move clips"]


def test_handler_move_clips_errors(ws):
    with pytest.raises(CodedValueError) as not_list:
        edit_handlers.move_clips(ws, {"clips": "nope"})
    assert not_list.value.code == "clips_not_list"
    with pytest.raises(CodedValueError) as empty:
        edit_handlers.move_clips(ws, {})
    assert empty.value.code == "missing_argument"
    with pytest.raises(CodedValueError) as unknown:
        edit_handlers.move_clips(
            ws, {"clips": [{"clip_id": "nope", "timeline_start": 1, "track_id": "host"}]}
        )
    assert unknown.value.code == "clip_not_found"


def test_submit_insert_gap_result_wire(ws, minimal_project):
    out = DocumentSyncService.open(minimal_project).submit(
        DocumentCommand(
            type="InsertGap",
            payload={"at_time": 2, "duration_sec": 1},
            client_id="c",
            role="viewer",
            client_seq=1,
        )
    )
    result = out["command"]["payload"]["result"]
    _pin(
        result,
        GAP_KEYS,
        '{"operation": "insert_gap", "affected_tracks": ["host", "guest"], "clip_count": 5, '
        '"timeline_duration_sec": 11.0, "at_time": 2.0, "duration_sec": 1.0}',
    )


def test_submit_move_clips_result_wire(ws, minimal_project):
    out = DocumentSyncService.open(minimal_project).submit(
        DocumentCommand(
            type="MoveClips",
            payload={"clips": [{"clip_id": "c1", "timeline_start": 20, "track_id": "guest"}]},
            client_id="c",
            role="viewer",
            client_seq=1,
        )
    )
    result = out["command"]["payload"]["result"]
    _pin(
        result,
        CLIPS_KEYS,
        '{"operation": "move_clips", "affected_tracks": ["guest", "host"], "clip_count": 3, '
        '"timeline_duration_sec": 25.0, "clip_ids": ["c1"]}',
    )


def test_cli_move_time_range(ws, minimal_project):
    result = _cli(minimal_project, "move", "--from-start", "0", "--from-end", "2", "--to", "8")
    assert result.exit_code == 0, result.output
    assert result.stdout == (
        '{\n  "operation": "move_segment",\n  "affected_tracks": [\n    "host",\n    "guest"\n'
        '  ],\n  "clip_count": 6,\n  "timeline_duration_sec": 10.0,\n  "source_start": 0.0,\n'
        '  "source_end": 2.0,\n  "insert_at": 8.0\n}\n'
    )
    assert list(json.loads(result.stdout)) == MOVE_KEYS
    assert _labels(ws) == ["before move segment", "after move segment"]


def test_cli_move_from_query(ws, minimal_project):
    result = _cli(minimal_project, "move", "--from-query", "hello", "--to-after", "world")
    assert result.exit_code == 0, result.output
    assert result.stdout == (
        '{\n  "operation": "move_segment",\n  "affected_tracks": [\n    "host",\n    "guest"\n'
        '  ],\n  "clip_count": 5,\n  "timeline_duration_sec": 10.0,\n  "source_start": 0.0,\n'
        '  "source_end": 0.5,\n  "insert_at": 5.5\n}\n'
    )
    assert _labels(ws) == ["before move by text", "after move by text"]


def test_cli_move_errors(ws, minimal_project):
    reversed_range = _cli(
        minimal_project, "move", "--from-start", "3", "--from-end", "1", "--to", "8"
    )
    assert reversed_range.exit_code == 1
    assert "(code range_end_before_start)" in reversed_range.stderr
    assert reversed_range.stdout == ""
    partial = _cli(minimal_project, "move", "--from-start", "3")
    assert partial.exit_code == 2
    assert partial.stdout == ""


def test_cli_move_clips(ws, minimal_project):
    payload = json.dumps([{"clip_id": "c1", "timeline_start": 20, "track_id": "guest"}])
    result = _cli(minimal_project, "move-clips", "--clips-json", payload)
    assert result.exit_code == 0, result.output
    assert result.stdout == (
        '{\n  "operation": "move_clips",\n  "affected_tracks": [\n    "guest",\n    "host"\n'
        '  ],\n  "clip_count": 3,\n  "timeline_duration_sec": 25.0,\n  "clip_ids": [\n'
        '    "c1"\n  ]\n}\n'
    )
    assert _labels(ws) == ["before move clips", "after move clips"]


def test_cli_move_clips_errors(ws, minimal_project):
    unknown = _cli(
        minimal_project,
        "move-clips",
        "--clips-json",
        json.dumps([{"clip_id": "nope", "timeline_start": 1, "track_id": "host"}]),
    )
    assert unknown.exit_code == 1
    assert "(code clip_not_found)" in unknown.stderr
    empty = _cli(minimal_project, "move-clips", "--clips-json", "[]")
    assert empty.exit_code == 1
    assert "(code missing_argument)" in empty.stderr


@pytest.mark.parametrize(
    ("args", "expected"),
    [
        (
            ["--at", "2", "--duration", "1"],
            '{\n  "operation": "insert_gap",\n  "affected_tracks": [\n    "host",\n    "guest"\n'
            '  ],\n  "clip_count": 5,\n  "timeline_duration_sec": 11.0,\n  "at_time": 2.0,\n'
            '  "duration_sec": 1.0\n}\n',
        ),
        (
            ["--at", "2.5"],
            '{\n  "operation": "insert_gap",\n  "affected_tracks": [\n    "host",\n    "guest"\n'
            '  ],\n  "clip_count": 5,\n  "timeline_duration_sec": 11.0,\n  "at_time": 2.5,\n'
            '  "duration_sec": 1.0\n}\n',
        ),
    ],
)
def test_cli_insert_gap(ws, minimal_project, args, expected):
    result = _cli(minimal_project, "insert-gap", *args)
    assert result.exit_code == 0, result.output
    assert result.stdout == expected
    assert _labels(ws) == ["before insert gap", "after insert gap"]
