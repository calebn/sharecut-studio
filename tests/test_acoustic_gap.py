"""Safety checks for review-only acoustic gap filler candidates (``filler:acoustic``)."""

from __future__ import annotations

import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.acoustic_gap import (
    AcousticGapConfig,
    AcousticGapRun,
    _voiced,
    find_voiced_gap_runs,
)
from podcast_mcp.edits.acoustic_laugh import burst_count, has_laugh_bursts
from podcast_mcp.edits.acoustic_phrase import (
    MIN_WORD_STEPS,
    phrase_hit_indexes,
    word_silence_ceiling,
)
from podcast_mcp.edits.acoustic_word import (
    flag_possible_words,
    heard_a_word,
    whisper_span_transcriber,
)
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.audition_context import _build_hypotheses
from podcast_mcp.edits.cut_placement import CutRejected
from podcast_mcp.edits.tighten import (
    acoustic_scan,
    analyze_fillers_and_pauses,
    apply_tighten_decisions,
    format_tighten_propose_summary,
    propose_tighten_edits,
)
from podcast_mcp.edits.tighten import apply as tighten_apply
from podcast_mcp.edits.tighten import prepare as tighten_prepare
from podcast_mcp.edits.tighten.acoustic_scan import _add_acoustic_candidates
from podcast_mcp.edits.tighten.apply import _resolve_analyzed_cuts
from podcast_mcp.edits.tighten.candidate import _AnalyzedCut, _CutCandidate
from podcast_mcp.edits.tighten.collect import _collect_candidates
from podcast_mcp.edits.tighten.propose import _flag_possible_words
from podcast_mcp.edits.tighten_reasons import is_likely_laugh_reason, is_possible_word_reason
from podcast_mcp.edits.transcript_cuts import coalesce_edits
from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.engines.models.whisper import WhisperWeightsMissingError
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.engines.whisper_device import WhisperPlacement
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
from podcast_mcp.pipeline.meta import PARAM_FIELDS
from podcast_mcp.util.model_missing import ModelMissing
from podcast_mcp.util.progress import (
    CancelledProgress,
    RecordingProgress,
    bind_progress,
    progress_task,
)
from podcast_mcp.util.project_state import render_cancel_scope

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


def _breath_like_run(total_sec: float, start: float, end: float, *, gain: float) -> np.ndarray:
    """Broadband breath energy with enough weak voicing to reach the classifier."""
    samples = np.zeros(int(total_sec * RATE), dtype=np.float32)
    count = int((end - start) * RATE)
    time = np.arange(count) / RATE
    noise = np.random.default_rng(218).normal(0, 0.017, count)
    samples[int(start * RATE) : int(start * RATE) + count] = (
        gain * (noise + 0.025 * np.sin(2 * np.pi * 180 * time))
    ).astype(np.float32)
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
    peer_samples: np.ndarray | None = None,
) -> EpisodeProject:
    duration = samples.size / RATE
    project = EpisodeProject.create("acoustic", str(tmp_path))
    track_ids = ["host"] + (["guest"] if peer_words is not None else [])
    for tid in track_ids:
        peer = samples * 0 if peer_samples is None else peer_samples
        _write_wav(tmp_path / "raw" / f"{tid}.wav", samples if tid == "host" else peer)
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

    runs = find_voiced_gap_runs(cache, 0.2, 1.4, defaults=load_defaults())

    assert runs
    assert all(0.2 <= run.start < run.end <= 1.4 for run in runs)
    assert np.array_equal(cache.waveform.samples, original)


def test_noise_short_gap_and_empty_window_are_rejected() -> None:
    noise = np.random.default_rng(7).normal(0, 0.12, RATE * 2).astype(np.float32)

    assert find_voiced_gap_runs(_cache(noise), 0.2, 1.0, defaults=load_defaults()) == []
    assert find_voiced_gap_runs(_cache(noise), 0.2, 0.5, defaults=load_defaults()) == []
    assert find_voiced_gap_runs(_cache(noise), 0.8, 0.4, defaults=load_defaults()) == []
    assert (
        find_voiced_gap_runs(
            _cache(np.zeros(RATE, dtype=np.float32)), 5.0, 6.0, defaults=load_defaults()
        )
        == []
    )
    with np.errstate(invalid="raise"):
        assert (
            find_voiced_gap_runs(
                _cache(np.zeros(RATE, dtype=np.float32)), 0.1, 0.9, defaults=load_defaults()
            )
            == []
        )


def test_window_too_short_to_hold_a_run_whole_scans_no_longer_gap() -> None:
    cache = _cache(_tone(3.0, 1.0, 1.3))

    assert find_voiced_gap_runs(cache, 0.4, 2.0, defaults=load_defaults())
    # 100 frames ~= 1.0 s of analysis, under the longest run plus its seam margins.
    assert find_voiced_gap_runs(cache, 0.4, 2.0, max_frames=100, defaults=load_defaults()) == []


def _bursts(total_sec: float, starts: list[float], length: float = 0.3) -> np.ndarray:
    samples = np.zeros(int(total_sec * RATE), dtype=np.float32)
    for start in starts:
        samples += _tone(total_sec, start, start + length)
    return samples


def test_gap_longer_than_one_window_is_scanned_whole_in_overlapping_windows() -> None:
    """A 40 s gap holds bursts everywhere, among them at each seam of the 6 s windows."""
    starts = [0.9, 3.0, 5.5, 6.2, 6.9, 9.5, 10.6, 14.9, 20.0, 29.8, 34.7, 39.0]
    cache = _cache(_bursts(41.0, starts))

    runs = find_voiced_gap_runs(cache, 0.4, 40.6, defaults=load_defaults())

    assert len(runs) == len(starts)
    for run, start in zip(runs, starts, strict=True):
        assert start - 0.05 <= run.start < run.end <= start + 0.35


def test_every_offset_of_a_burst_is_found_once_across_the_seams() -> None:
    for offset in np.arange(3.0, 12.0, 0.17):
        cache = _cache(_bursts(20.0, [float(offset)]))

        runs = find_voiced_gap_runs(cache, 0.4, 19.6, defaults=load_defaults())

        assert len(runs) == 1, offset


def test_a_run_cut_by_a_seam_is_not_reported_short() -> None:
    cache = _cache(_bursts(20.0, [6.3], length=1.2))

    (run,) = find_voiced_gap_runs(cache, 0.4, 19.6, defaults=load_defaults())

    assert run.end - run.start >= 1.1


def test_a_burst_straddling_a_seam_is_reported_whole_not_cut_at_the_seam() -> None:
    cache = _cache(_bursts(20.0, [6.2], length=0.5))

    (run,) = find_voiced_gap_runs(cache, 0.4, 19.6, defaults=load_defaults())

    assert abs((run.end - run.start) - 0.5) <= 0.04
    assert 6.15 <= run.start < run.end <= 6.75


def test_a_long_gap_is_judged_window_by_window_so_hum_in_one_does_not_hide_a_burst_in_another() -> (
    None
):
    samples = _bursts(41.0, [30.0])
    samples[: 20 * RATE] += _dbfs_sine(20.0, 120.0, -53.0)

    runs = find_voiced_gap_runs(_cache(samples), 0.4, 40.6, defaults=load_defaults())

    assert len(runs) == 1 and 29.9 <= runs[0].start < 30.4


def test_flat_hum_and_rumble_never_yield_candidates() -> None:
    hum = _dbfs_sine(3.0, 120.0, -53.0)
    rng = np.random.default_rng(3)
    rumble = np.convolve(rng.normal(0, 1, RATE * 3), np.ones(80) / 80, "same")
    rumble = (rumble / np.sqrt(np.mean(rumble**2)) * 10 ** (-42 / 20)).astype(np.float32)

    assert find_voiced_gap_runs(_cache(hum), 0.4, 2.8, defaults=load_defaults()) == []
    assert find_voiced_gap_runs(_cache(rumble), 0.4, 2.8, defaults=load_defaults()) == []


def test_voiced_burst_over_hum_is_still_found() -> None:
    samples = _dbfs_sine(3.0, 120.0, -53.0) + _tone(3.0, 1.0, 1.4)

    runs = find_voiced_gap_runs(_cache(samples), 0.4, 2.8, defaults=load_defaults())

    assert len(runs) == 1
    assert 0.9 <= runs[0].start < runs[0].end <= 1.5


def test_run_covering_most_of_the_gap_is_a_plateau_not_a_filler() -> None:
    samples = _tone(3.0, 0.45, 2.75)

    assert find_voiced_gap_runs(_cache(samples), 0.4, 2.8, defaults=load_defaults()) == []


def test_aperiodic_burst_and_short_blip_are_not_fillers() -> None:
    samples = np.zeros(RATE * 3, dtype=np.float32)
    rng = np.random.default_rng(11)
    samples[int(1.0 * RATE) : int(1.4 * RATE)] = rng.normal(0, 0.2, int(0.4 * RATE))
    blip = _tone(3.0, 1.0, 1.04)

    assert find_voiced_gap_runs(_cache(samples), 0.4, 2.8, defaults=load_defaults()) == []
    assert find_voiced_gap_runs(_cache(blip), 0.4, 2.8, defaults=load_defaults()) == []
    assert not _voiced(np.ones(10, dtype=np.float32), RATE)


@pytest.mark.parametrize("gain", [0.5, 1.0, 2.0])
def test_no_speech_context_keeps_voiced_runs_for_review(gain: float) -> None:
    samples = _tone(3.0, 0.65, 0.9, amp=0.036 * gain)
    samples += _tone(3.0, 1.3, 1.65, amp=0.2 * gain)

    runs = find_voiced_gap_runs(_cache(samples), 0.4, 2.0, defaults=load_defaults())

    assert len(runs) == 2


@pytest.mark.parametrize("gain", [0.5, 1.0, 2.0])
def test_contextual_breath_rejection_is_gain_stable_and_counted(gain: float) -> None:
    samples = _tone(3.0, 0.2, 0.4, amp=0.2 * gain)
    samples += _tone(3.0, 2.0, 2.2, amp=0.2 * gain)
    samples += _breath_like_run(3.0, 0.65, 0.9, gain=gain)
    samples += _tone(3.0, 1.3, 1.65, amp=0.2 * gain)
    skips: dict[str, int] = {}

    found = _add_acoustic_candidates(
        [], _two_words(), {"tighten": {}}, audio_cache=_cache(samples), skip_counts=skips
    )

    assert len(_acoustic(found)) == 1
    assert 1.25 <= _acoustic(found)[0].start < _acoustic(found)[0].end <= 1.7
    assert skips == {"acoustic:breath": 1}


@pytest.mark.parametrize("gain", [0.5, 1.0, 2.0])
def test_quiet_periodic_word_stays_reviewable_with_speech_context(gain: float) -> None:
    samples = _tone(3.0, 0.2, 0.4, amp=0.2 * gain)
    samples += _tone(3.0, 2.0, 2.2, amp=0.2 * gain)
    samples += _tone(3.0, 0.65, 0.9, amp=0.036 * gain)
    skips: dict[str, int] = {}

    found = _add_acoustic_candidates(
        [], _two_words(), {"tighten": {}}, audio_cache=_cache(samples), skip_counts=skips
    )

    assert len(_acoustic(found)) == 1
    assert 0.6 <= _acoustic(found)[0].start < _acoustic(found)[0].end <= 0.95
    assert skips.get("acoustic:breath", 0) == 0


def test_public_proposal_scans_the_track_for_acoustic_fillers(tmp_path: Path) -> None:
    samples = _tone(3.0, 0.2, 0.4)
    samples += _tone(3.0, 2.0, 2.2)
    samples += _tone(3.0, 0.65, 0.9, amp=0.036)
    samples += _tone(3.0, 1.3, 1.65)
    project = _project(tmp_path, samples, _two_words().words)
    defaults = {"tighten": {}}

    with (
        patch(
            "podcast_mcp.edits.tighten.propose.build_track_audio_caches",
            return_value={"host": _cache(samples)},
        ),
        patch(
            "podcast_mcp.edits.tighten.propose.analyze_candidates",
            side_effect=lambda project, candidates, *args, **kwargs: [None] * len(candidates),
        ) as analyze,
    ):
        result = propose_tighten_edits(project, defaults)

    assert sum(c.reason == "filler:acoustic" for c in analyze.call_args.args[1]) == 2
    assert result.skip_counts.get("acoustic:breath", 0) == 0


def test_acoustic_gap_silero_is_opt_in_and_receives_only_candidate_samples() -> None:
    cache = _cache(_tone(2.0, 0.5, 0.9))
    with patch(
        "podcast_mcp.edits.acoustic_gap.classify_breath_samples", return_value=None
    ) as classify:
        assert find_voiced_gap_runs(cache, 0.2, 1.4, vad_backend="silero", defaults=load_defaults())

    assert classify.call_count == 1
    assert classify.call_args.kwargs["vad_backend"] == "silero"
    assert classify.call_args.args[0].size < cache.window(0.2, 1.4).size


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
    assert (
        AcousticGapConfig.from_tighten(
            {"acoustic_gap_filler": {"vad_backend": "silero"}}
        ).vad_backend
        == "silero"
    )
    assert (
        AcousticGapConfig.from_tighten(
            {"acoustic_gap_filler": {"vad_backend": "unknown"}}
        ).vad_backend
        == "heuristic"
    )
    field = next(p for p in PARAM_FIELDS if p.path == "tighten.acoustic_gap_filler.vad_backend")
    assert field.type == "enum" and field.enum == ("heuristic", "silero")


def test_disabled_config_adds_no_candidates() -> None:
    transcript = _two_words()
    defaults = {"tighten": {"max_pause_sec": 99.0, "acoustic_gap_filler": {"enabled": False}}}
    skips: dict[str, int] = {}

    found = _add_acoustic_candidates(
        [], transcript, defaults, audio_cache=_cache(_tone(3.0, 0.8, 1.2)), skip_counts=skips
    )

    assert found == []
    assert skips == {}


def test_configured_breath_backend_reaches_acoustic_detector() -> None:
    defaults = {"tighten": {"acoustic_gap_filler": {"vad_backend": "silero"}}}
    with patch(
        "podcast_mcp.edits.tighten.acoustic_scan.find_voiced_gap_runs", return_value=[]
    ) as detector:
        _add_acoustic_candidates([], _two_words(), defaults, audio_cache=_cache(np.zeros(RATE * 3)))

    detector.assert_called_once()
    assert detector.call_args.kwargs["vad_backend"] == "silero"


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
        acoustic_scan,
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


def test_peer_voice_in_gap_is_treated_as_bleed_with_no_peer_word(tmp_path: Path) -> None:
    samples = _tone(3.0, 0.8, 1.2)
    project = _project(
        tmp_path, samples, _two_words().words, peer_words=[], peer_samples=_tone(3.0, 0.9, 1.1)
    )
    skips: dict[str, int] = {}

    found = _add_acoustic_candidates(
        [],
        project.transcripts[0],
        {"tighten": {}},
        project=project,
        audio_cache=_cache(samples),
        audio_caches={"host": _cache(samples), "guest": _cache(_tone(3.0, 0.9, 1.1))},
        skip_counts=skips,
    )

    assert found == []
    assert skips == {"acoustic:peer_speaking": 1}


def test_peer_word_over_silent_peer_audio_does_not_block_the_gap(tmp_path: Path) -> None:
    samples = _tone(3.0, 0.8, 1.2)
    silent = np.zeros_like(samples)
    project = _project(
        tmp_path,
        samples,
        _two_words().words,
        peer_words=[TranscriptWord(text="-huh.", start=0.3, end=1.9)],
    )
    skips: dict[str, int] = {}

    found = _add_acoustic_candidates(
        [],
        project.transcripts[0],
        {"tighten": {}},
        project=project,
        audio_cache=_cache(samples),
        audio_caches={"host": _cache(samples), "guest": _cache(silent)},
        skip_counts=skips,
    )

    assert skips == {}
    assert [(round(c.start, 2), round(c.end, 2)) for c in _acoustic(found)] == [(0.78, 1.21)]


def _peer_gap_skips(
    tmp_path: Path, own: np.ndarray, peer: np.ndarray
) -> tuple[list[_CutCandidate], dict[str, int]]:
    project = _project(tmp_path, own, _two_words().words, peer_words=[], peer_samples=peer)
    skips: dict[str, int] = {}
    found = _add_acoustic_candidates(
        [],
        project.transcripts[0],
        {"tighten": {}},
        project=project,
        audio_cache=_cache(own),
        audio_caches={"host": _cache(own), "guest": _cache(peer)},
        skip_counts=skips,
    )
    return found, skips


def _peer_with_own_speech(copy_amp: float) -> np.ndarray:
    """The peer's track: a copy of the cut track's voice, and the peer's own speech later on."""
    return _tone(3.0, 0.8, 1.2, amp=copy_amp) + _tone(3.0, 2.2, 2.8, hz=130.0, amp=0.2)


@pytest.mark.parametrize("own_gain", [0.1, 1.0, 4.0])
def test_peer_copy_of_the_cut_tracks_voice_far_below_it_is_bleed_not_peer_speech(
    tmp_path: Path, own_gain: float
) -> None:
    """The verdict holds when the cut track's file alone is recorded at another gain (#1523)."""
    own = _tone(3.0, 0.8, 1.2, amp=0.2 * own_gain)

    found, skips = _peer_gap_skips(tmp_path, own, _peer_with_own_speech(0.02))

    assert skips == {}
    assert [(round(c.start, 2), round(c.end, 2)) for c in _acoustic(found)] == [(0.78, 1.21)]


def test_peer_voice_while_the_cut_track_is_quiet_blocks_the_gap(tmp_path: Path) -> None:
    own = _tone(3.0, 0.8, 1.2, amp=0.002)
    peer = _tone(3.0, 0.8, 1.2, amp=0.2)

    found, skips = _peer_gap_skips(tmp_path, own, peer)

    assert found == []
    assert skips == {"acoustic:peer_speaking": 1}


def test_peer_voice_while_the_cut_track_is_gated_shut_leaves_nothing_to_propose(
    tmp_path: Path,
) -> None:
    found, skips = _peer_gap_skips(
        tmp_path, np.zeros(3 * RATE, dtype=np.float32), _tone(3.0, 0.8, 1.2, amp=0.2)
    )

    assert found == []
    assert skips == {}


def test_independent_voices_at_similar_levels_block_the_gap(tmp_path: Path) -> None:
    own = _tone(3.0, 0.8, 1.2, hz=180.0, amp=0.2)
    peer = _tone(3.0, 0.9, 1.1, hz=130.0, amp=0.15)

    found, skips = _peer_gap_skips(tmp_path, own, peer)

    assert found == []
    assert skips == {"acoustic:peer_speaking": 1}


def test_bleed_margin_comes_from_the_analysis_heuristics(tmp_path: Path) -> None:
    own = _tone(3.0, 0.8, 1.2, amp=0.2)
    peer = _tone(3.0, 0.8, 1.2, amp=0.02)
    project = _project(tmp_path, own, _two_words().words, peer_words=[], peer_samples=peer)
    skips: dict[str, int] = {}

    found = _add_acoustic_candidates(
        [],
        project.transcripts[0],
        {"tighten": {}, "analysis": {"heuristics": {"bleed_dominance_db": 30.0}}},
        project=project,
        audio_cache=_cache(own),
        audio_caches={"host": _cache(own), "guest": _cache(peer)},
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
        hit_id=f"cut_{reason}_{start}_{end}",
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

    kept = _resolve_analyzed_cuts(
        [_PAUSE, _ACOUSTIC], [pause, CutRejected("breath")], skip_counts=skips
    )

    assert kept == [pause]
    assert skips == {"acoustic:breath": 1}


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


def _coalesced(tmp_path, *decisions: EditDecision) -> list[tuple[str, float, float, bool, bool]]:
    from source_review_helpers import finite_primary_recording

    project = EpisodeProject.create("c", str(tmp_path))
    finite_primary_recording(project, 3)
    project.edit_decisions = list(decisions)
    coalesce_edits(project, track_id="host", defaults=load_defaults())
    return sorted(
        (e.reason or "", e.start, e.end, e.applied, e.review_required)
        for e in project.edit_decisions
    )


def test_coalesce_keeps_a_likely_laugh_apart_from_a_pause_or_filler_beside_it(tmp_path) -> None:
    laugh = _decision("lf", 1.0, 1.5, "filler:acoustic:likely_laugh", review=True)
    pause = _decision("p", 1.52, 2.4, "pause:0.90s")
    um = _decision("um", 0.7, 0.98, "filler:um")
    assert _coalesced(tmp_path, um, laugh, pause) == [
        ("filler:acoustic:likely_laugh", 1.0, 1.5, False, True),
        ("filler:um", 0.7, 0.98, False, False),
        ("pause:0.90s", 1.52, 2.4, False, False),
    ]


def test_coalesce_keeps_acoustic_proposals_independent(tmp_path) -> None:
    applied_um = _decision("um", 0.30, 0.50, "filler:um", applied=True)
    pending_acoustic = _decision("ac", 0.53, 0.90, "filler:acoustic", review=True)
    assert _coalesced(tmp_path, applied_um, pending_acoustic) == [
        ("filler:acoustic", 0.53, 0.90, False, True),
        ("filler:um", 0.30, 0.50, True, False),
    ]

    acoustic = _decision("ac", 0.78, 1.175, "filler:acoustic", review=True)
    auto_um = _decision("um", 1.2, 1.4, "filler:um")
    assert _coalesced(tmp_path, acoustic, auto_um) == [
        ("filler:acoustic", 0.78, 1.175, False, True),
        ("filler:um", 1.2, 1.4, False, False),
    ]

    pause = _decision("p", 2.0, 2.5, "pause:1.40s")
    acoustic_after = _decision("ac", 2.52, 2.8, "filler:acoustic", review=True)
    assert _coalesced(tmp_path, pause, acoustic_after) == [
        ("filler:acoustic", 2.52, 2.8, False, True),
        ("pause:1.40s", 2.0, 2.5, False, False),
    ]


def test_coalesce_never_merges_across_applied_but_still_merges_ordinary_cuts(tmp_path) -> None:
    applied = _decision("old", 1.0, 1.3, "filler:um", applied=True)
    pending = _decision("new", 0.98, 1.3, "filler:um")
    assert _coalesced(tmp_path, applied, pending) == [
        ("filler:um", 0.98, 1.3, False, False),
        ("filler:um", 1.0, 1.3, True, False),
    ]

    left = _decision("a", 1.0, 1.3, "filler:um")
    right = _decision("b", 1.32, 1.5, "filler:uh")
    assert _coalesced(tmp_path, left, right) == [("filler:um", 1.0, 1.5, False, False)]


# --- end to end ------------------------------------------------------------------


def _acoustic_dialogue_samples() -> np.ndarray:
    """Voiced gap audio between audible words, with retained room tone."""
    samples = np.random.default_rng(941).normal(0, 0.0003, 3 * RATE).astype(np.float32)
    # Quiet room-tone separators let the final cut edges settle outside activity.
    for start, end in ((0.73, 0.78), (1.24, 1.29)):
        samples[round(start * RATE) : round(end * RATE)] *= 0.1
    for start, end in ((0.2, 0.4), (0.8, 1.2), (2.0, 2.2)):
        samples += _tone(3.0, start, end)
    return samples


def _e2e_defaults(**tighten: object) -> dict[str, object]:
    return {"tighten": {"max_pause_sec": 99.0, **tighten}}


def test_propose_emits_bounded_review_only_acoustic_decision_that_never_auto_applies(
    tmp_path: Path, sample_wav: Path
) -> None:
    del sample_wav  # ffmpeg availability gate for decoding the project WAV
    project = _project(tmp_path, _acoustic_dialogue_samples(), _two_words().words)

    proposal = propose_tighten_edits(project, _e2e_defaults())

    (decision,) = proposal.decisions
    assert decision.reason and decision.reason.startswith("filler:acoustic")
    assert decision.review_required and not decision.applied
    assert 0.4 + 0.025 <= decision.start < decision.end <= 2.0 - 0.025
    assert decision.start >= 0.7 and decision.end <= 1.35
    # No paced pad: the pause left behind can only be shorter than the original.
    assert decision.replace_gap_sec is None
    assert "1 acoustic (review)" in proposal.summary()

    assert apply_tighten_decisions(project, defaults=load_defaults()) == 0
    assert [e.id for e in project.edit_decisions] == [decision.id]
    assert project.edit_decisions[0].applied is False


def test_propose_ignores_peer_word_that_spans_the_gap_over_silent_peer_audio(
    tmp_path: Path, sample_wav: Path
) -> None:
    del sample_wav
    project = _project(
        tmp_path,
        _acoustic_dialogue_samples(),
        _two_words().words,
        peer_words=[TranscriptWord(text="-huh.", start=0.3, end=1.9)],
    )

    proposal = propose_tighten_edits(project, _e2e_defaults())

    (decision,) = proposal.decisions
    assert decision.reason and decision.reason.startswith("filler:acoustic")
    assert proposal.skip_counts == {}


def test_propose_skips_the_gap_when_the_peer_track_carries_untranscribed_voice(
    tmp_path: Path, sample_wav: Path
) -> None:
    del sample_wav
    project = _project(
        tmp_path,
        _acoustic_dialogue_samples(),
        _two_words().words,
        peer_words=[],
        peer_samples=_tone(3.0, 0.9, 1.1),
    )

    proposal = propose_tighten_edits(project, _e2e_defaults())

    assert proposal.decisions == []
    assert proposal.skip_counts == {"acoustic:peer_speaking": 1}


def test_propose_suppresses_acoustic_candidate_without_retained_level_profile(
    tmp_path: Path, sample_wav: Path
) -> None:
    del sample_wav
    project = _project(tmp_path, _tone(3.0, 0.8, 1.2), _two_words().words)

    proposal = propose_tighten_edits(project, _e2e_defaults())

    assert proposal.decisions == []
    assert proposal.skip_counts == {"acoustic:breath": 1}
    assert project.edit_decisions == []


def test_propose_apply_propose_keeps_applied_ranges_and_flags(
    tmp_path: Path, sample_wav: Path
) -> None:
    del sample_wav
    project = _project(tmp_path, _acoustic_dialogue_samples(), _two_words().words)
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
        _decision("applied-risky-um", 1.52, 1.58, "filler:um:risky", applied=True, review=True),
        _decision("manual", 1.6, 1.7, "nl:range", applied=True),
    ]

    propose_tighten_edits(project, {"tighten": {"max_pause_sec": 99.0}})

    assert {d.id for d in project.edit_decisions} == {
        "applied-acoustic",
        "applied-risky-um",
        "manual",
    }


def test_propose_does_not_mutate_decisions_when_analysis_raises(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del sample_wav
    project = _project(tmp_path, _tone(3.0, 0.8, 1.2), _two_words().words)
    before = [_decision("pending-um", 0.2, 0.4, "filler:um")]
    project.edit_decisions = list(before)

    def boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("dsp failed")

    monkeypatch.setattr("podcast_mcp.edits.tighten.propose.analyze_candidates", boom)
    with pytest.raises(RuntimeError):
        propose_tighten_edits(project, _e2e_defaults())

    assert project.edit_decisions == before


def test_analyze_entry_point_matches_propose_and_skips_decode_when_idle(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del sample_wav
    project = _project(tmp_path, _acoustic_dialogue_samples(), _two_words().words)

    decisions = analyze_fillers_and_pauses(project, project.transcripts[0], _e2e_defaults())

    assert [d.reason for d in decisions] == ["filler:acoustic"]
    assert decisions[0].review_required

    calls: list[object] = []

    def fake_build(*args: object, **_kwargs: object) -> dict[str, TrackAudioCache]:
        calls.append(args)
        return {}

    monkeypatch.setattr(tighten_apply, "build_track_audio_caches", fake_build)
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

    assert tighten_prepare._analyze_candidate(project, impossible, _e2e_defaults()) == CutRejected(
        "bounds"
    )


def test_summary_reports_acoustic_proposals_and_skips_separately() -> None:
    decisions = [
        _decision("a", 0.1, 0.2, "filler:um"),
        _decision("b", 0.5, 0.7, "filler:acoustic", review=True),
    ]
    assert (
        format_tighten_propose_summary(decisions, {"acoustic:breath": 2})
        == "2 proposed (1 filler, 0 pause, 1 acoustic (review), 2 acoustic skipped)"
    )
    assert format_tighten_propose_summary([], {"word_probe:unavailable": 2}) == (
        "0 proposed (0 filler, 0 pause, 2 word probe unavailable)"
    )
    assert format_tighten_propose_summary([], {"word_probe:failed": 1}) == (
        "0 proposed (0 filler, 0 pause, 1 word probe failed)"
    )
    assert format_tighten_propose_summary(
        [], {"word_probe:unavailable": 2, "word_probe:failed": 1}
    ) == ("0 proposed (0 filler, 0 pause, 2 word probe unavailable, 1 word probe failed)")


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


# --- untranscribed phrase (#1359) ----------------------------------------------


def _cadence_words(
    *, count: int = 40, duration: float = 0.14, silence: float = 0.15
) -> list[TranscriptWord]:
    words: list[TranscriptWord] = []
    at = 0.0
    for index in range(count):
        words.append(TranscriptWord(text=f"w{index}", start=at, end=at + duration))
        at += duration + silence
    return words


def _phrase_transcript(gap_sec: float = 5.6, **cadence: float) -> tuple[Transcript, float]:
    words = _cadence_words(**cadence)
    gap_start = words[-1].end
    gap_end = gap_start + gap_sec
    words.append(TranscriptWord(text="after", start=gap_end, end=gap_end + 0.2))
    return Transcript(track_id="host", words=words), gap_start


def _hits(
    total_sec: float,
    start: float,
    count: int,
    *,
    length: float = 0.2,
    silence: float = 0.12,
    amp: float = 0.2,
) -> np.ndarray:
    samples = np.zeros(int(total_sec * RATE), dtype=np.float32)
    for index in range(count):
        at = start + index * (length + silence)
        samples += _tone(total_sec, at, at + length, amp=amp)
    return samples


def _propose_in_gap(
    transcript: Transcript, samples: np.ndarray, skips: dict[str, int] | None = None
) -> list[_CutCandidate]:
    return _acoustic(
        _add_acoustic_candidates(
            [], transcript, {"tighten": {}}, audio_cache=_cache(samples), skip_counts=skips
        )
    )


@pytest.mark.parametrize("gain", [0.1, 1.0, 4.0])
@pytest.mark.parametrize("count", [3, 4])
def test_a_string_of_voiced_bursts_at_syllable_spacing_is_not_proposed(
    count: int, gain: float
) -> None:
    transcript, gap_start = _phrase_transcript()
    samples = _hits(transcript.words[-1].end + 1.0, gap_start + 1.0, count, amp=0.2 * gain)
    skips: dict[str, int] = {}

    assert _propose_in_gap(transcript, samples, skips) == []
    assert skips == {"acoustic:phrase": count}


@pytest.mark.parametrize("gain", [0.1, 1.0, 4.0])
def test_a_single_hit_in_the_same_gap_is_still_proposed(gain: float) -> None:
    transcript, gap_start = _phrase_transcript()
    samples = _hits(transcript.words[-1].end + 1.0, gap_start + 1.0, 1, amp=0.2 * gain)

    (found,) = _propose_in_gap(transcript, samples)

    assert gap_start + 0.9 <= found.start < found.end <= gap_start + 1.3


@pytest.mark.parametrize("gain", [0.1, 1.0, 4.0])
def test_two_hits_far_apart_are_each_proposed(gain: float) -> None:
    transcript, gap_start = _phrase_transcript()
    total = transcript.words[-1].end + 1.0
    samples = _hits(total, gap_start + 0.8, 1, amp=0.2 * gain)
    samples += _hits(total, gap_start + 4.0, 1, amp=0.2 * gain)

    found = _propose_in_gap(transcript, samples)

    assert len(found) == 2
    assert found[1].start - found[0].end > 2.0


@pytest.mark.parametrize("gain", [0.1, 4.0])
def test_a_pair_of_close_hits_is_two_fillers_not_a_phrase(gain: float) -> None:
    transcript, gap_start = _phrase_transcript()
    samples = _hits(transcript.words[-1].end + 1.0, gap_start + 1.0, 2, amp=0.2 * gain)

    assert len(_propose_in_gap(transcript, samples)) == 2


def test_hits_are_close_by_the_speakers_own_cadence_not_by_a_fixed_time() -> None:
    fast, fast_gap = _phrase_transcript()
    slow, slow_gap = _phrase_transcript(duration=0.3, silence=0.3)

    def string(transcript: Transcript, gap_start: float) -> np.ndarray:
        return _hits(transcript.words[-1].end + 1.0, gap_start + 1.0, 3, silence=0.25)

    assert len(_propose_in_gap(fast, string(fast, fast_gap))) == 3
    assert _propose_in_gap(slow, string(slow, slow_gap)) == []


def test_without_a_measurable_cadence_a_string_is_left_for_review() -> None:
    transcript = _two_words(0.4, 5.4)

    assert len(_propose_in_gap(transcript, _hits(6.0, 1.0, 4))) == 4


def test_a_flanking_words_voice_running_into_the_gap_is_not_part_of_a_string() -> None:
    transcript, gap_start = _phrase_transcript()
    total = transcript.words[-1].end + 1.0
    samples = _hits(total, gap_start, 3)

    found = _propose_in_gap(transcript, samples)

    assert len(found) == 3


def test_a_flanking_words_voice_running_out_of_the_gap_is_not_part_of_a_string() -> None:
    transcript, _ = _phrase_transcript()
    gap_end = transcript.words[-1].start
    total = transcript.words[-1].end + 1.0
    # Three hits at syllable spacing whose last one reaches the next word's start.
    samples = _hits(total, gap_end - 0.84, 3)

    found = _propose_in_gap(transcript, samples)

    assert len(found) == 3


def test_the_ceiling_is_the_silence_between_words_not_the_onset_step() -> None:
    # Onset steps are 0.7 s (a 0.6 s word and a 0.1 s silence); silences are 0.1 s.
    words = _cadence_words(duration=0.6, silence=0.1)

    ceiling = word_silence_ceiling(words, 0.35)

    assert ceiling is not None
    assert ceiling == pytest.approx(0.1, abs=1e-6)


def test_the_ceiling_ignores_pauses_and_needs_enough_silences() -> None:
    words = _cadence_words(count=MIN_WORD_STEPS, silence=0.1)  # one fewer silence than steps
    assert word_silence_ceiling(words, 0.35) is None
    assert word_silence_ceiling(_cadence_words(count=MIN_WORD_STEPS + 1, silence=0.1), 0.35)
    # Silences at or over the pause threshold are not counted.
    assert word_silence_ceiling(_cadence_words(count=40, silence=0.4), 0.35) is None


def test_hits_half_a_second_apart_are_not_a_phrase_at_ordinary_word_silence() -> None:
    ceiling = word_silence_ceiling(_cadence_words(duration=0.6, silence=0.1), 0.35)

    def runs(spacing: float) -> list[AcousticGapRun]:
        return [
            AcousticGapRun(start=i * (0.2 + spacing), end=i * (0.2 + spacing) + 0.2, confidence=1.0)
            for i in range(3)
        ]

    assert phrase_hit_indexes(runs(0.5), ceiling) == set()
    assert phrase_hit_indexes(runs(0.1), ceiling) == {0, 1, 2}


# --- laughs (#1365) -------------------------------------------------------------


def _laugh(
    total_sec: float, start: float, bursts: int, *, period: float = 0.2, amp: float = 0.2
) -> np.ndarray:
    """Voiced "ha ha ha": one tone whose level swells and dips ``bursts`` times, never silent."""
    length = bursts * period
    t = np.arange(int(length * RATE)) / RATE
    swell = 0.1 + 0.9 * np.sin(np.pi * t / period) ** 2
    samples = np.zeros(int(total_sec * RATE), dtype=np.float32)
    at = int(start * RATE)
    samples[at : at + t.size] = amp * swell * np.sin(2 * np.pi * 180.0 * t)
    return samples


@pytest.mark.parametrize("gain", [0.1, 1.0, 4.0])
@pytest.mark.parametrize("bursts", [3, 5])
def test_a_laugh_like_run_is_proposed_and_flagged(bursts: int, gain: float) -> None:
    transcript = _two_words(0.4, 5.4)
    skips: dict[str, int] = {}

    (found,) = _propose_in_gap(transcript, _laugh(6.0, 1.0, bursts, amp=0.2 * gain), skips)

    assert found.likely_laugh
    assert skips == {}


@pytest.mark.parametrize("gain", [0.1, 1.0, 4.0])
def test_a_held_uh_as_long_as_a_laugh_is_not_flagged(gain: float) -> None:
    transcript = _two_words(0.4, 5.4)

    (found,) = _propose_in_gap(transcript, _tone(6.0, 1.0, 2.0, amp=0.2 * gain))

    assert not found.likely_laugh


@pytest.mark.parametrize("gain", [0.1, 1.0, 4.0])
def test_two_bursts_are_a_stutter_not_a_likely_laugh(gain: float) -> None:
    transcript = _two_words(0.4, 5.4)

    (found,) = _propose_in_gap(transcript, _laugh(6.0, 1.0, 2, amp=0.2 * gain))

    assert not found.likely_laugh


def test_laugh_bursts_read_the_same_at_any_level_and_break_on_a_level_step() -> None:
    swell = np.tile(np.array([-30.0, -20.0, -12.0, -20.0, -30.0, -42.0]), 3)
    stepped = np.concatenate([swell[:12], swell[12:] + 20.0])
    for offset in (-20.0, 0.0, 12.0):
        assert has_laugh_bursts(swell + offset)
        assert not has_laugh_bursts(stepped + offset)
        assert not has_laugh_bursts(swell[:12] + offset)
    assert not has_laugh_bursts(np.full(30, -20.0))
    assert not has_laugh_bursts(np.zeros(0))


def test_a_likely_laugh_is_held_for_review_and_named_in_the_summary(
    tmp_path: Path, sample_wav: Path
) -> None:
    del sample_wav
    samples = np.random.default_rng(941).normal(0, 0.0003, 3 * RATE).astype(np.float32)
    for start, end in ((0.73, 0.78), (1.24, 1.29)):
        samples[round(start * RATE) : round(end * RATE)] *= 0.1
    samples += _tone(3.0, 0.2, 0.4) + _laugh(3.0, 0.8, 3, period=0.13) + _tone(3.0, 2.0, 2.2)
    project = _project(tmp_path, samples, _two_words().words)

    proposal = propose_tighten_edits(project, _e2e_defaults())

    (decision,) = proposal.decisions
    assert decision.reason == "filler:acoustic:likely_laugh"
    assert decision.review_required
    assert "1 acoustic (review, 1 likely laugh)" in proposal.summary()


# --- possible missed words (#1062) ----------------------------------------------


@pytest.mark.parametrize(
    ("heard", "is_word"),
    [
        ("Then...", True),
        ("I nut.", True),
        ("Here.", True),
        ("This seems-", True),
        ("Um, that, uh, that's what", True),
        ("Umm.", False),
        ("Uhh.", False),
        ("Hmm.", False),
        ("Mmm. Mmm.", False),
        ("Mm-hmm.", False),
        ("Uh-huh.", False),
        ("Mhm. Mhm.", False),
        ("Hahaha.", False),
        ("Ha ha ha ha.", False),
        ("Heh heh heh.", False),
        ("", False),
    ],
)
def test_a_word_is_told_from_a_hesitation_laugh_or_backchannel(heard: str, is_word: bool) -> None:
    assert heard_a_word(heard) is is_word


def _planted_probe(monkeypatch: pytest.MonkeyPatch, heard: str, calls: list[tuple[int, str]]):
    def transcriber(defaults: dict) -> object:
        def transcribe(samples: np.ndarray, language: str | None) -> str:
            calls.append((samples.size, str(language)))
            return heard

        return transcribe

    monkeypatch.setattr("podcast_mcp.edits.tighten.propose.whisper_span_transcriber", transcriber)


def _acoustic_project(tmp_path: Path) -> EpisodeProject:
    return _project(tmp_path, _acoustic_dialogue_samples(), _two_words().words)


def test_a_span_the_model_hears_as_a_word_is_flagged_held_and_named_in_the_summary(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del sample_wav
    calls: list[tuple[int, str]] = []
    _planted_probe(monkeypatch, "Then...", calls)

    proposal = propose_tighten_edits(_acoustic_project(tmp_path), _e2e_defaults())

    (decision,) = proposal.decisions
    assert decision.reason == "filler:acoustic:possible_word"
    assert decision.review_required
    assert "1 acoustic (review, 1 possible missed word)" in proposal.summary()
    (samples, language) = calls[0]
    assert language == "en"
    assert samples == round((decision.end - decision.start + 0.6) * RATE)


def test_a_span_the_model_hears_as_a_hesitation_is_proposed_unflagged(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del sample_wav
    _planted_probe(monkeypatch, "Umm.", [])

    proposal = propose_tighten_edits(_acoustic_project(tmp_path), _e2e_defaults())

    (decision,) = proposal.decisions
    assert decision.reason == "filler:acoustic"
    assert "1 acoustic (review)" in proposal.summary()


def test_a_laugh_the_model_hears_as_a_word_carries_both_flags_and_reads_as_a_word(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del sample_wav
    _planted_probe(monkeypatch, "This seems-", [])
    samples = np.random.default_rng(941).normal(0, 0.0003, 3 * RATE).astype(np.float32)
    for start, end in ((0.73, 0.78), (1.24, 1.29)):
        samples[round(start * RATE) : round(end * RATE)] *= 0.1
    samples += _tone(3.0, 0.2, 0.4) + _laugh(3.0, 0.8, 3, period=0.13) + _tone(3.0, 2.0, 2.2)

    project = _project(tmp_path, samples, _two_words().words)
    proposal = propose_tighten_edits(project, _e2e_defaults())

    (decision,) = proposal.decisions
    assert decision.reason == "filler:acoustic:likely_laugh:possible_word"
    assert is_possible_word_reason(decision.reason)
    assert is_likely_laugh_reason(decision.reason)
    assert "1 acoustic (review, 1 likely laugh, 1 possible missed word)" in proposal.summary()


def test_without_the_probe_setting_nothing_is_heard(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del sample_wav
    calls: list[tuple[int, str]] = []
    _planted_probe(monkeypatch, "Then...", calls)
    defaults = _e2e_defaults(acoustic_gap_filler={"word_probe": False})

    proposal = propose_tighten_edits(_acoustic_project(tmp_path), defaults)

    assert [d.reason for d in proposal.decisions] == ["filler:acoustic"]
    assert calls == []


@pytest.mark.parametrize("gone", ["loader", "gate"])
def test_a_missing_model_leaves_the_proposal_unflagged_and_counts_it(
    tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch, gone: str
) -> None:
    del sample_wav
    error: Exception = (
        WhisperWeightsMissingError("large-v3-turbo")
        if gone == "loader"
        else ModelMissing(
            id="whisper",
            model="large-v3-turbo",
            label="Whisper speech model",
            purpose="transcription",
            size="~1.6 GB",
            size_bytes=None,
            command="podcast bootstrap --component whisper",
            state="missing",
        )
    )

    def missing(defaults: dict) -> object:
        raise error

    monkeypatch.setattr("podcast_mcp.edits.tighten.propose.whisper_span_transcriber", missing)

    proposal = propose_tighten_edits(_acoustic_project(tmp_path), _e2e_defaults())

    assert [d.reason for d in proposal.decisions] == ["filler:acoustic"]
    assert proposal.skip_counts["word_probe:unavailable"] == 1


class _FlatCache:
    waveform = SimpleNamespace(sample_rate=RATE)

    def window(self, start: float, end: float) -> np.ndarray:
        return np.ones(round((end - start) * RATE))


def _mixed_run() -> list[EditDecision]:
    return [
        _decision("a", 1.0, 1.5, "filler:acoustic", review=True),
        _decision("b", 2.0, 2.4, "filler:um"),
        _decision("c", 3.0, 3.3, "pause:trim"),
        _decision("d", 4.0, 4.2, "filler:acoustic:risky", review=True),
    ]


@pytest.mark.parametrize("fails_at", ["load", "first decode"])
def test_a_missing_model_counts_only_the_acoustic_proposals_of_a_mixed_run(
    monkeypatch: pytest.MonkeyPatch, fails_at: str
) -> None:
    def transcriber(defaults: dict) -> object:
        if fails_at == "load":
            raise WhisperWeightsMissingError("large-v3-turbo")

        def transcribe(samples: np.ndarray, language: str | None) -> str:
            raise WhisperWeightsMissingError("large-v3-turbo")

        return transcribe

    monkeypatch.setattr("podcast_mcp.edits.tighten.propose.whisper_span_transcriber", transcriber)
    decisions = _mixed_run()
    skip_counts: dict[str, int] = {}

    _flag_possible_words(
        EpisodeProject.model_construct(),
        {},
        decisions,
        {"host": _FlatCache()},
        skip_counts,
    )

    assert skip_counts == {"word_probe:unavailable": 2}
    assert [d.reason for d in decisions] == [
        "filler:acoustic",
        "filler:um",
        "pause:trim",
        "filler:acoustic:risky",
    ]


def test_a_missing_model_on_first_decode_fails_the_probe_child_short_of_total(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def transcriber(defaults: dict) -> object:
        def transcribe(samples: np.ndarray, language: str | None) -> str:
            raise WhisperWeightsMissingError("large-v3-turbo")

        return transcribe

    monkeypatch.setattr("podcast_mcp.edits.tighten.propose.whisper_span_transcriber", transcriber)
    rec = RecordingProgress()
    decisions = _mixed_run()
    skip_counts: dict[str, int] = {}

    with bind_progress(rec), progress_task("propose-edits", "Propose", reporter=rec):
        _flag_possible_words(
            EpisodeProject.model_construct(),
            {},
            decisions,
            {"host": _FlatCache()},
            skip_counts,
        )

    assert skip_counts == {"word_probe:unavailable": 2}
    child = [e for e in rec.events if e.task_id == "word-probe"]
    assert any(e.kind == "start" and e.current == 0 and e.total == 2 for e in child)
    assert any(e.kind == "fail" for e in child)
    assert not any(e.kind == "end" for e in child)
    assert not any(e.kind == "update" and e.current is not None and e.current >= 2 for e in child)
    assert not any(e.task_id == "propose-edits" and e.kind == "fail" for e in rec.events)


def test_a_decode_error_on_one_span_keeps_earlier_flags_and_counts_the_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    heard: list[int] = []

    def transcriber(defaults: dict) -> object:
        def transcribe(samples: np.ndarray, language: str | None) -> str:
            heard.append(1)
            if len(heard) == 2:
                raise RuntimeError("cuda OOM")
            return "Then..."

        return transcribe

    monkeypatch.setattr("podcast_mcp.edits.tighten.propose.whisper_span_transcriber", transcriber)
    decisions = _mixed_run()
    skip_counts: dict[str, int] = {}

    _flag_possible_words(
        EpisodeProject.model_construct(),
        {},
        decisions,
        {"host": _FlatCache()},
        skip_counts,
    )

    assert heard == [1, 1]
    assert skip_counts == {"word_probe:failed": 1}
    assert [d.reason for d in decisions] == [
        "filler:acoustic:possible_word",
        "filler:um",
        "pause:trim",
        "filler:acoustic:risky",
    ]


def test_the_probe_advances_a_named_child_once_per_heard_span() -> None:
    rec = RecordingProgress()
    decisions = [
        _decision("a", 1.0, 1.5, "filler:acoustic", review=True),
        _decision("b", 2.0, 2.4, "filler:um"),
        _decision("d", 4.0, 4.2, "filler:acoustic:risky", review=True),
    ]

    with (
        bind_progress(rec),
        progress_task("propose-edits", "Propose", total=1, reporter=rec) as wrap,
    ):
        flagged = flag_possible_words(
            decisions,
            lambda track, start, end: np.ones(round((end - start) * RATE)),
            lambda samples, language: "Umm.",
            {},
        )
        assert wrap.total == 1
        assert wrap.current == 0

    assert flagged == 0
    child = [e for e in rec.events if e.task_id == "word-probe"]
    assert any(e.kind == "start" and e.total == 2 for e in child)
    assert any(e.kind == "update" and e.current == 2 and e.total == 2 for e in child)
    assert any(e.kind == "end" for e in child)
    assert not any(e.task_id == "propose-edits" and e.kind == "update" for e in rec.events)


def test_cancel_stops_the_probe_after_the_span_already_heard() -> None:
    heard: list[int] = []

    def transcribe(samples: np.ndarray, language: str | None) -> str:
        heard.append(1)
        return "Then..."

    decisions = [
        _decision("a", 1.0, 1.5, "filler:acoustic", review=True),
        _decision("d", 4.0, 4.2, "filler:acoustic:risky", review=True),
    ]
    with pytest.raises(CancelledProgress):
        with render_cancel_scope(lambda: len(heard) >= 1):
            flag_possible_words(
                decisions,
                lambda track, start, end: np.ones(round((end - start) * RATE)),
                transcribe,
                {},
            )

    assert heard == [1]
    assert [d.reason for d in decisions] == [
        "filler:acoustic:possible_word",
        "filler:acoustic:risky",
    ]


def test_only_acoustic_decisions_are_heard_and_a_flagged_one_is_not_flagged_twice() -> None:
    heard: list[float] = []

    def transcribe(samples: np.ndarray, language: str | None) -> str:
        heard.append(samples.size / RATE)
        return "Great."

    decisions = [
        _decision("a", 1.0, 1.5, "filler:acoustic", review=True),
        _decision("b", 2.0, 2.4, "filler:um"),
        _decision("c", 3.0, 3.3, "filler:acoustic:possible_word", review=True),
        _decision("d", 4.0, 4.2, "filler:acoustic:risky", review=True),
    ]

    flagged = flag_possible_words(
        decisions, lambda track, start, end: np.ones(round((end - start) * RATE)), transcribe, {}
    )

    assert flagged == 2
    assert [d.reason for d in decisions] == [
        "filler:acoustic:possible_word",
        "filler:um",
        "filler:acoustic:possible_word",
        "filler:acoustic:risky:possible_word",
    ]
    assert heard == pytest.approx([1.1, 0.8])


def test_the_engine_hands_the_model_only_the_samples_it_was_given() -> None:
    seen: dict[str, object] = {}

    class _Segment:
        text = " Then. "
        compression_ratio = 0.5

    class _Model:
        def transcribe(self, audio: np.ndarray, **kwargs: object):
            seen.update(kwargs, dtype=audio.dtype, size=audio.size)
            return iter([_Segment()]), None

    engine = TranscriptionEngine(model_size="base", defaults=load_defaults())
    engine._model = _Model()

    text = engine.transcribe_samples(np.zeros(1600), language="en", initial_prompt="Umm.")

    assert text == "Then."
    assert seen == {
        "language": "en",
        "initial_prompt": "Umm.",
        "vad_filter": False,
        "condition_on_previous_text": False,
        "temperature": 0.0,
        "max_new_tokens": 32,
        "dtype": np.dtype("float32"),
        "size": 1600,
    }


def test_a_looping_probe_decode_is_retried_with_a_repetition_penalty_and_that_is_kept() -> None:
    calls: list[dict[str, object]] = []

    def segment(text: str, ratio: float) -> SimpleNamespace:
        return SimpleNamespace(text=text, compression_ratio=ratio)

    class _Model:
        def transcribe(self, audio: np.ndarray, **kwargs: object):
            calls.append(kwargs)
            if "repetition_penalty" in kwargs:
                return iter([segment(" Um, uh, hmm. ", 0.6)]), None
            return iter([segment(" Uh, uh, uh, uh, uh, uh, uh, uh. ", 26.0)]), None

    engine = TranscriptionEngine(model_size="base", defaults=load_defaults())
    engine._model = _Model()

    assert engine.transcribe_samples(np.zeros(1600), language="en") == "Um, uh, hmm."
    assert len(calls) == 2
    assert calls[1]["repetition_penalty"] == 1.3
    assert calls[1]["temperature"] == 0.0
    assert calls[1]["max_new_tokens"] == 32


def test_a_probe_decode_that_does_not_loop_is_decoded_once() -> None:
    calls: list[dict[str, object]] = []

    class _Model:
        def transcribe(self, audio: np.ndarray, **kwargs: object):
            calls.append(kwargs)
            return iter([SimpleNamespace(text=" Okay. ", compression_ratio=2.4)]), None

    engine = TranscriptionEngine(model_size="base", defaults=load_defaults())
    engine._model = _Model()

    assert engine.transcribe_samples(np.zeros(1600), language="en") == "Okay."
    assert len(calls) == 1


def test_an_empty_probe_decode_returns_empty_text_without_a_retry() -> None:
    calls: list[dict[str, object]] = []

    class _Model:
        def transcribe(self, audio: np.ndarray, **kwargs: object):
            calls.append(kwargs)
            return iter([]), None

    engine = TranscriptionEngine(model_size="base", defaults=load_defaults())
    engine._model = _Model()

    assert engine.transcribe_samples(np.zeros(1600), language="en") == ""
    assert len(calls) == 1


def test_a_still_looping_probe_retry_is_kept_without_a_third_decode() -> None:
    calls: list[dict[str, object]] = []

    class _Model:
        def transcribe(self, audio: np.ndarray, **kwargs: object):
            calls.append(kwargs)
            if len(calls) > 2:
                pytest.fail("The word probe decoded more than twice")
            text = " First looping text. " if len(calls) == 1 else " Second looping text. "
            return iter([SimpleNamespace(text=text, compression_ratio=26.0)]), None

    engine = TranscriptionEngine(model_size="base", defaults=load_defaults())
    engine._model = _Model()

    assert engine.transcribe_samples(np.zeros(1600), language="en") == "Second looping text."
    assert len(calls) == 2
    assert calls[1]["repetition_penalty"] == 1.3


def test_the_word_probe_factory_pins_its_cpu_threads() -> None:
    with patch("podcast_mcp.engines.transcribe.TranscriptionEngine") as factory:
        whisper_span_transcriber(load_defaults())

    assert factory.call_count == 1
    assert factory.call_args.kwargs["cpu_threads"] == 4


def test_the_word_probe_engine_pins_its_cpu_threads() -> None:
    seen: dict[str, object] = {}

    def factory(path: str, **kwargs: object) -> object:
        seen.update(kwargs)
        return object()

    placement = WhisperPlacement("cpu", "int8")
    pinned = TranscriptionEngine(model_size="base", defaults=load_defaults(), cpu_threads=4)
    pinned._load_model(factory, "m", placement)
    assert seen["cpu_threads"] == 4

    seen.clear()
    TranscriptionEngine(model_size="base", defaults=load_defaults())._load_model(
        factory, "m", placement
    )
    assert "cpu_threads" not in seen


def test_burst_count_is_one_for_a_hum_and_counts_each_pulse_at_any_level() -> None:
    hum = np.array([-40.0, -20.0, -12.0, -12.0, -14.0, -22.0, -30.0])
    two_syllables = np.array([-40.0, -12.0, -12.0, -22.0, -30.0, -22.0, -12.0, -12.0, -30.0])
    for offset in (-20.0, 0.0, 12.0):
        assert burst_count(hum + offset) == 1
        assert burst_count(two_syllables + offset) == 2
    assert burst_count(np.zeros(0)) == 0
