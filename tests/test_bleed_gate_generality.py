"""The bleed gate keeps own sound over a voiced copy, for speaker pairs other than the lab's.

Written for #1066, whose per-frame pitch and voice gate was rejected; these pin the level
and timbre gate as protections any later rule must keep. The peer speaks with a falling
400 -> 250 Hz contour; the lane's speaker talks at 100-140 Hz. The lane carries the peer's
coloured copy 16 dB down, and the peer's own track runs 140 ms late. #1131 adds a peer
whose track opens late on each word, breaths the peer's call app gates out, a mic noise
floor, and a host who laughs again and again.
"""

from __future__ import annotations

import itertools
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from test_bleed_attenuation import (
    LAB_COUPLING_DB,
    LAB_LAG_SEC,
    TALK_START,
    _colored,
    _db,
    _gated_over,
    _laugh,
    _room_floor,
    _silent,
    _talk_words,
    _unchanged,
)
from test_bleed_gate_regression import RATE, _write_pcm

TALK_END = 31.0
DURATION = TALK_END + 2.0
OWN_WORDS = ((0.2, 0.7), (TALK_END + 0.5, TALK_END + 1.7))
PEER_CONTOUR = (400.0, 250.0)
OWNER_CONTOUR = (100.0, 140.0)


def _tone(
    clock: np.ndarray,
    start: float,
    end: float,
    hz: tuple[float, float],
    tilt: float,
    shaped: bool = True,
) -> np.ndarray:
    """A voiced sound gliding from ``hz[0]`` to ``hz[1]``; harmonics fall off as 1/h**tilt.
    ``shaped`` swells it in and out over its whole length."""
    inside = (clock >= start) & (clock < end)
    local = clock[inside] - start
    f0 = hz[0] + (hz[1] - hz[0]) * local / (end - start)
    phase = 2 * np.pi * np.cumsum(f0) / RATE
    out = np.zeros(clock.size)
    out[inside] = sum(np.sin(h * phase) / h**tilt for h in range(1, 6))
    if shaped:
        out[inside] *= np.sin(np.pi * local / (end - start)) ** 2
    return out


def _peer_voice(
    clock: np.ndarray,
    contour: tuple[float, float],
    tilt: float,
    words: list[tuple[float, float]],
    breaths: tuple[tuple[float, float], ...] = (),
) -> np.ndarray:
    """The peer's words, each a 30 ms consonant burst then a vowel on ``contour``, and
    soft breaths 14 dB under the words."""
    voice = np.zeros(clock.size)
    noise = np.random.default_rng(17).normal(0, 0.5, clock.size)
    for start, end in words:
        voice += _tone(clock, start + 0.03, end, contour, tilt)
        burst = (clock >= start) & (clock < start + 0.03)
        voice[burst] += noise[burst]
    level = voice.std()
    air = np.convolve(np.random.default_rng(19).normal(0, 1, clock.size), np.ones(12) / 12, "same")
    for start, end in breaths:
        breath = air * _envelope(clock, "breath", start, end)
        inside = (clock >= start) & (clock < end)
        voice += breath * 0.2 * level / breath[inside].std()
    return voice * 0.25 / voice.std()


def _envelope(clock: np.ndarray, kind: str, start: float, end: float) -> np.ndarray:
    """The amplitude envelope of an unvoiced own sound, peaking at 1."""
    inside = (clock >= start) & (clock < end)
    local = clock[inside] - start
    out = np.zeros(clock.size)
    if kind == "laugh":
        out[inside] = np.clip(np.sin(2 * np.pi * 6 * local), 0, None) ** 2
    else:
        out[inside] = np.sin(np.pi * local / (end - start)) ** 2
    return out


def _own_sound(clock: np.ndarray, kind: str, start: float, end: float, hz: float) -> np.ndarray:
    """A laugh, a breath, a "sh", or a sound at ``hz``: "mm" and "uh-huh" in one and two
    humps, "talk" as five syllables of continuous phonation with 20 ms edges. The laugh,
    the breath and the "sh" have no pitch: breathy bursts six times a second, low noise
    and rising hiss, each swelling in and out."""
    if kind == "laugh":
        return _laugh(clock, start, end)
    if kind in ("breath", "sh"):
        noise = np.random.default_rng(37).normal(0, 1, clock.size)
        noise = (
            np.convolve(noise, np.ones(12) / 12, mode="same")
            if kind == "breath"
            else np.diff(noise, prepend=0.0)
        )
        return noise * _envelope(clock, kind, start, end)
    tone = _tone(clock, start, end, (hz, hz), 1.0, shaped=False)
    inside = (clock >= start) & (clock < end)
    local = clock[inside] - start
    if kind == "talk":
        edges = np.clip(np.minimum(local, end - start - local) / 0.02, 0, 1)
        tone[inside] *= edges * (0.4 + 0.6 * np.sin(np.pi * 5 * local / (end - start)) ** 2)
        return tone
    humps = {"mm": 1, "uh-huh": 2}[kind]
    tone[inside] *= np.sin(np.pi * humps * local / (end - start)) ** 2
    return tone


def _episode(
    tmp_path: Path,
    *,
    own: tuple[tuple[str, float, float, float, float], ...] = (),
    copy_lift: tuple[float, float, float] | None = None,
    peer_contour: tuple[float, float] = PEER_CONTOUR,
    peer_tilt: float = 1.0,
    owner_contour: tuple[float, float] = OWNER_CONTOUR,
    own_words: tuple[tuple[float, float], ...] = OWN_WORDS,
    peer_words: list[tuple[float, float]] | None = None,
    peer_gate_late: tuple[float, ...] = (),
    peer_breaths: tuple[tuple[float, float], ...] = (),
    room_floor_db: float | None = None,
) -> EpisodeProject:
    """``own``: (kind, start, end, level dB against the direct track, f0 Hz) of the host's
    own sounds. ``copy_lift``: (start, end, dB) raises the copy for a stretch.
    ``owner_contour`` and ``own_words``: the host's transcribed words. ``peer_words``
    replaces the peer's words. ``peer_gate_late``: seconds the peer's own track stays
    shut at the start of each word, cycled over the words, as a call app's gate opens
    late. ``peer_breaths``: the peer's breaths, which the copy carries and the peer's own
    track gates out. ``room_floor_db``: a steady noise bed under the host's mic."""
    project = EpisodeProject.create("own vs copy", str(tmp_path))
    project.ensure_dirs()
    clock = np.arange(int(DURATION * RATE)) / RATE
    words = _talk_words(TALK_END) if peer_words is None else peer_words
    voice = _peer_voice(clock, peer_contour, peer_tilt, words, peer_breaths)
    talk = slice(round(TALK_START * RATE), round(TALK_END * RATE))
    host = _colored(voice)
    host *= 10 ** ((LAB_COUPLING_DB + _db(voice[talk]) - _db(host[talk])) / 20)
    if copy_lift is not None:
        lifted = (clock >= copy_lift[0]) & (clock < copy_lift[1])
        host[lifted] *= 10 ** (copy_lift[2] / 20)
    for start, end in own_words:
        host += 0.2 * _tone(clock, start, end, owner_contour, 1.0) / 1.5
    for kind, start, end, level_db, hz in own:
        sound = _own_sound(clock, kind, start, end, hz)
        window = slice(round(start * RATE), round(end * RATE))
        host += sound * 10 ** ((level_db + _db(voice[talk]) - _db(sound[window])) / 20)
    if room_floor_db is not None:
        host += _room_floor(clock.size, room_floor_db)
    direct = voice.copy()
    for (start, _), late in zip(words, itertools.cycle(peer_gate_late or (0.0,)), strict=False):
        direct[(clock >= start) & (clock < start + late)] = 0.0
    for start, end in peer_breaths:
        direct[(clock >= start) & (clock < end)] = 0.0
    direct = np.roll(direct, round(LAB_LAG_SEC * RATE))
    for track_id, samples in (("host", host), ("guest", direct)):
        _write_pcm(tmp_path / "raw" / f"{track_id}.wav", samples)
        project.timeline.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=DURATION),
                role=TrackRole.DIALOGUE,
                transcript_gate=track_id == "host",
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"clip-{track_id}",
                track_id=track_id,
                source_start=0.0,
                source_end=DURATION,
                timeline_start=0.0,
            )
        )
    host_words = [
        TranscriptWord(text=f"mine{n}", start=start, end=end)
        for n, (start, end) in enumerate(own_words)
    ] + [
        TranscriptWord(
            text=f"w{n}",
            start=start,
            end=end,
            suppressed=True,
            audibility_status="bleed",
            dominant_track="guest",
        )
        for n, (start, end) in enumerate(words)
    ]
    project.transcripts = [
        Transcript(track_id="host", words=sorted(host_words, key=lambda word: word.start)),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text=f"w{n}", start=start + LAB_LAG_SEC, end=end + LAB_LAG_SEC)
                for n, (start, end) in enumerate(words)
            ],
        ),
    ]
    return project


def _touched_percent(
    before: np.ndarray, after: np.ndarray, kind: str, start: float, end: float
) -> float:
    """The share of an unvoiced sound, where its envelope is at least 30% of its peak, that
    the gate changed."""
    envelope = _envelope(np.arange(before.size) / RATE, kind, start, end)
    loud = envelope >= 0.3 * envelope.max()
    return round(100 * np.count_nonzero(after[loud] != before[loud]) / np.count_nonzero(loud), 1)


OWN_OVER_A_VOICED_COPY = [
    pytest.param("mm", 5.0, 5.15, -6.0, 120.0, id="mm-150ms-at-minus-6"),
    pytest.param("uh-huh", 5.0, 5.3, -10.0, 120.0, id="uh-huh-300ms-at-minus-10"),
    pytest.param("laugh", 5.0, 5.8, -1.0, 0.0, id="laugh-at-minus-1"),
    pytest.param("talk", 5.0, 6.2, -2.0, 120.0, id="crosstalk-at-minus-2"),
    pytest.param("talk", 5.0, 6.2, -5.0, 120.0, id="crosstalk-at-minus-5"),
    pytest.param("talk", 5.0, 6.2, -2.0, 230.0, id="crosstalk-near-the-peers-pitch-at-minus-2"),
    pytest.param("talk", 5.0, 6.2, -5.0, 260.0, id="crosstalk-inside-the-peers-range-at-minus-5"),
    pytest.param("mm", 5.0, 5.15, -6.0, 300.0, id="mm-at-the-peers-pitch-at-minus-6"),
]


@pytest.mark.parametrize(("kind", "start", "end", "level_db", "hz"), OWN_OVER_A_VOICED_COPY)
def test_own_sound_over_a_voiced_copy_is_untouched(
    tmp_path: Path, kind: str, start: float, end: float, level_db: float, hz: float
) -> None:
    project = _episode(tmp_path, own=((kind, start, end, level_db, hz),))
    before, after = _gated_over(project, tmp_path)
    _unchanged(before, after, start, end)
    _silent(after, 1.05, 3.95)
    _silent(after, 7.45, 10.55)


LOUD_COPY_RUN = {"copy_lift": (12.0, 16.0, 8.0), "peer_tilt": -1.0}
UNPITCHED_OWN_SOUND_CLEARLY_OVER_THE_COPY = [
    pytest.param("laugh", 5.0, 5.8, 6.0, False, id="laugh-800ms-at-plus-6"),
    pytest.param("laugh", 5.0, 5.8, 8.0, False, id="laugh-800ms-at-plus-8"),
    pytest.param("laugh", 5.0, 5.8, 10.0, False, id="laugh-800ms-at-plus-10"),
    pytest.param("laugh", 5.0, 5.8, 12.0, False, id="laugh-800ms-at-plus-12"),
    pytest.param("laugh", 5.0, 5.25, 10.0, False, id="laugh-250ms-at-plus-10"),
    pytest.param("laugh", 5.0, 5.25, 12.0, False, id="laugh-250ms-at-plus-12"),
    pytest.param("laugh", 20.0, 20.5, 8.0, False, id="laugh-500ms-at-plus-8"),
    pytest.param("laugh", 20.0, 20.5, 10.0, False, id="laugh-500ms-at-plus-10"),
    pytest.param("laugh", 20.0, 20.5, 12.0, False, id="laugh-500ms-at-plus-12"),
    pytest.param("breath", 5.0, 5.1, 4.0, False, id="breath-at-plus-4"),
    pytest.param("breath", 5.0, 5.1, 6.0, False, id="breath-at-plus-6"),
    pytest.param("breath", 5.0, 5.06, 8.0, False, id="60ms-breath-at-plus-8"),
    pytest.param("breath", 5.0, 5.08, 8.0, False, id="80ms-breath-at-plus-8"),
    pytest.param("sh", 5.0, 5.1, 17.2, False, id="sh-at-plus-17"),
    pytest.param("laugh", 13.0, 13.8, 4.0, True, id="laugh-in-a-loud-copy-at-plus-4"),
    pytest.param("laugh", 13.0, 13.8, 6.0, True, id="laugh-in-a-loud-copy-at-plus-6"),
    pytest.param("laugh", 13.0, 13.8, 8.0, True, id="laugh-in-a-loud-copy-at-plus-8"),
    pytest.param("laugh", 13.0, 13.8, 10.0, True, id="laugh-in-a-loud-copy-at-plus-10"),
    pytest.param("laugh", 13.0, 13.8, 12.0, True, id="laugh-in-a-loud-copy-at-plus-12"),
    pytest.param("laugh", 14.0, 14.25, 12.0, True, id="short-laugh-in-a-loud-copy"),
    pytest.param("breath", 14.0, 14.1, 3.0, True, id="breath-in-a-loud-copy"),
    pytest.param("breath", 14.0, 14.06, 6.0, True, id="60ms-breath-in-a-loud-copy"),
    pytest.param("sh", 14.0, 14.1, 16.0, True, id="sh-in-a-loud-copy"),
]


def _beside_the_copy(
    tmp_path: Path, kind: str, start: float, end: float, over_db: float, loud_run: bool
) -> tuple[np.ndarray, np.ndarray]:
    extra = LOUD_COPY_RUN if loud_run else {}
    copy_db = LAB_COUPLING_DB + (8.0 if loud_run else 0.0)
    project = _episode(tmp_path, own=((kind, start, end, copy_db + over_db, 0.0),), **extra)
    return _gated_over(project, tmp_path)


@pytest.mark.parametrize(
    ("kind", "start", "end", "over_db", "loud_run"), UNPITCHED_OWN_SOUND_CLEARLY_OVER_THE_COPY
)
def test_unpitched_own_sound_clearly_over_the_copy_is_untouched(
    tmp_path: Path, kind: str, start: float, end: float, over_db: float, loud_run: bool
) -> None:
    """A laugh, breath or "sh" has no pitch, so nothing but its level and timbre can tell
    it from the copy. ``over_db`` is over the copy there (full band). Many fall in the
    gaps between the peer's words, where the gate expects the copy only as far ahead of
    the peer's track as the copy arrives (#1131)."""
    before, after = _beside_the_copy(tmp_path, kind, start, end, over_db, loud_run)
    _unchanged(before, after, start, end)


def test_a_laugh_4_db_over_the_copy_loses_only_a_burst_on_a_loud_word(tmp_path: Path) -> None:
    """Its last burst falls on a loud word of the peer's, where it stands about 2 dB over
    the copy, less than level and timbre can tell from it."""
    before, after = _beside_the_copy(tmp_path, "laugh", 5.0, 5.8, 4.0, False)
    assert _touched_percent(before, after, "laugh", 5.0, 5.8) <= 5.6


SPEAKER_PAIRS = {
    "same-range": {"owner_contour": (100.0, 140.0), "peer_contour": (145.0, 105.0)},
    "barely-overlapping": {"owner_contour": (100.0, 150.0), "peer_contour": (260.0, 150.0)},
    "too-short-own-range": {"own_words": ((0.2, 0.45),)},
}
OWN_SOUND_FOR_EVERY_PAIR = [
    pytest.param("talk", 5.0, 6.2, -5.0, 120.0, id="crosstalk-at-minus-5"),
    pytest.param("mm", 5.0, 5.15, -6.0, 120.0, id="mm-at-minus-6"),
    pytest.param("talk", 5.0, 6.2, -5.0, 135.0, id="crosstalk-at-135-hz"),
]


@pytest.mark.parametrize("pair", SPEAKER_PAIRS)
@pytest.mark.parametrize(("kind", "start", "end", "level_db", "hz"), OWN_SOUND_FOR_EVERY_PAIR)
def test_own_voice_is_kept_for_other_speaker_pairs(
    tmp_path: Path, pair: str, kind: str, start: float, end: float, level_db: float, hz: float
) -> None:
    """Pairs the lab does not have: the same pitch range, ranges that barely meet, and a
    speaker with too few words to learn a range from."""
    project = _episode(tmp_path, own=((kind, start, end, level_db, hz),), **SPEAKER_PAIRS[pair])
    before, after = _gated_over(project, tmp_path)
    _unchanged(before, after, start, end)
    _silent(after, 1.05, 3.95)
    _silent(after, 7.45, 10.55)


LAUGH_NEAR_THE_COPY = {
    "same-range": {4.0: 1.8, 6.0: 1.8},
    "barely-overlapping": {4.0: 1.8},
    "too-short-own-range": {4.0: 5.6},
}


@pytest.mark.parametrize("pair", SPEAKER_PAIRS)
@pytest.mark.parametrize("over_db", [4.0, 6.0, 8.0, 10.0, 12.0])
def test_a_laugh_is_touched_no_more_than_level_and_timbre_do_for_other_speaker_pairs(
    tmp_path: Path, pair: str, over_db: float
) -> None:
    """``LAUGH_NEAR_THE_COPY``: the share of a laugh whose last burst lands on a loud word,
    where level and timbre cannot tell it from the copy. Every other laugh is untouched."""
    project = _episode(
        tmp_path,
        own=(("laugh", 5.0, 5.8, LAB_COUPLING_DB + over_db, 0.0),),
        **SPEAKER_PAIRS[pair],
    )
    before, after = _gated_over(project, tmp_path)
    touched = _touched_percent(before, after, "laugh", 5.0, 5.8)
    assert touched <= LAUGH_NEAR_THE_COPY[pair].get(over_db, 0.0)


LAUGH_STARTS = (5.0, 14.0, 23.0, 8.0, 17.0, 26.0)
LAUGHS_AT = {4.0: (5.6, 38.2, 0.0, 38.2, 17.0, 1.8), 6.0: (0.0, 0.0, 0.0, 0.0, 0.0, 1.8)}


@pytest.mark.parametrize("over_db", LAUGHS_AT)
@pytest.mark.parametrize("laughs", [4, 5, 6])
def test_a_host_who_laughs_again_and_again_keeps_each_laugh(
    tmp_path: Path, laughs: int, over_db: float
) -> None:
    """#1130's counterexample: untranscribed 800 ms laughs beside the copy, several in the
    peer's gaps. Own sound louder than the copy cannot lengthen how far ahead of the
    peer's track the gate expects the copy, so laughing more does not switch the
    protection off. ``LAUGHS_AT``: the most each laugh may lose; those over 0 have a
    burst on a loud word of the peer's."""
    starts = LAUGH_STARTS[:laughs]
    project = _episode(
        tmp_path,
        own=tuple(("laugh", s, s + 0.8, LAB_COUPLING_DB + over_db, 0.0) for s in starts),
    )
    before, after = _gated_over(project, tmp_path)
    touched = [_touched_percent(before, after, "laugh", s, s + 0.8) for s in starts]
    assert all(t <= most for t, most in zip(touched, LAUGHS_AT[over_db], strict=False)), touched


@pytest.mark.parametrize("floor_db", [-70.0, -60.0])
def test_a_laugh_over_the_copy_on_a_mic_with_a_noise_floor_is_untouched(
    tmp_path: Path, floor_db: float
) -> None:
    """#1130's other counterexample: a steady mic noise floor and no room ring."""
    project = _episode(
        tmp_path, own=(("laugh", 5.0, 5.8, LAB_COUPLING_DB + 6.0, 0.0),), room_floor_db=floor_db
    )
    before, after = _gated_over(project, tmp_path)
    _unchanged(before, after, 5.0, 5.8)
    copy = slice(round(1.05 * RATE), round(3.95 * RATE))
    assert np.sum(after[copy] ** 2) < 10**-1.5 * np.sum(before[copy] ** 2)


def _copy_at_full_level(
    before: np.ndarray,
    after: np.ndarray,
    words: list[tuple[float, float]],
    own: tuple[tuple[float, float], ...] = (),
) -> float:
    """Seconds of the peer's words on the host's lane the gate left untouched, away from
    the host's own words and sounds, in 10 ms blocks."""
    block = RATE // 100
    blocks = before.size // block
    whole = slice(0, blocks * block)
    kept = np.all(
        before[whole].reshape(blocks, block) == after[whole].reshape(blocks, block), axis=1
    ) & np.any(before[whole].reshape(blocks, block) != 0, axis=1)
    clock = np.arange(blocks) / 100
    inside = np.any([(clock >= start) & (clock < end) for start, end in words], axis=0)
    for start, end in [*((s - 0.3, e + 0.3) for s, e in OWN_WORDS), *own]:
        inside &= (clock < start - 0.1) | (clock >= end + 0.1)
    return round(float(np.count_nonzero(kept & inside)) / 100, 2)


LATE_WORDS = _talk_words(TALK_END)
LATE_OPENINGS = tuple(np.random.default_rng(31).uniform(0.03, 0.12, len(LATE_WORDS)).round(3))


def test_laughs_beside_a_peer_whose_track_opens_late_are_kept(tmp_path: Path) -> None:
    """The peer's own track opens 30-120 ms late on every word, as a call app's gate does,
    so its copy here starts first. The gate measures that lead and reads ahead as far,
    so the copy stays reduced as much as before, and the laughs are kept: main cut a
    third of the 500 ms one."""
    laughs = (("laugh", 5.0, 5.8, 6.0), ("laugh", 20.0, 20.5, 8.0))
    project = _episode(
        tmp_path,
        own=tuple((kind, a, b, LAB_COUPLING_DB + over, 0.0) for kind, a, b, over in laughs),
        peer_gate_late=LATE_OPENINGS,
    )
    before, after = _gated_over(project, tmp_path)
    for _, start, end, _ in laughs:
        _unchanged(before, after, start, end)
    spans = tuple((a, b) for _, a, b, _ in laughs)
    assert _copy_at_full_level(before, after, LATE_WORDS, spans) <= 4.07


def _phrases(count: int, words: tuple[int, int]) -> list[tuple[float, float]]:
    """``count`` phrases of ``words[0]`` to ``words[1]`` words of 200-400 ms, 30 ms apart,
    with 300-500 ms between phrases."""
    rng = np.random.default_rng(5)
    spans: list[tuple[float, float]] = []
    start = TALK_START
    for _ in range(count):
        for _ in range(rng.integers(words[0], words[1] + 1)):
            length = rng.uniform(0.2, 0.4)
            spans.append((start, start + length))
            start += length + 0.03
        start += rng.uniform(0.27, 0.47)
    return spans


def test_copy_that_leads_the_peers_track_past_the_read_ahead_is_reduced_as_before(
    tmp_path: Path,
) -> None:
    """Before every fourth phrase the peer breathes for 300 ms, which the copy here
    carries and the peer's call app gates out of their own track. The lane is already
    sounding when the gate's 200 ms read-ahead starts, so those openings count as
    leading by all of it, and the gate keeps reading the full 200 ms rather than the
    lead of the phrases without a breath."""
    words = _phrases(34, (1, 2))
    starts = [b for (_, a), (b, _) in itertools.pairwise(words) if b - a > 0.1]
    breaths = tuple((start - 0.3, start) for start in starts[1::4])
    project = _episode(tmp_path, peer_words=words, peer_breaths=breaths)
    before, after = _gated_over(project, tmp_path)
    assert _copy_at_full_level(before, after, [*words, *breaths]) == 0.0


def test_a_peer_with_too_few_openings_to_measure_keeps_the_full_read_ahead(
    tmp_path: Path,
) -> None:
    """The peer talks without a pause the gate can time: there is no opening to measure
    the copy's lead from, so the gate reads the full 200 ms ahead."""
    words = _phrases(1, (88, 88))
    project = _episode(tmp_path, peer_words=words)
    before, after = _gated_over(project, tmp_path)
    _unchanged(before, after, *OWN_WORDS[0])
    assert _copy_at_full_level(before, after, words) == 0.0
