"""Safety checks for review-only acoustic gap filler candidates (``filler:acoustic``)."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits import fillers
from podcast_mcp.edits.acoustic_gap import (
    AcousticGapConfig,
    AcousticGapRun,
    _voiced,
    find_voiced_gap_runs,
)
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.audition_context import _build_hypotheses
from podcast_mcp.edits.fillers import (
    _add_acoustic_candidates,
    _AnalyzedCut,
    _collect_candidates,
    _CutCandidate,
    _resolve_analyzed_cuts,
    analyze_fillers_and_pauses,
)
from podcast_mcp.edits.tighten import (
    apply_tighten_decisions,
    format_tighten_propose_summary,
    propose_tighten_edits,
)
from podcast_mcp.edits.transcript_cuts import coalesce_edits
from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

RATE = 16_000


def _cache(samples: np.ndarray, rate: int = RATE) -> TrackAudioCache:
    empty = TrackRmsCache(np.zeros(1, dtype=np.float32), rate)
    return TrackAudioCache(empty, TrackRmsCache(samples.astype(np.float32), rate))


def _tone(total_sec: float, start: float, end: float, *, hz: float = 180.0, amp: float = 0.2):
    samples = np.zeros(int(total_sec * RATE), dtype=np.float32)
    n = int((end - start) * RATE)
    t = np.arange(n) / RATE
    samples[int(start * RATE) : int(start * RATE) + n] = amp * np.sin(2 * np.pi * hz * t)
    return samples


def _dbfs_sine(total_sec: float, hz: float, level_db: float) -> np.ndarray:
    t = np.arange(int(total_sec * RATE)) / RATE
    return (10 ** (level_db / 20) * np.sqrt(2) * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def _two_words(gap_start: float = 0.4, gap_end: float = 2.0, **left: object) -> Transcript:
    first = TranscriptWord(text="one", start=0.2, end=gap_start)
    for key, value in left.items():
        setattr(first, key, value)
    return Transcript(
        track_id="host",
        words=[first, TranscriptWord(text="two", start=gap_end, end=gap_end + 0.2)],
    )


def _acoustic(candidates: list[_CutCandidate]) -> list[_CutCandidate]:
    return [c for c in candidates if c.reason == "filler:acoustic"]


def _write_wav(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(pcm.tobytes())


def _project(
    tmp_path: Path,
    samples: np.ndarray,
    words: list[TranscriptWord],
    *,
    peer_words: list[TranscriptWord] | None = None,
) -> EpisodeProject:
    duration = samples.size / RATE
    project = EpisodeProject.create("acoustic", str(tmp_path))
    track_ids = ["host"] + (["guest"] if peer_words is not None else [])
    for tid in track_ids:
        _write_wav(tmp_path / "raw" / f"{tid}.wav", samples if tid == "host" else samples * 0)
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=duration),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"full_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=duration,
                timeline_start=0.0,
            )
        )
    project.transcripts = [Transcript(track_id="host", words=words)]
    if peer_words is not None:
        project.transcripts.append(Transcript(track_id="guest", words=peer_words))
    return project


def _decision(
    ident: str, start: float, end: float, reason: str, *, applied=False, review=False
) -> EditDecision:
    return EditDecision(
        id=ident,
        track_id="host",
        start=start,
        end=end,
        type=EditDecisionType.REMOVE,
        reason=reason,
        applied=applied,
        review_required=review,
    )


# --- detector ---------------------------------------------------------------


def test_sustained_voiced_run_is_bounded_inside_gap_and_does_not_mutate_cache() -> None:
    cache = _cache(_tone(2.0, 0.5, 0.9))
    original = cache.waveform.samples.copy()

    runs = find_voiced_gap_runs(cache, 0.2, 1.4)

    assert runs
    assert all(0.2 <= run.start < run.end <= 1.4 for run in runs)
    assert np.array_equal(cache.waveform.samples, original)


def test_noise_short_gap_and_empty_window_are_rejected() -> None:
    noise = np.random.default_rng(7).normal(0, 0.12, RATE * 2).astype(np.float32)

    assert find_voiced_gap_runs(_cache(noise), 0.2, 1.0) == []
    assert find_voiced_gap_runs(_cache(noise), 0.2, 0.5) == []
    assert find_voiced_gap_runs(_cache(noise), 0.8, 0.4) == []
    assert find_voiced_gap_runs(_cache(np.zeros(RATE, dtype=np.float32)), 5.0, 6.0) == []


def test_gap_longer_than_frame_budget_is_skipped_even_with_voiced_run() -> None:
    cache = _cache(_tone(3.0, 1.0, 1.3))

    assert find_voiced_gap_runs(cache, 0.4, 2.0)
    # 100 frames ~= 1.0 s of analysis; the 1.6 s gap is never scanned.
    assert find_voiced_gap_runs(cache, 0.4, 2.0, max_frames=100) == []


def test_flat_hum_and_rumble_never_yield_candidates() -> None:
    hum = _dbfs_sine(3.0, 120.0, -53.0)
    rng = np.random.default_rng(3)
    rumble = np.convolve(rng.normal(0, 1, RATE * 3), np.ones(80) / 80, "same")
    rumble = (rumble / np.sqrt(np.mean(rumble**2)) * 10 ** (-42 / 20)).astype(np.float32)

    assert find_voiced_gap_runs(_cache(hum), 0.4, 2.8) == []
    assert find_voiced_gap_runs(_cache(rumble), 0.4, 2.8) == []


def test_voiced_burst_over_hum_is_still_found() -> None:
    samples = _dbfs_sine(3.0, 120.0, -53.0) + _tone(3.0, 1.0, 1.4)

    runs = find_voiced_gap_runs(_cache(samples), 0.4, 2.8)

    assert len(runs) == 1
    assert 0.9 <= runs[0].start < runs[0].end <= 1.5


def test_run_covering_most_of_the_gap_is_a_plateau_not_a_filler() -> None:
    samples = _tone(3.0, 0.45, 2.75)

    assert find_voiced_gap_runs(_cache(samples), 0.4, 2.8) == []


def test_aperiodic_burst_and_short_blip_are_not_fillers() -> None:
    samples = np.zeros(RATE * 3, dtype=np.float32)
    rng = np.random.default_rng(11)
    samples[int(1.0 * RATE) : int(1.4 * RATE)] = rng.normal(0, 0.2, int(0.4 * RATE))
    blip = _tone(3.0, 1.0, 1.04)

    assert find_voiced_gap_runs(_cache(samples), 0.4, 2.8) == []
    assert find_voiced_gap_runs(_cache(blip), 0.4, 2.8) == []
    assert not _voiced(np.ones(10, dtype=np.float32), RATE)


# --- config -----------------------------------------------------------------


def test_config_defaults_and_bounds() -> None:
    assert AcousticGapConfig.from_tighten(None) == AcousticGapConfig()
    cfg = AcousticGapConfig.from_tighten(
        {
            "acoustic_gap_filler": {
                "enabled": False,
                "min_gap_sec": 0.1,
                "max_run_sec": 9.0,
                "max_frames": 5000,
            }
        }
    )
    assert cfg == AcousticGapConfig(
        enabled=False, min_gap_sec=0.35, max_run_sec=1.5, max_frames=600
    )
    lowered = AcousticGapConfig.from_tighten(
        {"acoustic_gap_filler": {"min_gap_sec": "bad", "max_run_sec": 0.5, "max_frames": 1}}
    )
    assert lowered == AcousticGapConfig(min_gap_sec=0.35, max_run_sec=0.5, max_frames=20)


def test_disabled_config_adds_no_candidates() -> None:
    transcript = _two_words()
    defaults = {"tighten": {"max_pause_sec": 99.0, "acoustic_gap_filler": {"enabled": False}}}
    skips: dict[str, int] = {}

    found = _add_acoustic_candidates(
        [], transcript, defaults, audio_cache=_cache(_tone(3.0, 0.8, 1.2)), skip_counts=skips
    )

    assert found == []
    assert skips == {}


def test_missing_audio_is_counted_only_when_there_is_a_gap_to_scan() -> None:
    skips: dict[str, int] = {}
    _add_acoustic_candidates([], _two_words(), {"tighten": {}}, skip_counts=skips)
    assert skips == {"acoustic:no_audio": 1}

    tight: dict[str, int] = {}
    _add_acoustic_candidates([], _two_words(0.4, 0.5), {"tighten": {}}, skip_counts=tight)
    assert tight == {}


# --- collection ---------------------------------------------------------------


def test_acoustic_candidate_is_bounded_by_run_not_gap() -> None:
    candidates = _add_acoustic_candidates(
        [], _two_words(0.4, 2.0), {"tighten": {}}, audio_cache=_cache(_tone(3.0, 0.8, 1.2))
    )
    (acoustic,) = _acoustic(candidates)

    assert acoustic.review_only
    assert acoustic.strictly_bounded
    assert acoustic.min_start is not None and acoustic.max_end is not None
    assert 0.4 + 0.025 <= acoustic.min_start <= acoustic.start < acoustic.end
    assert acoustic.end <= acoustic.max_end <= acoustic.end + 0.05 + 1e-9
    # The ceiling tracks the run, far from the next word at 2.0 s.
    assert acoustic.max_end < 1.4


def test_suppressed_bleed_or_other_speaker_anchor_never_creates_candidate() -> None:
    cache = _cache(_tone(3.0, 0.8, 1.2))
    for left in ({"suppressed": True}, {"audibility_status": "bleed"}):
        found = _add_acoustic_candidates([], _two_words(**left), {"tighten": {}}, audio_cache=cache)
        assert not _acoustic(found)

    skips: dict[str, int] = {}
    found = _add_acoustic_candidates(
        [],
        _two_words(speaker_match_track="guest"),
        {"tighten": {}},
        audio_cache=cache,
        skip_counts=skips,
    )
    assert not _acoustic(found)
    assert skips == {"acoustic:not_owner": 1}


def test_edge_margin_and_occupied_runs_are_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        fillers,
        "find_voiced_gap_runs",
        lambda *_a, **_k: [
            AcousticGapRun(start=0.40, end=0.50, confidence=0.5),  # hugs the left word
            AcousticGapRun(start=1.00, end=1.30, confidence=0.5),  # under an existing filler
        ],
    )
    occupied = [_CutCandidate("host", 1.1, 1.2, "filler:um", "filler")]
    skips: dict[str, int] = {}

    found = _add_acoustic_candidates(
        occupied,
        _two_words(),
        {"tighten": {}},
        audio_cache=_cache(np.zeros(RATE * 3)),
        skip_counts=skips,
    )

    assert found == occupied
    assert skips == {"acoustic:edge_margin": 1, "acoustic:occupied": 1}


def test_peer_speaking_in_gap_is_treated_as_bleed(tmp_path: Path) -> None:
    samples = _tone(3.0, 0.8, 1.2)
    project = _project(
        tmp_path,
        samples,
        _two_words().words,
        peer_words=[TranscriptWord(text="yes", start=0.9, end=1.1)],
    )
    skips: dict[str, int] = {}

    found = _add_acoustic_candidates(
        [],
        project.transcripts[0],
        {"tighten": {}},
        project=project,
        audio_cache=_cache(samples),
        skip_counts=skips,
    )

    assert found == []
    assert skips == {"acoustic:peer_speaking": 1}


def test_collect_candidates_alone_never_scans_audio() -> None:
    candidates = _collect_candidates(_two_words(), {"tighten": {"max_pause_sec": 1.2}})
    assert not _acoustic(candidates)
    assert [c.cut_kind for c in candidates] == ["pause"]


# --- post-analysis resolution ------------------------------------------------------


def _analyzed(start: float, end: float, reason: str) -> _AnalyzedCut:
    return _AnalyzedCut(
        track_id="host",
        start=start,
        end=end,
        reason=reason,
        review_required=reason == "filler:acoustic",
        crossfade_ms=10,
        cut_confidence=1.0,
        boundary_mode="test",
    )


_PAUSE = _CutCandidate("host", 0.4, 1.6, "pause:1.60s", "pause", max_end=1.6)
_ACOUSTIC = _CutCandidate(
    "host",
    0.8,
    1.2,
    "filler:acoustic",
    "filler",
    filler_confidence=0.5,
    max_end=1.25,
    min_start=0.75,
    review_only=True,
)


def test_pause_trim_survives_when_acoustic_analysis_rejects_the_run() -> None:
    skips: dict[str, int] = {}
    pause = _analyzed(0.4, 1.6, "pause:1.60s")

    kept = _resolve_analyzed_cuts([_PAUSE, _ACOUSTIC], [pause, None], skip_counts=skips)

    assert kept == [pause]
    assert skips == {"acoustic:rejected": 1}


def test_surviving_acoustic_run_replaces_overlapping_pause_trim() -> None:
    skips: dict[str, int] = {}
    acoustic = _analyzed(0.8, 1.2, "filler:acoustic")

    kept = _resolve_analyzed_cuts(
        [_PAUSE, _ACOUSTIC], [_analyzed(0.4, 1.6, "pause:1.60s"), acoustic], skip_counts=skips
    )

    assert kept == [acoustic]
    assert skips == {"acoustic:replaced_pause": 1}


def test_acoustic_run_overlapping_a_paced_word_filler_is_dropped() -> None:
    filler = _CutCandidate("host", 0.3, 0.5, "filler:um", "filler")
    widened = _analyzed(0.3, 1.9, "filler:um")  # pacing widened um across the gap
    skips: dict[str, int] = {}

    kept = _resolve_analyzed_cuts(
        [filler, _ACOUSTIC],
        [widened, _analyzed(0.8, 1.2, "filler:acoustic")],
        skip_counts=skips,
    )

    assert kept == [widened]
    assert skips == {"acoustic:overlaps_cut": 1}


def test_cut_overlapping_an_applied_decision_is_not_reproposed() -> None:
    filler = _CutCandidate("host", 1.0, 1.3, "filler:um", "filler")
    skips: dict[str, int] = {}

    kept = _resolve_analyzed_cuts(
        [filler],
        [_analyzed(0.98, 1.3, "filler:um")],
        existing=[_decision("old", 1.0, 1.3, "filler:um", applied=True)],
        skip_counts=skips,
    )

    assert kept == []
    assert skips == {"applied_overlap": 1}


# --- coalescing ----------------------------------------------------------------


def _coalesced(*decisions: EditDecision) -> list[tuple[str, float, float, bool, bool]]:
    project = EpisodeProject.create("c", "/tmp/ws")
    project.edit_decisions = list(decisions)
    coalesce_edits(project, track_id="host")
    return sorted(
        (e.reason or "", e.start, e.end, e.applied, e.review_required)
        for e in project.edit_decisions
    )


def test_coalesce_keeps_acoustic_proposals_independent() -> None:
    applied_um = _decision("um", 0.30, 0.50, "filler:um", applied=True)
    pending_acoustic = _decision("ac", 0.53, 0.90, "filler:acoustic", review=True)
    assert _coalesced(applied_um, pending_acoustic) == [
        ("filler:acoustic", 0.53, 0.90, False, True),
        ("filler:um", 0.30, 0.50, True, False),
    ]

    acoustic = _decision("ac", 0.78, 1.175, "filler:acoustic", review=True)
    auto_um = _decision("um", 1.2, 1.4, "filler:um")
    assert _coalesced(acoustic, auto_um) == [
        ("filler:acoustic", 0.78, 1.175, False, True),
        ("filler:um", 1.2, 1.4, False, False),
    ]

    pause = _decision("p", 2.0, 2.5, "pause:1.40s")
    acoustic_after = _decision("ac", 2.52, 2.8, "filler:acoustic", review=True)
    assert _coalesced(pause, acoustic_after) == [
        ("filler:acoustic", 2.52, 2.8, False, True),
        ("pause:1.40s", 2.0, 2.5, False, False),
    ]


def test_coalesce_never_merges_across_applied_but_still_merges_ordinary_cuts() -> None:
    applied = _decision("old", 1.0, 1.3, "filler:um", applied=True)
    pending = _decision("new", 0.98, 1.3, "filler:um")
    assert _coalesced(applied, pending) == [
        ("filler:um", 0.98, 1.3, False, False),
        ("filler:um", 1.0, 1.3, True, False),
    ]

    left = _decision("a", 1.0, 1.3, "filler:um")
    right = _decision("b", 1.32, 1.5, "filler:uh")
    assert _coalesced(left, right) == [("filler:um", 1.0, 1.5, False, False)]


# --- end to end ------------------------------------------------------------------


def _e2e_defaults(**tighten: object) -> dict[str, object]:
    return {"tighten": {"max_pause_sec": 99.0, **tighten}}


def test_propose_emits_bounded_review_only_acoustic_decision_that_never_auto_applies(
    tmp_path: Path, sample_wav: Path
) -> None:
    del sample_wav  # ffmpeg availability gate for decoding the project WAV
    project = _project(tmp_path, _tone(3.0, 0.8, 1.2), _two_words().words)

    proposal = propose_tighten_edits(project, _e2e_defaults())

    (decision,) = proposal.decisions
    assert decision.reason and decision.reason.startswith("filler:acoustic")
    assert decision.review_required and not decision.applied
    assert 0.4 + 0.025 <= decision.start < decision.end <= 2.0 - 0.025
    assert decision.start >= 0.7 and decision.end <= 1.35
    # No paced pad: the pause left behind can only be shorter than the original.
    assert decision.replace_gap_sec is None
    assert "1 acoustic (review)" in proposal.summary()

    assert apply_tighten_decisions(project) == 0
    assert [e.id for e in project.edit_decisions] == [decision.id]
    assert project.edit_decisions[0].applied is False


def test_propose_apply_propose_keeps_applied_ranges_and_flags(
    tmp_path: Path, sample_wav: Path
) -> None:
    del sample_wav
    project = _project(tmp_path, _tone(3.0, 0.8, 1.2), _two_words().words)
    first = propose_tighten_edits(project, _e2e_defaults()).decisions[0]
    # A human approved the acoustic proposal but the decision was not archived
    # (transcript reconcile / fixtures can leave applied decisions in place).
    first.applied = True
    snapshot = (first.id, first.start, first.end, first.applied, first.review_required)

    second = propose_tighten_edits(project, _e2e_defaults())

    assert second.decisions == []
    assert second.skip_counts.get("applied_overlap") == 1
    assert [
        (e.id, e.start, e.end, e.applied, e.review_required) for e in project.edit_decisions
    ] == [snapshot]


def test_reproposal_regenerates_pending_and_ordinary_applied_edits(minimal_project) -> None:
    from podcast_mcp.models import load_project

    project = load_project(minimal_project)
    project.edit_decisions = [
        _decision("pending-acoustic", 0.5, 0.7, "filler:acoustic", review=True),
        _decision("applied-acoustic", 0.8, 1.0, "filler:acoustic", applied=True, review=True),
        _decision("applied-um", 1.2, 1.3, "filler:um", applied=True),
        _decision("risky-um", 1.4, 1.5, "filler:um:risky", review=True),
        _decision("manual", 1.6, 1.7, "nl:range", applied=True),
    ]

    propose_tighten_edits(project, {"tighten": {"max_pause_sec": 99.0}})

    assert {d.id for d in project.edit_decisions} == {"applied-acoustic", "risky-um", "manual"}


def test_propose_does_not_mutate_decisions_when_analysis_raises(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del sample_wav
    project = _project(tmp_path, _tone(3.0, 0.8, 1.2), _two_words().words)
    before = [_decision("pending-um", 0.2, 0.4, "filler:um")]
    project.edit_decisions = list(before)

    def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("dsp failed")

    monkeypatch.setattr("podcast_mcp.edits.tighten._analyze_candidate", boom)
    with pytest.raises(RuntimeError):
        propose_tighten_edits(project, _e2e_defaults())

    assert project.edit_decisions == before


def test_analyze_entry_point_matches_propose_and_skips_decode_when_idle(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del sample_wav
    project = _project(tmp_path, _tone(3.0, 0.8, 1.2), _two_words().words)

    decisions = analyze_fillers_and_pauses(project, project.transcripts[0], _e2e_defaults())

    assert [d.reason for d in decisions] == ["filler:acoustic"]
    assert decisions[0].review_required

    calls: list[object] = []

    def fake_build(*args: object, **_kwargs: object) -> dict[str, TrackAudioCache]:
        calls.append(args)
        return {}

    monkeypatch.setattr(fillers, "build_track_audio_caches", fake_build)
    disabled = _e2e_defaults(acoustic_gap_filler={"enabled": False})
    assert analyze_fillers_and_pauses(project, project.transcripts[0], disabled) == []
    assert calls == []


def test_bounded_candidate_with_empty_window_is_dropped_before_analysis(
    tmp_path: Path, sample_wav: Path
) -> None:
    del sample_wav
    project = _project(tmp_path, _tone(3.0, 0.8, 1.2), _two_words().words)
    impossible = _CutCandidate(
        "host",
        0.8,
        1.2,
        "filler:acoustic",
        "filler",
        filler_confidence=0.5,
        min_start=1.3,
        max_end=0.9,
        review_only=True,
    )

    assert fillers._analyze_candidate(project, impossible, _e2e_defaults()) is None


def test_summary_reports_acoustic_proposals_and_skips_separately() -> None:
    decisions = [
        _decision("a", 0.1, 0.2, "filler:um"),
        _decision("b", 0.5, 0.7, "filler:acoustic", review=True),
    ]
    assert (
        format_tighten_propose_summary(decisions, {"acoustic:rejected": 2})
        == "2 proposed (1 filler, 0 pause, 1 acoustic (review), 2 acoustic skipped)"
    )


# --- audition hypothesis ------------------------------------------------------------


def test_pending_acoustic_edit_is_review_hypothesis_with_its_own_span() -> None:
    hypotheses = _build_hypotheses(
        window={"start": 0.0, "end": 2.0},
        tracks_out=[],
        render_status={},
        edits={
            "pending": [
                {
                    "id": "e1",
                    "track_id": "host",
                    "reason": "filler:acoustic",
                    "timeline_start": 0.8,
                    "timeline_end": 1.2,
                }
            ],
            "applied": [],
        },
        track_ids=["host"],
    )
    (acoustic,) = [h for h in hypotheses if h["code"] == "acoustic_gap_filler"]
    assert acoustic["next"]["fix"]["autonomy"] == "needs_approval"
    assert acoustic["evidence"] == {
        "edit_id": "e1",
        "reason": "filler:acoustic",
        "timeline_start": 0.8,
        "timeline_end": 1.2,
    }
    assert acoustic["meaning"].startswith("A local DSP candidate")
