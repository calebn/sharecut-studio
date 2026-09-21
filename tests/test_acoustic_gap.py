"""Synthetic safety checks for review-only acoustic gap candidates."""

import numpy as np

from podcast_mcp.edits.acoustic_gap import find_voiced_gap_runs
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.audition_context import _build_hypotheses
from podcast_mcp.edits.fillers import _collect_candidates
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.models import (
    EditDecision,
    EditDecisionType,
    Transcript,
    TranscriptWord,
    load_project,
)


def _cache(samples: np.ndarray, rate: int = 16_000) -> TrackAudioCache:
    empty = TrackRmsCache(np.zeros(1, dtype=np.float32), rate)
    return TrackAudioCache(empty, TrackRmsCache(samples.astype(np.float32), rate))


def test_sustained_voiced_run_is_bounded_inside_gap_and_does_not_mutate_cache() -> None:
    rate = 16_000
    t = np.arange(rate * 2) / rate
    samples = np.zeros(rate * 2, dtype=np.float32)
    samples[rate // 2 : rate * 9 // 10] = 0.2 * np.sin(2 * np.pi * 180 * t[: rate * 4 // 10])
    cache = _cache(samples)
    original = cache.waveform.samples.copy()

    runs = find_voiced_gap_runs(cache, 0.2, 1.4)

    assert runs
    assert all(0.2 <= run.start < run.end <= 1.4 for run in runs)
    assert np.array_equal(cache.waveform.samples, original)


def test_acoustic_run_replaces_overlapping_pause_candidate() -> None:
    rate = 16_000
    t = np.arange(rate * 3) / rate
    samples = np.zeros(rate * 3, dtype=np.float32)
    samples[int(0.8 * rate) : int(1.2 * rate)] = 0.2 * np.sin(
        2 * np.pi * 180 * t[: int(0.4 * rate)]
    )
    transcript = Transcript(
        track_id="host",
        words=[
            TranscriptWord(text="one", start=0.2, end=0.4),
            TranscriptWord(text="two", start=2.0, end=2.2),
        ],
    )
    candidates = _collect_candidates(
        transcript,
        {"tighten": {"max_pause_sec": 1.2}},
        audio_cache=_cache(samples),
    )
    acoustic = [c for c in candidates if c.reason == "filler:acoustic"]
    assert acoustic
    assert not any(c.cut_kind == "pause" for c in candidates)
    assert all(0.4 <= c.start < c.end <= 2.0 for c in acoustic)


def test_noise_short_gap_and_long_gap_are_rejected() -> None:
    rate = 16_000
    rng = np.random.default_rng(7)
    noise = rng.normal(0, 0.12, rate * 2).astype(np.float32)

    assert find_voiced_gap_runs(_cache(noise), 0.2, 1.0) == []
    assert find_voiced_gap_runs(_cache(noise), 0.2, 0.5) == []
    assert find_voiced_gap_runs(_cache(noise), 0.0, 10.0) == []


def test_suppressed_or_bleed_anchor_never_creates_candidate() -> None:
    rate = 16_000
    t = np.arange(rate * 3) / rate
    samples = np.zeros(rate * 3, dtype=np.float32)
    samples[int(0.8 * rate) : int(1.2 * rate)] = 0.2 * np.sin(
        2 * np.pi * 180 * t[: int(0.4 * rate)]
    )
    defaults = {"tighten": {"max_pause_sec": 99.0}}
    for field in ("suppressed", "bleed"):
        left = TranscriptWord(text="one", start=0.2, end=0.4)
        if field == "suppressed":
            left.suppressed = True
        else:
            left.audibility_status = "bleed"
        transcript = Transcript(
            track_id="host", words=[left, TranscriptWord(text="two", start=2.0, end=2.2)]
        )
        candidates = _collect_candidates(transcript, defaults, audio_cache=_cache(samples))
        assert not any(c.reason == "filler:acoustic" for c in candidates)


def test_pending_acoustic_edit_is_review_hypothesis_without_rescan() -> None:
    hypotheses = _build_hypotheses(
        window={"start": 0.0, "end": 2.0},
        tracks_out=[],
        render_status={},
        edits={
            "pending": [{"id": "e1", "track_id": "host", "reason": "filler:acoustic"}],
            "applied": [],
        },
        track_ids=["host"],
    )
    acoustic = [h for h in hypotheses if h["code"] == "acoustic_gap_filler"]
    assert len(acoustic) == 1
    assert acoustic[0]["next"]["fix"]["autonomy"] == "needs_approval"


def test_reproposal_replaces_pending_acoustic_but_keeps_applied(minimal_project) -> None:
    project = load_project(minimal_project)
    project.edit_decisions = [
        EditDecision(
            id="pending-acoustic",
            track_id="host",
            start=0.5,
            end=0.7,
            type=EditDecisionType.REMOVE,
            reason="filler:acoustic",
            review_required=True,
            applied=False,
        ),
        EditDecision(
            id="applied-acoustic",
            track_id="host",
            start=0.8,
            end=1.0,
            type=EditDecisionType.REMOVE,
            reason="filler:acoustic",
            review_required=True,
            applied=True,
        ),
    ]
    propose_tighten_edits(project, {"tighten": {"max_pause_sec": 99.0}})
    ids = {decision.id for decision in project.edit_decisions}
    assert "pending-acoustic" not in ids
    assert "applied-acoustic" in ids
