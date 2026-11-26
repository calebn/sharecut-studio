"""Pin the exact wire output of the four AnalysisService report methods on every surface."""

from __future__ import annotations

import json
import math
import re
import struct
import wave
from contextlib import ExitStack
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from audibility_floors import floors_at
from podcast_mcp.cli.main import app
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import audio_audit
from podcast_mcp.engines.bleed_echo import EchoPairProfile
from podcast_mcp.engines.pcm_cache import TrackRmsCache
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.mcp.tools import timeline, transcript
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.project.store import save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.tracks import stem_path

pytestmark = pytest.mark.unscoped_ok

_GUEST_TO_HOST_MEASURED = patch(
    "podcast_mcp.engines.pcm_cache.TrackRmsCacheSet.echo_pairs",
    new=lambda self: [
        EchoPairProfile(
            source_track_id="guest",
            bleed_track_id="host",
            span_start=0.0,
            span_end=10.0,
            dominated_frames=100,
            copy_frames=40,
            consistent_frames=30,
            lag_ms=3.0,
            level_db=-18.0,
            examples=(1.0,),
            null_runs=8,
            null_copy_rate=0.05,
            null_consistent_rate=0.02,
        )
    ],
)

_TOOLS = {
    "analyze_cleanup": (timeline.analyze_cleanup_tool, "analyze-cleanup"),
    "audio_diagnostics": (timeline.audio_diagnostics_tool, "audio-diagnostics"),
    "gate_overreach": (transcript.gate_overreach_tool, "gate-overreach"),
    "reconciliation_status": (transcript.reconciliation_status_tool, "reconciliation-status"),
}
_FLAGS = {"track_id": "--track", "start_sec": "--start", "end_sec": "--end"}
_FINGERPRINT = re.compile(r'"(fingerprint|last_reconciliation_hash)": "[0-9a-f]{16}"')


def _fake_rms(project, track_id, t_start, t_end, **kwargs):
    host_bleed = (1.0, 3.0, 5.0)
    if any(a <= t_start < a + 0.6 for a in host_bleed) or 3.0 <= t_start < 4.0:
        return -40.0 if track_id == "host" else -30.0
    if track_id == "host" and 2.0 <= t_start < 2.6:
        return -55.0
    if track_id == "guest" and 2.0 <= t_start < 2.6:
        return -60.0
    return -30.0


@pytest.fixture(autouse=True)
def _synthetic_audio():
    with (
        floors_at(-42.0),
        _GUEST_TO_HOST_MEASURED,
        patch("podcast_mcp.engines.audio_audit._rms_for_track_at_timeline", side_effect=_fake_rms),
    ):
        yield


def _bleed(text: str, start: float, end: float) -> TranscriptWord:
    return TranscriptWord(
        text=text,
        start=start,
        end=end,
        confidence=0.9,
        audibility_status="bleed",
        dominant_track="guest",
    )


def _build(tmp_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    for tid, speaker in (("host", "Host"), ("guest", "Guest")):
        raw = tmp_path / "raw" / f"{tid}.wav"
        raw.parent.mkdir(exist_ok=True)
        raw.write_bytes(b"\x00" * 100)
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=speaker,
                role=TrackRole.DIALOGUE,
                speaker=speaker,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=10.0),
            )
        )
        project.timeline.clips.append(
            Clip(id=f"c-{tid}", track_id=tid, source_start=0.0, source_end=10.0, timeline_start=0.0)
        )
    host_words = [
        TranscriptWord(text="hello", start=0.0, end=0.5, confidence=0.9),
        _bleed("bleed", 1.0, 1.5),
        TranscriptWord(
            text="quiet", start=2.0, end=2.5, confidence=0.9, audibility_status="inaudible"
        ),
        _bleed("loud", 3.0, 4.0),
        _bleed("later", 5.0, 5.5),
    ]
    guest_words = [
        TranscriptWord(text="bleed", start=1.0, end=1.5, confidence=0.9),
        TranscriptWord(text="loud", start=3.0, end=4.0, confidence=0.9),
        TranscriptWord(text="later", start=5.0, end=5.5, confidence=0.9),
    ]
    project.transcripts = [
        Transcript(track_id="host", words=host_words),
        Transcript(track_id="guest", words=guest_words),
    ]
    project.combined_transcript = TranscriptionEngine(defaults=load_defaults()).merge_transcripts(
        project
    )
    return project


def _workspace(
    tmp_path: Path,
    *,
    gate: bool = False,
    agate: bool = False,
    stem: bool = False,
    words: bool = True,
    reconcile: tuple[str | None, bool] | None = None,
) -> ProjectWorkspace:
    project = _build(tmp_path)
    if gate:
        project.track_by_id("host").transcript_gate = True
    if agate:
        project.processing_chains.append(
            ProcessingChain(track_id="host", effects=[ProcessingEffect(effect="agate")])
        )
    if stem:
        path = stem_path(project, "host")
        path.parent.mkdir(parents=True, exist_ok=True)
        _write_sine(path)
    if not words:
        project.transcripts = [t for t in project.transcripts if t.track_id != "host"]
    if reconcile is not None:
        project.last_reconciliation_hash, project.reconciliation_stale = reconcile
    return ProjectWorkspace.open(save_project(project))


def _write_sine(path: Path) -> None:
    frames = b"".join(
        struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(32000)
    )
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(frames)


def _norm(text: str, ws: ProjectWorkspace) -> str:
    text = text.replace(str(ws.path.parent), "<ws>")
    return _FINGERPRINT.sub(r'"\1": "<fp>"', text)


def _dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


def _surfaces(ws: ProjectWorkspace, name: str, **kwargs: Any) -> list[dict]:
    tool, command = _TOOLS[name]
    flags = [part for key, value in kwargs.items() for part in (_FLAGS[key], str(value))]
    service = getattr(AnalysisService(ws), name)(**kwargs)
    cli = CliRunner().invoke(app, ["edit", command, "--project", str(ws.path), *flags])
    assert cli.exit_code == 0, cli.output
    texts = [
        _dump(service),
        _dump(json.loads(tool(str(ws.path), **kwargs))),
        _dump(json.loads(cli.output)),
    ]
    return [json.loads(_norm(text, ws)) for text in texts]


def _pinned(ws: ProjectWorkspace, name: str, expected: dict, **kwargs: Any) -> None:
    for surface in _surfaces(ws, name, **kwargs):
        assert _dump(surface) == _dump(expected)


class _FakeCache:
    class profile:
        voice_db = -20.0

    def __init__(self, body_db):
        self._body_db = body_db

    def rms_db(self, lo, hi):
        return self._body_db(lo)


_RAW = _FakeCache(lambda lo: -20.0)
_FINAL = _FakeCache(lambda lo: -90.0 if lo < 1.2 else -20.0)
_WORDS = [(0, "hello", 0.0, 0.5), (1, "bleed", 1.0, 1.5), (2, "quiet", 2.0, 2.5)]
_WORDS += [(3, "loud", 3.0, 4.0), (4, "later", 5.0, 5.5)]


def _onset_drop(path, start, end, cache=None):
    return -40.0 if end - start < 0.05 else -20.0


def _gate_patches():
    return (
        patch.object(audio_audit, "measure_window_rms_db", side_effect=_onset_drop),
        patch.object(TrackRmsCache, "from_recording", return_value=None),
        patch.object(TrackRmsCache, "from_timeline_stem", return_value=_FINAL),
        patch.object(audio_audit, "_pre_transcript_gate_cache", return_value=_RAW),
    )


def _noise_issue(index, text, start, end, **extra):
    return {
        "word_index": index,
        "text": text,
        "start": start,
        "end": end,
        "kind": "clipped_onset",
        "body_rms_db": -20.0,
        "onset_rms_db": -40.0,
        "drop_db": 20.0,
        **extra,
    }


def _loss_issue(index, text, start, end, **extra):
    return {
        "word_index": index,
        "text": text,
        "start": start,
        "end": end,
        "kind": "processed_word_loss",
        "raw_body_rms_db": -20.0,
        "processed_body_rms_db": -90.0,
        **extra,
    }


_NOISE_ISSUES = [_noise_issue(*row) for row in _WORDS]
_LOSS_ISSUES = [_loss_issue(*row) for row in _WORDS[:2]]
_NOISE_ADVICE = (
    "Lower gate threshold, increase hold (80-120 ms) and release (200-400 ms); "
    "audition with play --source processed:<track>."
)
_LOSS_ADVICE = "Review added onset/tail loss against ungated audio; preserve speech before accepting this gate."
_NOISE_REPORT = {
    "track_id": "host",
    "gate_present": True,
    "risk": "high",
    "issue_count": 5,
    "issues": _NOISE_ISSUES,
    "advice": _NOISE_ADVICE,
}
_TRANSCRIPT_REPORT = {
    "track_id": "host",
    "gate_present": True,
    "gate_type": "transcript",
    "risk": "moderate",
    "issue_count": 2,
    "issues": _LOSS_ISSUES,
    "analyzed_words": 5,
    "advice": _LOSS_ADVICE,
}


def _flag_row(index, text, start, end, status, dominant, own, other, reason):
    return {
        "track_id": "host",
        "source_id": None,
        "word_index": index,
        "text": text,
        "start": start,
        "end": end,
        "audibility_status": status,
        "dominant_track": dominant,
        "own_rms_db": own,
        "reason": reason,
        "suppressed": False,
        "track_rms_db": {"guest": other, "host": own},
    }


_FLAGGED_HOST = [
    _flag_row(1, "bleed", 1.0, 1.5, "bleed", "guest", -40.0, -30.0, "cross_track_bleed"),
    _flag_row(2, "quiet", 2.0, 2.5, "inaudible", None, -55.0, -60.0, "below_audibility_threshold"),
    _flag_row(3, "loud", 3.0, 4.0, "bleed", "guest", -40.0, -30.0, "cross_track_bleed"),
    _flag_row(4, "later", 5.0, 5.5, "bleed", "guest", -40.0, -30.0, "cross_track_bleed"),
]
_BLEED_WARNING = (
    "60% of words are cross-track bleed - this looks like a multi-mic bleed session, not "
    "isolated crosstalk. Transcript suppression alone won't remove it from the audio; see "
    "podcast-mute-bleed to gate stems, and check mic gain staging/placement for future recordings."
)
_NO_GATE = {
    "advice": "No noise gate on this track.",
    "gate_present": False,
    "issues": [],
    "risk": "none",
}


def _host_row(**overrides):
    row = {
        "track_id": "host",
        "effects": [],
        "health": None,
        "gate_analysis": {"track_id": "host", **_NO_GATE},
        "low_audibility_count": 0,
        "low_audibility_sample": [],
        "flagged_count": 4,
        "bleed_count": 3,
        "bleed_ratio": 0.6,
        "flagged_sample": _FLAGGED_HOST,
        "fade_recommendations": [],
        "high_bleed_warning": _BLEED_WARNING,
    }
    return {**row, **overrides}


_GUEST_ROW = {
    "track_id": "guest",
    "effects": [],
    "health": None,
    "gate_analysis": {"track_id": "guest", **_NO_GATE},
    "low_audibility_count": 0,
    "low_audibility_sample": [],
    "flagged_count": 0,
    "bleed_count": 0,
    "bleed_ratio": 0.0,
    "flagged_sample": [],
    "fade_recommendations": [],
}
_POLICY = {
    "bleed_dominance_db": 6.0,
    "bleed_ratio_warn_threshold": 0.2,
    "ml_backend": "off",
    "reconcile_on_render": True,
    "transcript_mode": "reconcile",
}
_RECONCILIATION = {
    "fingerprint": "<fp>",
    "last_reconciliation_hash": None,
    "reconciliation_stale_flag": False,
    "stale": True,
}
_SUMMARY = "host: 4 flagged words; host: 3 bleed words; host: HIGH BLEED (60% of words)"


def _cleanup(tracks, summary=_SUMMARY, **overrides):
    return {
        "policy": _POLICY,
        "reconciliation": _RECONCILIATION,
        "summary": summary,
        "tracks": tracks,
        **overrides,
    }


def test_reconciliation_status_wire(tmp_path):
    _pinned(_workspace(tmp_path), "reconciliation_status", _RECONCILIATION)


def test_reconciliation_status_flagged_stale_wire(tmp_path):
    ws = _workspace(tmp_path, reconcile=("deadbeef", True))
    expected = {**_RECONCILIATION, "last_reconciliation_hash": "deadbeef"}
    expected["reconciliation_stale_flag"] = True
    _pinned(ws, "reconciliation_status", expected)


def test_reconciliation_status_current_wire(tmp_path):
    ws = _workspace(tmp_path)
    ws.project.last_reconciliation_hash = AnalysisService(ws).reconciliation_status()["fingerprint"]
    save_project(ws.project)
    expected = {**_RECONCILIATION, "last_reconciliation_hash": "<fp>", "stale": False}
    _pinned(ws, "reconciliation_status", expected)


def test_gate_overreach_no_gate_wire(tmp_path):
    expected = {"track_id": "host", **_NO_GATE}
    _pinned(_workspace(tmp_path), "gate_overreach", expected, track_id="host")


def test_gate_overreach_noise_gate_without_words_wire(tmp_path):
    ws = _workspace(tmp_path, agate=True, words=False)
    expected = {
        "track_id": "host",
        "gate_present": True,
        "risk": "unknown",
        "issues": [],
        "advice": "No transcript words to analyze gate behavior.",
    }
    _pinned(ws, "gate_overreach", expected, track_id="host")


def test_gate_overreach_noise_gate_clean_wire(tmp_path):
    ws = _workspace(tmp_path, agate=True)
    expected = {
        "track_id": "host",
        "gate_present": True,
        "risk": "none",
        "issue_count": 0,
        "issues": [],
        "advice": "Gate settings look acceptable for analyzed words.",
    }
    _pinned(ws, "gate_overreach", expected, track_id="host")


def test_gate_overreach_noise_gate_overreach_wire(tmp_path):
    ws = _workspace(tmp_path, agate=True, stem=True)
    patches = _gate_patches()
    with patches[0], patches[1], patches[2]:
        _pinned(ws, "gate_overreach", _NOISE_REPORT, track_id="host")


def test_gate_overreach_transcript_gate_without_evidence_wire(tmp_path):
    expected = {
        "track_id": "host",
        "gate_present": True,
        "gate_type": "transcript",
        "risk": "unknown",
        "issue_count": 0,
        "issues": [],
        "analyzed_words": 0,
        "advice": "Ungated and processed audio evidence is required to assess this transcript gate.",
    }
    _pinned(_workspace(tmp_path, gate=True), "gate_overreach", expected, track_id="host")


def test_gate_overreach_transcript_gate_overreach_wire(tmp_path):
    ws = _workspace(tmp_path, gate=True, stem=True)
    patches = _gate_patches()
    with patches[2], patches[3]:
        _pinned(ws, "gate_overreach", _TRANSCRIPT_REPORT, track_id="host")


def test_gate_overreach_combined_wire(tmp_path):
    ws = _workspace(tmp_path, gate=True, agate=True, stem=True)
    noise = {**_NOISE_REPORT, "gate_type": "noise"}
    expected = {
        "track_id": "host",
        "gate_present": True,
        "gate_type": "combined",
        "risk": "high",
        "issue_count": 7,
        "issues": [
            *({**issue, "gate_type": "noise"} for issue in _NOISE_ISSUES),
            *({**issue, "gate_type": "transcript"} for issue in _LOSS_ISSUES),
        ],
        "components": [noise, _TRANSCRIPT_REPORT],
        "advice": "Review each gate separately; noise-gate tuning only uses the noise component.",
    }
    with ExitStack() as stack:
        for manager in _gate_patches():
            stack.enter_context(manager)
        _pinned(ws, "gate_overreach", expected, track_id="host")


def test_gate_overreach_combined_without_ungated_evidence_wire(tmp_path):
    ws = _workspace(tmp_path, gate=True, agate=True, stem=True)
    expected = {
        "track_id": "host",
        "gate_present": True,
        "gate_type": "combined",
        "risk": "unknown",
        "issue_count": 0,
        "issues": [],
        "components": [],
        "advice": "Evidence before transcript gating is unavailable; neither gate is verified safe.",
    }
    with patch.object(audio_audit, "_pre_transcript_gate_cache", side_effect=OSError("gone")):
        _pinned(ws, "gate_overreach", expected, track_id="host")


def test_analyze_cleanup_wire(tmp_path):
    expected = _cleanup([_host_row(), _GUEST_ROW])
    _pinned(_workspace(tmp_path), "analyze_cleanup", expected)


def test_analyze_cleanup_track_scoped_wire(tmp_path):
    ws = _workspace(tmp_path)
    _pinned(ws, "analyze_cleanup", _cleanup([_host_row()]), track_id="host")
    guest = _cleanup([_GUEST_ROW], summary="No significant cleanup issues detected.")
    _pinned(ws, "analyze_cleanup", guest, track_id="guest")


def test_analyze_cleanup_with_effects_and_low_audibility_wire(tmp_path):
    ws = _workspace(tmp_path, agate=True)
    sample = {"track_id": "host", "source_id": None, "word_index": 2, "text": "quiet"}
    with patch.object(audio_audit, "list_low_audibility_words", return_value=[sample]):
        reports = _surfaces(ws, "analyze_cleanup", track_id="host")
    gate = {"track_id": "host", **_NO_GATE, "gate_present": True, "issue_count": 0}
    gate["advice"] = "Gate settings look acceptable for analyzed words."
    summary = "host: 1 low-audibility words; " + _SUMMARY
    row = _host_row(
        effects=["agate"],
        low_audibility_count=1,
        low_audibility_sample=[sample],
        gate_analysis=gate,
    )
    for report in reports:
        assert _dump(report) == _dump(_cleanup([row], summary))


_ASTATS_KEYS = {
    "crest_factor",
    "dc_offset",
    "dynamic_range_db",
    "flat_factor",
    "noise_floor_db",
    "peak_count",
    "peak_level_db",
    "rms_level_db",
}
_HUM_KEYS = {
    "dominant_frequency",
    "energy_ratios",
    "hum_detected",
    "recommendation",
    "threshold_ratio",
}


def _is_number(value):
    return isinstance(value, int | float) and not isinstance(value, bool)


def _assert_astats(astats):
    assert set(astats) == _ASTATS_KEYS
    assert all(_is_number(value) for value in astats.values())


def _assert_full_hum(hum):
    assert set(hum) == _HUM_KEYS
    assert isinstance(hum["hum_detected"], bool)
    assert isinstance(hum["dominant_frequency"], str)
    assert set(hum["energy_ratios"]) == {"50hz_ratio", "60hz_ratio"}
    assert all(_is_number(value) for value in hum["energy_ratios"].values())
    assert _is_number(hum["threshold_ratio"])


def test_analyze_cleanup_health_wire(tmp_path):
    ws = _workspace(tmp_path, agate=True, stem=True)
    for report in _surfaces(ws, "analyze_cleanup", track_id="host"):
        health = report["tracks"][0]["health"]
        assert set(health) == _ASTATS_KEYS | {"hum", "voice_db"}
        _assert_full_hum(health["hum"])
        assert _is_number(health["voice_db"])
        report["tracks"][0]["health"] = None
        report["tracks"][0]["gate_analysis"]["issue_count"] = 0
        assert report["tracks"][0]["effects"] == ["agate"]
        assert set(report) == {"policy", "reconciliation", "summary", "tracks"}


@pytest.fixture
def diag_ws(tmp_path):
    ws = _workspace(tmp_path)
    _write_sine(tmp_path / "raw" / "host.wav")
    return ws


def test_audio_diagnostics_full_stem_wire(diag_ws):
    reports = _surfaces(diag_ws, "audio_diagnostics", track_id="host")
    assert reports[0] == reports[1] == reports[2]
    report = reports[0]
    assert set(report) == {"track_id", "astats", "hum", "spectrogram_png", "waveform_png"}
    assert report["track_id"] == "host"
    assert report["spectrogram_png"] == "<ws>/artifacts/diagnostics/host/spectrogram.png"
    assert report["waveform_png"] == "<ws>/artifacts/diagnostics/host/waveform.png"
    _assert_astats(report["astats"])
    _assert_full_hum(report["hum"])
    assert Path(diag_ws.path.parent, "artifacts/diagnostics/host/waveform.png").is_file()


def test_audio_diagnostics_windowed_wire(diag_ws):
    reports = _surfaces(diag_ws, "audio_diagnostics", track_id="host", start_sec=0.5, end_sec=1.5)
    assert reports[0] == reports[1] == reports[2]
    report = reports[0]
    assert set(report) == {"track_id", "astats", "hum", "spectrogram_png", "waveform_png", "window"}
    assert report["window"] == {"clock": "timeline", "unit": "sec", "start": 0.5, "end": 1.5}
    assert (
        report["spectrogram_png"] == "<ws>/artifacts/diagnostics/host/spectrogram_0.500_1.500.png"
    )
    assert report["waveform_png"] == "<ws>/artifacts/diagnostics/host/waveform_0.500_1.500.png"
    _assert_astats(report["astats"])
    assert report["hum"] == {"hum_detected": False, "reason": "clip too short to analyze"}


def test_audio_diagnostics_range_error(diag_ws):
    message = "end_sec must be after start_sec. Pick an end_sec later than start_sec."
    kwargs = {"track_id": "host", "start_sec": 1.0, "end_sec": 1.0}
    with pytest.raises(CodedValueError) as service:
        AnalysisService(diag_ws).audio_diagnostics(**kwargs)
    with pytest.raises(CodedValueError) as mcp:
        timeline.audio_diagnostics_tool(str(diag_ws.path), **kwargs)
    for error in (service, mcp):
        assert error.value.code == "range_end_before_start"
        assert str(error.value) == message
    cli = CliRunner().invoke(
        app,
        [
            "edit",
            "audio-diagnostics",
            "--project",
            str(diag_ws.path),
            *("--track", "host"),
            *("--start", "1.0", "--end", "1.0"),
        ],
    )
    assert cli.exit_code == 1
    assert cli.output == (
        f"Error: {message} (code range_end_before_start) (set PODCAST_DEBUG=1 for the traceback)\n"
    )
