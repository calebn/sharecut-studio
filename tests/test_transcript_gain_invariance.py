"""Transcript reconcile judges a word inaudible against its own track's levels (#1324).

The same recording at a lower level must get the same audibility verdicts and the same
reconciled transcript. Every scenario is written at several gains; each must give the
verdicts of the unscaled recording.
"""

from __future__ import annotations

import sys
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from bleed_helpers import delay, voices
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.word_spans import WordSpanCaps, trim_implausible_words
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    TrackRmsCache,
    TrackRmsCacheSet,
    compute_word_audibility_map,
    list_low_audibility_words,
)
from podcast_mcp.engines.bleed_echo import EchoPairProfile
from podcast_mcp.engines.transcript_reconcile import reconcile_transcript
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

RATE = 16_000
SECONDS = 20
GAINS_DB = (0.0, -12.0, -24.0, 6.0)
SPEECH_DB = -18.0
ROOM_DB = -68.0


def _tone(n: int, level_db: float, f0: float = 150.0) -> np.ndarray:
    t = np.arange(n) / RATE
    tone = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 6))
    return tone / np.sqrt(np.mean(tone**2)) * 10 ** (level_db / 20)


def _voice(audio: np.ndarray, start: float, end: float, level_db: float, f0: float = 150.0) -> None:
    lo, hi = round(start * RATE), round(end * RATE)
    audio[lo:hi] += _tone(hi - lo, level_db, f0)


def _room(seed: int, seconds: int = SECONDS) -> np.ndarray:
    return np.random.default_rng(seed).normal(0, 10 ** (ROOM_DB / 20), seconds * RATE)


def _pcm24(samples: np.ndarray) -> bytes:
    ints = np.rint(samples * 8388607).astype("<i4")
    return ints.view(np.uint8).reshape(-1, 4)[:, :3].tobytes()


def _host(f0: float) -> tuple[np.ndarray, list[TranscriptWord]]:
    """Loud words that set the speech level, a soft but audible one, and a faint one."""
    audio = _room(11)
    spans = [
        ("alpha", 1.0, 1.6, SPEECH_DB),
        ("soft", 2.0, 2.5, SPEECH_DB - 15.0),
        ("faint", 3.0, 3.5, SPEECH_DB - 36.0),
        ("bleed", 5.0, 5.6, SPEECH_DB - 12.0),
        ("long", 8.0, 10.0, SPEECH_DB),
        ("end", 12.0, 13.0, SPEECH_DB),
    ]
    for _, start, end, level in spans:
        _voice(audio, start, end, level, f0)
    return audio, [TranscriptWord(text=t, start=s, end=e) for t, s, e, _ in spans]


def _guest(f0: float) -> tuple[np.ndarray, list[TranscriptWord]]:
    audio = _room(23)
    spans = [("bravo", 5.0, 5.6), ("charlie", 14.0, 15.0), ("delta", 16.0, 17.0)]
    for _, start, end in spans:
        _voice(audio, start, end, SPEECH_DB, f0)
    return audio, [TranscriptWord(text=t, start=s, end=e) for t, s, e in spans]


def _project(
    tmp_path: Path,
    gain_db: float,
    tracks: tuple[tuple[str, np.ndarray, list[TranscriptWord]], ...],
) -> EpisodeProject:
    project = EpisodeProject.create("gain", str(tmp_path))
    for track_id, audio, words in tracks:
        path = tmp_path / "raw" / f"{track_id}.wav"
        path.parent.mkdir(parents=True, exist_ok=True)
        scaled = audio * 10 ** (gain_db / 20)
        assert np.max(np.abs(scaled)) < 1.0
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(3)
            handle.setframerate(RATE)
            handle.writeframes(_pcm24(scaled))
        seconds = audio.size / RATE
        project.timeline.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=seconds),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"c_{track_id}",
                track_id=track_id,
                source_start=0.0,
                source_end=seconds,
                timeline_start=0.0,
            )
        )
        project.transcripts.append(Transcript(track_id=track_id, words=words))
    return project


def _two_mics(tmp_path: Path, gain_db: float, f0: float = 150.0) -> EpisodeProject:
    host, host_words = _host(f0)
    guest, guest_words = _guest(f0)
    return _project(tmp_path, gain_db, (("host", host, host_words), ("guest", guest, guest_words)))


def _path(source: str, bleed: str) -> EchoPairProfile:
    return EchoPairProfile(
        source_track_id=source,
        bleed_track_id=bleed,
        span_start=0.0,
        span_end=20.0,
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


_GUEST_REACHES_HOST = patch(
    "podcast_mcp.engines.audio_audit.TrackRmsCacheSet.echo_pairs",
    new=lambda self: [_path("guest", "host")],
)

UNSCALED = [
    ("host", "alpha", "audible"),
    ("host", "soft", "audible"),
    ("host", "faint", "inaudible"),
    ("host", "bleed", "bleed"),
    ("host", "long", "audible"),
    ("host", "end", "audible"),
    ("guest", "bravo", "audible"),
    ("guest", "charlie", "audible"),
    ("guest", "delta", "audible"),
]


def _verdicts(project: EpisodeProject) -> list[tuple[str, str, str]]:
    with _GUEST_REACHES_HOST:
        rows = compute_word_audibility_map(project, policy=AnalysisPolicy())
    return [(r["track_id"], r["text"], r["audibility_status"]) for r in rows]


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_audibility_verdicts_do_not_move_with_recording_level(tmp_path: Path, gain_db: float):
    assert _verdicts(_two_mics(tmp_path, gain_db)) == UNSCALED


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_reconciled_transcript_does_not_move_with_recording_level(tmp_path: Path, gain_db: float):
    project = _two_mics(tmp_path, gain_db)
    with _GUEST_REACHES_HOST:
        reconcile_transcript(project, policy=AnalysisPolicy(), dry_run=False, update_status=True)
    host = project.transcript_for_track("host")
    assert host is not None
    assert [(w.text, w.audibility_status, w.suppressed) for w in host.words] == [
        ("alpha", "audible", False),
        ("soft", "audible", False),
        ("faint", "inaudible", True),
        ("bleed", "bleed", True),
        ("long", "audible", False),
        ("end", "audible", False),
    ]


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_low_audibility_scan_does_not_move_with_recording_level(tmp_path: Path, gain_db: float):
    rows = list_low_audibility_words(_two_mics(tmp_path, gain_db))
    assert [(r["track_id"], r["text"]) for r in rows] == [("host", "faint")]


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_same_pitch_on_both_mics_keeps_the_verdicts(tmp_path: Path, gain_db: float):
    """Two voices of one pitch: the verdict reads levels, never who is talking."""
    assert _verdicts(_two_mics(tmp_path, gain_db, f0=210.0)) == UNSCALED


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_track_with_a_single_word_judges_it_audible(tmp_path: Path, gain_db: float):
    audio = _room(5, seconds=1)
    _voice(audio, 0.2, 0.6, SPEECH_DB)
    project = _project(
        tmp_path, gain_db, (("solo", audio, [TranscriptWord(text="hi", start=0.2, end=0.6)]),)
    )
    rows = compute_word_audibility_map(project, policy=AnalysisPolicy())
    assert [r["audibility_status"] for r in rows] == ["audible"]


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_track_without_contrast_between_speech_and_room_judges_nothing_inaudible(
    tmp_path: Path, gain_db: float
):
    """A steady tone has no room to tell its voice from: its floor would sit over all of it."""
    audio = _tone(2 * RATE, SPEECH_DB)
    project = _project(
        tmp_path, gain_db, (("tone", audio, [TranscriptWord(text="hi", start=0.5, end=1.5)]),)
    )
    rows = compute_word_audibility_map(project, policy=AnalysisPolicy())
    assert [r["audibility_status"] for r in rows] == ["audible"]


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_track_with_no_live_audio_judges_its_words_inaudible(tmp_path: Path, gain_db: float):
    project = _project(
        tmp_path,
        gain_db,
        (("mute", np.zeros(2 * RATE), [TranscriptWord(text="hi", start=0.5, end=1.0)]),),
    )
    rows = compute_word_audibility_map(project, policy=AnalysisPolicy())
    assert [r["audibility_status"] for r in rows] == ["inaudible"]


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_verdicts_hold_without_the_optional_aligner_extras(tmp_path: Path, gain_db: float):
    absent = {name: None for name in ("torch", "torchaudio", "ctc_forced_aligner")}
    with patch.dict(sys.modules, absent):
        assert _verdicts(_two_mics(tmp_path, gain_db)) == UNSCALED


def test_one_floor_serves_the_audit_and_tighten(tmp_path: Path):
    _two_mics(tmp_path, -12.0)
    audit = TrackRmsCache.from_timeline_stem(tmp_path / "raw" / "host.wav", sample_rate=RATE)
    tighten = TrackAudioCache(jump=audit, waveform=audit)
    assert audit.voice_floor_db == tighten.voice_floor_db
    assert audit.voice_floor_db == pytest.approx(SPEECH_DB - 12.0 - 27.0, abs=0.5)


def _stretched_token(gain_db: float) -> tuple[TrackRmsCache, list[TranscriptWord]]:
    audio = _room(3)
    _voice(audio, 1.0, 1.3, SPEECH_DB)
    _voice(audio, 6.0, 8.0, SPEECH_DB)
    words = [
        TranscriptWord(text="uh", start=0.5, end=5.0),
        TranscriptWord(text="so", start=6.0, end=8.0),
    ]
    samples = audio * 10 ** (gain_db / 20)
    return TrackRmsCache(samples=samples, sample_rate=RATE), words


@pytest.mark.parametrize("gain_db", GAINS_DB)
def test_stretched_token_trims_onto_its_voice_at_any_level(gain_db: float):
    cache, words = _stretched_token(gain_db)
    caps = WordSpanCaps.from_defaults({"tighten": {"filler_words": ["uh"]}})
    trim_implausible_words(words, cache, caps)
    assert (round(words[0].start, 1), round(words[0].end, 1)) == (1.0, 1.3)


@pytest.mark.parametrize("gain_db", (0.0, -12.0, -24.0, -36.0, 12.0))
def test_a_same_room_bleed_path_is_found_at_any_recording_level(gain_db: float):
    """Fixed open and source levels lose the pair a few tens of dB down."""
    dry = voices(7)
    room = np.random.default_rng(11).standard_normal((2, dry["caleb"].size))
    mic = dry["caleb"] + 0.1 * delay(dry["audra"], 0.003) + 1e-3 * room[0]
    own = dry["audra"] + 1e-4 * room[1]
    scale = 10 ** (gain_db / 20)
    caches = TrackRmsCacheSet(
        caches={
            "caleb": TrackRmsCache(samples=(mic * scale).astype(np.float32), sample_rate=8000),
            "audra": TrackRmsCache(samples=(own * scale).astype(np.float32), sample_rate=8000),
        }
    )
    assert [(p.source_track_id, p.bleed_track_id, p.lag_ms) for p in caches.echo_pairs()] == [
        ("audra", "caleb", 3.0)
    ]
