"""Pin the wire output of ``TimelineService.copy_segment``.

The service result, the ``edit copy-segment`` CLI (``json.dumps(indent=2)``) and
``copy_segment_tool`` (``to_json``) carry the same ``{duration, extracts}`` clipboard, and
``paste_segment`` takes ``clipboard["duration"]`` and ``clipboard["extracts"]`` straight back.
Nothing is normalized: the project is built in code with explicit clip times. ``_as_dict`` lets
the same expectations hold if the service returns a model instead of a bare dict.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools.timeline import copy_segment_tool
from podcast_mcp.models import (
    Clip,
    ClipBleedRestore,
    ClipJoinMode,
    ClipMuteRegion,
    ClipOffSpeakerMuteRegion,
    EditMode,
    FadeCurve,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import SourceSpan
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()

SHA = "a" * 64
ERROR_TEXT = "end must be after start. Pick an end later than the start."

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_BOX = re.compile(r"[│╭╮╰╯─]")


def _error_text(text: str) -> str:
    return " ".join(_BOX.sub(" ", _ANSI.sub("", text)).split())


def _as_dict(result: Any) -> dict:
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


def _text(value: Any) -> str:
    return json.dumps(value)


def _plain(
    track: str, source_start: float, source_end: float, at: float, fade_in=0, fade_out=0
) -> dict:
    return {
        "track_id": track,
        "source_start": source_start,
        "source_end": source_end,
        "relative_timeline_start": at,
        "source_id": None,
        "fade_in_ms": fade_in,
        "fade_out_ms": fade_out,
        "join_in_mode": "fade",
        "mute_regions": [],
    }


EXTRACT_KEYS = [
    "track_id",
    "source_start",
    "source_end",
    "relative_timeline_start",
    "source_id",
    "fade_in_ms",
    "fade_out_ms",
    "join_in_mode",
    "mute_regions",
]
RICH_KEYS = [
    "track_id",
    "source_start",
    "source_end",
    "relative_timeline_start",
    "source_id",
    "fade_in_ms",
    "fade_out_ms",
    "gain_db",
    "fade_in_curve",
    "fade_out_curve",
    "join_in_mode",
    "mute_regions",
    "off_speaker_mute_regions",
    "bleed_restore",
]

HOST_1 = _plain("host", 0.0, 5.0, 0.0, 10, 20)
HOST_2 = _plain("host", 10.0, 15.0, 5.0, 30, 40) | {"fade_out_curve": "s"}
HOST_2_KEYS = [*EXTRACT_KEYS[:7], "fade_out_curve", *EXTRACT_KEYS[7:]]
GUEST_1 = _plain("guest", 0.0, 4.0, 1.0)
RICH = {
    "track_id": "extra",
    "source_start": 20.0,
    "source_end": 26.0,
    "relative_timeline_start": 2.0,
    "source_id": None,
    "fade_in_ms": 100,
    "fade_out_ms": 200,
    "gain_db": -3.5,
    "fade_in_curve": "equal_power",
    "fade_out_curve": "s",
    "join_in_mode": "crossfade",
    "mute_regions": [
        {"start_s": 21.0, "end_s": 22.0, "fade_out_ms": 5, "fade_in_ms": 6},
        {"start_s": 23.0, "end_s": 23.5, "fade_out_ms": 5, "fade_in_ms": 5, "gain_db": -6.0},
    ],
    "off_speaker_mute_regions": [
        {"start_s": 24.0, "end_s": 24.5, "fade_out_ms": 5, "fade_in_ms": 5}
    ],
    "bleed_restore": {"source_sha256": SHA, "regions": [{"start_s": 25.0, "end_s": 25.5}]},
}


def _track(track_id: str) -> Track:
    return Track(
        id=track_id,
        label=track_id,
        role=TrackRole.DIALOGUE,
        media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=80.0),
    )


def _build(path: Path, *, with_extra: bool) -> Path:
    project = load_project(path)
    project.timeline.tracks = [_track("host"), _track("guest")]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
            fade_in_ms=10,
            fade_out_ms=20,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=10.0,
            source_end=15.0,
            timeline_start=5.0,
            fade_in_ms=30,
            fade_out_ms=40,
            fade_out_curve=FadeCurve.S,
        ),
        Clip(id="g1", track_id="guest", source_start=0.0, source_end=4.0, timeline_start=1.0),
    ]
    if with_extra:
        project.timeline.tracks.append(_track("extra"))
        project.timeline.clips.append(
            Clip(
                id="x1",
                track_id="extra",
                source_start=20.0,
                source_end=26.0,
                timeline_start=2.0,
                fade_in_ms=100,
                fade_out_ms=200,
                gain_db=-3.5,
                fade_in_curve=FadeCurve.EQUAL_POWER,
                fade_out_curve=FadeCurve.S,
                join_in_mode=ClipJoinMode.CROSSFADE,
                mute_regions=[
                    ClipMuteRegion(start_s=21.0, end_s=22.0, fade_out_ms=5, fade_in_ms=6),
                    ClipMuteRegion(start_s=23.0, end_s=23.5, gain_db=-6.0),
                ],
                off_speaker_mute_regions=[ClipOffSpeakerMuteRegion(start_s=24.0, end_s=24.5)],
                bleed_restore=ClipBleedRestore(
                    source_sha256=SHA, regions=[SourceSpan(start_s=25.0, end_s=25.5)]
                ),
            )
        )
    project.timeline.duration_sec = 15.0
    save_project(project)
    return path


@pytest.fixture
def built(minimal_project) -> Path:
    return _build(minimal_project, with_extra=False)


@pytest.fixture
def rich(minimal_project) -> Path:
    return _build(minimal_project, with_extra=True)


@pytest.fixture(autouse=True)
def _no_debug(monkeypatch):
    monkeypatch.delenv("PODCAST_DEBUG", raising=False)


def _copy(path: Path, start, end, track_ids=None) -> dict:
    return _as_dict(
        TimelineService(ProjectWorkspace.open(path)).copy_segment(start, end, track_ids)
    )


def _geometry(path: Path) -> list[tuple]:
    return sorted(
        (c.track_id, c.timeline_start, c.source_start, c.source_end, c.fade_in_ms, c.fade_out_ms)
        for c in load_project(path).clips
    )


def _cli(path: Path, start: str, end: str, tracks: str | None = None):
    args = ["edit", "copy-segment", "--project", str(path), "--start", start, "--end", end]
    if tracks is not None:
        args += ["--tracks", tracks]
    return runner.invoke(app, args)


def _tool(path: Path, start, end, track_ids=None) -> str:
    return copy_segment_tool(str(path), start, end, track_ids)


# ------------------------------------------------------------------ (a) plain copy


def test_plain_two_track_copy_exact_dict_and_key_order(built):
    result = _copy(built, 0, 10)
    assert list(result) == ["duration", "extracts"]
    assert result == {"duration": 10, "extracts": [HOST_1, HOST_2, GUEST_1]}
    assert [list(e) for e in result["extracts"]] == [EXTRACT_KEYS, HOST_2_KEYS, EXTRACT_KEYS]


def test_plain_copy_pinned_text(built):
    assert _text(_copy(built, 0, 10)) == (
        '{"duration": 10, "extracts": ['
        '{"track_id": "host", "source_start": 0.0, "source_end": 5.0, '
        '"relative_timeline_start": 0.0, "source_id": null, "fade_in_ms": 10, '
        '"fade_out_ms": 20, "join_in_mode": "fade", "mute_regions": []}, '
        '{"track_id": "host", "source_start": 10.0, "source_end": 15.0, '
        '"relative_timeline_start": 5.0, "source_id": null, "fade_in_ms": 30, '
        '"fade_out_ms": 40, "fade_out_curve": "s", "join_in_mode": "fade", '
        '"mute_regions": []}, '
        '{"track_id": "guest", "source_start": 0.0, "source_end": 4.0, '
        '"relative_timeline_start": 1.0, "source_id": null, "fade_in_ms": 0, '
        '"fade_out_ms": 0, "join_in_mode": "fade", "mute_regions": []}]}'
    )


def test_service_is_read_only(built):
    before = _geometry(built)
    entries = len(load_project(built).history.entries)
    _copy(built, 0, 10)
    assert _geometry(built) == before
    assert len(load_project(built).history.entries) == entries


# ------------------------------------------------------------------ (b) optional keys


def test_rich_clip_optional_keys_and_positions(rich):
    result = _copy(rich, 0, 10, ["extra"])
    assert list(result) == ["duration", "extracts"]
    (extract,) = result["extracts"]
    assert list(extract) == RICH_KEYS
    assert extract == RICH
    assert _text(extract["mute_regions"]) == (
        '[{"start_s": 21.0, "end_s": 22.0, "fade_out_ms": 5, "fade_in_ms": 6}, '
        '{"start_s": 23.0, "end_s": 23.5, "fade_out_ms": 5, "fade_in_ms": 5, "gain_db": -6.0}]'
    )
    assert [list(r) for r in extract["mute_regions"]] == [
        ["start_s", "end_s", "fade_out_ms", "fade_in_ms"],
        ["start_s", "end_s", "fade_out_ms", "fade_in_ms", "gain_db"],
    ]
    assert list(extract["off_speaker_mute_regions"][0]) == [
        "start_s",
        "end_s",
        "fade_out_ms",
        "fade_in_ms",
    ]
    assert list(extract["bleed_restore"]) == ["source_sha256", "regions"]
    assert list(extract["bleed_restore"]["regions"][0]) == ["start_s", "end_s"]


def test_plain_clips_omit_every_optional_key(built):
    for extract in _copy(built, 0, 10)["extracts"]:
        for key in (
            "gain_db",
            "fade_in_curve",
            "off_speaker_mute_regions",
            "bleed_restore",
        ):
            assert key not in extract
    assert "fade_out_curve" not in _copy(built, 0, 10)["extracts"][0]
    assert "fade_out_curve" in _copy(built, 0, 10)["extracts"][1]


def _single_optional(path: Path, **changes) -> dict:
    project = load_project(path)
    clip = next(c for c in project.clips if c.id == "g1")
    for key, value in changes.items():
        setattr(clip, key, value)
    save_project(project)
    (extract,) = _copy(path, 0, 10, ["guest"])["extracts"]
    return extract


def test_gain_alone_sits_after_fades(built):
    extract = _single_optional(built, gain_db=2.5)
    assert list(extract) == [*EXTRACT_KEYS[:7], "gain_db", "join_in_mode", "mute_regions"]
    assert extract["gain_db"] == 2.5


def test_in_curve_alone_sits_between_fades_and_join_mode(built):
    extract = _single_optional(built, fade_in_curve=FadeCurve.EQUAL_POWER)
    assert list(extract) == [*EXTRACT_KEYS[:7], "fade_in_curve", "join_in_mode", "mute_regions"]
    assert extract["fade_in_curve"] == "equal_power"


def test_join_in_mode_cut_and_off_speaker_alone(built):
    extract = _single_optional(
        built,
        join_in_mode=ClipJoinMode.CUT,
        off_speaker_mute_regions=[ClipOffSpeakerMuteRegion(start_s=1.0, end_s=2.0)],
    )
    assert list(extract) == [*EXTRACT_KEYS, "off_speaker_mute_regions"]
    assert extract["join_in_mode"] == "cut"
    assert extract["off_speaker_mute_regions"] == [
        {"start_s": 1.0, "end_s": 2.0, "fade_out_ms": 5, "fade_in_ms": 5}
    ]


def test_bleed_restore_alone_is_last(built):
    extract = _single_optional(
        built,
        bleed_restore=ClipBleedRestore(
            source_sha256=SHA, regions=[SourceSpan(start_s=1.0, end_s=2.0)]
        ),
    )
    assert list(extract) == [*EXTRACT_KEYS, "bleed_restore"]


def test_mute_regions_are_sorted_in_the_extract(built):
    extract = _single_optional(
        built,
        mute_regions=[
            ClipMuteRegion(start_s=2.0, end_s=3.0),
            ClipMuteRegion(start_s=0.5, end_s=1.0),
        ],
    )
    assert [r["start_s"] for r in extract["mute_regions"]] == [0.5, 2.0]


def test_range_inside_rich_clip_slices_source_but_keeps_everything(rich):
    result = _copy(rich, 2.5, 4, ["extra"])
    (extract,) = result["extracts"]
    assert list(extract) == RICH_KEYS
    assert extract["source_start"] == 20.5
    assert extract["source_end"] == 22.0
    assert extract["relative_timeline_start"] == 0.0
    assert extract["fade_in_ms"] == 100
    assert extract["fade_out_ms"] == 200
    assert extract["fade_out_curve"] == "s"
    assert extract["mute_regions"] == RICH["mute_regions"][:1]
    assert extract["off_speaker_mute_regions"] == RICH["off_speaker_mute_regions"]
    assert extract["bleed_restore"] == RICH["bleed_restore"]


# ------------------------------------------------------------------ (c) range, filter, order


def test_range_ending_inside_a_clip_keeps_the_clip_fades(built):
    result = _copy(built, 3, 8.3)
    assert result["duration"] == 5.300000000000001
    assert result["extracts"] == [
        _plain("host", 3.0, 5.0, 0.0, 10, 20),
        _plain("host", 10.0, 13.3, 2.0, 30, 40) | {"fade_out_curve": "s"},
        _plain("guest", 2.0, 4.0, 0.0),
    ]


def test_range_ending_inside_first_clip_keeps_both_fades(built):
    result = _copy(built, 2.5, 4)
    assert result == {
        "duration": 1.5,
        "extracts": [
            _plain("host", 2.5, 4.0, 0.0, 10, 20),
            _plain("guest", 1.5, 3.0, 0.0),
        ],
    }


def test_track_ids_filter(built):
    assert _copy(built, 0, 10, ["guest"]) == {"duration": 10, "extracts": [GUEST_1]}
    assert _copy(built, 0, 10, ["host"])["extracts"] == [HOST_1, HOST_2]
    assert _copy(built, 0, 10, ["nope"]) == {"duration": 10, "extracts": []}


def test_track_ids_order_wins_and_default_is_clip_order(rich):
    default = [e["track_id"] for e in _copy(rich, 0, 10)["extracts"]]
    assert default == ["host", "host", "guest", "extra"]
    ordered = [e["track_id"] for e in _copy(rich, 0, 10, ["extra", "host"])["extracts"]]
    assert ordered == ["extra", "host", "host"]
    assert [e["track_id"] for e in _copy(rich, 0, 10, [])["extracts"]] == default


def test_empty_range_with_no_clips(built):
    result = _copy(built, 100, 110)
    assert result == {"duration": 10, "extracts": []}
    assert _text(result) == '{"duration": 10, "extracts": []}'


def test_empty_project(minimal_project):
    assert _copy(minimal_project, 0, 2) == {"duration": 2, "extracts": []}


# ------------------------------------------------------------------ (g) float formatting


def test_duration_float_formatting(built):
    assert _text(_copy(built, 0, 0.30000000000000004)) == (
        '{"duration": 0.30000000000000004, "extracts": [{"track_id": "host", '
        '"source_start": 0.0, "source_end": 0.30000000000000004, '
        '"relative_timeline_start": 0.0, "source_id": null, "fade_in_ms": 10, '
        '"fade_out_ms": 20, "join_in_mode": "fade", "mute_regions": []}]}'
    )
    assert _copy(built, 0.1, 0.4)["duration"] == 0.30000000000000004


def test_duration_follows_the_argument_type(built):
    assert _text(_copy(built, 0, 10))[:15] == '{"duration": 10'
    assert _text(_copy(built, 0.0, 10.0))[:17] == '{"duration": 10.0'
    assert _text(_copy(built, 1, 3.0))[:16] == '{"duration": 2.0'
    assert isinstance(_copy(built, 0, 10)["duration"], int)
    assert isinstance(_copy(built, 0.0, 10.0)["duration"], float)


# ------------------------------------------------------------------ (d) errors


@pytest.mark.parametrize(("start", "end"), [(5, 5), (5.0, 2.0), (0, -1)])
def test_service_range_end_before_start(built, start, end):
    with pytest.raises(CodedValueError) as raised:
        TimelineService(ProjectWorkspace.open(built)).copy_segment(start, end)
    assert raised.value.code == "range_end_before_start"
    assert str(raised.value) == ERROR_TEXT


def test_cli_range_end_before_start(built):
    result = _cli(built, "5", "2")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert _error_text(result.stderr) == (
        f"Error: {ERROR_TEXT} (code range_end_before_start) (set PODCAST_DEBUG=1 for the traceback)"
    )
    assert isinstance(result.exception, SystemExit)


def test_mcp_range_end_before_start(built):
    with pytest.raises(CodedValueError) as raised:
        _tool(built, 5.0, 5.0)
    assert raised.value.code == "range_end_before_start"
    assert str(raised.value) == ERROR_TEXT


# ------------------------------------------------------------------ (e) CLI and MCP bytes


def test_cli_stdout_is_indent_two_json_of_the_service_result(rich):
    result = _cli(rich, "0", "10")
    assert result.exit_code == 0, result.output
    expected = _copy(rich, 0.0, 10.0)
    assert result.stdout == json.dumps(expected, indent=2) + "\n"
    assert list(json.loads(result.stdout)["extracts"][-1]) == RICH_KEYS


def test_cli_stdout_pinned_bytes(built):
    result = _cli(built, "0", "2.5", "guest")
    assert result.exit_code == 0, result.output
    assert result.stdout == (
        "{\n"
        '  "duration": 2.5,\n'
        '  "extracts": [\n'
        "    {\n"
        '      "track_id": "guest",\n'
        '      "source_start": 0.0,\n'
        '      "source_end": 1.5,\n'
        '      "relative_timeline_start": 1.0,\n'
        '      "source_id": null,\n'
        '      "fade_in_ms": 0,\n'
        '      "fade_out_ms": 0,\n'
        '      "join_in_mode": "fade",\n'
        '      "mute_regions": []\n'
        "    }\n"
        "  ]\n"
        "}\n"
    )


def test_cli_whole_number_range_prints_float_duration(built):
    result = _cli(built, "0", "10")
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["duration"] == 10.0
    assert result.stdout.startswith('{\n  "duration": 10.0,\n')


def test_cli_tracks_option_filters_and_orders(rich):
    result = _cli(rich, "0", "10", " extra , guest ,")
    assert result.exit_code == 0, result.output
    assert [e["track_id"] for e in json.loads(result.stdout)["extracts"]] == ["extra", "guest"]


def test_cli_empty_range(built):
    result = _cli(built, "100", "110")
    assert result.exit_code == 0, result.output
    assert result.stdout == '{\n  "duration": 10.0,\n  "extracts": []\n}\n'


def test_mcp_output_text(rich):
    out = _tool(rich, 0, 10)
    assert out == json.dumps(_copy(rich, 0, 10), indent=2)
    assert list(json.loads(out)) == ["duration", "extracts"]
    assert list(json.loads(out)["extracts"][-1]) == RICH_KEYS


def test_mcp_output_pinned_for_empty_and_filtered(built):
    assert _tool(built, 100, 110) == '{\n  "duration": 10,\n  "extracts": []\n}'
    assert _tool(built, 0.0, 10.0, ["nope"]) == '{\n  "duration": 10.0,\n  "extracts": []\n}'
    assert json.loads(_tool(built, 0, 10, ["guest"])) == {"duration": 10, "extracts": [GUEST_1]}


# ------------------------------------------------------------------ (f) round trip into paste


def _paste_roundtrip(path: Path, insert_at: float, mode: EditMode, *, start=0, end=10) -> list:
    ws = ProjectWorkspace.open(path)
    clipboard = _as_dict(TimelineService(ws).copy_segment(start, end))
    TimelineService(ProjectWorkspace.open(path)).paste_segment(
        insert_at, clipboard["duration"], clipboard["extracts"], mode=mode
    )
    return _geometry(path)


def test_round_trip_ripple_paste(built):
    assert _paste_roundtrip(built, 10.0, EditMode.RIPPLE) == [
        ("guest", 1.0, 0.0, 4.0, 0, 0),
        ("guest", 11.0, 0.0, 4.0, 0, 0),
        ("host", 0.0, 0.0, 5.0, 10, 20),
        ("host", 5.0, 10.0, 15.0, 30, 40),
        ("host", 10.0, 0.0, 5.0, 10, 20),
        ("host", 15.0, 10.0, 15.0, 30, 40),
    ]


def test_round_trip_gap_paste_after_the_range(built):
    assert _paste_roundtrip(built, 20, EditMode.GAP) == [
        ("guest", 1.0, 0.0, 4.0, 0, 0),
        ("guest", 21.0, 0.0, 4.0, 0, 0),
        ("host", 0.0, 0.0, 5.0, 10, 20),
        ("host", 5.0, 10.0, 15.0, 30, 40),
        ("host", 20.0, 0.0, 5.0, 10, 20),
        ("host", 25.0, 10.0, 15.0, 30, 40),
    ]


def test_round_trip_partial_range_keeps_fades(built):
    assert _paste_roundtrip(built, 20, EditMode.GAP, start=3, end=8.3) == [
        ("guest", 1.0, 0.0, 4.0, 0, 0),
        ("guest", 20.0, 2.0, 4.0, 0, 0),
        ("host", 0.0, 0.0, 5.0, 10, 20),
        ("host", 5.0, 10.0, 15.0, 30, 40),
        ("host", 20.0, 3.0, 5.0, 10, 20),
        ("host", 22.0, 10.0, 13.3, 30, 40),
    ]


def test_round_trip_rich_clip_survives_paste(rich):
    ws = ProjectWorkspace.open(rich)
    clipboard = _as_dict(TimelineService(ws).copy_segment(0, 10, ["extra"]))
    TimelineService(ProjectWorkspace.open(rich)).paste_segment(
        20, clipboard["duration"], clipboard["extracts"], mode=EditMode.GAP
    )
    pasted = [c for c in load_project(rich).clips if c.track_id == "extra" and c.id != "x1"]
    assert len(pasted) == 1
    clip = pasted[0]
    assert (clip.timeline_start, clip.source_start, clip.source_end) == (22.0, 20.0, 26.0)
    assert (clip.fade_in_ms, clip.fade_out_ms, clip.gain_db) == (100, 200, -3.5)
    assert clip.join_in_mode is ClipJoinMode.CROSSFADE
    assert (clip.fade_in_curve, clip.fade_out_curve) == (FadeCurve.EQUAL_POWER, FadeCurve.S)
    assert len(clip.mute_regions) == 2
    assert len(clip.off_speaker_mute_regions) == 1
    assert clip.bleed_restore is not None


def test_round_trip_cli_clipboard_into_paste_cli(built, tmp_path):
    clipboard = tmp_path / "clip.json"
    out = _cli(built, "0", "10")
    assert out.exit_code == 0, out.output
    clipboard.write_text(out.stdout)
    result = runner.invoke(
        app,
        [
            "edit",
            "paste-segment",
            "--project",
            str(built),
            "--at",
            "10",
            "--clipboard",
            str(clipboard),
            "--mode",
            "ripple",
        ],
    )
    assert result.exit_code == 0, result.output
    assert len(_geometry(built)) == 6
