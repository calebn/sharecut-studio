from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

import multistream_media as media
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import prosody_profile, retained_bleed_alignment
from podcast_mcp.engines import (
    balance,
    bleed_gate,
    gate_fill,
    level_profile,
    room_tone,
    speaker_id,
    waveform_pyramid,
)
from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.asr_silence import silence_filter_fingerprint
from podcast_mcp.engines.ffmpeg import AudioProbe
from podcast_mcp.engines.media_probe import probe_media
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import EpisodeProject, GateFill, GateFillSource, MediaAsset, Track
from podcast_mcp.services.document.play_stems import _PlayStems
from podcast_mcp.util.fingerprint import file_stamp
from podcast_mcp.util.project_state import file_revision_key

MAIN_MEDIA_KEY = "aaa47cb2e786ca55e370"
MAIN_SILENCE_FINGERPRINT = "bdfa08a23038fd29f56cb4216a1ef6b3f352a2292fdfa83c195ee14c3949948f"
MAIN_BALANCE_DIGEST = "e240b20362847f7f6656bc8b6a8eab18da442e6bb316305db92eee82a4e8f6b1"
MAIN_ALIGN_NAME = "asr.word_align_8ddd9e4881f64893.json"


def _project(tmp_path: Path, media_path: Path) -> EpisodeProject:
    project = EpisodeProject.create("Streams", str(tmp_path))
    project.tracks = [
        Track(id="t", label="T", media=MediaAsset(path=str(media_path)), transcript_gate=True)
    ]
    return project


@pytest.fixture
def mono_wav(tmp_path: Path) -> Path:
    return media.single_stream_media(tmp_path)["wav"]


def test_probe_counts_audio_streams(tmp_path: Path, mono_wav: Path) -> None:
    assert probe_media(mono_wav).audio_stream_count == 1
    assert AudioProbe(1.0, 8000, 1).audio_stream_count == 1
    for name in ("st.mkv", "kid.ogg", "two_b.mkv"):
        assert probe_media(media.multistream(tmp_path, name)).audio_stream_count == 2
    assert probe_media(media.video_only(tmp_path)).audio_stream_count == 0


def test_revisions_that_feed_decodes_are_bumped() -> None:
    assert level_profile._RECORD_REV == 3
    assert bleed_gate.BLEED_GATE_REV == 20
    assert room_tone._POOL_REV == 3
    assert waveform_pyramid._BUILD_REVISION == 3
    assert prosody_profile.ALGORITHM_VERSION == 6


def test_pyramid_key_and_silence_fingerprint_leave_the_old_keys() -> None:
    assert waveform_pyramid.media_key("a.wav", 1, 2) != MAIN_MEDIA_KEY
    fingerprint = silence_filter_fingerprint([], "abc", AsrOptions())
    assert fingerprint != MAIN_SILENCE_FINGERPRINT


def test_retained_alignment_fingerprint_follows_the_gate_revision(
    tmp_path: Path, mono_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _project(tmp_path, mono_wav)
    defaults = load_defaults()
    current = retained_bleed_alignment._fingerprint(project, defaults=defaults)
    monkeypatch.setattr(bleed_gate, "BLEED_GATE_REV", 19)
    assert retained_bleed_alignment._fingerprint(project, defaults=defaults) != current


def test_balance_digest_adds_a_term_for_several_streams_only(
    tmp_path: Path, mono_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(balance, "file_revision", lambda _path: (1, 2, 3, 4))
    single = balance.balance_basis_digest(_project(tmp_path, mono_wav), "t")
    assert single == MAIN_BALANCE_DIGEST
    several = media.multistream(tmp_path, "two_b.mkv")
    assert balance.balance_basis_digest(_project(tmp_path, several), "t") != single


def _fill(path: Path, **extra: object) -> GateFill:
    stamp = file_stamp(path)
    return GateFill(
        source=GateFillSource.COMFORT_NOISE,
        path="fill.wav",
        media_size=stamp.size,
        media_mtime_ns=stamp.mtime_ns,
        holes=1,
        filled_sec=0.5,
        level_db=-60.0,
        fade_ms=10,
        **extra,
    )


def test_legacy_gate_fill_stays_in_force_on_single_stream_media(
    tmp_path: Path, mono_wav: Path
) -> None:
    project = _project(tmp_path, mono_wav)
    (tmp_path / "fill.wav").write_bytes(b"fill")
    project.tracks[0].gate_fill = _fill(mono_wav)
    assert gate_fill.current_gate_fill_path(project, project.tracks[0]) == tmp_path / "fill.wav"
    payload = gate_fill.gate_fill_payload(project, project.tracks[0])
    stamp = file_stamp(mono_wav)
    assert payload["fill"] == {
        "source": "comfort_noise",
        "path": "fill.wav",
        "media_size": stamp.size,
        "media_mtime_ns": stamp.mtime_ns,
        "holes": 1,
        "filled_sec": 0.5,
        "level_db": -60.0,
        "noise_db": None,
        "fade_ms": 10,
    }


def test_legacy_gate_fill_is_ignored_on_several_streams(tmp_path: Path) -> None:
    several = media.multistream(tmp_path, "two_b.mkv")
    project = _project(tmp_path, several)
    (tmp_path / "fill.wav").write_bytes(b"fill")
    track = project.tracks[0]
    track.gate_fill = _fill(several)
    assert gate_fill.current_gate_fill_path(project, track) is None
    track.gate_fill = _fill(several, audio_stream=0)
    assert gate_fill.current_gate_fill_path(project, track) == tmp_path / "fill.wav"


@pytest.mark.parametrize(("name", "expected"), [("mono", None), ("two_b.mkv", 0)])
def test_planned_gate_fill_records_the_stream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, expected: int | None
) -> None:
    path = media.multistream(tmp_path, name) if name != "mono" else None
    path = path or media.single_stream_media(tmp_path)["wav"]
    project = _project(tmp_path, path)
    holes = SimpleNamespace(bounds=[(0, 10)], seconds=0.5, sample_rate=8000)
    made = SimpleNamespace(samples=np.zeros(10), level_db=-60.0, noise_db=None, basis="x")
    monkeypatch.setattr(gate_fill, "detect_gate_holes", lambda _path: holes)
    monkeypatch.setattr(
        gate_fill, "FILL_SOURCES", [(GateFillSource.COMFORT_NOISE, lambda *_: made)]
    )
    monkeypatch.setattr(gate_fill, "_write_fill", lambda *_: "fill.wav")
    result = gate_fill.plan_gate_fill(project, project.tracks[0], fade_ms=10)
    assert result.fill is not None
    assert result.fill.audio_stream == expected


def _profile(stem_hash: str) -> speaker_id.SpeakerProfile:
    return speaker_id.SpeakerProfile("t", "t", [0.0], 1.0, stem_hash)


def test_speaker_profile_key_is_unchanged_for_single_stream_media(
    tmp_path: Path, mono_wav: Path
) -> None:
    project = _project(tmp_path, mono_wav)
    legacy = file_revision_key(mono_wav)
    assert speaker_id._profile_stem_valid(project, _profile(legacy))


def test_speaker_profile_key_follows_the_first_stream_for_several(tmp_path: Path) -> None:
    several = media.multistream(tmp_path, "two_b.mkv")
    project = _project(tmp_path, several)
    legacy = file_revision_key(several)
    assert not speaker_id._profile_stem_valid(project, _profile(legacy))
    assert speaker_id._profile_stem_valid(project, _profile(f"{legacy}:a0"))


def _align_path(project: EpisodeProject, audio: Path | None, tmp_path: Path) -> Path:
    engine = TranscriptionEngine(defaults=load_defaults())
    aligner = SimpleNamespace(cache_identity=lambda: "aligner")
    words = [SimpleNamespace(text="a", start=0.0, end=1.0)]
    extra = {} if audio is None else {"audio": audio}
    return engine.word_align_cache_path(
        project, "t", tmp_path / "asr.json", aligner, words, **extra
    )


def test_word_align_cache_key_is_unchanged_for_single_stream_media(
    tmp_path: Path, mono_wav: Path
) -> None:
    project = _project(tmp_path, mono_wav)
    legacy = _align_path(project, None, tmp_path)
    assert legacy.name == MAIN_ALIGN_NAME
    assert _align_path(project, mono_wav, tmp_path) == legacy


def test_word_align_cache_key_follows_the_first_stream_for_several(tmp_path: Path) -> None:
    several = media.multistream(tmp_path, "two_b.mkv")
    project = _project(tmp_path, several)
    assert _align_path(project, several, tmp_path) != _align_path(project, None, tmp_path)


@pytest.mark.parametrize("several", [False, True])
def test_raw_audition_cache_key_marks_several_streams(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, several: bool
) -> None:
    path = (
        media.multistream(tmp_path, "two_b.mkv")
        if several
        else media.single_stream_media(tmp_path)["wav"]
    )
    workspace = SimpleNamespace(
        project=_project(tmp_path, path), effective_config=lambda: load_defaults()
    )
    stems = _PlayStems(workspace)
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.services.document import play_stems

    monkeypatch.setattr(play_stems, "timeline_range_to_source", lambda *_: (path, 0.1, 0.6))
    monkeypatch.setattr(FFmpegEngine, "extract_segment", lambda *_: None)
    got, *_ = stems._resolve_audio("track:t", 0.0, 0.5, rerender=False)
    plain = stems._cache_path("raw_t", 0.0, 0.5, path)
    marked = stems._cache_path("raw_t", 0.0, 0.5, path, extra="a0")
    assert got == (marked if several else plain)
