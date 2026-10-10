from __future__ import annotations

from unittest.mock import patch

import pytest

from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.filler_pacing import FillerPacingResult
from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate, _CutRejected
from podcast_mcp.edits.speech_energy_guard import ResolvedCutScope
from podcast_mcp.engines.audio_audit import TrackRmsCache
from test_breath_detect import (
    _EDGE_TOL,
    _fake_windows,
    _fixture_words,
    _host_project,
    _shaped_noise,
)
from test_fillers import _passthrough_opt, _safe_risk

# A pause trim ends well before the floor of air its next word keeps in a real proposal; these
# tests pace theirs to the word itself, so they take the floor away and the trim is measured alone.
_NO_FLOOR = {"min_retained_pause_sec": 0.0, "min_retained_solo_pause_sec": 0.0}


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


def _proposal(
    tmp_path, cache: TrackAudioCache, cut_end: float, backend: str, *, cut_start: float = 4.3
):
    candidate = _CutCandidate(
        track_id="host",
        start=cut_start,
        end=5.5,
        reason="pause:candidate",
        cut_kind="pause",
        max_end=cut_end,
    )
    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            return_value=(_passthrough_opt(cut_start, 5.5), _safe_risk()),
        ),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=FillerPacingResult(cut_start, cut_end),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=ResolvedCutScope("session_clear", None),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", return_value=_safe_risk()),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=20),
        patch(
            "podcast_mcp.engines.vad_silero.get_shared_vad",
            return_value=_BreathFixtureVad(),
        ),
    ):
        return _analyze_candidate(
            _project_with_wav(tmp_path, cache),
            candidate,
            {"tighten": {**_NO_FLOOR, "breath_handling": {"vad_backend": backend}}},
            audio_cache=cache,
        )


def _splice_proposal(cache: TrackAudioCache, cut_end: float, backend: str):
    """A filler cut ``_analyze_candidate`` splices with no pad, whose pacing runs to
    ``cut_end``: the edge checks of a splice, breath protection among them, read the real
    audio of ``cache``."""
    candidate = _CutCandidate(
        track_id="host", start=4.9, end=5.05, reason="filler:candidate", cut_kind="filler"
    )
    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            return_value=(_passthrough_opt(4.9, cut_end), _safe_risk()),
        ),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=FillerPacingResult(4.9, cut_end),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=ResolvedCutScope("session_clear", None),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", return_value=_safe_risk()),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=20),
        patch(
            "podcast_mcp.engines.vad_silero.get_shared_vad",
            return_value=_BreathFixtureVad(),
        ),
    ):
        return _analyze_candidate(
            _host_project(_fixture_words()),
            candidate,
            {"tighten": {"breath_handling": {"vad_backend": backend}}},
            audio_cache=cache,
        )


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
@pytest.mark.parametrize("cut_end", [5.05, 5.12])
def test_a_splice_cut_end_inside_a_quiet_breath_onset_retreats_to_the_onset(
    backend: str, cut_end: float
) -> None:
    result = _splice_proposal(
        _cache_with_breaths((5.0, 5.12, 0.0008), (5.12, 5.26, 0.026)), cut_end, backend
    )

    assert not isinstance(result, _CutRejected)
    assert (result.start, result.end) == pytest.approx((4.9, 5.0))


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
def test_a_splice_cut_through_a_quiet_voiced_onset_is_rejected_as_breath(backend: str) -> None:
    from test_breath_detect import _harmonic_tone

    cache = _cache_with_breaths((5.0, 5.12, 0.0008), (5.12, 5.26, 0.026))
    # The quiet onset is voiced speech and must fail the shared refinement gate: a splice
    # cannot move off it, so the cut is dropped. A pause trim ends before it instead.
    samples = cache.waveform.samples
    samples[round(5.0 * 16000) : round(5.12 * 16000)] = _harmonic_tone(1920, 0.0008)

    assert _splice_proposal(cache, 5.15, backend) == _CutRejected("breath")


@pytest.mark.parametrize("peak", [0.55, 0.60])
def test_a_splice_cut_through_connected_protected_activity_is_rejected_as_breath(
    peak: float,
) -> None:
    import numpy as np

    cache = _cache_with_breaths((5.0, 5.12, 0.0008), (5.12, 5.26, 0.026))
    with patch(
        "podcast_mcp.edits.breath_detect.voicing_probes",
        side_effect=lambda samples, rate, **kw: np.full(
            max(1, (samples.size - min(samples.size, 640)) // 160 + 1), peak
        ),
    ):
        assert _splice_proposal(cache, 5.15, "heuristic") == _CutRejected("breath")


@pytest.mark.parametrize("adjustment", ["max_end", "pacing"])
@pytest.mark.parametrize("kind", ["pause", "filler"])
def test_final_cut_end_retreats_to_retained_breath_onset(
    tmp_path, adjustment: str, kind: str
) -> None:
    candidate = _CutCandidate(
        track_id="host",
        start=4.3 if kind == "pause" else 5.0,
        end=5.5,
        reason=f"{kind}:candidate",
        cut_kind=kind,
        max_end=5.2 if adjustment == "max_end" else None,
    )
    measured = []
    start = candidate.start
    cache = _cache()
    project = _project_with_wav(tmp_path, cache)

    def assess(project, track_id, start, end, **kwargs):
        measured.append((start, end))
        return _safe_risk()

    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            return_value=(_passthrough_opt(start, 5.5), _safe_risk()),
        ),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=FillerPacingResult(start, 5.5 if adjustment == "max_end" else 5.2),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=ResolvedCutScope("session_clear", None),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", side_effect=assess),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=20),
    ):
        result = _analyze_candidate(project, candidate, {"tighten": _NO_FLOOR}, audio_cache=cache)

    if kind == "filler":
        assert result == _CutRejected("reparandum")
        return
    assert not isinstance(result, _CutRejected)
    # The breath at 5.1 stays whole: the trim ends 30 ms before it.
    assert (result.start, result.end) == pytest.approx((4.3, 5.07), abs=_EDGE_TOL)
    assert measured == [pytest.approx((4.3, 5.07), abs=_EDGE_TOL)]
    assert result.crossfade_ms == 20


@pytest.mark.parametrize("start", [4.3, 5.15])
def test_retreat_that_removes_entire_cut_skips_proposal(tmp_path, start: float) -> None:
    candidate = _CutCandidate("host", 4.3, 5.45, "pause:0.9s", "pause", max_end=5.2)
    cache = _cache()
    project = _project_with_wav(tmp_path, cache)
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
            return_value=ResolvedCutScope("session_clear", None),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", return_value=_safe_risk()),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=20),
    ):
        result = _analyze_candidate(project, candidate, {"tighten": _NO_FLOOR}, audio_cache=cache)

    if start > 5.1:
        assert result == _CutRejected("no_air")
    else:
        assert not isinstance(result, _CutRejected)
        assert (result.start, result.end) == pytest.approx((4.3, 5.07), abs=_EDGE_TOL)


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
@pytest.mark.parametrize("cut_end", [5.05, 5.12])
def test_final_cut_end_inside_quiet_breath_onset_retreats_to_onset(
    tmp_path, backend: str, cut_end: float
) -> None:
    result = _proposal(
        tmp_path,
        _cache_with_breaths((5.0, 5.12, 0.0008), (5.12, 5.26, 0.026)),
        cut_end,
        backend,
    )

    assert not isinstance(result, _CutRejected)
    assert (result.start, result.end) == pytest.approx((4.3, 4.97), abs=_EDGE_TOL)


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
def test_final_crossing_search_continues_after_earlier_non_crossing_run(
    tmp_path, backend: str
) -> None:
    cache = _cache_with_breaths(
        (4.45, 4.6, 0.026),
        (5.0, 5.12, 0.0008),
        (5.12, 5.26, 0.026),
    )

    result = _proposal(tmp_path, cache, 5.15, backend, cut_start=4.6)

    assert not isinstance(result, _CutRejected)
    assert (result.start, result.end) == pytest.approx((4.63, 4.97), abs=_EDGE_TOL)


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
def test_a_pause_trim_ends_before_a_quiet_onset_that_cannot_be_refined(
    tmp_path,
    backend: str,
) -> None:
    from test_breath_detect import _harmonic_tone

    cache = _cache_with_breaths(
        (5.0, 5.12, 0.0008),
        (5.12, 5.26, 0.026),
    )
    # The quiet onset is voiced speech and must fail the shared refinement gate. A
    # splice would be suppressed; a pause trim removes only air, so it ends where the
    # sound starts and keeps it whole (#1055).
    samples = cache.waveform.samples
    samples[round(5.0 * 16000) : round(5.12 * 16000)] = _harmonic_tone(1920, 0.0008)

    result = _proposal(tmp_path, cache, 5.15, backend)

    assert not isinstance(result, _CutRejected)
    assert (result.start, result.end) == pytest.approx((4.3, 4.97), abs=_EDGE_TOL)


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
@pytest.mark.parametrize("edge", [5.20, 5.30])
def test_final_start_retains_complete_quiet_tail(backend: str, edge: float) -> None:
    from podcast_mcp.edits import breath_detect

    cache = _cache_with_breaths((5.0, 5.10, 0.0008), (5.10, 5.24, 0.026), (5.24, 5.36, 0.0008))
    with patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=_BreathFixtureVad()):
        result = breath_detect.protect_cut_breaths(
            _host_project(_fixture_words()),
            "host",
            edge,
            5.40,
            defaults={"tighten": {"breath_handling": {"vad_backend": backend}}},
            audio_cache=cache,
        )
    assert result == pytest.approx((5.36, 5.40))


@pytest.mark.parametrize("peak", [0.55, 0.60])
def test_a_pause_trim_ends_before_connected_protected_activity(tmp_path, peak: float) -> None:
    import numpy as np

    cache = _cache_with_breaths((5.0, 5.12, 0.0008), (5.12, 5.26, 0.026))
    with patch(
        "podcast_mcp.edits.breath_detect.voicing_probes",
        side_effect=lambda samples, rate, **kw: np.full(
            max(1, (samples.size - min(samples.size, 640)) // 160 + 1), peak
        ),
    ):
        result = _proposal(tmp_path, cache, 5.15, "heuristic")

    assert not isinstance(result, _CutRejected)
    assert (result.start, result.end) == pytest.approx((4.3, 4.97), abs=_EDGE_TOL)


def test_a_peers_onset_at_a_ripple_edge_shrinks_the_pause_trim_and_labels_it(tmp_path) -> None:
    # A session ripple cuts the guest too. The gated guest's 50 ms burst at 5.25 (a
    # gate opening on a word's attack, too short for the voiced-run check) starts
    # inside the trim's end, so the trim ends before it and is flagged for review.
    from test_breath_detect import _dbfs, _with_guest

    guest = TrackAudioCache(
        jump=TrackRmsCache(_fake_windows(gap_floor=0.0)(None, 0, 10.2)[::2], sample_rate=8000),
        waveform=TrackRmsCache(
            _fake_windows(gap_floor=0.0, placed=((_shaped_noise(800, _dbfs(-20.0)), 5.25),))(
                None, 0, 10.2
            ),
            sample_rate=16000,
        ),
    )
    host = _cache_with_breaths()
    project = _with_guest(_project_with_wav(tmp_path, host))
    peer = _project_with_wav(tmp_path / "guest", guest)
    project.track_by_id("guest").media = peer.tracks[0].media.model_copy(deep=True)
    project.track_by_id("guest").media.path = "guest/host.wav"
    project.clips[1].source_end = 10.2
    candidate = _CutCandidate("host", 4.3, 5.45, "pause:1.15s", "pause", max_end=5.3)
    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            return_value=(_passthrough_opt(4.9, 5.3), _safe_risk()),
        ),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=FillerPacingResult(4.9, 5.3),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=ResolvedCutScope("session_clear", None),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", return_value=_safe_risk()),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=20),
    ):
        result = _analyze_candidate(
            project,
            candidate,
            {"tighten": _NO_FLOOR},
            audio_cache=host,
            audio_caches={"host": host, "guest": guest},
        )

    assert not isinstance(result, _CutRejected)
    assert (result.start, result.end, result.reason, result.review_required) == (
        pytest.approx(4.9),
        pytest.approx(5.22),
        "pause:1.15s:air_edges",
        False,
    )


@pytest.mark.parametrize("walk", ["between_kept_voices", "voiced"])
def test_pause_air_labels_its_own_move_and_holds_an_unsettled_voice_edge(
    tmp_path,
    walk: str,
) -> None:
    from dataclasses import replace

    from podcast_mcp.edits.fillers import _VoicedSpeechCheck

    cache = _cache_with_breaths()
    project = _project_with_wav(tmp_path, cache)
    candidate = _CutCandidate("host", 4.90, 5.40, "pause:candidate", "pause")

    def propose(walk_start: float):
        def between(project, plan, candidate, **kw):
            return replace(plan, start=walk_start) if walk == "between_kept_voices" else plan

        def voiced_check(candidate, start, end, **kw):
            return _VoicedSpeechCheck(walk_start if walk == "voiced" else start, end, None)

        with (
            patch("podcast_mcp.edits.fillers._between_kept_voices", side_effect=between),
            patch(
                "podcast_mcp.edits.fillers.optimize_and_assess",
                return_value=(_passthrough_opt(4.90, 5.40), _safe_risk()),
            ),
            patch(
                "podcast_mcp.edits.fillers.apply_filler_pacing",
                return_value=FillerPacingResult(4.90, 5.40),
            ),
            patch("podcast_mcp.edits.fillers._check_voiced_speech", side_effect=voiced_check),
            patch(
                "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
                return_value=ResolvedCutScope("session_clear", None),
            ),
            patch("podcast_mcp.edits.fillers.assess_cut_risk", return_value=_safe_risk()),
            patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=20),
        ):
            result = _analyze_candidate(
                project,
                candidate,
                {"tighten": _NO_FLOOR},
                audio_cache=cache,
            )
        return result

    unmoved, walked = propose(4.90), propose(5.00)

    assert not isinstance(unmoved, _CutRejected)
    assert (unmoved.start, unmoved.end) == pytest.approx((4.90, 5.40))
    assert (unmoved.reason, unmoved.review_required) == ("pause:candidate", False)
    if walk == "voiced":
        assert walked == _CutRejected("unsettled_edges")
        assert project.editorial.edit_log == []
        assert project.edit_decisions == []
        assert [(c.source_start, c.source_end) for c in project.clips] == [(0.0, 10.2)]
        return
    assert not isinstance(walked, _CutRejected)
    assert (walked.start, walked.end) == pytest.approx((5.00, 5.40))
    assert (walked.reason, walked.review_required) == ("pause:candidate", False)


@pytest.mark.parametrize("adjustment", ["min_start", "pacing", "voiced"])
def test_a_pause_mover_into_a_quiet_tail_is_too_short_or_unsettled(
    adjustment: str,
) -> None:
    from podcast_mcp.edits.fillers import _VoicedSpeechCheck

    cache = _cache_with_breaths((5.0, 5.10, 0.0008), (5.10, 5.24, 0.026), (5.24, 5.36, 0.0008))
    candidate = _CutCandidate(
        "host",
        4.90,
        5.40,
        "pause:candidate",
        "pause",
        min_start=5.30 if adjustment == "min_start" else None,
    )

    def voiced_check(candidate, start, end, **kw):
        if adjustment == "voiced" and start == 4.90:
            start = 5.30
        return _VoicedSpeechCheck(start, end, None)

    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            return_value=(_passthrough_opt(4.90, 5.40), _safe_risk()),
        ),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=FillerPacingResult(5.30 if adjustment == "pacing" else 4.90, 5.40),
        ),
        patch(
            "podcast_mcp.edits.fillers._check_voiced_speech",
            side_effect=voiced_check,
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=ResolvedCutScope("session_clear", None),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", return_value=_safe_risk()),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=20),
    ):
        result = _analyze_candidate(
            _host_project(_fixture_words()), candidate, {"tighten": _NO_FLOOR}, audio_cache=cache
        )
    # The breath and its quiet tail stay whole, and the 10 ms of air left after them is
    # under the shortest cut: a pause trim is not made of what a splice would have kept.
    assert result == _CutRejected("unsettled_edges" if adjustment == "voiced" else "too_short")


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
@pytest.mark.parametrize(
    "bounds, expected",
    [
        ((4.90, 5.05), (4.90, 5.00)),
        ((4.90, 5.00), (4.90, 5.00)),
        ((5.36, 5.40), (5.36, 5.40)),
        ((5.00, 5.36), (5.00, 5.36)),
        ((5.12, 5.20), None),
    ],
)
def test_complete_breath_geometry_and_idempotence(backend, bounds, expected) -> None:
    from podcast_mcp.edits.breath_detect import protect_cut_breaths

    cache = _cache_with_breaths((5.00, 5.10, 0.0008), (5.10, 5.24, 0.026), (5.24, 5.36, 0.0008))
    defaults = {"tighten": {"breath_handling": {"vad_backend": backend}}}
    with patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=_BreathFixtureVad()):
        actual = protect_cut_breaths(
            _host_project(_fixture_words()), "host", *bounds, defaults=defaults, audio_cache=cache
        )
        if expected is None:
            assert actual is None
        else:
            assert actual == pytest.approx(expected)
            assert (
                protect_cut_breaths(
                    _host_project(_fixture_words()),
                    "host",
                    *actual,
                    defaults=defaults,
                    audio_cache=cache,
                )
                == actual
            )


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
def test_distinct_breaths_shrink_both_original_edges(backend) -> None:
    from podcast_mcp.edits.breath_detect import protect_cut_breaths

    cache = _cache_with_breaths((4.90, 5.08, 0.026), (5.20, 5.38, 0.026))
    with patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=_BreathFixtureVad()):
        actual = protect_cut_breaths(
            _host_project(_fixture_words()),
            "host",
            5.00,
            5.30,
            audio_cache=cache,
            defaults={"tighten": {"breath_handling": {"vad_backend": backend}}},
        )
    assert actual == pytest.approx((5.08, 5.20))


@pytest.mark.parametrize("failure", ["missing", "nonfinite", "profile", "begin", "eof", "long"])
def test_enabled_protection_suppresses_unavailable_or_incomplete_evidence(failure) -> None:
    import numpy as np

    from podcast_mcp.edits.breath_detect import protect_cut_breaths

    cache = _cache_with_breaths((5.0, 5.60 if failure == "long" else 5.24, 0.026))
    bounds = (0.0, 0.10) if failure == "begin" else (5.12, 5.40)
    if failure == "eof":
        bounds = (10.0, 10.2)
    if failure == "nonfinite":
        cache.waveform.samples[3200] = np.nan
    if failure == "profile":
        cache.waveform.samples[:] = 0.0
    with patch("podcast_mcp.edits.breath_detect.load_mono_window", side_effect=OSError("missing")):
        assert (
            protect_cut_breaths(
                _host_project(_fixture_words()),
                "host",
                *bounds,
                audio_cache=None if failure == "missing" else cache,
            )
            is None
        )


def test_floor_only_and_unrelated_protected_activity_are_clear() -> None:
    from podcast_mcp.edits.breath_detect import protect_cut_breaths
    from test_breath_detect import _harmonic_tone

    cache = _cache_with_breaths()
    cache.waveform.samples[round(4.8 * 16000) : round(4.9 * 16000)] = _harmonic_tone(1600, 0.026)
    assert protect_cut_breaths(
        _host_project(_fixture_words()), "host", 5.0, 5.4, audio_cache=cache
    ) == (5.0, 5.4)


def test_shrink_recomputes_kept_word_eligibility() -> None:
    from podcast_mcp.edits.breath_detect import protect_cut_breaths
    from podcast_mcp.models import Transcript, TranscriptWord

    project = _host_project(_fixture_words())
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="kept", start=5.00, end=5.36)])
    ]
    cache = _cache_with_breaths((5.00, 5.10, 0.0008), (5.10, 5.24, 0.026), (5.24, 5.36, 0.0008))
    assert protect_cut_breaths(project, "host", 5.10, 5.40, audio_cache=cache) is None


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
@pytest.mark.parametrize("tail", ["voiced", "sibilant", "kept"])
def test_completed_quiet_tail_cannot_hide_protected_activity(backend, tail) -> None:
    from podcast_mcp.edits.breath_detect import protect_cut_breaths
    from test_breath_detect import _harmonic_tone, _sibilant_noise

    cache = _cache_with_breaths((5.0, 5.10, 0.0008), (5.10, 5.24, 0.026), (5.24, 5.36, 0.0008))
    project = _host_project(_fixture_words())
    if tail == "kept":
        project = _host_project((("keep", 5.24, 5.36),))
    else:
        blob = (_harmonic_tone if tail == "voiced" else _sibilant_noise)(1920, 0.0008)
        cache.waveform.samples[83840:85760] = blob
    with patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=_BreathFixtureVad()):
        assert (
            protect_cut_breaths(
                project,
                "host",
                5.30,
                5.40,
                audio_cache=cache,
                defaults={"tighten": {"breath_handling": {"vad_backend": backend}}},
            )
            is None
        )


def test_proposal_to_exact_approval_preserves_complete_breath_source(tmp_path) -> None:
    from podcast_mcp.edits.decisions import approve_edits
    from podcast_mcp.edits.fillers import _apply_analyzed_cut

    cache = _cache_with_breaths((5.0, 5.12, 0.0008), (5.12, 5.26, 0.026))
    result = _proposal(tmp_path, cache, 5.15, "heuristic", cut_start=4.3)
    assert not isinstance(result, _CutRejected)
    project = _project_with_wav(tmp_path, cache)
    decision = _apply_analyzed_cut(project, result)
    with patch(
        "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
        return_value=ResolvedCutScope("session_clear", None),
    ):
        assert approve_edits(project, [decision.id]) == 1
    assert any(clip.source_start <= 5.0 and clip.source_end >= 5.26 for clip in project.clips)
    _assert_original_breath_pcm(project, tmp_path, (5.0, 5.26))


def test_default_apply_preserves_proposed_complete_breath(tmp_path) -> None:
    from podcast_mcp.edits.fillers import _apply_analyzed_cut
    from podcast_mcp.edits.tighten import apply_tighten_decisions

    cache = _cache_with_breaths((5.0, 5.12, 0.0008), (5.12, 5.26, 0.026))
    result = _proposal(tmp_path, cache, 5.05, "heuristic", cut_start=4.3)
    assert not isinstance(result, _CutRejected)
    # The trim shrank off the breath and needs no review: applying consumes the stored
    # bounds, breath whole.
    assert (result.reason, result.review_required) == ("pause:candidate:air_edges", False)
    project = _project_with_wav(tmp_path, cache)
    _apply_analyzed_cut(project, result)
    with patch(
        "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
        return_value=ResolvedCutScope("session_clear", None),
    ):
        assert apply_tighten_decisions(project) == 1
    assert any(clip.source_start <= 5.0 and clip.source_end >= 5.26 for clip in project.clips)
    _assert_original_breath_pcm(project, tmp_path, (5.0, 5.26))


def _assert_original_breath_pcm(project, tmp_path, breath):
    import numpy as np

    from podcast_mcp.engines.align import load_mono_window
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.engines.timeline_render import render_track_from_timeline
    from podcast_mcp.util.timebase import SourceSec

    start, end = breath
    mapped = SessionTimeline(project).exact_source_span("host", SourceSec(start), SourceSec(end))
    assert mapped is not None
    track = project.track_by_id("host")
    original = load_mono_window(
        tmp_path / "host.wav", start_sec=start, duration_sec=end - start, sample_rate=16000
    )
    rendered = render_track_from_timeline(project, track, tmp_path / "played.wav", {})
    played = load_mono_window(
        rendered, start_sec=float(mapped[0]), duration_sec=end - start, sample_rate=16000
    )
    np.testing.assert_allclose(played, original, atol=2 / 32768, rtol=0)


def _project_with_wav(tmp_path, cache):
    import wave

    project = _host_project(_fixture_words())
    project.meta.workspace_dir = str(tmp_path)
    tmp_path.mkdir(parents=True, exist_ok=True)
    path = tmp_path / "host.wav"
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes((cache.waveform.samples * 32767).astype("<i2").tobytes())
    project.tracks[0].media.path = "host.wav"
    project.tracks[0].media.duration_sec = 10.2
    project.clips[0].source_end = 10.2
    return project


@pytest.mark.parametrize("protected_edge", ["start", "end"])
@pytest.mark.parametrize("neighbor_mode", [None, "waveform_only"])
def test_coalescing_mixed_modes_preserves_protected_breath_on_default_apply(
    tmp_path, protected_edge, neighbor_mode
) -> None:
    from podcast_mcp.edits.breath_detect import protect_cut_breaths
    from podcast_mcp.edits.tighten import apply_tighten_decisions
    from podcast_mcp.edits.transcript_cuts import append_remove_decision, coalesce_edits

    if protected_edge == "end":
        cache = _cache_with_breaths((5.0, 5.12, 0.0008), (5.12, 5.26, 0.026))
        requested = (4.9, 5.05)
        expected = (4.9, 5.0)
        neighbor = (4.8, 4.89)
        breath = (5.0, 5.26)
    else:
        cache = _cache_with_breaths((5.0, 5.10, 0.0008), (5.10, 5.24, 0.026), (5.24, 5.36, 0.0008))
        requested = (5.3, 5.4)
        expected = (5.36, 5.4)
        neighbor = (5.41, 5.44)
        breath = (5.0, 5.36)
    project = _project_with_wav(tmp_path, cache)
    protected = protect_cut_breaths(project, "host", *requested, audio_cache=cache)
    assert protected == pytest.approx(expected)
    assert protected is not None
    saved = append_remove_decision(
        project,
        "host",
        *protected,
        reason="filler:protected",
        review_required=False,
        boundary_mode="vocal_transcript_guided",
    )
    append_remove_decision(
        project,
        "host",
        *neighbor,
        reason="filler:um",
        review_required=False,
        boundary_mode=neighbor_mode,
    )
    assert coalesce_edits(project, track_id="host") == 0
    with patch(
        "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
        return_value=ResolvedCutScope("session_clear", None),
    ):
        assert apply_tighten_decisions(project) == 2
    assert any(
        clip.source_start <= breath[0] and clip.source_end >= breath[1] for clip in project.clips
    )
    archived = next(row for row in project.editorial.edit_log if saved.id in row.decision_ids)
    edge_index = 0 if protected_edge == "start" else 1
    assert archived.params["per_track_source"]["host"][edge_index] == pytest.approx(
        expected[edge_index]
    )
    assert (archived.source_start, archived.source_end) == pytest.approx(expected)


def test_a_pause_trim_with_no_air_left_after_a_breath_and_its_tail_is_no_air() -> None:
    from podcast_mcp.edits.fillers import _VoicedSpeechCheck

    cache = _cache_with_breaths((5.0, 5.10, 0.0008), (5.10, 5.24, 0.026), (5.24, 5.36, 0.0008))
    # Pacing leaves 5.30-5.38 of the gap; the breath's tail and the 50 ms average that
    # finds it reach 5.39, so there is no air left.
    candidate = _CutCandidate("host", 4.3, 5.45, "pause:short", "pause")
    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            return_value=(_passthrough_opt(5.30, 5.38), _safe_risk()),
        ),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=FillerPacingResult(5.30, 5.38),
        ),
        patch(
            "podcast_mcp.edits.fillers._check_voiced_speech",
            return_value=_VoicedSpeechCheck(5.30, 5.38, None),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=ResolvedCutScope("session_clear", None),
        ),
    ):
        assert _analyze_candidate(
            _host_project(_fixture_words()), candidate, {"tighten": {}}, audio_cache=cache
        ) == _CutRejected("no_air")


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
@pytest.mark.parametrize(
    "bounds, expected",
    [
        ((4.90, 5.05), (4.90, 5.00)),
        ((5.30, 5.60), (5.36, 5.60)),
        ((5.00, 5.36), None),
        ((4.90, 5.36), None),
    ],
)
def test_a_faded_edge_keeps_breaths_whole_and_never_removes_one(backend, bounds, expected) -> None:
    from podcast_mcp.edits.breath_detect import protect_cut_breaths

    cache = _cache_with_breaths((5.00, 5.10, 0.0008), (5.10, 5.24, 0.026), (5.24, 5.36, 0.0008))
    with patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=_BreathFixtureVad()):
        actual = protect_cut_breaths(
            _host_project(_fixture_words()),
            "host",
            *bounds,
            defaults={"tighten": {"breath_handling": {"vad_backend": backend}}},
            audio_cache=cache,
            strict=False,
        )
    assert actual == (expected if expected is None else pytest.approx(expected))


def test_a_faded_edge_never_removes_a_breath_run_whose_onset_runs_on() -> None:
    from podcast_mcp.edits.breath_detect import protect_cut_breaths

    # A long quiet lead-in keeps the breath from being traced back to room tone; its
    # in-band run alone still fills most of the cut.
    cache = _cache_with_breaths((4.40, 5.10, 0.0008), (5.10, 5.24, 0.026))
    assert (
        protect_cut_breaths(
            _host_project(_fixture_words()), "host", 5.08, 5.26, audio_cache=cache, strict=False
        )
        is None
    )
    assert protect_cut_breaths(
        _host_project(_fixture_words()), "host", 4.90, 5.26, audio_cache=cache, strict=False
    ) == (4.90, 5.26)


@pytest.mark.parametrize("evidence", ["missing", "silent", "longer_than_a_breath"])
def test_a_faded_edge_may_sit_where_no_breath_is_found(evidence) -> None:
    from podcast_mcp.edits.breath_detect import protect_cut_breaths

    cache = _cache_with_breaths((5.0, 5.60, 0.026))
    if evidence == "silent":
        cache.waveform.samples[:] = 0.0
    with patch("podcast_mcp.edits.breath_detect.load_mono_window", side_effect=OSError("missing")):
        actual = protect_cut_breaths(
            _host_project(_fixture_words()),
            "host",
            5.12,
            5.40,
            audio_cache=None if evidence == "missing" else cache,
            strict=False,
        )
    assert actual == (5.12, 5.40)


def _mute(cache: TrackAudioCache, candidate: _CutCandidate, paced: tuple[float, float]):
    with (
        patch(
            "podcast_mcp.edits.fillers.optimize_and_assess",
            return_value=(_passthrough_opt(candidate.start, candidate.end), _safe_risk()),
        ),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=FillerPacingResult(*paced),
        ),
        patch("podcast_mcp.edits.fillers.assess_cut_risk", return_value=_safe_risk()),
        patch("podcast_mcp.edits.fillers.next_onset", return_value=None),
    ):
        return _analyze_candidate(
            _host_project(_fixture_words()),
            candidate,
            {"tighten": {"edit_mode": "mute"}},
            audio_cache=cache,
        )


def test_a_mute_edge_never_chops_a_breath() -> None:
    from test_breath_detect import _harmonic_tone

    cache = _cache_with_breaths((5.0, 5.12, 0.0008), (5.12, 5.26, 0.026))
    cache.waveform.samples[round(4.6 * 16000) : round(4.72 * 16000)] = _harmonic_tone(1920, 0.026)

    result = _mute(cache, _CutCandidate("host", 4.6, 4.8, "filler:uh", "filler"), (4.6, 5.15))

    assert not isinstance(result, _CutRejected)
    assert (result.decision_type, result.start, result.end) == ("mute", 4.6, pytest.approx(5.0))


def test_a_mute_never_proposes_a_breath_as_an_acoustic_filler() -> None:
    cache = _cache_with_breaths((5.0, 5.10, 0.0008), (5.10, 5.24, 0.026), (5.24, 5.36, 0.0008))
    candidate = _CutCandidate(
        "host", 5.0, 5.36, "filler:acoustic", "filler", min_start=5.0, max_end=5.36
    )

    assert _mute(cache, candidate, (5.0, 5.36)) == _CutRejected("breath")
