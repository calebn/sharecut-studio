"""A track's room tone and the sounds that rise out of it (``edits/room_model.py``, #1055)."""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.edits.audio_cache import DIGITAL_SILENCE_DB
from podcast_mcp.edits.room_model import (
    Room,
    Sound,
    find_sounds,
    least_spread,
    mode_spread,
    read_room,
    smoothed,
)

RATE = 16_000
BREATHS_BELOW_SPEECH_DB = (7.0, 40.0)


def _room_levels(n: int, centre: float, spread: float, seed: int = 4) -> np.ndarray:
    """Smoothed-level samples of a normal room: ``n`` frames, ``spread`` dB apart."""
    return centre + spread * np.random.default_rng(seed).standard_normal(n)


def test_the_least_spread_is_what_stationary_noise_averaged_over_50_ms_reads() -> None:
    assert least_spread(RATE) == pytest.approx(0.219, abs=0.001)


def test_smoothed_levels_average_in_power_and_hold_a_gates_silence() -> None:
    levels = np.array([DIGITAL_SILENCE_DB] * 8 + [-20.0] * 3 + [DIGITAL_SILENCE_DB] * 8)

    got = smoothed(levels)

    # A loud frame spreads two frames each way, at a fifth of its power per frame.
    assert got[0] == DIGITAL_SILENCE_DB
    assert got[5] == DIGITAL_SILENCE_DB
    assert got[6] == pytest.approx(-20.0 + 10.0 * np.log10(1 / 5), abs=0.01)
    assert got[9] == pytest.approx(-20.0 + 10.0 * np.log10(3 / 5), abs=0.01)


def test_a_normal_room_reads_its_median_and_spread() -> None:
    room = read_room(_room_levels(600, -70.0, 1.0), RATE)

    assert room.level_db == pytest.approx(-70.0, abs=0.15)
    assert room.spread_db == pytest.approx(1.0, abs=0.15)


def test_a_room_is_never_steadier_than_stationary_noise_can_read() -> None:
    room = read_room(np.full(300, -70.0), RATE)

    assert room.spread_db == least_spread(RATE)
    assert room.level_db == pytest.approx(-70.0 + 1.645 * least_spread(RATE), abs=0.001)


def test_a_sample_that_is_mostly_sound_reads_the_room_the_tracks_mode_gives_it() -> None:
    # 85% of the frames are tails and speech between -60 and -15, 15% room at -90 +- 1.5.
    # Read from the sample alone its spread is the sample's, tens of dB; the track's mode
    # (the one place its levels pile up) says 1.5, and the lesser stands.
    rng = np.random.default_rng(5)
    sample = np.concatenate([rng.uniform(-60.0, -15.0, 510), _room_levels(90, -90.0, 1.5, seed=6)])
    prior = mode_spread(sample, ceiling_db=-40.0, sample_rate=RATE)

    assert read_room(sample, RATE).spread_db > 8.0
    room = read_room(sample, RATE, prior)

    assert room.spread_db == pytest.approx(1.5, abs=0.6)
    # The anchor is the sample's 5th percentile, which is the room's own 33rd here: the
    # level reads up to 1.645 spreads over the room's median, never under it.
    assert room.level_db == pytest.approx(-87.4, abs=0.1)


def test_a_track_gated_to_digital_silence_has_that_for_a_room() -> None:
    sample = np.concatenate([np.full(30, DIGITAL_SILENCE_DB), _room_levels(270, -70.0, 1.0)])

    assert read_room(sample, RATE) == Room(DIGITAL_SILENCE_DB, least_spread(RATE))


def test_the_lesser_of_the_sample_and_the_mode_prior_stands() -> None:
    sample = _room_levels(400, -70.0, 2.0)

    assert read_room(sample, RATE, prior=0.5).spread_db == pytest.approx(0.5)
    assert read_room(sample, RATE, prior=9.0).spread_db == pytest.approx(
        read_room(sample, RATE).spread_db
    )


def test_the_mode_of_a_track_is_its_room_with_a_thin_continuum_of_sound_above() -> None:
    rng = np.random.default_rng(8)
    levels = np.concatenate([_room_levels(500, -92.0, 1.5, seed=9), rng.uniform(-90.0, -20.0, 500)])

    assert mode_spread(levels, ceiling_db=-50.0, sample_rate=RATE) == pytest.approx(1.5, abs=0.6)


def test_a_flat_spread_of_levels_has_no_mode_to_read() -> None:
    levels = np.random.default_rng(2).uniform(-90.0, -20.0, 1000)

    assert mode_spread(levels, ceiling_db=0.0, sample_rate=RATE) is None


def _track(room_db: float = -70.0, seconds: float = 8.0, seed: int = 3) -> np.ndarray:
    """Raw 10 ms levels of a steady room: its frames stay within a dB of its median."""
    return _room_levels(round(seconds * 100), room_db, 0.45, seed)


def _sounds(levels: np.ndarray, speech_db: float | None = -15.0, pause=(300, 500), room=None):
    smooth = smoothed(levels)
    room = room or read_room(smooth[:250], RATE)
    return find_sounds(
        levels, room, speech_db, pause, RATE, breath_below_speech_db=BREATHS_BELOW_SPEECH_DB
    )


def test_a_breath_over_a_steady_room_is_one_sound_with_a_guard_frame_each_side() -> None:
    levels = _track()
    levels[350:380] += 12.0 * np.sin(np.linspace(0.0, np.pi, 30))

    # The breath's frames 350-379 rise 12 dB out of a room steady to 0.45 dB; its 50 ms
    # average clears the room's reach from frame 350 to 379, and a guard frame is added.
    assert _sounds(levels) == [Sound(349, 381, True)]


def test_a_sound_is_traced_out_against_the_room_under_it_not_the_whole_windows() -> None:
    # The room read over the window says -70 with a 1.5 dB spread (reach -67), but where
    # this sound is the room sits at a steady -76: a breath rises from it over frames
    # 400-430 into a word at -20 (430-460). Against the window's reach, frames 400-415 of
    # the breath, up to 8 dB over the room under them, would be air. Read within half a
    # second, the room's reach is 0.8 dB over -76: the sound starts where the breath's
    # average first clears it (402), less a guard frame, and ends a guard frame after the
    # word's average is back at the room (462).
    levels = np.full(800, -76.0)
    levels[400:430] = np.linspace(-76.0, -60.0, 30)
    levels[430:460] = -20.0

    sounds = find_sounds(
        levels,
        Room(-70.0, 1.5),
        -15.0,
        (0, 0),
        RATE,
        breath_below_speech_db=BREATHS_BELOW_SPEECH_DB,
    )

    assert sounds == [Sound(401, 463, False)]


@pytest.mark.parametrize(("bump_db", "expected"), [(-68.87, []), (-68.65, [Sound(399, 421, True)])])
def test_the_line_sits_four_spreads_over_the_rooms_median(bump_db: float, expected) -> None:
    # A room as steady as a room reads: frames at -70 read a median of -69.64 dBFS and the
    # least spread, 0.219 dB, so the line is at -68.76. A 200 ms stretch 3.5 spreads over
    # the median (-68.87) is the room; one 4.5 spreads over it (-68.65) is a sound, traced
    # out to two spreads and given a guard frame each side.
    levels = np.full(800, -70.0)
    levels[400:420] = bump_db

    assert _sounds(levels) == expected


def test_a_click_whose_own_frame_reaches_the_ceiling_stays_whole_though_its_average_does_not():
    # One 10 ms click at -52 dBFS, 37 dB under the -15 dBFS speech: over the ceiling (40 dB
    # under). Its 50 ms average spreads it over five frames at -58.7, under the ceiling, but
    # the click itself reaches it, so it is kept whole and splits the air.
    levels = np.full(800, -70.0)
    levels[400] = -52.0

    assert _sounds(levels) == [Sound(397, 404, False)]


def test_a_steady_room_alone_holds_no_sound() -> None:
    assert _sounds(_track()) == []


def test_a_sound_reaching_the_ceiling_is_not_removable_and_a_quieter_one_is() -> None:
    levels = _track()
    levels[350:370] = -50.0  # 35 dB under the speech: over the ceiling
    levels[420:440] = -62.0  # 47 dB under the speech: under it

    first, second = _sounds(levels)

    assert (first.removable, second.removable) == (False, True)


def test_two_sounds_a_dip_of_50_ms_apart_are_one_and_a_wider_gap_keeps_them_two() -> None:
    near = _track()
    near[350:365] += 15.0
    near[370:385] += 15.0  # 50 ms of room between them
    far = _track()
    far[350:365] += 15.0
    far[380:395] += 15.0  # 150 ms

    assert len(_sounds(near)) == 1
    assert len(_sounds(far)) == 2


def test_a_track_that_speaks_and_cannot_tell_air_from_sound_is_one_sound_to_keep() -> None:
    # Speech at -15 dBFS over a room at -50: the room is within the 40 dB breaths hide in.
    levels = _track(room_db=-50.0)

    (everything,) = _sounds(levels)

    assert everything == Sound(0, levels.size, False)


def test_a_window_of_bleed_with_no_room_in_it_is_one_sound_to_keep_however_tall_it_reads() -> None:
    # Nothing but a peer's voice at -55 to -30 dBFS: its room reads as tall as the bleed
    # itself, so the line sits over the bleed and finds nothing. The track still speaks
    # (its loudest frames stand 25 dB out of its quietest), and a line that reaches into
    # the range breaths sit in cannot tell air from sound.
    levels = np.random.default_rng(12).uniform(-55.0, -30.0, 800)
    smooth = smoothed(levels)
    room = read_room(smooth, RATE)
    speech = float(np.percentile(levels, 90))

    assert room.line_db > speech
    assert find_sounds(
        levels, room, speech, (300, 500), RATE, breath_below_speech_db=BREATHS_BELOW_SPEECH_DB
    ) == [Sound(0, 800, False)]


def test_a_mic_that_never_speaks_has_no_speech_to_protect() -> None:
    # Its speech level is its room's own upper edge, under the line: the same -50 room
    # that blocks a speaking track is plain air here.
    levels = _track(room_db=-50.0)
    own_speech = float(np.percentile(levels, 90))

    assert _sounds(levels, speech_db=own_speech) == []


def test_a_pause_quieter_than_the_room_between_words_lowers_the_line() -> None:
    # A gate or expander closes further in a long pause than in the short gaps the room is
    # read from. Between the words it reads -57 dBFS, a line within 40 dB of the -15 dBFS
    # speech: on that room alone the track cannot tell air from sound, and its whole window
    # is one sound to keep. Its pause sits at -80, and a breath 12 dB over it is a sound
    # like any other, removable whole.
    levels = _track(room_db=-80.0)
    levels[350:380] += 12.0 * np.sin(np.linspace(0.0, np.pi, 30))
    room_between_words = Room(-57.0, 0.5)

    assert _sounds(levels, room=room_between_words, pause=(0, 0)) == [Sound(0, 800, False)]
    assert _sounds(levels, room=room_between_words) == [Sound(349, 381, True)]


def test_a_pause_that_is_mostly_sound_cannot_raise_the_line() -> None:
    # The pause's 200 frames are a sound at -45 dBFS: read on its own its room is the sound,
    # but the lower line of the two stands, so the whole stretch is one sound (30 dB under
    # the speech, over the ceiling) out to a guard frame past the room's reach each side.
    levels = _track()
    levels[300:500] = -45.0 + np.random.default_rng(1).standard_normal(200)

    assert _sounds(levels, room=Room(-70.0, 0.5)) == [Sound(297, 503, False)]
