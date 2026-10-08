"""Speaker hand-overs settle into pauses, and a short turn keeps its whole voiced run (#1095)."""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.engines.speaker_hand_overs import settle_hand_overs, voice_runs

QUIET, LOUD = -80.0, -20.0
REACH = 50  # one 1 s window of 20 ms frames
A, B = 0, 1


def _levels(frames: int, runs: list[tuple[int, int]]) -> np.ndarray:
    levels = np.full(frames, QUIET)
    for lo, hi in runs:
        levels[lo:hi] = LOUD
    return levels


def _labels(frames: int, turns: list[tuple[int, int]]) -> np.ndarray:
    """Speaker per frame from ``(first frame, speaker)`` turn starts."""
    labels = np.zeros(frames, dtype=np.int64)
    for first, speaker in turns:
        labels[first:] = speaker
    return labels


def _scores(frames: int, lean: dict[tuple[int, int], tuple[float, float]]) -> np.ndarray:
    """Window cosines: A ahead by default, ``lean`` overrides spans."""
    scores = np.tile([0.5, 0.2], (frames, 1))
    for (lo, hi), value in lean.items():
        scores[lo:hi] = value
    return scores


def _own(voices: dict[tuple[int, int], int]):
    """A span embedded on its own sounds like the speaker whose voice it overlaps most."""

    def own(lo: int, hi: int) -> np.ndarray:
        heard = np.zeros(2)
        for (a, b), speaker in voices.items():
            heard[speaker] += max(0, min(hi, b) - max(lo, a))
        return np.where(np.arange(2) == np.argmax(heard), 0.9, 0.1)

    return own


def _hand_overs(labels: np.ndarray) -> list[int]:
    return (np.flatnonzero(np.diff(labels) != 0) + 1).tolist()


def _settle(labels, scores, runs, own, frames):
    levels = _levels(frames, runs)
    return settle_hand_overs(labels, scores, levels, runs, own, reach=REACH)


# A talks [20, 120), B replies [140, 170), A talks again [190, 290).
RUNS = [(20, 120), (140, 170), (190, 290)]
VOICES = {(20, 120): A, (140, 170): B, (190, 290): A}
FRAMES = 300


def _quiet(frame_levels: np.ndarray, cut: int) -> bool:
    return bool(frame_levels[cut - 1] == QUIET or frame_levels[cut] == QUIET)


def test_a_hand_over_inside_an_utterance_moves_to_the_pause_before_it() -> None:
    # The attribution hands over to B 0.2 s into B's reply; the windows there already
    # lean to B, so the reply's first 0.2 s belongs with the rest of it.
    labels = _labels(FRAMES, [(0, A), (150, B), (180, A)])
    scores = _scores(FRAMES, {(140, 180): (0.3, 0.6)})
    settled, overlap = _settle(labels, scores, RUNS, _own(VOICES), FRAMES)
    levels = _levels(FRAMES, RUNS)
    assert all(_quiet(levels, cut) for cut in _hand_overs(settled))
    assert np.all(settled[140:170] == B)
    assert np.all(settled[20:120] == A) and np.all(settled[190:290] == A)
    assert np.all(overlap == -1)


def test_a_short_reply_parked_in_the_pause_takes_its_whole_run() -> None:
    # The lab failure: B's 0.6 s reply sits between A's turns; the 1 s windows over the
    # reply lean to A (smeared from A's turns), the pause before it leans to B, and the
    # attribution parks B's turn in that silence. B's voice embedded alone is B.
    labels = _labels(FRAMES, [(0, A), (124, B), (136, A)])
    scores = _scores(FRAMES, {(120, 140): (0.3, 0.6), (140, 170): (0.45, 0.42)})
    settled, _ = _settle(labels, scores, RUNS, _own(VOICES), FRAMES)
    levels = _levels(FRAMES, RUNS)
    assert np.all(settled[140:170] == B), "the reply is entirely on B's lane"
    assert np.all(settled[20:120] == A) and np.all(settled[190:290] == A)
    assert len(_hand_overs(settled)) == 2
    assert all(_quiet(levels, cut) for cut in _hand_overs(settled))


def test_a_short_reply_that_sounds_like_its_neighbour_does_not_move() -> None:
    labels = _labels(FRAMES, [(0, A), (124, B), (136, A)])
    scores = _scores(FRAMES, {(120, 140): (0.3, 0.6)})
    voices = {(20, 120): A, (140, 170): A, (190, 290): A}
    settled, _ = _settle(labels, scores, RUNS, _own(voices), FRAMES)
    # B's turn held no voice, so it dissolves into A.
    assert np.all(settled == A)


def test_two_voices_with_no_pause_between_them_stay_and_are_flagged() -> None:
    # One 6 s run, A then B with no pause anywhere near: true overlap or latching.
    runs = [(0, FRAMES)]
    labels = _labels(FRAMES, [(0, A), (150, B)])
    voices = {(0, 150): A, (150, FRAMES): B}
    settled, overlap = _settle(labels, _scores(FRAMES, {}), runs, _own(voices), FRAMES)
    assert _hand_overs(settled) == [150]
    assert np.all(overlap[150 - REACH // 4 : 150] == B)
    assert np.all(overlap[150 : 150 + REACH // 4] == A)
    assert np.all(overlap[: 150 - REACH // 4] == -1)


def test_a_run_whose_pieces_sound_like_their_own_sides_is_flagged_not_moved() -> None:
    # Pauses exist a little way off, but each side of the cut is its own voice.
    runs = [(20, 120), (130, 230), (250, 290)]
    labels = _labels(FRAMES, [(0, A), (180, B)])
    voices = {(20, 180): A, (180, 290): B}
    scores = _scores(FRAMES, {(180, FRAMES): (0.2, 0.5)})
    settled, overlap = _settle(labels, scores, runs, _own(voices), FRAMES)
    assert _hand_overs(settled) == [180]
    assert overlap[179] == B and overlap[180] == A


def test_a_run_too_short_for_two_voices_never_keeps_a_cut() -> None:
    runs = [(20, 120), (140, 148), (190, 290)]
    labels = _labels(FRAMES, [(0, A), (144, B)])
    settled, overlap = _settle(labels, _scores(FRAMES, {}), runs, _own(VOICES), FRAMES)
    [cut] = _hand_overs(settled)
    assert not 140 < cut < 148
    assert np.all(overlap == -1)


def test_a_hand_over_between_long_turns_lands_on_the_quietest_cut_of_its_pause() -> None:
    runs = [(20, 120), (160, 290)]
    levels = _levels(FRAMES, runs)
    levels[120:160] = -60.0
    levels[150:152] = -90.0
    labels = _labels(FRAMES, [(0, A), (125, B)])
    voices = {(20, 120): A, (160, 290): B}
    settled, _ = settle_hand_overs(
        labels, _scores(FRAMES, {}), levels, runs, _own(voices), reach=REACH
    )
    assert _hand_overs(settled) == [151]


def test_nothing_moves_without_measurable_pauses() -> None:
    labels = _labels(FRAMES, [(0, A), (150, B)])
    settled, overlap = settle_hand_overs(
        labels, _scores(FRAMES, {}), np.full(FRAMES, -30.0), [], _own({}), reach=REACH
    )
    assert np.array_equal(settled, labels)
    assert np.all(overlap == -1)


# --- voiced runs from the recording's own levels -------------------------------------


def test_voice_runs_follow_the_recordings_own_floor_and_speech_level() -> None:
    levels = _levels(FRAMES, RUNS)
    voiced = levels > QUIET
    labels = _labels(FRAMES, [(0, A), (130, B), (180, A)])
    runs = voice_runs(levels, labels, voiced)
    assert runs == RUNS
    # A recording 25 dB quieter overall has the same pauses.
    assert voice_runs(levels - 25.0, labels, voiced) == RUNS


def test_a_speaker_25_db_quieter_keeps_their_detected_reply() -> None:
    levels = np.full(FRAMES, -60.0)
    levels[20:120] = levels[190:290] = -20.0
    levels[140:170] = -45.0
    voiced = np.zeros(FRAMES, dtype=bool)
    for lo, hi in RUNS:
        voiced[lo:hi] = True
    labels = _labels(FRAMES, [(0, A), (130, B), (180, A)])
    scores = _scores(FRAMES, {(130, 180): (0.1, 0.9)})

    settled, overlap = settle_hand_overs(
        labels, scores, levels, voice_runs(levels, labels, voiced), _own(VOICES), reach=REACH
    )

    assert settled[140:170].tolist() == [B] * 30
    assert settled[20:120].tolist() == [A] * 100
    assert settled[190:290].tolist() == [A] * 100
    assert overlap.tolist() == [-1] * FRAMES


def test_voice_runs_ignore_clicks_and_bridge_stops_inside_a_word() -> None:
    levels = _levels(FRAMES, RUNS)
    levels[60:62] = QUIET  # a 40 ms stop inside A's word
    levels[180:182] = LOUD  # a 40 ms click in the pause
    labels = _labels(FRAMES, [(0, A), (130, B), (180, A)])
    assert voice_runs(levels, labels, levels > QUIET) == RUNS
    assert voice_runs(levels, labels, None) == [(20, 120), (140, 170), (190, 290)]


@pytest.mark.parametrize("spread", [0.0, 3.0])
def test_a_recording_without_pauses_has_no_voice_runs(spread: float) -> None:
    levels = -30.0 + spread * np.sin(np.arange(FRAMES))
    labels = _labels(FRAMES, [(0, A), (150, B)])
    assert voice_runs(levels, labels, np.ones(FRAMES, dtype=bool)) == []
    assert voice_runs(levels, labels, None) == []


def _quiet_reply_levels() -> np.ndarray:
    levels = np.full(FRAMES, -60.0)
    levels[20:120] = levels[190:290] = -20.0
    levels[140:170] = -45.0
    return levels


@pytest.mark.parametrize("gain", [0.0, -25.0])
def test_quiet_cluster_measurement_keeps_a_reply_without_vad(gain: float) -> None:
    levels = _quiet_reply_levels() + gain
    labels = _labels(FRAMES, [(0, A), (130, B), (180, A)])
    runs = voice_runs(levels, labels, None)
    assert runs == [(20, 120), (140, 170), (190, 290)]
    settled, overlap = settle_hand_overs(
        labels, _scores(FRAMES, {(130, 180): (0.1, 0.9)}), levels, runs, _own(VOICES), REACH
    )
    assert settled[140:170].tolist() == [B] * 30
    assert settled[20:120].tolist() == [A] * 100
    assert settled[190:290].tolist() == [A] * 100
    assert overlap.tolist() == [-1] * 300


def test_detector_heard_quiet_reply_reclaims_a_turn_parked_in_a_pause() -> None:
    levels = _quiet_reply_levels()
    labels = _labels(FRAMES, [(0, A), (124, B), (136, A)])
    detected = levels > -60.0
    runs = voice_runs(levels, labels, detected)
    assert runs == [(20, 120), (140, 170), (190, 290)]
    settled, overlap = settle_hand_overs(
        labels,
        _scores(FRAMES, {(120, 140): (0.3, 0.6), (140, 170): (0.45, 0.42)}),
        levels,
        runs,
        _own(VOICES),
        REACH,
    )
    assert settled[140:170].tolist() == [B] * 30
    assert settled[20:120].tolist() == [A] * 100
    assert settled[190:290].tolist() == [A] * 100
    assert overlap.tolist() == [-1] * 300


@pytest.mark.parametrize(
    ("heard_frames", "expected"),
    [(2, [(20, 120), (190, 290)]), (3, [(20, 120), (140, 170), (190, 290)])],
)
def test_local_measurement_needs_a_minimum_run_of_speech_samples(heard_frames, expected) -> None:
    levels = _quiet_reply_levels()
    labels = _labels(FRAMES, [(0, A), (130, B), (180, A)])
    detected = levels == -20.0
    detected[140 : 140 + heard_frames] = True
    assert voice_runs(levels, labels, detected) == expected


@pytest.mark.parametrize("cluster_frames", [0, 1, 2])
def test_detector_protects_a_reply_with_missing_or_sparse_cluster_membership(
    cluster_frames,
) -> None:
    levels = _quiet_reply_levels()
    labels = np.zeros(FRAMES, dtype=np.int64)
    labels[140 : 140 + cluster_frames] = B
    assert voice_runs(levels, labels, levels > -60.0) == [(20, 120), (140, 170), (190, 290)]


@pytest.mark.parametrize(
    ("noise_frames", "expected"),
    [
        (2, [(20, 120), (140, 170), (190, 290)]),
        (3, [(20, 120), (140, 170), (175, 178), (190, 290)]),
    ],
)
def test_detector_noise_protection_has_the_same_duration_filter(noise_frames, expected) -> None:
    levels = _quiet_reply_levels()
    labels = _labels(FRAMES, [(0, A), (130, B), (180, A)])
    detected = levels > -60.0
    detected[175 : 175 + noise_frames] = True
    assert voice_runs(levels, labels, detected) == expected


def test_detector_negative_background_turn_still_dissolves() -> None:
    levels = _levels(FRAMES, [(20, 120), (190, 290)])
    labels = _labels(FRAMES, [(0, A), (130, B), (180, A)])
    runs = voice_runs(levels, labels, levels > QUIET)
    assert runs == [(20, 120), (190, 290)]
    settled, overlap = settle_hand_overs(
        labels, _scores(FRAMES, {(130, 180): (0.1, 0.9)}), levels, runs, _own(VOICES), REACH
    )
    assert settled.tolist() == [A] * 300
    assert overlap.tolist() == [-1] * 300


def test_continuous_speakers_distinguish_real_all_true_vad_from_missing_vad() -> None:
    levels = np.full(FRAMES, -20.0)
    levels[150:] = -45.0
    labels = _labels(FRAMES, [(0, A), (150, B)])
    detected_runs = voice_runs(levels, labels, np.ones(FRAMES, dtype=bool))
    missing_runs = voice_runs(levels, labels, None)
    assert detected_runs == [(0, 300)]
    assert missing_runs == []
    scores = _scores(FRAMES, {(150, FRAMES): (0.1, 0.9)})
    own = _own({(0, 150): A, (150, FRAMES): B})
    for runs, expected_overlap in [
        (detected_runs, [-1] * 138 + [B] * 12 + [A] * 12 + [-1] * 138),
        (missing_runs, [-1] * 300),
    ]:
        settled, overlap = settle_hand_overs(labels, scores, levels, runs, own, REACH)
        assert settled.tolist() == [A] * 150 + [B] * 150
        assert overlap.tolist() == expected_overlap


def test_digital_silence_never_supplies_a_floor_or_detector_voice() -> None:
    labels = _labels(FRAMES, [(0, A), (130, B), (180, A)])
    detected = np.ones(FRAMES, dtype=bool)
    assert voice_runs(np.full(FRAMES, -200.0), labels, detected) == []
    gated = _quiet_reply_levels()
    gated[gated == -60.0] = -200.0
    assert voice_runs(gated, labels, detected) == [(20, 120), (140, 170), (190, 290)]
    assert voice_runs(gated, labels, None) == []
    gated[140:170] = -20.0
    assert voice_runs(gated, labels, detected) == []
    assert voice_runs(np.array([]), np.array([], dtype=np.int64), np.array([], dtype=bool)) == []


@pytest.mark.parametrize("available", [True, False])
def test_a_cluster_uses_its_lower_floor_when_global_background_is_louder(available: bool) -> None:
    levels = np.full(FRAMES, -50.0)
    levels[20:220] = -20.0
    levels[240:250] = -70.0
    levels[250:290] = -60.0
    labels = _labels(FRAMES, [(0, A), (240, B), (290, A)])
    detected = (levels == -20.0) | (levels == -60.0) if available else None
    assert voice_runs(levels, labels, detected) == [(20, 220), (250, 290)]


@pytest.mark.parametrize("available", [True, False])
def test_a_speech_only_cluster_uses_the_recordings_measured_floor(available: bool) -> None:
    levels = _quiet_reply_levels()
    labels = _labels(FRAMES, [(0, A), (140, B), (170, A)])
    detected = levels > -60.0 if available else None
    assert voice_runs(levels, labels, detected) == [(20, 120), (140, 170), (190, 290)]


@pytest.mark.parametrize("gain", [0.0, -25.0])
@pytest.mark.parametrize("a_frames", [60, 150])
@pytest.mark.parametrize("dip", [False, True])
@pytest.mark.parametrize("available", [False, True])
def test_unrelated_contrast_cannot_erase_a_continuous_quiet_cluster(
    gain: float, a_frames: int, dip: bool, available: bool
) -> None:
    levels = np.full(FRAMES, -45.0 + gain)
    levels[:a_frames] = -20.0 + gain
    if dip:
        levels[: a_frames // 6] = -32.0 + gain
    labels = _labels(FRAMES, [(0, A), (a_frames, B)])
    detected = np.ones(FRAMES, dtype=bool) if available else None
    runs = voice_runs(levels, labels, detected)
    assert runs == ([(0, 300)] if available else [])
    scores = _scores(FRAMES, {(a_frames, FRAMES): (0.1, 0.9)})
    settled, overlap = settle_hand_overs(
        labels, scores, levels, runs, _own({(0, a_frames): A, (a_frames, FRAMES): B}), REACH
    )
    assert settled.tolist() == [A] * a_frames + [B] * (FRAMES - a_frames)
    expected = (
        [-1] * (a_frames - 12) + [B] * 12 + [A] * 12 + [-1] * (FRAMES - a_frames - 12)
        if available
        else [-1] * 300
    )
    assert overlap.tolist() == expected


@pytest.mark.parametrize("gain", [0.0, -25.0])
@pytest.mark.parametrize("noise", [[], [135, 143], [135, 143, 151], [135, 143, 151, 159, 167]])
def test_disconnected_detector_blips_cannot_expand_a_background_cluster(gain, noise) -> None:
    levels = np.full(FRAMES, -80.0 + gain)
    levels[20:120] = levels[190:290] = -20.0 + gain
    levels[130:180] = -60.0 + gain
    labels = _labels(FRAMES, [(0, A), (130, B), (180, A)])
    detected = levels == -20.0 + gain
    detected[noise] = True
    runs = voice_runs(levels, labels, detected)
    assert runs == [(20, 120), (190, 290)]
    settled, overlap = settle_hand_overs(
        labels,
        _scores(FRAMES, {(130, 180): (0.1, 0.9)}),
        levels,
        runs,
        _own({(20, 120): A, (190, 290): A}),
        REACH,
    )
    assert settled.tolist() == [A] * 300
    assert overlap.tolist() == [-1] * 300


@pytest.mark.parametrize(
    ("noise_frames", "expected"),
    [(2, [(20, 120), (190, 290)]), (3, [(20, 120), (130, 180), (190, 290)])],
)
def test_raised_background_calibration_requires_contiguous_duration(noise_frames, expected) -> None:
    levels = np.full(FRAMES, -80.0)
    levels[20:120] = levels[190:290] = -20.0
    levels[130:180] = -60.0
    labels = _labels(FRAMES, [(0, A), (130, B), (180, A)])
    detected = levels == -20.0
    detected[135 : 135 + noise_frames] = True
    assert voice_runs(levels, labels, detected) == expected


def test_unavailable_detector_still_dissolves_a_digital_silent_turn() -> None:
    levels = _quiet_reply_levels()
    levels[130:180] = -200.0
    labels = _labels(FRAMES, [(0, A), (130, B), (180, A)])
    runs = voice_runs(levels, labels, None)
    assert runs == [(20, 120), (190, 290)]
    settled, overlap = settle_hand_overs(
        labels, _scores(FRAMES, {(130, 180): (0.1, 0.9)}), levels, runs, _own(VOICES), REACH
    )
    assert settled.tolist() == [A] * 300
    assert overlap.tolist() == [-1] * 300
