"""A recording's room tone and the sounds that rise out of it (``edits/room_model.py``, #1055)."""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.edits.audio_cache import DIGITAL_SILENCE_DB, speech_level_db
from podcast_mcp.edits.room_model import (
    Room,
    RoomBasis,
    Sound,
    find_sounds,
    least_spread,
    merge_sounds,
    mode_spread,
    read_conservative_room,
    read_mode,
    read_recording_room,
    read_room,
    read_unwatched_room,
    smoothed,
    speaks,
)
from podcast_mcp.util.dsp import LOW_BAND, SPEECH_BAND

RATE = 16_000
LEAST = least_spread(RATE)
BREATHS_BELOW_SPEECH_DB = (7.0, 40.0)


def _room_levels(n: int, centre: float, spread: float, seed: int = 4) -> np.ndarray:
    """Smoothed-level samples of a normal room: ``n`` frames, ``spread`` dB apart."""
    return centre + spread * np.random.default_rng(seed).standard_normal(n)


def test_the_least_spread_is_what_stationary_noise_averaged_over_50_ms_reads() -> None:
    assert pytest.approx(0.219, abs=0.001) == LEAST


def test_a_narrow_band_reads_a_wider_spread_from_the_steadiest_room() -> None:
    # Stationary noise in a 30 Hz Gaussian band estimates its power from a hundredth of the
    # samples the speech band's does: no room in that band is steadier than about 2.7 dB.
    assert least_spread(RATE, LOW_BAND) == pytest.approx(2.66, abs=0.01)
    assert least_spread(RATE, SPEECH_BAND) == LEAST


def test_smoothed_levels_average_in_power_and_hold_a_gates_silence() -> None:
    levels = np.array([DIGITAL_SILENCE_DB] * 8 + [-20.0] * 3 + [DIGITAL_SILENCE_DB] * 8)

    got = smoothed(levels)

    # A loud frame spreads two frames each way, at a fifth of its power per frame.
    assert got[0] == DIGITAL_SILENCE_DB
    assert got[5] == DIGITAL_SILENCE_DB
    assert got[6] == pytest.approx(-20.0 + 10.0 * np.log10(1 / 5), abs=0.01)
    assert got[9] == pytest.approx(-20.0 + 10.0 * np.log10(3 / 5), abs=0.01)


def test_a_normal_room_reads_its_median_and_spread() -> None:
    room = read_room(_room_levels(600, -70.0, 1.0), LEAST)

    assert room.level_db == pytest.approx(-70.0, abs=0.15)
    assert room.spread_db == pytest.approx(1.0, abs=0.15)


def test_what_stands_far_over_the_rooms_median_is_clipped_out_of_the_room_it_is_read_from() -> None:
    # A third of the frames are the tails of words, 4 to 30 dB over a room at -70 +- 1 dB.
    # The two low percentiles alone would read the room 0.5 dB high and 0.3 dB wide; clipping
    # what stands more than three spreads over the median, until the same frames are left,
    # gives back the room.
    rng = np.random.default_rng(3)
    tails = rng.uniform(-66.0, -40.0, 210)
    sample = np.concatenate([_room_levels(390, -70.0, 1.0, seed=4), tails])
    rng.shuffle(sample)

    room = read_room(sample, LEAST)

    assert room.spread_db == pytest.approx(1.0, abs=0.07)
    assert room.level_db == pytest.approx(-69.8, abs=0.2)


def test_a_room_is_never_steadier_than_stationary_noise_can_read() -> None:
    room = read_room(np.full(300, -70.0), LEAST)

    assert room.spread_db == LEAST
    assert room.level_db == pytest.approx(-70.0 + 1.645 * LEAST, abs=0.001)


def test_a_sample_that_is_mostly_sound_reads_the_room_the_tracks_mode_gives_it() -> None:
    # 85% of the frames are tails and speech between -60 and -15, 15% room at -90 +- 1.5.
    # Read from the sample alone its spread is the sample's, tens of dB; the track's mode
    # (the one place its levels pile up) says 1.5, and the lesser stands.
    rng = np.random.default_rng(5)
    sample = np.concatenate([rng.uniform(-60.0, -15.0, 510), _room_levels(90, -90.0, 1.5, seed=6)])
    prior = mode_spread(sample, -40.0, LEAST)

    assert read_room(sample, LEAST).spread_db > 8.0
    room = read_room(sample, LEAST, prior)

    assert room.spread_db == pytest.approx(1.5, abs=0.6)
    # The anchor is the sample's 5th percentile, which is the room's own 33rd here: the
    # level reads up to 1.645 spreads over the room's median, never under it.
    assert room.level_db == pytest.approx(-87.4, abs=0.1)


def test_a_track_a_gate_holds_at_digital_silence_most_of_the_time_has_that_for_a_room() -> None:
    sample = np.concatenate([np.full(180, DIGITAL_SILENCE_DB), _room_levels(120, -70.0, 1.0)])

    assert read_room(sample, LEAST) == Room(DIGITAL_SILENCE_DB, LEAST)
    assert read_conservative_room(sample, LEAST) == Room(DIGITAL_SILENCE_DB, LEAST)


@pytest.mark.parametrize("zeros", [15, 90, 140])
def test_runs_of_digital_silence_in_a_live_room_are_not_a_gate_and_do_not_move_the_room(
    zeros: int,
) -> None:
    # A denoiser's mute or a gap in the file: from one frame in forty to nearly half of the
    # quiet. The room is the live frames between them, and the silence is not a level its
    # median or spread should count.
    live = _room_levels(300, -70.0, 1.0)
    sample = np.concatenate([np.full(zeros, DIGITAL_SILENCE_DB), live])

    assert read_room(sample, LEAST) == read_room(live, LEAST)
    assert read_room(sample, LEAST).level_db == pytest.approx(-70.0, abs=0.5)


def test_the_lesser_of_the_sample_and_the_mode_prior_stands() -> None:
    sample = _room_levels(400, -70.0, 2.0)

    assert read_room(sample, LEAST, prior=0.5).spread_db == pytest.approx(0.5)
    assert read_room(sample, LEAST, prior=9.0).spread_db == pytest.approx(
        read_room(sample, LEAST).spread_db
    )


def test_the_mode_of_a_track_is_its_room_with_a_thin_continuum_of_sound_above() -> None:
    rng = np.random.default_rng(8)
    levels = np.concatenate([_room_levels(500, -92.0, 1.5, seed=9), rng.uniform(-90.0, -20.0, 500)])

    assert mode_spread(levels, -50.0, LEAST) == pytest.approx(1.5, abs=0.6)


def test_a_flat_spread_of_levels_has_no_mode_to_read() -> None:
    levels = np.random.default_rng(2).uniform(-90.0, -20.0, 1000)

    assert mode_spread(levels, 0.0, LEAST) is None


# --- the room is read where the whole session is quiet (L2) -------------------------------


def _conversation(seconds: float = 60.0):
    """A host's smoothed levels over ``seconds``: room at -75 dBFS, and a peer who talks
    through 80% of the time at -45 dBFS bleeding into the host's mic.

    Returns the levels and the mask of the quiet 20% (nobody speaking)."""
    n = round(seconds * 100)
    levels = _room_levels(n, -75.0, 0.6, seed=21)
    quiet = (np.arange(n) // 100) % 5 == 0  # one second in five
    levels[~quiet] = _room_levels(int((~quiet).sum()), -45.0, 3.0, seed=22)
    return levels, quiet


def test_a_room_read_between_the_tracks_own_words_is_bleed_a_room_read_in_the_quiet_is_not() -> (
    None
):
    levels, quiet = _conversation()
    smooth = smoothed(levels)

    own_gaps = read_room(smooth[~quiet], LEAST)
    session = read_recording_room(smooth, quiet, ~quiet, LEAST, ceiling_db=-55.0)

    assert own_gaps.level_db > -50.0  # the peer's voice, tens of dB over the true room
    assert session is not None
    room, basis = session
    assert basis is RoomBasis.SESSION_SILENCE
    assert room.level_db == pytest.approx(-75.0, abs=1.0)


def test_a_recording_reads_a_spread_no_wider_than_its_own_mode_whatever_its_quiet_holds() -> None:
    # 15 s of room at -90 +- 1.5 dB, then 600 frames the session calls silent that are
    # mostly tails and bleed between -60 and -15 with 90 frames of the same room. The quiet
    # alone reads a spread of tens of dB; the recording's mode, where its levels pile up,
    # says 1.5, and the lesser stands.
    rng = np.random.default_rng(5)
    smooth = np.concatenate(
        [
            _room_levels(1500, -90.0, 1.5, seed=3),
            rng.uniform(-60.0, -15.0, 510),
            _room_levels(90, -90.0, 1.5, seed=6),
        ]
    )
    quiet = np.arange(smooth.size) >= 1500

    assert read_room(smooth[quiet], LEAST).spread_db > 8.0
    read = read_recording_room(smooth, quiet, ~quiet, LEAST, ceiling_db=-40.0)

    assert read is not None
    assert read[0].spread_db == pytest.approx(1.5, abs=0.6)


def test_a_recording_with_too_little_quiet_falls_back_to_the_low_end_of_its_own_gaps() -> None:
    # 0.3 s of quiet in 60 s: not enough to read a room from. The track's gaps between its
    # own words hold the room at the low end of a spread of bleed: the fallback reads that
    # low end itself (the sample's 5th percentile), never the median the gaps would give.
    levels, _ = _conversation()
    smooth = smoothed(levels)
    quiet = np.zeros(smooth.size, dtype=bool)
    quiet[:30] = True
    gaps = (np.arange(smooth.size) // 100) % 5 == 0
    gaps[:30] = False
    gaps |= (np.arange(smooth.size) // 100) % 5 == 1  # a second of quiet-ish gap, then bleed

    room, basis = read_recording_room(smooth, quiet, gaps, LEAST, ceiling_db=-55.0)

    assert basis is RoomBasis.OWN_GAPS
    sample = smooth[gaps]
    assert room.level_db == pytest.approx(float(np.percentile(sample, 5.0)), abs=0.01)
    assert room.level_db < float(np.median(sample)) - 10.0


def test_a_recording_with_no_quiet_and_no_gaps_has_no_room() -> None:
    smooth = smoothed(_room_levels(600, -70.0, 1.0))
    nowhere = np.zeros(smooth.size, dtype=bool)

    assert read_recording_room(smooth, nowhere, nowhere, LEAST, ceiling_db=-55.0) is None


def test_the_conservative_room_stands_at_the_low_percentile_not_the_normals_median() -> None:
    sample = _room_levels(600, -70.0, 1.0)

    conservative = read_conservative_room(sample, LEAST)
    normal = read_room(sample, LEAST)

    assert conservative.spread_db == normal.spread_db
    assert conservative.level_db == pytest.approx(
        normal.level_db - 1.645 * normal.spread_db, abs=0.002
    )
    assert conservative.line_db < normal.line_db


def test_merged_sounds_are_removable_only_when_every_part_is() -> None:
    sounds = [Sound(10, 20, True), Sound(20, 30, False), Sound(50, 60, True), Sound(5, 12, True)]

    assert merge_sounds(sounds) == [Sound(5, 30, False), Sound(50, 60, True)]


# --- sounds ------------------------------------------------------------------------------


def _track(room_db: float = -70.0, seconds: float = 8.0, seed: int = 3) -> np.ndarray:
    """Raw 10 ms levels of a steady room: its frames stay within a dB of its median."""
    return _room_levels(round(seconds * 100), room_db, 0.45, seed)


def _sounds(levels: np.ndarray, speech_db: float | None = -15.0, room=None):
    smooth = smoothed(levels)
    room = room or read_room(smooth[:250], LEAST)
    return find_sounds(
        levels, room, speech_db, LEAST, breath_below_speech_db=BREATHS_BELOW_SPEECH_DB
    )


def test_a_breath_over_a_steady_room_is_one_sound_with_a_guard_frame_each_side() -> None:
    levels = _track()
    levels[350:380] += 12.0 * np.sin(np.linspace(0.0, np.pi, 30))

    # The breath's frames 350-379 rise 12 dB out of a room steady to 0.45 dB; its 50 ms
    # average clears the room's reach from frame 350 to 379, and a guard frame is added.
    assert _sounds(levels) == [Sound(349, 382, True)]


def test_a_sound_is_traced_out_against_the_room_under_it_not_the_recordings() -> None:
    # The room read over the recording says -70 with a 1.5 dB spread (reach -67), but where
    # this sound is the room sits at a steady -76: a breath rises from it over frames
    # 400-430 into a word at -20 (430-460). Against the recording's reach, frames 400-415 of
    # the breath, up to 8 dB over the room under them, would be air. Read within a quarter
    # of a second, the room's reach is 0.8 dB over -76: the sound starts where the breath's
    # average first clears it (402), less a guard frame, and ends a guard frame after the
    # word's average is back at the room (462).
    levels = np.full(800, -76.0)
    levels[400:430] = np.linspace(-76.0, -60.0, 30)
    levels[430:460] = -20.0

    sounds = find_sounds(
        levels,
        Room(-70.0, 1.5),
        -15.0,
        LEAST,
        breath_below_speech_db=BREATHS_BELOW_SPEECH_DB,
    )

    assert sounds == [Sound(400, 463, False)]


def test_a_stretch_the_gate_closes_further_gets_its_own_lower_line() -> None:
    # A gate or expander closes further in a long pause than in the short gaps between
    # words: the room reads -57 dBFS over the recording, a line within 40 dB of the -15 dBFS
    # speech, and a pause at -80 holds a breath 12 dB over it. The room near the breath is
    # -80, so the breath is a sound like any other, removable whole.
    levels = _track(room_db=-80.0)
    levels[350:380] += 12.0 * np.sin(np.linspace(0.0, np.pi, 30))
    room = Room(-70.0, 0.5)

    assert _sounds(levels, room=room) == [Sound(349, 381, True)]


@pytest.mark.parametrize(("bump_db", "expected"), [(-68.87, []), (-68.65, [Sound(399, 406, True)])])
def test_a_frame_must_clear_a_line_four_spreads_over_the_rooms_median(
    bump_db: float, expected
) -> None:
    # A room as steady as a room reads: frames at -70 read a median of -69.64 dBFS and the
    # least spread, 0.219 dB, so the line is at -68.76. A 50 ms stretch (too short to be
    # sustained) 3.5 spreads over the median (-68.87) is the room; one 4.5 spreads over it
    # (-68.65) is a sound, traced out to two spreads and given a guard frame each side.
    levels = np.full(800, -70.0)
    levels[400:405] = bump_db

    assert _sounds(levels) == expected


def test_a_stretch_that_stays_over_the_room_is_a_sound_however_low_it_runs() -> None:
    # 200 ms at 3.5 spreads: no frame clears the line, but twenty frames running over the room
    # by that much are not noise, whose average of twenty frames wanders half as far as one.
    levels = np.full(800, -70.0)
    levels[400:420] = -68.87

    assert _sounds(levels) == [Sound(399, 421, True)]


def test_a_breath_a_few_db_over_a_floor_that_jitters_is_a_sound_the_line_cannot_see() -> None:
    # A denoised floor jittering 1.7 dB frame to frame puts the line 7 dB over its median; a
    # breath 4 dB over it for 300 ms never crosses it. Thirty frames that stay that far over
    # the floor are a breath, and what the jitter alone does (the first assertion) is not.
    floor = _room_levels(800, -90.0, 1.7, seed=14)
    breath = floor.copy()
    breath[400:430] += 4.0
    room = Room(-90.0, 1.7)

    def sounds(levels):
        return find_sounds(
            levels, room, -15.0, LEAST, breath_below_speech_db=BREATHS_BELOW_SPEECH_DB
        )

    assert sounds(floor) == []
    (found,) = sounds(breath)
    assert (found.lo, found.hi) == (pytest.approx(399, abs=4), pytest.approx(431, abs=4))


def test_a_click_whose_own_frame_reaches_the_ceiling_stays_whole_though_its_average_does_not():
    # One 10 ms click at -52 dBFS, 37 dB under the -15 dBFS speech: over the ceiling (40 dB
    # under). Its 50 ms average spreads it over five frames at -58.7, under the ceiling, but
    # the click itself reaches it, so it is kept whole and splits the air.
    levels = np.full(800, -70.0)
    levels[400] = -52.0

    assert _sounds(levels) == [Sound(397, 404, False)]


def test_a_sustained_sound_with_one_frame_at_the_ceiling_is_kept_whole_though_its_average_is_not():
    # The low band's room (a 2.7 dB spread at -68 dBFS: line -57.4) with a 300 ms stretch at
    # -62 that never crosses the line and one frame in it at -55, the ceiling for a -15 dBFS
    # speech level. The 50 ms average of that frame (-60.6) stays under both; the frame
    # itself reaches the ceiling, so the sound is not one a trim may remove.
    levels = np.full(800, -68.0)
    levels[400:430] = -62.0
    levels[415] = -55.0

    (sound,) = find_sounds(
        levels,
        Room(-68.0, 2.66),
        -15.0,
        least_spread(RATE, LOW_BAND),
        breath_below_speech_db=BREATHS_BELOW_SPEECH_DB,
        gate_on_speech=False,
    )

    assert (sound.lo, sound.hi, sound.removable) == (398, 432, False)


def test_a_steady_room_alone_holds_no_sound() -> None:
    with_breath = _track()
    with_breath[350:380] += 12.0 * np.sin(np.linspace(0.0, np.pi, 30))

    assert _sounds(_track()) == []
    # The same room with a breath in it holds that breath.
    assert len(_sounds(with_breath)) == 1


def test_a_sound_reaching_the_ceiling_is_not_removable_and_a_quieter_one_is() -> None:
    levels = _track()
    levels[350:370] = -50.0  # 35 dB under the speech: over the ceiling
    levels[420:440] = -62.0  # 47 dB under the speech: under it

    first, second = _sounds(levels)

    assert (first.removable, second.removable) == (False, True)


def test_a_recording_with_no_speech_level_keeps_every_sound_whole() -> None:
    levels = _track()
    levels[420:440] = -62.0  # removable under a -15 dBFS speech level

    assert [s.removable for s in _sounds(levels, speech_db=-15.0)] == [True]
    assert [s.removable for s in _sounds(levels, speech_db=None)] == [False]


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


def test_a_band_with_no_speech_to_measure_it_against_does_not_give_up_on_a_tall_room() -> None:
    # The same -50 room in the low band, whose levels are not the speech's: it is air there
    # unless something rises out of it.
    levels = _track(room_db=-50.0)
    smooth = smoothed(levels)

    sounds = find_sounds(
        levels,
        read_room(smooth, LEAST),
        -15.0,
        LEAST,
        breath_below_speech_db=BREATHS_BELOW_SPEECH_DB,
        gate_on_speech=False,
    )

    assert sounds == []


def test_a_window_of_bleed_with_no_room_in_it_is_one_sound_to_keep_however_tall_it_reads() -> None:
    # Nothing but a peer's voice at -55 to -30 dBFS: its room reads as tall as the bleed
    # itself, so the line sits over the bleed and finds nothing. The track still speaks
    # (its loudest frames stand 25 dB out of its quietest), and a line that reaches into
    # the range breaths sit in cannot tell air from sound.
    levels = np.random.default_rng(12).uniform(-55.0, -30.0, 800)
    smooth = smoothed(levels)
    room = read_room(smooth, LEAST)
    speech = float(np.percentile(levels, 90))

    assert room.line_db > speech
    assert find_sounds(
        levels, room, speech, LEAST, breath_below_speech_db=BREATHS_BELOW_SPEECH_DB
    ) == [Sound(0, 800, False)]


def test_a_mic_that_never_speaks_has_no_speech_to_protect() -> None:
    # Its speech level is its room's own upper edge, under the line: the same -50 room
    # that blocks a speaking track is plain air here.
    levels = _track(room_db=-50.0)
    own_speech = float(np.percentile(levels, 90))

    assert _sounds(levels, speech_db=own_speech) == []
    # Given real speech 35 dB over the same room, that room is one sound to keep.
    assert _sounds(levels, speech_db=-15.0) == [Sound(0, levels.size, False)]


def test_a_stretch_gets_the_same_sounds_whatever_surrounds_it() -> None:
    # The sounds of a recording are a function of its levels and its room alone: the same
    # breath, with different recording around it, is the same sound, and the frames away
    # from it do not move it.
    short = _track(seconds=8.0)
    short[350:380] += 12.0 * np.sin(np.linspace(0.0, np.pi, 30))
    long = np.concatenate([_track(seconds=20.0, seed=9), short])
    room = Room(-69.6, LEAST)

    (here,) = _sounds(short, room=room)
    (there,) = [s for s in _sounds(long, room=room) if s.lo > 2000]

    assert (there.lo - 2000, there.hi - 2000, there.removable) == (here.lo, here.hi, here.removable)


def _talker(seed: int = 5):
    """A recording that talks through the frames a session calls quiet: 3000 frames of room
    at -91 +- 1.7 dB (while its peers talk), and 3000 of speech between -60 and -12 dBFS.

    Returns the smoothed levels and the mask of the frames the session calls quiet (only
    the recording's own speech and 1% of its room)."""
    rng = np.random.default_rng(seed)
    room = _room_levels(3000, -91.0, 1.7, seed=seed)
    speech = rng.uniform(-60.0, -12.0, 3000)
    smooth = smoothed(np.concatenate([room, speech]))
    quiet = np.zeros(smooth.size, dtype=bool)
    quiet[2970:] = True
    return smooth, quiet


def test_a_recording_with_no_words_reads_its_room_where_its_own_levels_pile_up() -> None:
    smooth, quiet = _talker()
    speech = speech_level_db(smooth)

    # Read through the session's silence it takes its own speech for its room.
    through_silence = read_recording_room(smooth, quiet, ~quiet, LEAST, ceiling_db=-52.0)
    assert through_silence is not None
    assert through_silence[0].line_db > -50.0

    read = read_unwatched_room(smooth, LEAST, speech)

    assert read is not None
    room, basis = read
    assert basis is RoomBasis.OWN_LEVELS
    assert room.level_db == pytest.approx(-91.0, abs=0.8)
    assert 0.5 < room.spread_db < 2.5  # the room's, not the speech's tens of dB


def test_a_recording_that_never_speaks_is_a_room_throughout() -> None:
    levels = smoothed(_room_levels(1200, -74.0, 0.8, seed=4))
    speech = speech_level_db(levels)

    assert not speaks(levels, speech)
    assert read_unwatched_room(levels, LEAST, speech) == (
        read_room(levels, LEAST),
        RoomBasis.OWN_LEVELS,
    )


def test_a_recording_with_no_speech_level_at_all_is_a_room_throughout() -> None:
    levels = smoothed(_room_levels(30, -74.0, 0.8, seed=4))

    assert speech_level_db(levels) is None
    assert read_unwatched_room(levels, LEAST, None) == (
        read_room(levels, LEAST),
        RoomBasis.OWN_LEVELS,
    )


def test_a_gate_that_holds_a_talker_at_digital_silence_between_its_words_is_its_room() -> None:
    # Words at -15 dBFS over 40% of the frames and digital silence between them: the live
    # frames are all speech, the gate's silence is the room.
    levels = np.concatenate([np.full(600, DIGITAL_SILENCE_DB), np.full(400, -15.0)] * 3)

    read = read_unwatched_room(levels, LEAST, speech_level_db(levels))

    assert read == (Room(DIGITAL_SILENCE_DB, LEAST), RoomBasis.OWN_LEVELS)


def test_a_talker_with_no_room_mode_falls_back_to_the_low_end_of_all_its_frames() -> None:
    # Levels spread evenly from -60 to -12 pile up nowhere: the room is the 5th percentile.
    smooth = smoothed(np.random.default_rng(2).uniform(-60.0, -12.0, 3000))
    speech = speech_level_db(smooth)

    room, basis = read_unwatched_room(smooth, LEAST, speech)

    assert basis is RoomBasis.OWN_LEVELS
    assert room.level_db == pytest.approx(float(np.percentile(smooth, 5.0)), abs=0.01)
    assert room == read_conservative_room(smooth, LEAST)


def test_the_mode_of_a_track_reports_the_level_it_piles_up_at() -> None:
    rng = np.random.default_rng(8)
    levels = np.concatenate([_room_levels(500, -92.0, 1.5, seed=9), rng.uniform(-90.0, -20.0, 500)])

    mode = read_mode(levels, -50.0, LEAST)

    assert mode is not None
    assert mode.level_db == pytest.approx(-92.0, abs=0.8)
    assert mode.spread_db == pytest.approx(1.5, abs=0.6)
