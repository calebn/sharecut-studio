"""Word ownership is judged at the measured copy lag (#1052).

A remote participant's own track trails their voice on an in-room mic. Reconcile
reads the source's level at that lag, measured per pair from the audio, and falls
back to 0 lag when the estimate is not confident. A word the lag alone would give
away keeps its owner unless its sound carries the source's fine spectrum.

The scene: speech-like bursts on two mics (``bleed_helpers.voices``), Audra's copy on
Caleb's mic 20 dB down over a room-noise floor 60 dB down, Audra's own track 150 ms
late. Planted bursts in a quiet stretch make one case each.
"""

from __future__ import annotations

from unittest.mock import patch

import numpy as np
import pytest

from bleed_helpers import RATE, delay, voices
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    TrackRmsCache,
    TrackRmsCacheSet,
    compute_word_audibility_map,
)
from podcast_mcp.engines.bleed_echo import EchoPairProfile
from podcast_mcp.models import EpisodeProject, Track, TrackRole, Transcript, TranscriptWord

LATENCY_SEC = 0.15
COPY_GAIN = 0.1
ROOM_NOISE = 1e-3
LOUD, SOFT = 0.3, 0.075
QUIET = (200.0, 230.0)
# Caleb-track words: (start, end) on the shared clock.
WORDS = {
    "copy": (210.0, 210.2),
    "after": (212.2, 212.4),
    "cross": (214.0, 214.3),
    "same": (216.0, 216.3),
}
AUDRA_WORDS = {"cross": (214.27, 214.57)}
# (voice, start, seconds, amplitude) on the dry clock, before Audra's track latency.
BURSTS = (
    ("audra", 210.0, 0.2, LOUD),  # Audra alone: Caleb's mic carries only her copy.
    ("audra", 212.0, 0.2, LOUD),  # Audra stops as Caleb starts softly.
    ("caleb", 212.2, 0.2, SOFT),
    ("caleb", 214.0, 0.3, SOFT),  # Both talk at once; Audra is louder at the lag.
    ("audra", 214.12, 0.3, LOUD),
    ("caleb", 216.0, 0.3, LOUD),  # Both talk at once at the same level.
    ("audra", 216.0, 0.3, LOUD),
)
BLEED_PATH = EchoPairProfile(
    source_track_id="audra",
    bleed_track_id="caleb",
    span_start=0.0,
    span_end=240.0,
    dominated_frames=100,
    copy_frames=40,
    consistent_frames=30,
    lag_ms=0.5,
    level_db=-20.0,
    examples=(1.0,),
    null_runs=8,
    null_copy_rate=0.05,
    null_consistent_rate=0.02,
)


def _caches(*, background: bool = True) -> TrackRmsCacheSet:
    dry = (
        voices(7)
        if background
        else {name: np.zeros(round(240 * RATE)) for name in ("caleb", "audra")}
    )
    caleb, audra = dry["caleb"].copy(), dry["audra"].copy()
    for samples in (caleb, audra):
        samples[round(QUIET[0] * RATE) : round(QUIET[1] * RATE)] = 0.0
    for seed, (voice, start, sec, amplitude) in enumerate(BURSTS):
        size, first = round(sec * RATE), round(start * RATE)
        noise = np.random.default_rng(seed).standard_normal(size)
        (caleb if voice == "caleb" else audra)[first : first + size] += (
            noise * np.hanning(size) * amplitude
        )
    noise = np.random.default_rng(11).standard_normal((2, caleb.size))
    return TrackRmsCacheSet(
        caches={
            "caleb": TrackRmsCache(
                samples=(caleb + COPY_GAIN * audra + ROOM_NOISE * noise[0]).astype(np.float32)
            ),
            "audra": TrackRmsCache(
                samples=(delay(audra, LATENCY_SEC) + 1e-4 * noise[1]).astype(np.float32)
            ),
        }
    )


def _project() -> EpisodeProject:
    project = EpisodeProject.create("ep", "/tmp/copy-lag")
    project.timeline.tracks = [
        Track(id=tid, label=tid, role=TrackRole.DIALOGUE, speaker=tid) for tid in ("caleb", "audra")
    ]
    project.transcripts = [
        Transcript(
            track_id=tid,
            words=[TranscriptWord(text=text, start=a, end=b) for text, (a, b) in words.items()],
        )
        for tid, words in (("caleb", WORDS), ("audra", AUDRA_WORDS))
    ]
    return project


def _verdicts(caches: TrackRmsCacheSet) -> dict[tuple[str, str], tuple[str, str | None]]:
    with patch.object(TrackRmsCacheSet, "echo_pairs", lambda self: [BLEED_PATH]):
        rows = compute_word_audibility_map(_project(), policy=AnalysisPolicy(), caches=caches)
    return {(r["track_id"], r["text"]): (r["audibility_status"], r["dominant_track"]) for r in rows}


@pytest.fixture(scope="module")
def verdicts() -> dict[tuple[str, str], tuple[str, str | None]]:
    return _verdicts(_caches())


def test_a_copy_that_leads_its_source_track_is_the_sources_word(verdicts) -> None:
    """At 0 lag Audra's track has barely started, so her copy reads as Caleb's own word."""
    assert verdicts[("caleb", "copy")] == ("bleed", "audra")


def test_an_own_word_after_the_peer_stops_stays_own(verdicts) -> None:
    """At 0 lag Audra's late track still carries the syllable she finished before Caleb spoke."""
    assert verdicts[("caleb", "after")] == ("audible", None)


def test_crosstalk_keeps_both_words_own(verdicts) -> None:
    """Audra out-levels Caleb's soft word only at the lag, and the word does not sound like her."""
    assert verdicts[("caleb", "cross")] == ("audible", None)
    assert verdicts[("audra", "cross")] == ("audible", None)


def test_a_word_at_the_peers_level_stays_own(verdicts) -> None:
    assert verdicts[("caleb", "same")] == ("audible", None)


def test_the_lag_and_the_copys_likeness_are_measured_once_per_pair() -> None:
    caches = _caches()
    with patch.object(TrackRmsCacheSet, "echo_pairs", lambda self: [BLEED_PATH]):
        path = caches.copy_path("audra", "caleb")
        assert path.lag_sec == pytest.approx(LATENCY_SEC)
        assert path.likeness is not None
        assert caches.bleed_paths("caleb") == {"audra": path}
        assert caches.bleed_paths("audra") == {}


def test_too_little_of_the_peer_to_measure_falls_back_to_zero_lag() -> None:
    """Under 30 s of Audra's speech the lag is not trusted, so each word gets its 0-lag verdict."""
    caches = _caches(background=False)
    with patch.object(TrackRmsCacheSet, "echo_pairs", lambda self: [BLEED_PATH]):
        assert caches.copy_path("audra", "caleb").lag_sec == 0.0
        assert caches.copy_path("audra", "caleb").likeness is None
    found = _verdicts(caches)
    assert found[("caleb", "copy")] == ("audible", None)
    assert found[("caleb", "after")] == ("bleed", "audra")


def test_mics_on_different_sample_clocks_fall_back_to_zero_lag() -> None:
    caches = _caches()
    audra = caches.caches["audra"]
    caches.caches["audra"] = TrackRmsCache(samples=audra.samples[::2], sample_rate=RATE // 2)
    with patch.object(TrackRmsCacheSet, "echo_pairs", lambda self: [BLEED_PATH]):
        assert caches.copy_path("audra", "caleb").lag_sec == 0.0


def test_a_lag_without_a_measured_likeness_takes_no_word() -> None:
    from podcast_mcp.engines.audio_audit import CopyPath

    assert not CopyPath(lag_sec=LATENCY_SEC, likeness=None).carries(1.0)
    assert CopyPath(lag_sec=LATENCY_SEC, likeness=0.4).carries(0.4)
    assert not CopyPath(lag_sec=LATENCY_SEC, likeness=0.4).carries(0.39)
