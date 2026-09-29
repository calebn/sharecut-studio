from __future__ import annotations

from unittest.mock import patch

import pytest

from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.filler_pacing import FillerPacingResult
from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate
from podcast_mcp.engines.audio_audit import TrackRmsCache
from test_breath_detect import _fake_windows, _host_project, _shaped_noise
from test_fillers import _passthrough_opt, _safe_risk


def _cache() -> TrackAudioCache:
    samples = _fake_windows(placed=((_shaped_noise(3840, 0.026), 5.1),))(None, 0, 10.2)
    return TrackAudioCache(
        jump=TrackRmsCache(samples[::2], sample_rate=8000),
        waveform=TrackRmsCache(samples, sample_rate=16000),
    )


def _cache_with_breaths(*breaths: tuple[float, float, float]) -> TrackAudioCache:
    from test_breath_detect import _fake_windows

    placed = tuple(
        (_shaped_noise(round((end - start) * 16000), level), start) for start, end, level in breaths
    )
    samples = _fake_windows(placed=placed)(None, 0, 10.2)
    return TrackAudioCache(
        jump=TrackRmsCache(samples[::2], sample_rate=8000),
        waveform=TrackRmsCache(samples, sample_rate=16000),
    )


class _BreathFixtureVad:
    WINDOW_SAMPLES = 512
    SAMPLE_RATE = 16000

    def speech_probs(self, samples):
        import numpy as np

        frames = samples[: samples.size - samples.size % self.WINDOW_SAMPLES].reshape(
            -1, self.WINDOW_SAMPLES
        )
        rms = np.sqrt(np.mean(frames**2, axis=1))
        return np.where((rms > 0.006) & (rms < 0.09), 0.2, 0.9).astype(np.float32)


def _proposal(cache: TrackAudioCache, cut_end: float, backend: str):
    candidate = _CutCandidate(
        track_id="host",
        start=4.9,
        end=5.5,
        reason="pause:candidate",
        cut_kind="pause",
        max_end=cut_end,
    )
    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            return_value=(_passthrough_opt(4.9, 5.5), _safe_risk()),
        ),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=FillerPacingResult(4.9, cut_end),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=("session", None),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", return_value=_safe_risk()),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=20),
        patch(
            "podcast_mcp.engines.vad_silero.get_shared_vad",
            return_value=_BreathFixtureVad(),
        ),
    ):
        return _analyze_candidate(
            _host_project(),
            candidate,
            {"tighten": {"breath_handling": {"vad_backend": backend}}},
            audio_cache=cache,
        )


@pytest.mark.parametrize("adjustment", ["max_end", "pacing"])
@pytest.mark.parametrize("kind", ["pause", "filler"])
def test_final_cut_end_retreats_to_retained_breath_onset(adjustment: str, kind: str) -> None:
    candidate = _CutCandidate(
        track_id="host",
        start=5.0,
        end=5.5,
        reason=f"{kind}:candidate",
        cut_kind=kind,
        max_end=5.2 if adjustment == "max_end" else None,
    )
    measured = []

    def assess(project, track_id, start, end, **kwargs):
        measured.append((start, end))
        return _safe_risk()

    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            return_value=(_passthrough_opt(5.0, 5.5), _safe_risk()),
        ),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=FillerPacingResult(5.0, 5.5 if adjustment == "max_end" else 5.2),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=("session", None),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", side_effect=assess),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=20),
    ):
        result = _analyze_candidate(
            _host_project(), candidate, {"tighten": {}}, audio_cache=_cache()
        )

    assert result is not None
    assert (result.start, result.end) == pytest.approx((5.0, 5.1))
    assert measured == [(5.0, pytest.approx(5.1))]
    assert result.crossfade_ms == 20


@pytest.mark.parametrize("start", [5.0, 5.15])
def test_retreat_that_removes_entire_cut_skips_proposal(start: float) -> None:
    candidate = _CutCandidate("host", start, 5.2, "pause:0.9s", "pause", max_end=5.2)
    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            return_value=(_passthrough_opt(start, 5.2), _safe_risk()),
        ),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=FillerPacingResult(start, 5.2),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=("session", None),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", return_value=_safe_risk()),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=20),
    ):
        result = _analyze_candidate(
            _host_project(), candidate, {"tighten": {}}, audio_cache=_cache()
        )

    if start > 5.1:
        assert result is None
    else:
        assert result is not None
        assert (result.start, result.end) == pytest.approx((5.0, 5.1))


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
@pytest.mark.parametrize("cut_end", [5.05, 5.12])
def test_final_cut_end_inside_quiet_breath_onset_retreats_to_onset(
    backend: str, cut_end: float
) -> None:
    result = _proposal(
        _cache_with_breaths((5.0, 5.12, 0.0008), (5.12, 5.26, 0.026)),
        cut_end,
        backend,
    )

    assert result is not None
    assert (result.start, result.end) == pytest.approx((4.9, 5.0))


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
def test_final_crossing_search_continues_after_earlier_non_crossing_run(backend: str) -> None:
    cache = _cache_with_breaths(
        (4.75, 4.9, 0.026),
        (5.0, 5.12, 0.0008),
        (5.12, 5.26, 0.026),
    )

    result = _proposal(cache, 5.15, backend)

    assert result is not None
    assert (result.start, result.end) == pytest.approx((4.9, 5.0))


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
def test_final_crossing_does_not_retreat_when_quiet_onset_cannot_be_refined(
    backend: str,
) -> None:
    from test_breath_detect import _harmonic_tone

    cache = _cache_with_breaths(
        (5.0, 5.12, 0.0008),
        (5.12, 5.26, 0.026),
    )
    # The quiet onset is voiced speech and must fail the shared refinement gate.
    samples = cache.waveform.samples
    samples[round(5.0 * 16000) : round(5.12 * 16000)] = _harmonic_tone(1920, 0.0008)

    result = _proposal(cache, 5.15, backend)

    assert result is not None
    assert result.end == pytest.approx(5.15)
