"""#945: another speaker's copy on a lane is muted on a gated lane, turned down on a room mic.

``auto`` resolves per lane: a lane that sits at digital silence where nobody talks is
muted, a lane with a room or noise floor is turned down by ``bleed_attenuation_db``.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import pytest
import yaml

from podcast_mcp.config import load_defaults
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.engines.bleed_gate import build_bleed_gate_plan
from podcast_mcp.engines.transcript_gated_play import apply_track_transcript_gate
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from test_bleed_gate_regression import RATE, _read_pcm, _write_pcm

DURATION = 4.0
FOREIGN = (1.0, 3.0)


def _speech(start: float, end: float, seed: int) -> np.ndarray:
    """Syllable-rate noise bursts, so level envelopes rise and fall like a voice."""
    clock = np.arange(int(DURATION * RATE)) / RATE
    inside = (clock >= start) & (clock < end)
    envelope = 0.5 * (1 - np.cos(2 * np.pi * 4 * (clock - start)))
    noise = np.random.default_rng(seed).normal(0, 0.25, clock.size)
    return np.where(inside, noise * envelope, 0.0)


def _colored(samples: np.ndarray) -> np.ndarray:
    """Room coloration: a short reflection and a gentle low-pass."""
    reflected = samples + 0.4 * np.roll(samples, int(0.003 * RATE))
    return np.convolve(reflected, np.ones(6) / 6, mode="same")


def _episode(
    tmp_path: Path,
    *,
    direct_lag_sec: float = 0.0,
    colored: bool = False,
    direct_gated_until: float | None = None,
    own_overlap: tuple[float, float] | None = None,
) -> EpisodeProject:
    """Host mic carries guest bleed 18 dB down; the guest's own track may run late or gate late."""
    project = EpisodeProject.create("bleed attenuation", str(tmp_path))
    project.ensure_dirs()
    clock = np.arange(int(DURATION * RATE)) / RATE
    voice = _speech(*FOREIGN, seed=7)
    direct = np.roll(voice, round(direct_lag_sec * RATE))
    if direct_gated_until is not None:
        direct[clock < direct_gated_until + direct_lag_sec] = 0.0
    host = 0.12 * (_colored(voice) if colored else voice)
    owner = (clock >= 0.2) & (clock < 0.7)
    host[owner] += 0.2 * np.sin(2 * np.pi * 173 * clock[owner])
    if own_overlap is not None:
        overlap = (clock >= own_overlap[0]) & (clock < own_overlap[1])
        host[overlap] += 0.5 * np.sin(2 * np.pi * 191 * clock[overlap])
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
    bleed = {
        "suppressed": True,
        "audibility_status": "bleed",
        "dominant_track": "guest",
    }
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="mine", start=0.25, end=0.65),
                TranscriptWord(text="and", start=1.0, end=2.0, **bleed),
                TranscriptWord(text="then", start=2.0, end=3.0, **bleed),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="and", start=1.0 + direct_lag_sec, end=2.0 + direct_lag_sec),
                TranscriptWord(text="then", start=2.0 + direct_lag_sec, end=3.0 + direct_lag_sec),
            ],
        ),
    ]
    return project


def _gated(project: EpisodeProject, tmp_path: Path) -> tuple[np.ndarray, np.ndarray]:
    source = tmp_path / "raw" / "host.wav"
    output = tmp_path / "gated.wav"
    shutil.copyfile(source, output)
    apply_track_transcript_gate(project, "host", output, timeline_start=0, timeline_end=DURATION)
    return _read_pcm(source).astype(float), _read_pcm(output).astype(float)


def _gain_db(before: np.ndarray, after: np.ndarray, start: float, end: float) -> float:
    window = slice(round(start * RATE), round(end * RATE))
    energy = float(np.sum(before[window] ** 2))
    return 10 * np.log10(float(np.sum(after[window] ** 2)) / energy)


def _silent(after: np.ndarray, start: float, end: float) -> None:
    window = after[round(start * RATE) : round(end * RATE)]
    np.testing.assert_array_equal(window, np.zeros(window.shape))


def _unchanged(before: np.ndarray, after: np.ndarray, start: float, end: float) -> None:
    window = slice(round(start * RATE), round(end * RATE))
    np.testing.assert_array_equal(after[window], before[window])


def _configure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, **heuristics: object) -> None:
    defaults = load_defaults()
    defaults["analysis"]["heuristics"].update(heuristics)
    config = tmp_path / "pipeline.yaml"
    config.write_text(yaml.safe_dump(defaults))
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(config))


@pytest.mark.usefixtures("one_phrase_copy_evidence")
@pytest.mark.parametrize(
    ("direct_lag_sec", "colored"),
    [
        pytest.param(0.0, False, id="exact-copy"),
        pytest.param(0.14, True, id="colored-copy-direct-track-140ms-late"),
    ],
)
def test_foreign_copy_on_a_gated_lane_is_muted(
    tmp_path: Path, direct_lag_sec: float, colored: bool
) -> None:
    project = _episode(tmp_path, direct_lag_sec=direct_lag_sec, colored=colored)
    plan = build_bleed_gate_plan(project, "host")
    assert (plan.reduction, plan.bed_db) == ("mute", -90.0)
    before, after = _gated(project, tmp_path)
    _silent(after, 1.05, 2.95)
    _unchanged(before, after, 0.0, 0.85)
    _unchanged(before, after, 3.2, DURATION)


@pytest.mark.usefixtures("one_phrase_copy_evidence")
def test_attenuate_turns_the_copy_down_by_the_configured_amount(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _configure(monkeypatch, tmp_path, bleed_handling="attenuate", bleed_attenuation_db=12.0)
    project = _episode(tmp_path)
    before, after = _gated(project, tmp_path)
    assert _gain_db(before, after, 1.05, 2.95) == pytest.approx(-12.0, abs=0.2)


@pytest.mark.usefixtures("one_phrase_copy_evidence")
def test_track_speakers_own_speech_is_untouched(tmp_path: Path) -> None:
    project = _episode(tmp_path, own_overlap=(1.8, 2.2))
    before, after = _gated(project, tmp_path)
    _unchanged(before, after, 0.2, 0.7)
    _unchanged(before, after, 1.8, 2.2)
    _silent(after, 1.05, 1.6)
    _silent(after, 2.55, 2.95)


@pytest.mark.usefixtures("one_phrase_copy_evidence")
def test_late_gate_on_the_direct_track_still_mutes_the_foreign_copy(tmp_path: Path) -> None:
    project = _episode(tmp_path, direct_gated_until=1.15)
    _, after = _gated(project, tmp_path)
    _silent(after, 1.05, 2.95)


@pytest.mark.usefixtures("one_phrase_copy_evidence")
def test_level_without_a_matching_copy_is_not_foreign_evidence(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    unrelated = _speech(*FOREIGN, seed=99)
    _write_pcm(tmp_path / "raw" / "guest.wav", np.roll(unrelated, round(0.9 * RATE)))
    plan = build_bleed_gate_plan(project, "host")
    assert plan.attenuation_spans == ()
    assert plan.reasons == ("uncertain_foreign_ownership",)


@pytest.mark.usefixtures("one_phrase_copy_evidence")
@pytest.mark.parametrize(
    "host_bleed_words",
    [
        pytest.param([(1.0, 1.6), (2.4, 3.0)], id="copy-between-asr-word-spans"),
        pytest.param([], id="copy-with-no-word-on-this-lane"),
    ],
)
def test_copy_is_found_from_the_peers_track_not_this_lanes_words(
    tmp_path: Path, host_bleed_words: list[tuple[float, float]]
) -> None:
    project = _episode(tmp_path, direct_lag_sec=0.14)
    transcript = project.transcript_for_track("host")
    transcript.words = [
        transcript.words[0],
        *(
            TranscriptWord(
                text="w",
                start=start,
                end=end,
                suppressed=True,
                audibility_status="bleed",
                dominant_track="guest",
            )
            for start, end in host_bleed_words
        ),
    ]
    _, after = _gated(project, tmp_path)
    _silent(after, 1.05, 2.95)


TALK_START = 1.0
LAB_COUPLING_DB = -16.0
LAB_LAG_SEC = 0.14


def _talk_words(end: float, seed: int = 3) -> list[tuple[float, float]]:
    """Words of uneven length and spacing from 1 s to ``end``, so no shift repeats them."""
    rng = np.random.default_rng(seed)
    words: list[tuple[float, float]] = []
    start = TALK_START
    while (finish := start + rng.uniform(0.2, 0.4)) <= end:
        words.append((start, finish))
        start = finish + rng.uniform(0.05, 0.15)
    return words


def _db(samples: np.ndarray) -> float:
    return 10 * np.log10(float(np.mean(samples**2)))


def _peer_voice(words: list[tuple[float, float]], clock: np.ndarray, seed: int = 11) -> np.ndarray:
    """Separate words, each two syllables of speech-band noise, like the peer's speech."""
    noise = np.convolve(np.random.default_rng(seed).normal(0, 1, clock.size), np.ones(16), "same")
    noise *= 0.25 / noise.std()
    voice = np.zeros(clock.size)
    for start, end in words:
        inside = (clock >= start) & (clock < end)
        local = clock[inside] - start
        shape = np.sin(np.pi * local / (end - start)) ** 2
        voice[inside] = noise[inside] * shape * (0.6 + 0.4 * np.cos(2 * np.pi * 5 * local) ** 2)
    return voice


def _voiced(clock: np.ndarray, start: float, end: float, humps: int) -> np.ndarray:
    """A hummed sound of ``humps`` syllables, like "mm" or "uh-huh"."""
    inside = (clock >= start) & (clock < end)
    local = clock[inside] - start
    tone = sum(np.sin(2 * np.pi * h * 120 * local) / h for h in range(1, 6))
    out = np.zeros(clock.size)
    out[inside] = tone * np.sin(np.pi * humps * local / (end - start)) ** 2
    return out


def _laugh(clock: np.ndarray, start: float, end: float) -> np.ndarray:
    """Breathy bursts six times a second."""
    inside = (clock >= start) & (clock < end)
    local = clock[inside] - start
    out = np.zeros(clock.size)
    burst = np.clip(np.sin(2 * np.pi * 6 * local), 0, None) ** 2
    out[inside] = np.random.default_rng(5).normal(0, 1, local.size) * burst
    return out


def _burst(clock: np.ndarray, start: float, end: float) -> np.ndarray:
    """A plosive release: a short broadband burst."""
    inside = (clock >= start) & (clock < end)
    return np.where(inside, np.random.default_rng(9).normal(0, 1, clock.size), 0.0)


def _room_floor(size: int, level_db: float) -> np.ndarray:
    """Speech-band noise at ``level_db`` dBFS RMS, like a room mic's steady bed."""
    noise = np.convolve(np.random.default_rng(13).normal(0, 1, size), np.ones(16), "same")
    return noise * 10 ** (level_db / 20) / noise.std()


def _own_sound(clock: np.ndarray, kind: str, start: float, end: float) -> np.ndarray:
    if kind == "laugh":
        return _laugh(clock, start, end)
    if kind == "burst":
        return _burst(clock, start, end)
    if kind == "tone":
        return np.where((clock >= start) & (clock < end), np.sin(2 * np.pi * 181 * clock), 0.0)
    return _voiced(clock, start, end, {"mm": 1, "uh-huh": 2, "talk": 5}[kind])


def _talking_over(
    tmp_path: Path,
    *,
    own: tuple[tuple[str, float, float, float], ...] = (),
    talk_end: float = 31.0,
    transcribed_at: tuple[float, float] | None = None,
    lag_sec: float = LAB_LAG_SEC,
    room_floor_db: float | None = None,
    room_floor_spans: tuple[tuple[float, float], ...] | None = None,
    copy_lift: tuple[float, float, float] | None = None,
    channel_copy_db: tuple[float, ...] = (),
    co_talker: bool = False,
) -> EpisodeProject:
    """The peer talks from 1 s to ``talk_end``; the host mic carries a coloured copy 16 dB down.

    ``co_talker`` puts another voice on the host mic instead of the copy: it talks over
    the same stretch at the copy's level, with words of its own.

    The peer's direct track runs ``lag_sec`` late, 140 ms by default as on the lab
    tape. ``own`` adds the host's own sounds (kind, start, end, level in dB against the
    direct track) on top of the copy. ``room_floor_db`` lays a steady noise bed under
    the host track, everywhere or only in ``room_floor_spans``; elsewhere the host track
    is digital silence between sounds, like a call app's gated track. ``copy_lift``
    (start, end, dB) raises the copy for a stretch, as when the peer leans toward the
    host mic. ``channel_copy_db`` writes the host track as one channel per entry, the
    copy there raised or lowered by that many dB, with the own sounds on the first only.
    """
    duration = talk_end + 1.0
    project = EpisodeProject.create("talking over", str(tmp_path))
    project.ensure_dirs()
    clock = np.arange(int(duration * RATE)) / RATE
    words = _talk_words(talk_end)
    voice = _peer_voice(words, clock)
    talk = slice(round(TALK_START * RATE), round(talk_end * RATE))
    host = (
        _peer_voice(_talk_words(talk_end, seed=17), clock, seed=19)
        if co_talker
        else _colored(voice)
    )
    host *= 10 ** ((LAB_COUPLING_DB + _db(voice[talk]) - _db(host[talk])) / 20)
    if copy_lift is not None:
        lifted = (clock >= copy_lift[0]) & (clock < copy_lift[1])
        host[lifted] *= 10 ** (copy_lift[2] / 20)
    mine = (clock >= 0.2) & (clock < 0.7)
    host[mine] += 0.2 * np.sin(2 * np.pi * 173 * clock[mine])
    sounds = np.zeros(clock.size)
    for kind, start, end, level_db in own:
        sound = _own_sound(clock, kind, start, end)
        window = slice(round(start * RATE), round(end * RATE))
        sounds += sound * 10 ** ((level_db + _db(voice[talk]) - _db(sound[window])) / 20)
    if room_floor_db is not None:
        bed = _room_floor(clock.size, room_floor_db)
        if room_floor_spans is not None:
            bed *= np.any([(clock >= a) & (clock < b) for a, b in room_floor_spans], axis=0)
        host += bed
    direct = np.roll(voice, round(lag_sec * RATE))
    if channel_copy_db:
        host = np.column_stack([host * 10 ** (gain / 20) for gain in channel_copy_db])
        host[:, 0] += sounds
    else:
        host += sounds
    for track_id, samples in (("host", host), ("guest", direct)):
        _write_pcm(tmp_path / "raw" / f"{track_id}.wav", samples)
        project.timeline.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=duration),
                role=TrackRole.DIALOGUE,
                transcript_gate=track_id == "host",
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"clip-{track_id}",
                track_id=track_id,
                source_start=0.0,
                source_end=duration,
                timeline_start=0.0,
            )
        )
    host_words = [TranscriptWord(text="mine", start=0.25, end=0.65)]
    if transcribed_at is not None:
        host_words.append(
            TranscriptWord(text="uh-huh", start=transcribed_at[0], end=transcribed_at[1])
        )
    host_words += [
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
                TranscriptWord(text=f"w{n}", start=start + lag_sec, end=end + lag_sec)
                for n, (start, end) in enumerate(words)
            ],
        ),
    ]
    return project


def _gated_over(project: EpisodeProject, tmp_path: Path) -> tuple[np.ndarray, np.ndarray]:
    source = tmp_path / "raw" / "host.wav"
    output = tmp_path / "gated.wav"
    shutil.copyfile(source, output)
    duration = project.timeline.tracks[0].media.duration_sec
    apply_track_transcript_gate(project, "host", output, timeline_start=0, timeline_end=duration)
    return _read_pcm(source).astype(float), _read_pcm(output).astype(float)


def test_pure_foreign_copy_at_lab_coupling_is_muted(tmp_path: Path) -> None:
    _, after = _gated_over(_talking_over(tmp_path), tmp_path)
    _silent(after, 1.05, 30.65)


@pytest.mark.parametrize(
    ("kind", "start", "end", "level_db"),
    [
        pytest.param("mm", 5.0, 5.15, -6.0, id="mm-150ms-at-minus-6"),
        pytest.param("uh-huh", 5.0, 5.3, -10.0, id="uh-huh-300ms-at-minus-10"),
        pytest.param("laugh", 5.0, 5.8, -1.0, id="laugh-at-minus-1"),
        pytest.param("talk", 5.0, 6.2, -2.0, id="crosstalk-at-minus-2"),
        pytest.param("talk", 5.0, 6.2, -5.0, id="crosstalk-at-minus-5"),
    ],
)
def test_own_sound_quieter_than_the_peers_direct_track_is_untouched(
    tmp_path: Path, kind: str, start: float, end: float, level_db: float
) -> None:
    project = _talking_over(tmp_path, own=((kind, start, end, level_db),))
    before, after = _gated_over(project, tmp_path)
    _unchanged(before, after, start, end)
    _silent(after, 1.05, 3.95)
    _silent(after, 7.45, 10.55)


def test_hold_keeps_a_plosive_burst_before_a_transcribed_own_word(tmp_path: Path) -> None:
    """The word's time starts at its vowel; the burst 20-35 ms earlier is the same word.

    The vowel sits under the copy's level, so only the transcript protects it, and the
    15 ms burst is too short to count as own voice by level.
    """
    project = _talking_over(
        tmp_path,
        own=(("burst", 4.965, 4.98, -6.0), ("mm", 5.0, 5.3, -22.0)),
        transcribed_at=(5.0, 5.3),
    )
    before, after = _gated_over(project, tmp_path)
    _unchanged(before, after, 4.965, 5.3)
    _silent(after, 1.05, 3.95)


@pytest.mark.parametrize("level_db", [-10.0, -8.0, -6.0])
def test_quiet_untranscribed_owner_overlapping_foreign_audio_stays_audible(
    tmp_path: Path, level_db: float
) -> None:
    project = _talking_over(tmp_path, own=(("tone", 6.0, 6.6, level_db),))
    before, after = _gated_over(project, tmp_path)
    _unchanged(before, after, 6.0, 6.6)
    _silent(after, 1.05, 3.95)


def test_backchannel_transcribed_early_is_kept_where_it_sounds(tmp_path: Path) -> None:
    project = _talking_over(tmp_path, own=(("uh-huh", 6.2, 6.5, -10.0),), transcribed_at=(5.0, 5.3))
    before, after = _gated_over(project, tmp_path)
    _unchanged(before, after, 6.2, 6.5)
    _silent(after, 1.05, 3.95)
    _silent(after, 7.45, 10.55)


def test_lane_with_a_room_floor_is_turned_down_20_db_not_muted(tmp_path: Path) -> None:
    project = _talking_over(tmp_path, room_floor_db=-60.0)
    plan = build_bleed_gate_plan(project, "host")
    assert plan.reduction == "attenuate"
    assert plan.bed_db == pytest.approx(-60.0, abs=1.0)
    before, after = _gated_over(project, tmp_path)
    assert _gain_db(before, after, 1.05, 30.65) == pytest.approx(-20.0, abs=0.2)


@pytest.mark.parametrize(
    ("room_floor_spans", "bed_db"),
    [
        pytest.param(((0.7, 1.0), (31.0, 31.3)), -90.0, id="gated-with-faint-tone-near-the-copy"),
        pytest.param(None, -76.0, id="steady-tone-below-the-bit-floor-once-turned-down"),
    ],
)
def test_lane_whose_bed_cannot_survive_attenuation_is_muted(
    tmp_path: Path, room_floor_spans: tuple[tuple[float, float], ...] | None, bed_db: float
) -> None:
    """Lab Caleb mic: half its quiet frames are the call app's digital silence, the rest
    room tone near -77 dBFS. Turned down 20 dB, that tone falls under one 16-bit step, so
    attenuating keeps no bed either; the copy tails beside it must not decide."""
    project = _talking_over(tmp_path, room_floor_db=-76.0, room_floor_spans=room_floor_spans)
    plan = build_bleed_gate_plan(project, "host")
    assert plan.reduction == "mute"
    assert plan.bed_db == pytest.approx(bed_db, abs=1.0)
    _, after = _gated_over(project, tmp_path)
    _silent(after, 1.05, 3.95)


def test_own_speech_starting_under_a_louder_copy_tail_is_untouched(tmp_path: Path) -> None:
    """Lab 829.31 "then" and 1108.74 "your": the lane's speaker starts talking 13 dB over
    the copy while the peer's last words, louder than usual on this mic, ring out. The
    seconds of own speech after it hear no copy, so the copy frames before it outvoted
    the onset when the whole run was judged at once."""
    project = _talking_over(
        tmp_path, copy_lift=(29.9, 30.7, 6.0), own=(("talk", 30.55, 31.6, 3.0),)
    )
    before, after = _gated_over(project, tmp_path)
    _unchanged(before, after, 30.55, 31.6)
    _silent(after, 1.05, 3.95)
    _silent(after, 7.45, 10.55)


def test_stereo_lane_keeps_own_speech_in_both_channels(tmp_path: Path) -> None:
    project = _talking_over(tmp_path, own=(("mm", 5.0, 5.15, -6.0),), channel_copy_db=(0.0, 0.0))
    before, after = _gated_over(project, tmp_path)
    assert before.shape == after.shape == (round(32.0 * RATE), 2)
    _unchanged(before, after, 5.0, 5.15)
    _silent(after, 1.05, 3.95)
    _silent(after, 7.45, 10.55)


@pytest.mark.parametrize(
    ("handling", "room_floor_db", "reduction"),
    [
        pytest.param("mute", -60.0, "mute", id="mute-overrides-a-room-floor"),
        pytest.param("attenuate", None, "attenuate", id="attenuate-overrides-a-gated-lane"),
    ],
)
def test_explicit_bleed_handling_overrides_auto(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    handling: str,
    room_floor_db: float | None,
    reduction: str,
) -> None:
    _configure(monkeypatch, tmp_path, bleed_handling=handling)
    project = _talking_over(tmp_path, room_floor_db=room_floor_db)
    assert build_bleed_gate_plan(project, "host").reduction == reduction
    before, after = _gated_over(project, tmp_path)
    if reduction == "mute":
        _silent(after, 1.05, 30.65)
    else:
        assert _gain_db(before, after, 1.05, 30.65) == pytest.approx(-20.0, abs=0.2)


def test_changing_bleed_handling_replans_the_same_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _talking_over(tmp_path)
    assert build_bleed_gate_plan(project, "host").reduction == "mute"
    _configure(monkeypatch, tmp_path, bleed_handling="attenuate")
    assert build_bleed_gate_plan(project, "host").reduction == "attenuate"


@pytest.mark.parametrize(
    ("talk_end", "attenuated"),
    [
        pytest.param(19.0, False, id="18s-of-peer-speech-abstains"),
        pytest.param(21.0, True, id="20s"),
        pytest.param(31.0, True, id="30s"),
    ],
)
def test_strong_copy_path_needs_twenty_seconds_of_peer_speech(
    tmp_path: Path, talk_end: float, attenuated: bool
) -> None:
    plan = build_bleed_gate_plan(_talking_over(tmp_path, talk_end=talk_end), "host")
    assert bool(plan.attenuation_spans) is attenuated
    assert plan.reasons == (() if attenuated else ("uncertain_foreign_ownership",))


def test_short_excerpt_with_a_strong_copy_is_muted(tmp_path: Path) -> None:
    _, after = _gated_over(_talking_over(tmp_path, talk_end=23.0), tmp_path)
    _silent(after, 1.05, 22.65)


@pytest.mark.parametrize("talk_end", [23.0, 31.0])
def test_another_voice_talking_over_the_same_stretch_is_untouched(
    tmp_path: Path, talk_end: float
) -> None:
    project = _talking_over(tmp_path, talk_end=talk_end, co_talker=True)
    plan = build_bleed_gate_plan(project, "host")
    assert plan.attenuation_spans == ()
    assert plan.reasons == ("uncertain_foreign_ownership",)
    before, after = _gated_over(project, tmp_path)
    _unchanged(before, after, 0.0, talk_end + 1.0)


@pytest.mark.parametrize("lag_sec", [0.3, 0.32])
def test_copy_lag_at_or_beyond_the_search_edge_abstains(tmp_path: Path, lag_sec: float) -> None:
    plan = build_bleed_gate_plan(_talking_over(tmp_path, lag_sec=lag_sec), "host")
    assert plan.attenuation_spans == ()
    assert plan.reasons == ("uncertain_foreign_ownership",)


def test_unknown_bleed_handling_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, tmp_path, bleed_handling="gate")
    with pytest.raises(ValueError, match="bleed_handling must be one of"):
        AnalysisPolicy.from_defaults()
