"""Wire pin for TimelineService.list_clips: key order, key presence and values of the
result at the service, the CLI, the MCP tool and the GUI assembler projections, so a
typed-result refactor must leave them unchanged. Recording keys are secret-derived, so
they are normalised to one placeholder per recording."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.gui.assembler import build_project_view, dump_project_projection
from podcast_mcp.mcp.tools.timeline import list_clips_tool
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    ClipMuteRegion,
    ClipOffSpeakerMuteRegion,
    FadeCurve,
    MediaAsset,
    SourceClippingRegion,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document import TimelineService

pytestmark = pytest.mark.unscoped_ok

STEPS = [
    {"at": 10, "delta_sec": 0.12},
    {"at": 15, "delta_sec": -0.08, "quiet": {"start_s": 14, "end_s": 16}},
]


@pytest.fixture
def episode(minimal_project: Path) -> Path:
    project = load_project(minimal_project)
    project.sources = [
        SourceRecording(
            id="s1",
            path="raw/guest.wav",
            duration_sec=100.0,
            clipping_regions=[SourceClippingRegion(start_s=1.0, end_s=1.5)],
            clipping_truncated=True,
        )
    ]
    project.timeline.tracks = [
        Track(
            id=tid,
            label=tid.title(),
            speaker=tid.title(),
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=100.0, sample_rate=16000),
        )
        for tid in ("host", "guest")
    ]
    project.timeline.clips = [
        Clip(
            id="h1",
            track_id="host",
            source_start=0.0,
            source_end=8.0,
            timeline_start=0.0,
            fade_out_ms=20,
        ),
        Clip(
            id="h2",
            track_id="host",
            source_start=8.0,
            source_end=20.0,
            timeline_start=8.0,
            fade_in_ms=20,
            gain_db=-3.5,
            fade_in_curve=FadeCurve.S,
            fade_out_curve=FadeCurve.EQUAL_POWER,
            join_in_mode=ClipJoinMode.CROSSFADE,
            timing={"steps": STEPS, "evidence": "private"},
            mute_regions=[ClipMuteRegion(start_s=9.0, end_s=9.5)],
        ),
        Clip(
            id="h3",
            track_id="host",
            source_start=30.0,
            source_end=40.0,
            timeline_start=20.0,
            join_in_mode=ClipJoinMode.CUT,
            off_speaker_mute_regions=[ClipOffSpeakerMuteRegion(start_s=31.0, end_s=32.0)],
        ),
        Clip(
            id="g1",
            track_id="guest",
            source_id="s1",
            source_start=0.0,
            source_end=20.0,
            timeline_start=0.0,
        ),
    ]
    project.timeline.duration_sec = 30.0
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="one", start=1.0, end=1.4),
                TranscriptWord(text="two", start=12.0, end=12.5, ignored=True),
            ],
        )
    ]
    save_project(project)
    return minimal_project


runner = CliRunner()

TOP_KEYS = ["tracks", "clip_count", "join_fade_limit_ms", "join_fade_limit_default_ms"]

G1 = {
    "id": "g1",
    "track_id": "guest",
    "source_start": 0.0,
    "source_end": 20.0,
    "timeline_start": 0.0,
    "timeline_end": 20.0,
    "fade_in_ms": 0,
    "fade_out_ms": 0,
    "join_in_mode": "fade",
    "join_left_clip_id": None,
    "join_render_mode": None,
    "join_crossfade_ms": 0,
    "join_crossfade_blocked": None,
    "source_id": "s1",
    "source_duration_sec": 100.0,
    "recording_key": "<rec:s1>",
    "origin_track_id": "guest",
    "mute_regions": [],
    "clipping_regions": [{"start_s": 1.0, "end_s": 1.5}],
    "clipping_truncated": True,
}
H1 = {
    "id": "h1",
    "track_id": "host",
    "source_start": 0.0,
    "source_end": 8.0,
    "timeline_start": 0.0,
    "timeline_end": 8.0,
    "fade_in_ms": 0,
    "fade_out_ms": 20,
    "join_in_mode": "fade",
    "join_left_clip_id": None,
    "join_render_mode": None,
    "join_crossfade_ms": 0,
    "join_crossfade_blocked": None,
    "source_id": None,
    "source_duration_sec": 100.0,
    "recording_key": "<rec:host>",
    "origin_track_id": "host",
    "mute_regions": [],
    "clipping_regions": [],
    "clipping_truncated": False,
}
H2_BARE = {
    "id": "h2",
    "track_id": "host",
    "source_start": 8.0,
    "source_end": 20.0,
    "timeline_start": 8.0,
    "timeline_end": 20.04,
    "fade_in_ms": 20,
    "fade_out_ms": 0,
    "gain_db": -3.5,
    "fade_in_curve": "s",
    "fade_out_curve": "equal_power",
    "join_in_mode": "crossfade",
    "join_left_clip_id": "h1",
    "join_render_mode": "crossfade",
    "join_crossfade_ms": 20,
    "join_crossfade_blocked": None,
    "join_borrow_sec": 0.01,
    "source_id": None,
    "source_duration_sec": 100.0,
    "recording_key": "<rec:host>",
    "origin_track_id": "host",
    "mute_regions": [{"start_s": 9.0, "end_s": 9.5, "fade_out_ms": 5, "fade_in_ms": 5}],
    "ignored_word_regions": [{"start_s": 12.0, "end_s": 12.5, "fade_out_ms": 5, "fade_in_ms": 5}],
    "clipping_regions": [],
    "clipping_truncated": False,
}
H2 = {
    **H2_BARE,
    "timing_steps": 2,
    "timing_summary": "2 corrections, largest 120 ms",
}
H2_STEPS = {
    **H2,
    "timing": {
        "steps": [{"at": 10.0, "delta_sec": 0.12}, {"at": 15.0, "delta_sec": -0.08}],
        "method": "bleed_lag",
        "micro_fade_ms": 10,
    },
}
H3 = {
    "id": "h3",
    "track_id": "host",
    "source_start": 30.0,
    "source_end": 40.0,
    "timeline_start": 20.0,
    "timeline_end": 30.0,
    "fade_in_ms": 0,
    "fade_out_ms": 0,
    "join_in_mode": "cut",
    "join_left_clip_id": "h2",
    "join_render_mode": "cut",
    "join_crossfade_ms": 0,
    "join_crossfade_blocked": None,
    "source_id": None,
    "source_duration_sec": 100.0,
    "recording_key": "<rec:host>",
    "origin_track_id": "host",
    "mute_regions": [],
    "off_speaker_mute_regions": [
        {"start_s": 31.0, "end_s": 32.0, "fade_out_ms": 5, "fade_in_ms": 5}
    ],
    "clipping_regions": [],
    "clipping_truncated": False,
}
ROW_KEYS_H2_STEPS = list(H2_STEPS)


def _listing(rows: dict, count: int, limit: int = 40, default: int = 40) -> dict:
    return {
        "tracks": rows,
        "clip_count": count,
        "join_fade_limit_ms": limit,
        "join_fade_limit_default_ms": default,
    }


ALL = _listing({"guest": [G1], "host": [H1, H2, H3]}, 4)
ALL_STEPS = _listing({"guest": [G1], "host": [H1, H2_STEPS, H3]}, 4)
HOST = _listing({"host": [H1, H2, H3]}, 3)
HOST_STEPS = _listing({"host": [H1, H2_STEPS, H3]}, 3)
GUEST = _listing({"guest": [G1]}, 1)
EMPTY = _listing({}, 0)


def _normalized(result) -> dict:
    if hasattr(result, "model_dump"):
        result = result.model_dump()
    assert type(result) is dict
    text = json.dumps(result)
    rows = [row for lane in result["tracks"].values() for row in lane]
    for row in rows:
        assert re.fullmatch(r"rec_[0-9a-f]{16}", row["recording_key"])
    by_recording = {row["track_id"]: row["recording_key"] for row in rows}
    assert len(set(by_recording.values())) == len(by_recording)
    value = json.loads(text)
    for row in (row for lane in value["tracks"].values() for row in lane):
        row["recording_key"] = f"<rec:{row['source_id'] or row['track_id']}>"
    return value


def _pin(result, expected: dict) -> None:
    actual = _normalized(result)
    assert list(actual) == TOP_KEYS
    assert list(actual["tracks"]) == list(expected["tracks"])
    for track_id, rows in expected["tracks"].items():
        for got, want in zip(actual["tracks"][track_id], rows, strict=True):
            assert list(got) == list(want)
    assert json.dumps(actual) == json.dumps(expected)


def _service(episode: Path) -> TimelineService:
    return TimelineService(ProjectWorkspace.open(episode))


def test_service_all_tracks(episode):
    _pin(_service(episode).list_clips(), ALL)


def test_service_all_tracks_with_timing_steps(episode):
    result = _service(episode).list_clips(include_timing_steps=True)
    _pin(result, ALL_STEPS)
    assert list(_normalized(result)["tracks"]["host"][1]) == ROW_KEYS_H2_STEPS


def test_service_explicit_false_matches_default(episode):
    _pin(_service(episode).list_clips(include_timing_steps=False), ALL)


def test_service_single_track(episode):
    svc = _service(episode)
    _pin(svc.list_clips("host"), HOST)
    _pin(svc.list_clips("host", include_timing_steps=True), HOST_STEPS)
    _pin(svc.list_clips(track_id="guest"), GUEST)
    _pin(svc.list_clips("guest", include_timing_steps=True), GUEST)


def test_service_unknown_track_is_empty(episode):
    _pin(_service(episode).list_clips("nope"), EMPTY)
    _pin(_service(episode).list_clips("nope", include_timing_steps=True), EMPTY)


def test_service_empty_timeline(minimal_project):
    _pin(_service(minimal_project).list_clips(), EMPTY)


def test_service_conditional_row_keys(episode):
    rows = {r["id"]: r for r in _normalized(_service(episode).list_clips())["tracks"]["host"]}
    assert {"gain_db", "fade_in_curve", "fade_out_curve", "join_borrow_sec"} <= rows["h2"].keys()
    assert {"ignored_word_regions", "timing_steps", "timing_summary"} <= rows["h2"].keys()
    assert "timing" not in rows["h2"]
    assert "off_speaker_mute_regions" in rows["h3"]
    for plain in (rows["h1"], rows["h3"]):
        absent = {"gain_db", "fade_in_curve", "ignored_word_regions", "timing_steps"}
        assert not absent & plain.keys()


def test_service_join_fade_limit_fields(episode):
    project = load_project(episode)
    project.timeline.join_fade_max_ms = 25
    save_project(project)
    _pin(_service(episode).list_clips("guest"), _listing({"guest": [G1]}, 1, 25, 40))


def test_service_join_fade_default_from_config(episode, monkeypatch):
    config = {"render": {"join_fade_max_ms": 60}}
    monkeypatch.setattr(ProjectWorkspace, "effective_config", lambda self: config)
    result = _service(episode).list_clips("guest")
    assert _normalized(result)["join_fade_limit_ms"] == 60
    assert _normalized(result)["join_fade_limit_default_ms"] == 60
    project = load_project(episode)
    project.timeline.join_fade_max_ms = 25
    save_project(project)
    again = _normalized(_service(episode).list_clips("guest"))
    assert (again["join_fade_limit_ms"], again["join_fade_limit_default_ms"]) == (25, 60)
    assert list(again) == TOP_KEYS


def _cli(episode: Path, *args: str):
    return runner.invoke(app, ["edit", "list-clips", "--project", str(episode), *args])


def _pin_cli(result, expected: dict) -> None:
    assert result.exit_code == 0, result.output
    parsed = json.loads(result.stdout)
    assert result.stdout == json.dumps(parsed, indent=2) + "\n"
    _pin(parsed, expected)


def test_cli_all_tracks(episode):
    _pin_cli(_cli(episode), ALL)


def test_cli_timing_steps(episode):
    _pin_cli(_cli(episode, "--timing-steps"), ALL_STEPS)


def test_cli_single_track(episode):
    _pin_cli(_cli(episode, "--track", "host"), HOST)
    _pin_cli(_cli(episode, "--track", "guest", "--timing-steps"), GUEST)


def test_cli_unknown_track_is_empty(episode):
    result = _cli(episode, "--track", "nope")
    assert result.exit_code == 0, result.output
    assert result.stdout == json.dumps(EMPTY, indent=2) + "\n"


def _pin_mcp(raw: str, expected: dict) -> None:
    assert isinstance(raw, str)
    _pin(json.loads(raw), expected)


def test_mcp_tool_all_tracks(episode):
    _pin_mcp(list_clips_tool(str(episode)), ALL)
    _pin_mcp(list_clips_tool(str(episode), include_timing_steps=True), ALL_STEPS)


def test_mcp_tool_single_track(episode):
    _pin_mcp(list_clips_tool(str(episode), "host"), HOST)
    _pin_mcp(list_clips_tool(str(episode), track_id="host", include_timing_steps=True), HOST_STEPS)
    _pin_mcp(list_clips_tool(str(episode), "guest"), GUEST)


def test_mcp_tool_unknown_track_is_empty(episode):
    assert json.loads(list_clips_tool(str(episode), "nope")) == EMPTY


def test_gui_clips_projection_for_host_and_guest(episode):
    host = dump_project_projection(episode, projection="clips")
    _pin(host["clips"], ALL_STEPS)
    guest = dump_project_projection(episode, projection="clips", audience="guest")
    _pin(guest["clips"], ALL)


def test_gui_transcript_audio_projection_clips(episode):
    host = dump_project_projection(episode, projection="transcript_audio")
    _pin(host["clips"], ALL_STEPS)
    guest = dump_project_projection(episode, projection="transcript_audio", audience="guest")
    _pin(guest["clips"], ALL)


def test_gui_full_view_clips_for_host_and_guest(episode):
    host = dump_project_projection(episode, projection="full")
    _pin(host["clips"], ALL_STEPS)
    guest = dump_project_projection(episode, projection="full", audience="guest")
    _pin(guest["clips"], ALL)


def test_gui_shell_view_clips(episode):
    _pin(dump_project_projection(episode, projection="shell")["clips"], ALL_STEPS)


def test_gui_view_object_clips(episode):
    _pin(build_project_view(ProjectWorkspace.open(episode)).clips, ALL_STEPS)
    guest = build_project_view(ProjectWorkspace.open(episode), audience="guest")
    _pin(guest.clips, ALL)


@pytest.fixture
def unicode_episode(minimal_project: Path) -> Path:
    project = load_project(minimal_project)
    project.timeline.tracks = [
        Track(
            id="hôte",
            label="Hôte",
            speaker="Hôte",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/hote.wav", duration_sec=100.0, sample_rate=16000),
        )
    ]
    project.timeline.clips = [
        Clip(
            id="clip-é",
            track_id="hôte",
            source_start=0.00001,
            source_end=8.0,
            timeline_start=0.0,
        )
    ]
    project.timeline.duration_sec = 8.0
    save_project(project)
    return minimal_project


def _raw_service_dump(episode: Path) -> dict:
    result = _service(episode).list_clips()
    return result.model_dump() if hasattr(result, "model_dump") else result


def _assert_raw_bytes(raw: str, episode: Path) -> None:
    dumped = _raw_service_dump(episode)
    row = dumped["tracks"]["hôte"][0]
    assert row["id"] == "clip-é"
    assert row["source_start"] == 0.00001
    assert "\\u00f4" in raw
    assert "\\u00e9" in raw
    assert "ô" not in raw
    assert "é" not in raw
    assert "1e-05" in raw
    assert "0.00001" not in raw
    assert json.loads(raw) == json.loads(json.dumps(dumped))


def test_mcp_tool_raw_string_bytes_with_unicode_and_tiny_float(unicode_episode):
    raw = list_clips_tool(str(unicode_episode))
    assert isinstance(raw, str)
    _assert_raw_bytes(raw, unicode_episode)
    assert raw == json.dumps(_raw_service_dump(unicode_episode), indent=2, default=str)


def test_cli_stdout_bytes_with_unicode_and_tiny_float(unicode_episode):
    result = _cli(unicode_episode)
    assert result.exit_code == 0, result.output
    _assert_raw_bytes(result.stdout, unicode_episode)
    assert result.stdout == json.dumps(_raw_service_dump(unicode_episode), indent=2) + "\n"
