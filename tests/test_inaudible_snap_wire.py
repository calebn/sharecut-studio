"""Wire pin for ``preview_inaudible_cut`` and ``waveform_snap_window`` on every surface.

Pins literal output text (key order, number formatting, ints vs floats) of the service,
``podcast edit preview-cut``, ``preview_inaudible_cut_tool``, ``GET /api/waveform-snap`` and
``share_daw_waveform_snap`` against a synthetic project. The expected texts are literals
captured from the engine, not recomputed values: a refactor behind these surfaces must not
change one byte of them.
"""

from __future__ import annotations

import json
import wave
from pathlib import Path
from typing import Any
from unittest.mock import patch

import numpy as np
import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines.waveform_pyramid import wait_pyramid_jobs
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools.edits import preview_inaudible_cut_tool
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share import share_daw_waveform_snap
from podcast_mcp.services.document import AnalysisService

pytestmark = pytest.mark.unscoped_ok

SR = 16000
CODE = "X-Sharecut-Error-Code"
LOOPBACK = ("127.0.0.1", 50000)
runner = CliRunner()

# name -> (kwargs of preview_inaudible_cut)
PREVIEW_CASES: dict[str, dict[str, Any]] = {
    "source_vocal_absorb_silence": {"track_id": "host", "start": 1.43, "end": 2.03},
    "source_vocal_absorb_silence_late_word": {"track_id": "host", "start": 4.52, "end": 5.0},
    "source_vocal_trailing_energy": {"track_id": "host", "start": 7.5, "end": 8.2},
    "source_vocal_plain": {"track_id": "host", "start": 6.9, "end": 7.1},
    "source_waveform_only": {"track_id": "bed", "start": 1.97, "end": 3.02},
    "source_by_speaker": {"speaker": "Bed", "start": 1.97, "end": 3.02},
    "timeline_vocal": {"track_id": "host", "start": 1.43, "end": 2.03, "timeline": True},
    "timeline_offset_waveform_only": {
        "track_id": "late",
        "start": 6.97,
        "end": 8.02,
        "timeline": True,
    },
    "timeline_passthrough_outside_clip": {
        "track_id": "host",
        "start": 20.0,
        "end": 21.0,
        "timeline": True,
    },
}

# name -> kwargs of waveform_snap_window
SNAP_CASES: dict[str, dict[str, Any]] = {
    "timeline_with_islands": {"track_id": "late", "start": 6.9, "end": 8.1, "timeline": True},
    "timeline_vocal_no_islands": {"track_id": "host", "start": 1.43, "end": 2.03, "timeline": True},
    "source_no_islands": {"track_id": "bed", "start": 1.9, "end": 3.1},
    "span_over_2s_focus": {"track_id": "host", "start": 0.0, "end": 10.0, "focus": 8.0},
    "span_over_2s_no_focus": {"track_id": "host", "start": 0.0, "end": 10.0},
    "span_over_2s_timeline_focus": {
        "track_id": "late",
        "start": 5.0,
        "end": 15.0,
        "timeline": True,
        "focus": 7.5,
    },
    "swapped_start_end": {"track_id": "host", "start": 3.0, "end": 2.0},
    "span_under_50ms": {"track_id": "host", "start": 1.0, "end": 1.01},
    "span_exactly_zero": {"track_id": "host", "start": 4.2, "end": 4.2},
}

# name -> (patched preview_inaudible_cut return value, waveform_snap_window kwargs)
TICK_INPUTS: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {
    "sub_microsecond_noise_merges": (
        {"start": 1.01002, "end": 1.0100204, "mode": "word"},
        {"track_id": "host", "start": 1.0, "end": 1.3},
    ),
    "twenty_microseconds_apart_stay_two": (
        {"start": 1.01, "end": 1.01002, "mode": "word"},
        {"track_id": "host", "start": 1.0, "end": 1.3},
    ),
    "int_edges_become_floats": (
        {"start": 1, "end": 2, "mode": "word"},
        {"track_id": "host", "start": 1.0, "end": 1.3},
    ),
    "island_midpoint_merges_with_preview_edge": (
        {"start": 7.49, "end": 7.4900004, "mode": "word"},
        {"track_id": "late", "start": 6.9, "end": 8.1, "timeline": True},
    ),
}


def _write_tone_wav(path: Path, bursts: list[tuple[float, float, float]], seconds: float) -> None:
    """Mono 16-bit wav of sine bursts ``(start, end, hz)`` over digital silence."""
    t = np.arange(int(seconds * SR)) / SR
    samples = np.zeros_like(t)
    for start, end, hz in bursts:
        live = (t >= start) & (t < end)
        samples[live] = 0.4 * np.sin(2 * np.pi * hz * t[live])
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(SR)
        audio.writeframes((samples * 32767).astype(np.int16).tobytes())


def _words(*rows: tuple[str, float, float]) -> list[TranscriptWord]:
    return [TranscriptWord(text=text, start=start, end=end) for text, start, end in rows]


@pytest.fixture
def snap_project(minimal_project: Path) -> Path:
    """A dialogue lane, a music bed with silence islands, and the bed again offset 5 s."""
    project = load_project(minimal_project)
    raw = project.workspace_path() / "raw"
    _write_tone_wav(
        raw / "host.wav",
        [
            (1.0, 1.4, 220.0),
            (1.45, 2.0, 220.0),
            (4.0, 4.5, 220.0),
            (6.0, 6.3, 220.0),
            (8.0, 8.5, 220.0),
            (9.0, 9.3, 220.0),
        ],
        10.0,
    )
    bed = [(0.0, 2.0, 330.0), (3.0, 5.0, 330.0), (6.0, 8.0, 330.0)]
    _write_tone_wav(raw / "bed.wav", bed, 10.0)
    _write_tone_wav(raw / "late.wav", bed, 10.0)

    def track(tid: str, label: str, role: TrackRole) -> Track:
        return Track(
            id=tid,
            label=label,
            role=role,
            speaker=label,
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=10.0),
        )

    project.timeline.tracks = [
        track("host", "Host", TrackRole.DIALOGUE),
        track("bed", "Bed", TrackRole.MUSIC),
        track("late", "Late", TrackRole.MUSIC),
    ]
    project.timeline.clips = [
        Clip(id="h", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0),
        Clip(id="b", track_id="bed", source_start=0.0, source_end=10.0, timeline_start=0.0),
        Clip(id="l", track_id="late", source_start=0.0, source_end=10.0, timeline_start=5.0),
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=_words(
                ("hello", 1.0, 1.4),
                ("there", 1.45, 2.0),
                ("again", 4.0, 4.5),
                ("end", 6.0, 6.3),
                ("um", 8.0, 8.2),
                ("ok", 9.0, 9.3),
            ),
        )
    ]
    save_project(project, minimal_project)
    wait_pyramid_jobs()
    return minimal_project


@pytest.fixture
def ws(snap_project: Path) -> ProjectWorkspace:
    return ProjectWorkspace.open(snap_project)


def _text(value: Any) -> str:
    return json.dumps(value, indent=2)


def _cli_args(project: Path, kwargs: dict[str, Any]) -> list[str]:
    args = ["edit", "preview-cut", "--project", str(project)]
    if "track_id" in kwargs:
        args += ["--track", kwargs["track_id"]]
    if "speaker" in kwargs:
        args += ["--speaker", kwargs["speaker"]]
    args += ["--start", str(kwargs["start"]), "--end", str(kwargs["end"])]
    if kwargs.get("timeline"):
        args.append("--timeline")
    return args


def _gui_get(project: Path, kwargs: dict[str, Any]):
    params: dict[str, Any] = {"path": str(project), **kwargs}
    if "timeline" in params:
        params["timeline"] = "true" if params["timeline"] else "false"
    return TestClient(create_app(), client=LOOPBACK).get("/api/waveform-snap", params=params)


def _compact(literal: str) -> str:
    """The text FastAPI writes for the JSON object a pinned indent=2 literal spells."""
    return json.dumps(json.loads(literal), separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------------------------------
# preview_inaudible_cut: service, CLI, MCP
# ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", list(PREVIEW_CASES))
def test_preview_service_text(ws, name):
    assert (
        _text(AnalysisService(ws).preview_inaudible_cut(**PREVIEW_CASES[name]))
        == (PREVIEW_PINS[name])
    )


@pytest.mark.parametrize("name", list(PREVIEW_CASES))
def test_preview_cli_text(snap_project, name):
    result = runner.invoke(app, _cli_args(snap_project, PREVIEW_CASES[name]))
    assert result.exit_code == 0, result.output
    assert result.stdout == PREVIEW_PINS[name] + "\n"


@pytest.mark.parametrize("name", list(PREVIEW_CASES))
def test_preview_mcp_text(snap_project, name):
    assert (
        preview_inaudible_cut_tool(str(snap_project), **PREVIEW_CASES[name]) == (PREVIEW_PINS[name])
    )


def test_preview_types_and_modes_are_pinned(ws):
    service = AnalysisService(ws)
    outs = {name: service.preview_inaudible_cut(**kw) for name, kw in PREVIEW_CASES.items()}
    assert {out["mode"] for out in outs.values()} == {"vocal_transcript_guided", "waveform_only"}
    for out in outs.values():
        assert list(out) == [
            "track_id",
            "timeline_mode",
            "start",
            "end",
            "mode",
            "shifted_start_ms",
            "shifted_end_ms",
            "confidence",
            "details",
        ]
        assert isinstance(out["timeline_mode"], bool)
        assert isinstance(out["confidence"], float)
        assert isinstance(out["shifted_start_ms"], float)
        assert isinstance(out["shifted_end_ms"], float)
        if out["details"] != {"strategy": "passthrough"}:
            assert isinstance(out["details"]["search_window_ms"], float)
            assert isinstance(out["details"]["trailing_energy_extended"], bool)
    assert outs["timeline_passthrough_outside_clip"]["details"] == {"strategy": "passthrough"}


def test_preview_unknown_track_service_mcp_cli(snap_project, ws):
    from podcast_mcp.util.coded_error import CodedValueError

    with pytest.raises(CodedValueError) as service_err:
        AnalysisService(ws).preview_inaudible_cut(track_id="nope", start=1.0, end=2.0)
    assert service_err.value.code == "track_not_found"
    assert str(service_err.value) == "unknown track_id: 'nope'"
    with pytest.raises(CodedValueError) as mcp_err:
        preview_inaudible_cut_tool(str(snap_project), start=1.0, end=2.0, track_id="nope")
    assert mcp_err.value.code == "track_not_found"
    assert str(mcp_err.value) == "unknown track_id: 'nope'"
    result = runner.invoke(
        app,
        _cli_args(snap_project, {"track_id": "nope", "start": 1, "end": 2}),
    )
    assert result.exit_code == CLI_UNKNOWN_TRACK_EXIT
    assert result.output == CLI_UNKNOWN_TRACK_OUTPUT


def test_preview_end_before_start_service(ws):
    from podcast_mcp.util.coded_error import CodedValueError

    with pytest.raises(CodedValueError) as err:
        AnalysisService(ws).preview_inaudible_cut(track_id="host", start=2.0, end=1.0)
    assert err.value.code == "range_end_before_start"
    assert str(err.value) == "end must be after start. Pick an end later than the start."
    with pytest.raises(CodedValueError) as tl_err:
        AnalysisService(ws).preview_inaudible_cut(
            track_id="host", start=2.0, end=1.0, timeline=True
        )
    assert tl_err.value.code == "range_end_before_start"
    assert str(tl_err.value) == (
        "timeline_end must be after timeline_start. Pick a timeline_end later than timeline_start."
    )


# ---------------------------------------------------------------------------------------
# waveform_snap_window: service, GUI route, share function
# ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", list(SNAP_CASES))
def test_snap_service_text(ws, name):
    assert _text(AnalysisService(ws).waveform_snap_window(**SNAP_CASES[name])) == SNAP_PINS[name]


@pytest.mark.parametrize("name", list(SNAP_CASES))
def test_snap_gui_text(snap_project, name):
    res = _gui_get(snap_project, SNAP_CASES[name])
    assert res.status_code == 200, res.text
    assert res.text == _compact(SNAP_PINS[name])


def test_snap_gui_literal_wire_text(snap_project):
    res = _gui_get(snap_project, SNAP_CASES["timeline_with_islands"])
    assert res.text == GUI_ISLANDS_TEXT


@pytest.mark.parametrize("name", list(SNAP_CASES))
def test_snap_share_text(snap_project, published_share, name):
    _ws, _version, share = published_share()
    out = share_daw_waveform_snap(share["token"], **SNAP_CASES[name])
    assert _text(out) == SNAP_PINS[name]


def test_snap_preview_none_when_preview_raises(ws, snap_project, published_share):
    kwargs = {"track_id": "host", "start": 1.0, "end": 1.3}
    with patch.object(AnalysisService, "preview_inaudible_cut", side_effect=RuntimeError("boom")):
        assert _text(AnalysisService(ws).waveform_snap_window(**kwargs)) == SNAP_PREVIEW_NONE
        res = _gui_get(snap_project, kwargs)
        assert res.text == _compact(SNAP_PREVIEW_NONE)
        _ws, _version, share = published_share()
        assert _text(share_daw_waveform_snap(share["token"], **kwargs)) == SNAP_PREVIEW_NONE


def test_snap_preview_none_keeps_timeline_islands(ws):
    with patch.object(AnalysisService, "preview_inaudible_cut", side_effect=RuntimeError("boom")):
        out = AnalysisService(ws).waveform_snap_window(**SNAP_CASES["timeline_with_islands"])
    assert _text(out) == SNAP_PREVIEW_NONE_ISLANDS


@pytest.mark.parametrize("name", list(TICK_INPUTS))
def test_snap_tick_dedup_and_rounding(ws, name):
    preview, kwargs = TICK_INPUTS[name]
    with patch.object(AnalysisService, "preview_inaudible_cut", return_value=preview):
        out = AnalysisService(ws).waveform_snap_window(**kwargs)
    assert _text(out) == TICK_PINS[name]


def test_snap_unknown_track_service_share_gui(snap_project, ws, published_share):
    from podcast_mcp.util.coded_error import CodedValueError

    kwargs = {"track_id": "nope", "start": 1.0, "end": 2.0}
    with pytest.raises(CodedValueError) as err:
        AnalysisService(ws).waveform_snap_window(**kwargs)
    assert err.value.code == "track_not_found"
    assert str(err.value) == "unknown track_id: 'nope'"
    _ws, _version, share = published_share()
    with pytest.raises(CodedValueError) as share_err:
        share_daw_waveform_snap(share["token"], **kwargs)
    assert share_err.value.code == "track_not_found"
    assert str(share_err.value) == "unknown track_id: 'nope'"
    res = _gui_get(snap_project, kwargs)
    assert res.status_code == 400
    assert res.headers[CODE] == GUI_UNKNOWN_TRACK_CODE
    assert res.text == GUI_UNKNOWN_TRACK_TEXT


PREVIEW_PINS: dict[str, str] = {
    "source_vocal_absorb_silence": """{
  "track_id": "host",
  "timeline_mode": false,
  "start": 1.41,
  "end": 3.6,
  "mode": "vocal_transcript_guided",
  "shifted_start_ms": -20.000000000000018,
  "shifted_end_ms": 1570.0000000000002,
  "confidence": 0.264,
  "details": {
    "strategy": "word+waveform+absorb_silence",
    "search_window_ms": 40.0,
    "max_shift_ms": 80.0,
    "trailing_energy_extended": false,
    "absorb_trailing_silence": true
  }
}""",
    "source_vocal_absorb_silence_late_word": """{
  "track_id": "host",
  "timeline_mode": false,
  "start": 4.52,
  "end": 5.6,
  "mode": "vocal_transcript_guided",
  "shifted_start_ms": 0.0,
  "shifted_end_ms": 599.9999999999997,
  "confidence": 0.722,
  "details": {
    "strategy": "word+waveform+absorb_silence",
    "search_window_ms": 40.0,
    "max_shift_ms": 80.0,
    "trailing_energy_extended": false,
    "absorb_trailing_silence": true
  }
}""",
    "source_vocal_trailing_energy": """{
  "track_id": "host",
  "timeline_mode": false,
  "start": 7.46,
  "end": 8.6,
  "mode": "vocal_transcript_guided",
  "shifted_start_ms": -40.000000000000036,
  "shifted_end_ms": 400.00000000000034,
  "confidence": 0.825,
  "details": {
    "strategy": "word+waveform+trailing_energy+absorb_silence",
    "search_window_ms": 40.0,
    "max_shift_ms": 80.0,
    "trailing_energy_extended": true,
    "absorb_trailing_silence": true
  }
}""",
    "source_vocal_plain": """{
  "track_id": "host",
  "timeline_mode": false,
  "start": 6.86,
  "end": 7.6,
  "mode": "vocal_transcript_guided",
  "shifted_start_ms": -40.000000000000036,
  "shifted_end_ms": 500.0,
  "confidence": 0.75,
  "details": {
    "strategy": "word+waveform+absorb_silence",
    "search_window_ms": 40.0,
    "max_shift_ms": 80.0,
    "trailing_energy_extended": false,
    "absorb_trailing_silence": true
  }
}""",
    "source_waveform_only": """{
  "track_id": "bed",
  "timeline_mode": false,
  "start": 2.001,
  "end": 2.98,
  "mode": "waveform_only",
  "shifted_start_ms": 30.999999999999915,
  "shifted_end_ms": -40.000000000000036,
  "confidence": 0.556,
  "details": {
    "strategy": "waveform",
    "search_window_ms": 40.0,
    "max_shift_ms": 80.0,
    "trailing_energy_extended": false,
    "absorb_trailing_silence": false
  }
}""",
    "source_by_speaker": """{
  "track_id": "bed",
  "timeline_mode": false,
  "start": 2.001,
  "end": 2.98,
  "mode": "waveform_only",
  "shifted_start_ms": 30.999999999999915,
  "shifted_end_ms": -40.000000000000036,
  "confidence": 0.556,
  "details": {
    "strategy": "waveform",
    "search_window_ms": 40.0,
    "max_shift_ms": 80.0,
    "trailing_energy_extended": false,
    "absorb_trailing_silence": false
  }
}""",
    "timeline_vocal": """{
  "track_id": "host",
  "timeline_mode": true,
  "start": 1.41,
  "end": 3.6,
  "mode": "vocal_transcript_guided",
  "shifted_start_ms": -20.000000000000018,
  "shifted_end_ms": 1570.0000000000002,
  "confidence": 0.264,
  "details": {
    "strategy": "word+waveform+absorb_silence",
    "search_window_ms": 40.0,
    "max_shift_ms": 80.0,
    "trailing_energy_extended": false,
    "absorb_trailing_silence": true
  }
}""",
    "timeline_offset_waveform_only": """{
  "track_id": "late",
  "timeline_mode": true,
  "start": 7.0009999999999994,
  "end": 7.9799999999999995,
  "mode": "waveform_only",
  "shifted_start_ms": 31.00000000000014,
  "shifted_end_ms": -40.000000000000036,
  "confidence": 0.556,
  "details": {
    "strategy": "waveform",
    "search_window_ms": 40.0,
    "max_shift_ms": 80.0,
    "trailing_energy_extended": false,
    "absorb_trailing_silence": false
  }
}""",
    "timeline_passthrough_outside_clip": """{
  "track_id": "host",
  "timeline_mode": true,
  "start": 20.0,
  "end": 21.0,
  "mode": "vocal_transcript_guided",
  "shifted_start_ms": 0.0,
  "shifted_end_ms": 0.0,
  "confidence": 0.0,
  "details": {
    "strategy": "passthrough"
  }
}""",
}

SNAP_PINS: dict[str, str] = {
    "timeline_with_islands": """{
  "track_id": "late",
  "start": 6.9,
  "end": 8.1,
  "timeline_mode": true,
  "preview": {
    "track_id": "late",
    "timeline_mode": true,
    "start": 6.939375,
    "end": 8.139375,
    "mode": "waveform_only",
    "shifted_start_ms": 39.374999999999936,
    "shifted_end_ms": 39.375000000000156,
    "confidence": 0.508,
    "details": {
      "strategy": "waveform",
      "search_window_ms": 40.0,
      "max_shift_ms": 80.0,
      "trailing_energy_extended": false,
      "absorb_trailing_silence": false
    }
  },
  "islands": [
    {
      "start": 7.0,
      "end": 7.98,
      "duration": 0.98,
      "midpoint": 7.49
    }
  ],
  "ticks": [
    6.939375,
    7.49,
    8.139375
  ]
}""",
    "timeline_vocal_no_islands": """{
  "track_id": "host",
  "start": 1.43,
  "end": 2.03,
  "timeline_mode": true,
  "preview": {
    "track_id": "host",
    "timeline_mode": true,
    "start": 1.41,
    "end": 3.6,
    "mode": "vocal_transcript_guided",
    "shifted_start_ms": -20.000000000000018,
    "shifted_end_ms": 1570.0000000000002,
    "confidence": 0.264,
    "details": {
      "strategy": "word+waveform+absorb_silence",
      "search_window_ms": 40.0,
      "max_shift_ms": 80.0,
      "trailing_energy_extended": false,
      "absorb_trailing_silence": true
    }
  },
  "islands": [],
  "ticks": [
    1.41,
    3.6
  ]
}""",
    "source_no_islands": """{
  "track_id": "bed",
  "start": 1.9,
  "end": 3.1,
  "timeline_mode": false,
  "preview": {
    "track_id": "bed",
    "timeline_mode": false,
    "start": 1.9393749999999998,
    "end": 3.1393750000000002,
    "mode": "waveform_only",
    "shifted_start_ms": 39.374999999999936,
    "shifted_end_ms": 39.375000000000156,
    "confidence": 0.508,
    "details": {
      "strategy": "waveform",
      "search_window_ms": 40.0,
      "max_shift_ms": 80.0,
      "trailing_energy_extended": false,
      "absorb_trailing_silence": false
    }
  },
  "islands": [],
  "ticks": [
    1.939375,
    3.139375
  ]
}""",
    "span_over_2s_focus": """{
  "track_id": "host",
  "start": 7.0,
  "end": 9.0,
  "timeline_mode": false,
  "preview": {
    "track_id": "host",
    "timeline_mode": false,
    "start": 6.96,
    "end": 8.96,
    "mode": "vocal_transcript_guided",
    "shifted_start_ms": -40.000000000000036,
    "shifted_end_ms": -39.99999999999915,
    "confidence": 0.5,
    "details": {
      "strategy": "word+waveform",
      "search_window_ms": 40.0,
      "max_shift_ms": 80.0,
      "trailing_energy_extended": false,
      "absorb_trailing_silence": false
    }
  },
  "islands": [],
  "ticks": [
    6.96,
    8.96
  ]
}""",
    "span_over_2s_no_focus": """{
  "track_id": "host",
  "start": 4.0,
  "end": 6.0,
  "timeline_mode": false,
  "preview": {
    "track_id": "host",
    "timeline_mode": false,
    "start": 3.96,
    "end": 5.96,
    "mode": "vocal_transcript_guided",
    "shifted_start_ms": -40.000000000000036,
    "shifted_end_ms": -40.000000000000036,
    "confidence": 0.5,
    "details": {
      "strategy": "word+waveform",
      "search_window_ms": 40.0,
      "max_shift_ms": 80.0,
      "trailing_energy_extended": false,
      "absorb_trailing_silence": false
    }
  },
  "islands": [],
  "ticks": [
    3.96,
    5.96
  ]
}""",
    "span_over_2s_timeline_focus": """{
  "track_id": "late",
  "start": 6.5,
  "end": 8.5,
  "timeline_mode": true,
  "preview": {
    "track_id": "late",
    "timeline_mode": true,
    "start": 6.539375,
    "end": 8.539375,
    "mode": "waveform_only",
    "shifted_start_ms": 39.374999999999936,
    "shifted_end_ms": 39.375000000000156,
    "confidence": 0.508,
    "details": {
      "strategy": "waveform",
      "search_window_ms": 40.0,
      "max_shift_ms": 80.0,
      "trailing_energy_extended": false,
      "absorb_trailing_silence": false
    }
  },
  "islands": [
    {
      "start": 7.0,
      "end": 7.98,
      "duration": 0.98,
      "midpoint": 7.49
    }
  ],
  "ticks": [
    6.539375,
    7.49,
    8.539375
  ]
}""",
    "swapped_start_end": """{
  "track_id": "host",
  "start": 2.0,
  "end": 3.0,
  "timeline_mode": false,
  "preview": {
    "track_id": "host",
    "timeline_mode": false,
    "start": 2.0,
    "end": 3.6,
    "mode": "vocal_transcript_guided",
    "shifted_start_ms": 0.0,
    "shifted_end_ms": 600.0000000000001,
    "confidence": 0.722,
    "details": {
      "strategy": "word+waveform+absorb_silence",
      "search_window_ms": 40.0,
      "max_shift_ms": 80.0,
      "trailing_energy_extended": false,
      "absorb_trailing_silence": true
    }
  },
  "islands": [],
  "ticks": [
    2.0,
    3.6
  ]
}""",
    "span_under_50ms": """{
  "track_id": "host",
  "start": 1.0,
  "end": 1.05,
  "timeline_mode": false,
  "preview": {
    "track_id": "host",
    "timeline_mode": false,
    "start": 0.96,
    "end": 0.9700000000000001,
    "mode": "vocal_transcript_guided",
    "shifted_start_ms": -40.000000000000036,
    "shifted_end_ms": -79.99999999999996,
    "confidence": 0.25,
    "details": {
      "strategy": "word+waveform",
      "search_window_ms": 40.0,
      "max_shift_ms": 80.0,
      "trailing_energy_extended": false,
      "absorb_trailing_silence": false
    }
  },
  "islands": [],
  "ticks": [
    0.96,
    0.97
  ]
}""",
    "span_exactly_zero": """{
  "track_id": "host",
  "start": 4.2,
  "end": 4.25,
  "timeline_mode": false,
  "preview": {
    "track_id": "host",
    "timeline_mode": false,
    "start": 4.175,
    "end": 5.6,
    "mode": "vocal_transcript_guided",
    "shifted_start_ms": -25.000000000000355,
    "shifted_end_ms": 1349.9999999999995,
    "confidence": 0.452,
    "details": {
      "strategy": "word+waveform+trailing_energy+absorb_silence",
      "search_window_ms": 40.0,
      "max_shift_ms": 80.0,
      "trailing_energy_extended": true,
      "absorb_trailing_silence": true
    }
  },
  "islands": [],
  "ticks": [
    4.175,
    5.6
  ]
}""",
}

TICK_PINS: dict[str, str] = {
    "sub_microsecond_noise_merges": """{
  "track_id": "host",
  "start": 1.0,
  "end": 1.3,
  "timeline_mode": false,
  "preview": {
    "start": 1.01002,
    "end": 1.0100204,
    "mode": "word"
  },
  "islands": [],
  "ticks": [
    1.01002
  ]
}""",
    "twenty_microseconds_apart_stay_two": """{
  "track_id": "host",
  "start": 1.0,
  "end": 1.3,
  "timeline_mode": false,
  "preview": {
    "start": 1.01,
    "end": 1.01002,
    "mode": "word"
  },
  "islands": [],
  "ticks": [
    1.01,
    1.01002
  ]
}""",
    "int_edges_become_floats": """{
  "track_id": "host",
  "start": 1.0,
  "end": 1.3,
  "timeline_mode": false,
  "preview": {
    "start": 1,
    "end": 2,
    "mode": "word"
  },
  "islands": [],
  "ticks": [
    1.0,
    2.0
  ]
}""",
    "island_midpoint_merges_with_preview_edge": """{
  "track_id": "late",
  "start": 6.9,
  "end": 8.1,
  "timeline_mode": true,
  "preview": {
    "start": 7.49,
    "end": 7.4900004,
    "mode": "word"
  },
  "islands": [
    {
      "start": 7.0,
      "end": 7.98,
      "duration": 0.98,
      "midpoint": 7.49
    }
  ],
  "ticks": [
    7.49
  ]
}""",
}

SNAP_PREVIEW_NONE = """{
  "track_id": "host",
  "start": 1.0,
  "end": 1.3,
  "timeline_mode": false,
  "preview": null,
  "islands": [],
  "ticks": []
}"""

SNAP_PREVIEW_NONE_ISLANDS = """{
  "track_id": "late",
  "start": 6.9,
  "end": 8.1,
  "timeline_mode": true,
  "preview": null,
  "islands": [
    {
      "start": 7.0,
      "end": 7.98,
      "duration": 0.98,
      "midpoint": 7.49
    }
  ],
  "ticks": [
    7.49
  ]
}"""

GUI_ISLANDS_TEXT = '{"track_id":"late","start":6.9,"end":8.1,"timeline_mode":true,"preview":{"track_id":"late","timeline_mode":true,"start":6.939375,"end":8.139375,"mode":"waveform_only","shifted_start_ms":39.374999999999936,"shifted_end_ms":39.375000000000156,"confidence":0.508,"details":{"strategy":"waveform","search_window_ms":40.0,"max_shift_ms":80.0,"trailing_energy_extended":false,"absorb_trailing_silence":false}},"islands":[{"start":7.0,"end":7.98,"duration":0.98,"midpoint":7.49}],"ticks":[6.939375,7.49,8.139375]}'

GUI_UNKNOWN_TRACK_CODE = "track_not_found"
GUI_UNKNOWN_TRACK_TEXT = '{"detail":"unknown track_id: \'nope\'"}'

CLI_UNKNOWN_TRACK_EXIT = 1
CLI_UNKNOWN_TRACK_OUTPUT = "Error: unknown track_id: 'nope' (code track_not_found) (set PODCAST_DEBUG=1 for the traceback)\n"
