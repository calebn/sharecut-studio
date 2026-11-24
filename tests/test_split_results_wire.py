"""Pin the wire output of the timeline split operations.

``TimelineService.split_clip`` / ``split_at_time`` and the ``split_at_time`` document handler
return the same dicts. Clip ids come from ``new_clip_id`` and the proposal ids from
``uuid.uuid4``; both are replaced by counters, so every id below is the real generated value
under that counter and nothing else is normalized.
"""

from __future__ import annotations

import itertools
import json
from types import SimpleNamespace

import pytest

import podcast_mcp.edits.transcript_cuts as transcript_cuts
import podcast_mcp.engines.clips_ops as clips_ops
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document_sync.handlers import edits as handlers
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok

SPLIT_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "at_time",
    "skipped_track_ids",
    "split_source_by_track",
    "split_pieces",
]
PIECE_KEYS = ["track_id", "original_clip_id", "left_clip_id", "right_clip_id"]
AT_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "at_time",
    "skipped_track_ids",
    "split_source_by_track",
    "first_right_pieces",
]
AT_MULTI_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "at_time",
    "skipped_track_ids",
    "split_source_by_track",
    "split_times",
    "first_right_pieces",
]
PROPOSE_KEYS = ["operation", "edit", "edits"]
EDIT_KEYS = [
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
CLIP_BY_TRACK_ID = (
    '{"operation": "split_clips_at", "affected_tracks": ["host"], "clip_count": 3, '
    '"timeline_duration_sec": 3.0, "at_time": 1.5, "skipped_track_ids": [], '
    '"split_source_by_track": {"host": 1.5}, "split_pieces": [{"track_id": "host", '
    '"original_clip_id": "h1", "left_clip_id": "clip_0001", '
    '"right_clip_id": "clip_0002"}]}'
)
CLIP_BY_SPEAKER = (
    '{"operation": "split_clips_at", "affected_tracks": ["guest"], '
    '"clip_count": 3, "timeline_duration_sec": 3.0, "at_time": 0.5, '
    '"skipped_track_ids": [], "split_source_by_track": {"guest": 0.5}, '
    '"split_pieces": [{"track_id": "guest", "original_clip_id": "g1", '
    '"left_clip_id": "clip_0001", "right_clip_id": "clip_0002"}]}'
)
CLIP_TRACK_IDS_TWO_TRACKS = (
    '{"operation": "split_clips_at", "affected_tracks": ["host", "guest"], '
    '"clip_count": 4, "timeline_duration_sec": 3.0, "at_time": 0.5, '
    '"skipped_track_ids": [], "split_source_by_track": {"host": 0.5, '
    '"guest": 0.5}, "split_pieces": [{"track_id": "host", '
    '"original_clip_id": "h1", "left_clip_id": "clip_0001", '
    '"right_clip_id": "clip_0002"}, {"track_id": "guest", '
    '"original_clip_id": "g1", "left_clip_id": "clip_0003", '
    '"right_clip_id": "clip_0004"}]}'
)
CLIP_DEFAULT_ALL_DIALOGUE = (
    '{"operation": "split_clips_at", "affected_tracks": ["host", "guest"], '
    '"clip_count": 4, "timeline_duration_sec": 3.0, "at_time": 0.5, '
    '"skipped_track_ids": [], "split_source_by_track": {"host": 0.5, '
    '"guest": 0.5}, "split_pieces": [{"track_id": "host", '
    '"original_clip_id": "h1", "left_clip_id": "clip_0001", '
    '"right_clip_id": "clip_0002"}, {"track_id": "guest", '
    '"original_clip_id": "g1", "left_clip_id": "clip_0003", '
    '"right_clip_id": "clip_0004"}]}'
)
CLIP_SKIPS_TRACK_WITHOUT_CLIP = (
    '{"operation": "split_clips_at", "affected_tracks": ["host"], "clip_count": 3, '
    '"timeline_duration_sec": 3.0, "at_time": 2.0, "skipped_track_ids": ["guest"], '
    '"split_source_by_track": {"host": 2.0}, "split_pieces": [{"track_id": "host", '
    '"original_clip_id": "h1", "left_clip_id": "clip_0001", '
    '"right_clip_id": "clip_0002"}]}'
)
CLIP_INT_AT_TIME = (
    '{"operation": "split_clips_at", "affected_tracks": ["host"], "clip_count": 3, '
    '"timeline_duration_sec": 3.0, "at_time": 1, "skipped_track_ids": ["guest"], '
    '"split_source_by_track": {"host": 1.0}, "split_pieces": [{"track_id": "host", '
    '"original_clip_id": "h1", "left_clip_id": "clip_0001", '
    '"right_clip_id": "clip_0002"}]}'
)
CLIP_FLOAT_AT_TIME = (
    '{"operation": "split_clips_at", "affected_tracks": ["host"], "clip_count": 3, '
    '"timeline_duration_sec": 3.0, "at_time": 1.0, "skipped_track_ids": ["guest"], '
    '"split_source_by_track": {"host": 1.0}, "split_pieces": [{"track_id": "host", '
    '"original_clip_id": "h1", "left_clip_id": "clip_0001", '
    '"right_clip_id": "clip_0002"}]}'
)
AT_SINGLE_TIME = (
    '{"operation": "split_clips_at", "affected_tracks": ["host", "guest"], '
    '"clip_count": 4, "timeline_duration_sec": 3.0, "at_time": 0.5, '
    '"skipped_track_ids": [], "split_source_by_track": {"host": 0.5, '
    '"guest": 0.5}, "first_right_pieces": [{"track_id": "host", '
    '"clip_id": "clip_0002"}, {"track_id": "guest", "clip_id": "clip_0004"}]}'
)
AT_EXPLICIT_TRACK_IDS = (
    '{"operation": "split_clips_at", "affected_tracks": ["host"], "clip_count": 3, '
    '"timeline_duration_sec": 3.0, "at_time": 0.5, "skipped_track_ids": [], '
    '"split_source_by_track": {"host": 0.5}, '
    '"first_right_pieces": [{"track_id": "host", "clip_id": "clip_0002"}]}'
)
AT_EXTRA_TIMES_CHAINED = (
    '{"operation": "split_clips_at", "affected_tracks": ["host", "guest"], '
    '"clip_count": 8, "timeline_duration_sec": 3.0, "at_time": 0.75, '
    '"skipped_track_ids": [], "split_source_by_track": {"host": 0.75, '
    '"guest": 0.75}, "split_times": [0.25, 0.5, 0.75], '
    '"first_right_pieces": [{"track_id": "host", "clip_id": "clip_0005"}, '
    '{"track_id": "guest", "clip_id": "clip_0007"}]}'
)
AT_EXTRA_TIME_SKIPS_TRACK = (
    '{"operation": "split_clips_at", "affected_tracks": ["host", "guest"], '
    '"clip_count": 5, "timeline_duration_sec": 3.0, "at_time": 0.5, '
    '"skipped_track_ids": [], "split_source_by_track": {"host": 0.5, '
    '"guest": 0.5}, "split_times": [2.0, 0.5], '
    '"first_right_pieces": [{"track_id": "host", "clip_id": "clip_0002"}]}'
)
AT_EXTRA_TIME_WITHOUT_CLIP_SKIPPED = (
    '{"operation": "split_clips_at", "affected_tracks": ["host", "guest"], '
    '"clip_count": 4, "timeline_duration_sec": 3.0, "at_time": 0.5, '
    '"skipped_track_ids": [], "split_source_by_track": {"host": 0.5, '
    '"guest": 0.5}, "split_times": [0.5], '
    '"first_right_pieces": [{"track_id": "host", "clip_id": "clip_0002"}, '
    '{"track_id": "guest", "clip_id": "clip_0004"}]}'
)
AT_PROPOSE_DEFAULTS = (
    '{"operation": "propose_split", "edit": {"id": "split_00000001", '
    '"track_id": "host", "type": "split", "start": 0.5, "end": 0.5, '
    '"crossfade_ms": 0, "reason": "guest:suggest_split", "author": null, '
    '"review_required": true, "applied": false, "cut_confidence": null, '
    '"boundary_mode": "timeline_split", "replace_gap_sec": null, '
    '"next_burst_sec": null, "scope": "session", "cut_speech": null, '
    '"track_ids": ["host", "guest"], "timebase": "timeline", "source_id": null, '
    '"source_timeline_span": null, "exact_range": null, '
    '"proposal_origin": "programmatic", "boundary_intent": "programmatic", "bound_pad": null}, '
    '"edits": [{"id": "split_00000001", "track_id": "host", "type": "split", '
    '"start": 0.5, "end": 0.5, "crossfade_ms": 0, "reason": "guest:suggest_split", '
    '"author": null, "review_required": true, "applied": false, '
    '"cut_confidence": null, "boundary_mode": "timeline_split", '
    '"replace_gap_sec": null, "next_burst_sec": null, "scope": "session", '
    '"cut_speech": null, "track_ids": ["host", "guest"], "timebase": "timeline", '
    '"source_id": null, "source_timeline_span": null, "exact_range": null, '
    '"proposal_origin": "programmatic", "boundary_intent": "programmatic", "bound_pad": null}]}'
)
AT_PROPOSE_REASON_AUTHOR_EXTRA = (
    '{"operation": "propose_split", "edit": {"id": "split_00000001", '
    '"track_id": "host", "type": "split", "start": 0.5, "end": 0.5, '
    '"crossfade_ms": 0, "reason": "why", "author": "bob", "review_required": true, '
    '"applied": false, "cut_confidence": null, "boundary_mode": "timeline_split", '
    '"replace_gap_sec": null, "next_burst_sec": null, "scope": "session", '
    '"cut_speech": null, "track_ids": ["host"], "timebase": "timeline", '
    '"source_id": null, "source_timeline_span": null, "exact_range": null, '
    '"proposal_origin": "programmatic", "boundary_intent": "programmatic", "bound_pad": null}, '
    '"edits": [{"id": "split_00000001", "track_id": "host", "type": "split", '
    '"start": 0.5, "end": 0.5, "crossfade_ms": 0, "reason": "why", '
    '"author": "bob", "review_required": true, "applied": false, '
    '"cut_confidence": null, "boundary_mode": "timeline_split", '
    '"replace_gap_sec": null, "next_burst_sec": null, "scope": "session", '
    '"cut_speech": null, "track_ids": ["host"], "timebase": "timeline", '
    '"source_id": null, "source_timeline_span": null, "exact_range": null, '
    '"proposal_origin": "programmatic", "boundary_intent": "programmatic", "bound_pad": null}, '
    '{"id": "split_00000002", "track_id": "host", "type": "split", "start": 1.5, '
    '"end": 1.5, "crossfade_ms": 0, "reason": "why", "author": "bob", '
    '"review_required": true, "applied": false, "cut_confidence": null, '
    '"boundary_mode": "timeline_split", "replace_gap_sec": null, '
    '"next_burst_sec": null, "scope": "session", "cut_speech": null, '
    '"track_ids": ["host"], "timebase": "timeline", "source_id": null, '
    '"source_timeline_span": null, "exact_range": null, '
    '"proposal_origin": "programmatic", "boundary_intent": "programmatic", "bound_pad": null}]}'
)


@pytest.fixture
def ws(minimal_project, monkeypatch) -> ProjectWorkspace:
    clip_ids = itertools.count(1)
    proposal_ids = itertools.count(1)
    monkeypatch.setattr(clips_ops, "new_clip_id", lambda: f"clip_{next(clip_ids):04d}")
    monkeypatch.setattr(
        transcript_cuts,
        "uuid",
        SimpleNamespace(uuid4=lambda: SimpleNamespace(hex=f"{next(proposal_ids):08d}0000")),
    )
    opened = ProjectWorkspace.open(minimal_project)
    opened.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=4.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            speaker="Guest",
            media=MediaAsset(path="raw/host.wav", duration_sec=4.0),
        ),
    ]
    opened.project.timeline.clips = [
        Clip(id="h1", track_id="host", source_start=0.0, source_end=3.0, timeline_start=0.0),
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=1.0, timeline_start=0.0),
    ]
    save_project(opened.project, opened.path)
    return ProjectWorkspace.open(minimal_project)


def _text(value: dict) -> str:
    return json.dumps(value)


def _failure(call) -> CodedValueError:
    with pytest.raises(CodedValueError) as raised:
        call()
    return raised.value


SPLIT_CLIP_CASES = [
    pytest.param(
        lambda service: service.split_clip(1.5, track_id="host"),
        CLIP_BY_TRACK_ID,
        id="clip_by_track_id",
    ),
    pytest.param(
        lambda service: service.split_clip(0.5, speaker="Guest"),
        CLIP_BY_SPEAKER,
        id="clip_by_speaker",
    ),
    pytest.param(
        lambda service: service.split_clip(0.5, track_ids=["host", "guest"]),
        CLIP_TRACK_IDS_TWO_TRACKS,
        id="clip_track_ids_two_tracks",
    ),
    pytest.param(
        lambda service: service.split_clip(0.5),
        CLIP_DEFAULT_ALL_DIALOGUE,
        id="clip_default_all_dialogue",
    ),
    pytest.param(
        lambda service: service.split_clip(2.0),
        CLIP_SKIPS_TRACK_WITHOUT_CLIP,
        id="clip_skips_track_without_clip",
    ),
    pytest.param(lambda service: service.split_clip(1), CLIP_INT_AT_TIME, id="clip_int_at_time"),
    pytest.param(
        lambda service: service.split_clip(1.0), CLIP_FLOAT_AT_TIME, id="clip_float_at_time"
    ),
]


@pytest.mark.parametrize(("call", "expected"), SPLIT_CLIP_CASES)
def test_service_split_clip_wire(ws, call, expected):
    result = call(TimelineService(ws))
    result = result.model_dump()
    assert list(result) == SPLIT_KEYS
    assert all(list(piece) == PIECE_KEYS for piece in result["split_pieces"])
    assert _text(result) == expected


def test_service_split_clip_at_time_echo_type(ws):
    as_int = TimelineService(ws).split_clip(1)
    as_int = as_int.model_dump()
    assert isinstance(as_int["at_time"], int)
    assert isinstance(as_int["split_source_by_track"]["host"], float)
    assert '"at_time": 1,' in _text(as_int)
    assert _text(as_int) == CLIP_INT_AT_TIME


def test_service_split_clip_float_at_time_echo_type(ws):
    as_float = TimelineService(ws).split_clip(1.0)
    as_float = as_float.model_dump()
    assert isinstance(as_float["at_time"], float)
    assert '"at_time": 1.0,' in _text(as_float)


def test_service_split_clip_skipped_and_source_by_track(ws):
    result = TimelineService(ws).split_clip(2.0)
    result = result.model_dump()
    assert result["skipped_track_ids"] == ["guest"]
    assert result["affected_tracks"] == ["host"]
    assert result["split_source_by_track"] == {"host": 2.0}
    assert [piece["track_id"] for piece in result["split_pieces"]] == ["host"]


def test_service_split_clip_pieces_match_project_clips(ws):
    result = TimelineService(ws).split_clip(0.5, track_ids=["host", "guest"])
    result = result.model_dump()
    reopened = ProjectWorkspace.open(ws.path)
    ids = {clip.id for clip in reopened.project.timeline.clips}
    for piece in result["split_pieces"]:
        assert piece["original_clip_id"] not in ids
        assert piece["left_clip_id"] in ids
        assert piece["right_clip_id"] in ids


@pytest.mark.parametrize(
    ("call", "message"),
    [
        pytest.param(
            lambda service: service.split_clip(3.5),
            "no clip at timeline 3.5 on tracks ['host', 'guest']",
            id="all_dialogue_tracks",
        ),
        pytest.param(
            lambda service: service.split_clip(3.5, track_id="host"),
            "no clip at timeline 3.5 on tracks ['host']",
            id="one_track",
        ),
        pytest.param(
            lambda service: service.split_clip(3.5, speaker="Guest"),
            "no clip at timeline 3.5 on tracks ['guest']",
            id="by_speaker",
        ),
    ],
)
def test_service_split_clip_no_clip_at_time(ws, call, message):
    error = _failure(lambda: call(TimelineService(ws)))
    assert error.code == "no_clip_at_time"
    assert str(error) == message


def test_service_split_clip_no_tracks(ws):
    ws.project.timeline.tracks = []
    ws.project.timeline.clips = []
    save_project(ws.project, ws.path)
    error = _failure(lambda: TimelineService(ProjectWorkspace.open(ws.path)).split_clip(0.5))
    assert error.code == "no_tracks_to_split"
    assert str(error) == "no tracks to split. Pass at least one track."


SPLIT_AT_TIME_CASES = [
    pytest.param(
        lambda service: service.split_at_time(0.5), AT_SINGLE_TIME, AT_KEYS, id="at_single_time"
    ),
    pytest.param(
        lambda service: service.split_at_time(0.5, ["host"]),
        AT_EXPLICIT_TRACK_IDS,
        AT_KEYS,
        id="at_explicit_track_ids",
    ),
    pytest.param(
        lambda service: service.split_at_time(0.25, extra_at_times=[0.5, 0.75]),
        AT_EXTRA_TIMES_CHAINED,
        AT_MULTI_KEYS,
        id="at_extra_times_chained",
    ),
    pytest.param(
        lambda service: service.split_at_time(2.0, extra_at_times=[0.5]),
        AT_EXTRA_TIME_SKIPS_TRACK,
        AT_MULTI_KEYS,
        id="at_extra_time_skips_track",
    ),
    pytest.param(
        lambda service: service.split_at_time(0.5, extra_at_times=[3.5]),
        AT_EXTRA_TIME_WITHOUT_CLIP_SKIPPED,
        AT_MULTI_KEYS,
        id="at_extra_time_without_clip_skipped",
    ),
    pytest.param(
        lambda service: service.split_at_time(0.5, propose=True),
        AT_PROPOSE_DEFAULTS,
        PROPOSE_KEYS,
        id="at_propose_defaults",
    ),
    pytest.param(
        lambda service: service.split_at_time(
            0.5, ["host"], propose=True, reason="why", author="bob", extra_at_times=[1.5]
        ),
        AT_PROPOSE_REASON_AUTHOR_EXTRA,
        PROPOSE_KEYS,
        id="at_propose_reason_author_extra",
    ),
]


@pytest.mark.parametrize(("call", "expected", "keys"), SPLIT_AT_TIME_CASES)
def test_service_split_at_time_wire(ws, call, expected, keys):
    result = call(TimelineService(ws))
    result = result.model_dump()
    assert list(result) == keys
    assert _text(result) == expected


def test_service_split_at_time_single_time_shape(ws):
    result = TimelineService(ws).split_at_time(0.5)
    result = result.model_dump()
    assert "split_times" not in result
    assert "split_pieces" not in result
    assert [list(piece) for piece in result["first_right_pieces"]] == [
        ["track_id", "clip_id"],
        ["track_id", "clip_id"],
    ]


def test_service_split_at_time_extra_times_shape(ws):
    result = TimelineService(ws).split_at_time(0.25, extra_at_times=[0.5, 0.75])
    result = result.model_dump()
    assert result["split_times"] == [0.25, 0.5, 0.75]
    assert "split_pieces" not in result
    first_right = {piece["track_id"]: piece["clip_id"] for piece in result["first_right_pieces"]}
    reopened = ProjectWorkspace.open(ws.path)
    by_id = {clip.id: clip for clip in reopened.project.timeline.clips}
    assert {tid: by_id[cid].timeline_start for tid, cid in first_right.items()} == {
        "host": 0.25,
        "guest": 0.25,
    }
    assert {tid: by_id[cid].timeline_end for tid, cid in first_right.items()} == {
        "host": 0.5,
        "guest": 0.5,
    }


def test_service_split_at_time_extra_time_skips_one_without_clip(ws):
    result = TimelineService(ws).split_at_time(0.5, extra_at_times=[3.5])
    result = result.model_dump()
    assert result["split_times"] == [0.5]
    assert result["at_time"] == 0.5


def test_service_split_at_time_propose_does_not_split(ws):
    TimelineService(ws).split_at_time(0.5, propose=True)
    reopened = ProjectWorkspace.open(ws.path)
    assert sorted(clip.id for clip in reopened.project.timeline.clips) == ["g1", "h1"]


def test_service_split_at_time_propose_edit_is_first_edit(ws):
    result = TimelineService(ws).split_at_time(
        0.5, ["host"], propose=True, extra_at_times=[1.5], author="bob"
    )
    result = result.model_dump()
    assert result["edit"] == result["edits"][0]
    assert all(list(edit) == EDIT_KEYS for edit in result["edits"])
    assert [edit["start"] for edit in result["edits"]] == [0.5, 1.5]
    assert [edit["author"] for edit in result["edits"]] == ["bob", "bob"]
    assert result["edits"][0]["reason"] == "guest:suggest_split"


@pytest.mark.parametrize(
    ("call", "message"),
    [
        pytest.param(
            lambda service: service.split_at_time(3.5),
            "no clip at timeline 3.5 on tracks ['host', 'guest']",
            id="single_time",
        ),
        pytest.param(
            lambda service: service.split_at_time(3.5, ["host"]),
            "no clip at timeline 3.5 on tracks ['host']",
            id="explicit_tracks",
        ),
        pytest.param(
            lambda service: service.split_at_time(3.5, extra_at_times=[3.6]),
            "no clip at timeline 3.6 on tracks ['host', 'guest']",
            id="every_time_without_clip_raises_last",
        ),
    ],
)
def test_service_split_at_time_no_clip_at_time(ws, call, message):
    error = _failure(lambda: call(TimelineService(ws)))
    assert error.code == "no_clip_at_time"
    assert str(error) == message


def test_service_split_at_time_no_tracks(ws):
    ws.project.timeline.tracks = []
    ws.project.timeline.clips = []
    save_project(ws.project, ws.path)
    error = _failure(lambda: TimelineService(ProjectWorkspace.open(ws.path)).split_at_time(0.5))
    assert error.code == "no_tracks_to_split"
    assert str(error) == "no tracks to split"


HANDLER_CASES = [
    pytest.param(
        {"at_time": 0.5},
        AT_SINGLE_TIME,
        id="handler_single_time",
    ),
    pytest.param(
        {"at_time": 0.5, "track_ids": ["host"]},
        AT_EXPLICIT_TRACK_IDS,
        id="handler_track_ids",
    ),
    pytest.param(
        {"at_time": 0.25, "extra_at_times": [0.5, 0.75]},
        AT_EXTRA_TIMES_CHAINED,
        id="handler_extra_at_times",
    ),
    pytest.param(
        {"at_time": 2.0, "extra_at_times": [0.5]},
        AT_EXTRA_TIME_SKIPS_TRACK,
        id="handler_extra_time_skips_track",
    ),
    pytest.param(
        {"at_time": 0.5, "_structural_mode": "propose"},
        AT_PROPOSE_DEFAULTS,
        id="handler_propose_default_reason",
    ),
    pytest.param(
        {
            "at_time": 0.5,
            "track_ids": ["host"],
            "reason": "why",
            "_author": "bob",
            "_structural_mode": "propose",
            "extra_at_times": [1.5],
        },
        AT_PROPOSE_REASON_AUTHOR_EXTRA,
        id="handler_propose_reason_author",
    ),
]


@pytest.mark.parametrize(("payload", "expected"), HANDLER_CASES)
def test_handler_split_at_time_matches_service_wire(ws, payload, expected):
    result = handlers.split_at_time(ws, payload)
    assert isinstance(result, dict)
    assert _text(result) == expected


def test_handler_split_at_time_explicit_apply_mode(ws):
    result = handlers.split_at_time(ws, {"at_time": 0.5, "_structural_mode": "apply"})
    assert _text(result) == AT_SINGLE_TIME


def test_handler_split_at_time_invalid_mode(ws):
    error = _failure(lambda: handlers.split_at_time(ws, {"at_time": 0.5, "_structural_mode": "x"}))
    assert error.code == "structural_mode_invalid"
