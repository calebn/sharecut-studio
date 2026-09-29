"""Tier A pins for voiced speech at tighten cut edges and inside pause spans (#815, #818).

Synthetic tracks: a 180 Hz harmonic "vowel" for voice, digital silence (-200 dBFS,
Zoom's gate) between words. Word times are what the transcript says; the audio is
what the listener hears, and the two disagree on purpose where the issues did.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.fillers import analyze_fillers_and_pauses
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.edits.tighten import apply_tighten_decisions, propose_tighten_edits
from podcast_mcp.edits.voiced_runs import run_straddling, voiced_runs, voiced_sec_inside
from podcast_mcp.engines.audio_audit import TrackRmsCache
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
DEFAULTS: dict[str, object] = {"tighten": {"max_pause_sec": 1.2}}
# The word tail past its transcript time is itself a review-only acoustic candidate;
# the edge pins look at the pause alone.
EDGE_DEFAULTS: dict[str, object] = {
    "tighten": {"max_pause_sec": 1.2, "acoustic_gap_filler": {"enabled": False}}
}


def _voice(samples: np.ndarray, start: float, end: float, *, level_db: float = -20.0) -> None:
    n = int((end - start) * RATE)
    t = np.arange(n) / RATE
    tone = sum(np.sin(2 * np.pi * 180.0 * k * t) / k for k in range(1, 6))
    tone = tone / np.sqrt(np.mean(tone**2)) * 10 ** (level_db / 20)
    samples[int(start * RATE) : int(start * RATE) + n] = tone.astype(np.float32)


def _breath(samples: np.ndarray, start: float, end: float, *, level_db: float = -30.0) -> None:
    n = int((end - start) * RATE)
    noise = np.random.default_rng(3).normal(0, 1.0, n)
    noise = noise / np.sqrt(np.mean(noise**2)) * 10 ** (level_db / 20)
    samples[int(start * RATE) : int(start * RATE) + n] = noise.astype(np.float32)


def _cache(samples: np.ndarray) -> TrackAudioCache:
    empty = TrackRmsCache(np.zeros(1, dtype=np.float32), RATE)
    return TrackAudioCache(empty, TrackRmsCache(samples.astype(np.float32), RATE))


def _project(tmp_path: Path, samples: np.ndarray, words: list[TranscriptWord]) -> EpisodeProject:
    path = tmp_path / "raw" / "host.wav"
    path.parent.mkdir(parents=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes((np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes())
    duration = samples.size / RATE
    project = EpisodeProject.create("voicing", str(tmp_path))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=duration),
        )
    )
    project.timeline.clips.append(
        Clip(id="c", track_id="host", source_start=0.0, source_end=duration, timeline_start=0.0)
    )
    project.transcripts = [Transcript(track_id="host", words=words)]
    return project


def test_voiced_runs_quantize_to_the_frame_grid_and_skip_breath() -> None:
    samples = np.zeros(4 * RATE, dtype=np.float32)
    _voice(samples, 0.2, 1.25)
    _breath(samples, 2.0, 2.3)
    runs = voiced_runs(_cache(samples), 0.0, 4.0, floor_db=-42.0)
    assert runs == [(pytest.approx(0.19), pytest.approx(1.26))]
    assert run_straddling(runs, 1.0) == runs[0]
    assert run_straddling(runs, 1.25) is None
    assert run_straddling(runs, 0.2) is None
    assert voiced_sec_inside(runs, 1.0, 3.0) == pytest.approx(0.26)
    assert voiced_sec_inside(runs, 2.0, 3.0) == 0.0


def test_voiced_runs_ignore_the_window_placement_and_digital_silence() -> None:
    samples = np.zeros(3 * RATE, dtype=np.float32)
    _voice(samples, 1.0, 1.5)
    cache = _cache(samples)
    assert voiced_runs(cache, 0.937, 2.2, floor_db=-42.0) == voiced_runs(
        cache, 0.5, 3.0, floor_db=-42.0
    )
    assert voiced_runs(cache, 1.6, 3.0, floor_db=-42.0) == []


def test_kept_word_overlaps_excludes_the_cut_word() -> None:
    project = EpisodeProject.create("idx", "/tmp/ws")
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="of", start=16.34, end=16.38),
                TranscriptWord(text="like", start=16.52, end=16.70),
                TranscriptWord(text="edits", start=17.30, end=17.58),
                TranscriptWord(text="muted", start=16.9, end=17.1, suppressed=True),
            ],
        )
    ]
    index = CutWordIndex.build(project, "host")
    # The voice before the edge is "like" itself, not a word that stays.
    assert not index.kept_word_overlaps(16.50, 16.63, exclude_start=16.52, exclude_end=17.22)
    # ... unless the run reaches back into "of".
    assert index.kept_word_overlaps(15.83, 16.63, exclude_start=16.52, exclude_end=17.22)
    assert index.kept_word_overlaps(17.22, 17.40, exclude_start=16.52, exclude_end=17.22)
    assert not index.kept_word_overlaps(16.9, 17.1, exclude_start=16.52, exclude_end=16.70)


def test_speech_inside_an_asr_gap_never_becomes_an_auto_applicable_pause(tmp_path: Path) -> None:
    """#818: Whisper dropped a sentence between "one" and "two"; the gap is still speech."""
    samples = np.zeros(4 * RATE, dtype=np.float32)
    _voice(samples, 0.2, 0.4)
    _voice(samples, 0.6, 2.4)
    _voice(samples, 3.0, 3.2)
    words = [
        TranscriptWord(text="one", start=0.2, end=0.4),
        TranscriptWord(text="two", start=3.0, end=3.2),
    ]
    project = _project(tmp_path, samples, words)

    proposal = propose_tighten_edits(project, DEFAULTS)

    (decision,) = proposal.decisions
    assert decision.reason == "pause:2.60s:solo:interior_speech"
    assert decision.review_required is True
    assert (decision.start, decision.end) == (pytest.approx(0.4, abs=0.05), pytest.approx(2.45))
    assert apply_tighten_decisions(project) == 0


def test_pause_start_inside_a_word_tail_moves_past_the_voice(tmp_path: Path) -> None:
    """#815: the aligner ends "one" at 1.0 s but the vowel runs to 1.25 s."""
    samples = np.zeros(4 * RATE, dtype=np.float32)
    _voice(samples, 0.2, 1.25)
    _voice(samples, 3.0, 3.2)
    words = [
        TranscriptWord(text="one", start=0.2, end=1.0),
        TranscriptWord(text="two", start=3.0, end=3.2),
    ]
    project = _project(tmp_path, samples, words)

    (decision,) = analyze_fillers_and_pauses(project, project.transcripts[0], EDGE_DEFAULTS)

    assert decision.reason == "pause:2.00s:solo"
    assert decision.review_required is False
    # Voice edge on the frame grid (1.26) plus 60 ms of air.
    assert decision.start == pytest.approx(1.32, abs=0.011)
    assert decision.end == pytest.approx(2.45)


def test_pause_end_inside_the_next_word_onset_moves_before_the_voice(tmp_path: Path) -> None:
    """Whisper hears "two" start at 3.0 s; the voice starts at 2.3 s, inside the cut."""
    samples = np.zeros(4 * RATE, dtype=np.float32)
    _voice(samples, 0.2, 0.4)
    _voice(samples, 2.3, 3.2)
    words = [
        TranscriptWord(text="one", start=0.2, end=0.4),
        TranscriptWord(text="two", start=3.0, end=3.2),
    ]
    project = _project(tmp_path, samples, words)

    (decision,) = analyze_fillers_and_pauses(project, project.transcripts[0], EDGE_DEFAULTS)

    assert decision.reason == "pause:2.60s:solo"
    assert decision.review_required is False
    assert decision.start == pytest.approx(0.4, abs=0.05)
    # Voice edge on the frame grid (2.29) minus 60 ms of air.
    assert decision.end == pytest.approx(2.23, abs=0.011)


def test_clean_dead_air_stays_auto_applicable(tmp_path: Path) -> None:
    samples = np.zeros(4 * RATE, dtype=np.float32)
    _voice(samples, 0.2, 0.58)
    _voice(samples, 3.0, 3.4)
    words = [
        TranscriptWord(text="one", start=0.2, end=0.6),
        TranscriptWord(text="two", start=3.0, end=3.4),
    ]
    project = _project(tmp_path, samples, words)

    (decision,) = analyze_fillers_and_pauses(project, project.transcripts[0], DEFAULTS)

    assert decision.reason == "pause:2.40s:solo"
    assert decision.review_required is False
    assert 0.58 <= decision.start <= 0.62
    assert decision.end == pytest.approx(2.45)
    assert apply_tighten_decisions(project) == 1


def test_word_cut_with_voice_running_through_both_edges_is_reviewed(tmp_path: Path) -> None:
    """Continuous "kind of like um edits": neither edge of a filler cut can leave the voice."""
    samples = np.zeros(4 * RATE, dtype=np.float32)
    _voice(samples, 0.5, 2.2)
    _voice(samples, 2.3, 2.6)
    words = [
        TranscriptWord(text="kind", start=0.5, end=0.9),
        TranscriptWord(text="of", start=0.95, end=1.1),
        TranscriptWord(text="like", start=1.2, end=1.5),
        TranscriptWord(text="um", start=1.55, end=1.8),
        TranscriptWord(text="edits", start=2.3, end=2.6),
    ]
    project = _project(tmp_path, samples, words)
    defaults = {"tighten": {"filler_words": ["like", "um"], "discourse_markers": []}}

    decisions = analyze_fillers_and_pauses(project, project.transcripts[0], defaults)

    assert [d.reason for d in decisions] == ["filler:like:voiced_edge", "filler:um:voiced_edge"]
    assert all(d.review_required for d in decisions)
