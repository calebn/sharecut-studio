"""#945: foreign dialogue on a lane is turned down by a fixed amount, not gated to silence."""

from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import pytest
import yaml

from podcast_mcp.config import load_defaults
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


@pytest.mark.usefixtures("one_phrase_copy_evidence")
@pytest.mark.parametrize(
    ("direct_lag_sec", "colored"),
    [
        pytest.param(0.0, False, id="exact-copy"),
        pytest.param(0.14, True, id="colored-copy-direct-track-140ms-late"),
    ],
)
def test_foreign_copy_on_silent_owner_span_is_turned_down_by_20_db(
    tmp_path: Path, direct_lag_sec: float, colored: bool
) -> None:
    project = _episode(tmp_path, direct_lag_sec=direct_lag_sec, colored=colored)
    before, after = _gated(project, tmp_path)
    assert _gain_db(before, after, 1.05, 2.95) == pytest.approx(-20.0, abs=0.2)
    np.testing.assert_array_equal(after[: round(0.95 * RATE)], before[: round(0.95 * RATE)])
    np.testing.assert_array_equal(after[round(3.05 * RATE) :], before[round(3.05 * RATE) :])


@pytest.mark.usefixtures("one_phrase_copy_evidence")
def test_attenuation_amount_comes_from_pipeline_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    defaults = load_defaults()
    defaults["analysis"]["heuristics"]["bleed_attenuation_db"] = 12.0
    config = tmp_path / "pipeline.yaml"
    config.write_text(yaml.safe_dump(defaults))
    monkeypatch.setenv("PODCAST_MCP_PIPELINE_DEFAULTS", str(config))
    project = _episode(tmp_path)
    before, after = _gated(project, tmp_path)
    assert _gain_db(before, after, 1.05, 2.95) == pytest.approx(-12.0, abs=0.2)


@pytest.mark.usefixtures("one_phrase_copy_evidence")
def test_track_speakers_own_speech_is_untouched(tmp_path: Path) -> None:
    project = _episode(tmp_path, own_overlap=(1.8, 2.2))
    before, after = _gated(project, tmp_path)
    np.testing.assert_array_equal(
        after[round(0.2 * RATE) : round(0.7 * RATE)], before[round(0.2 * RATE) : round(0.7 * RATE)]
    )
    np.testing.assert_array_equal(
        after[round(1.8 * RATE) : round(2.2 * RATE)], before[round(1.8 * RATE) : round(2.2 * RATE)]
    )
    assert _gain_db(before, after, 1.05, 1.6) == pytest.approx(-20.0, abs=0.2)
    assert _gain_db(before, after, 2.4, 2.95) == pytest.approx(-20.0, abs=0.2)


@pytest.mark.usefixtures("one_phrase_copy_evidence")
def test_late_gate_on_the_direct_track_still_turns_the_foreign_copy_down(tmp_path: Path) -> None:
    project = _episode(tmp_path, direct_gated_until=1.15)
    before, after = _gated(project, tmp_path)
    assert _gain_db(before, after, 1.02, 1.15) == pytest.approx(-20.0, abs=0.2)
    assert _gain_db(before, after, 1.15, 2.95) == pytest.approx(-20.0, abs=0.2)


@pytest.mark.usefixtures("one_phrase_copy_evidence")
def test_level_without_a_matching_copy_is_not_foreign_evidence(tmp_path: Path) -> None:
    project = _episode(tmp_path)
    unrelated = _speech(*FOREIGN, seed=99)
    _write_pcm(tmp_path / "raw" / "guest.wav", np.roll(unrelated, round(0.9 * RATE)))
    plan = build_bleed_gate_plan(project, "host")
    assert plan.attenuation_spans == ()
    assert plan.reasons == ("uncertain_foreign_ownership",)


@pytest.mark.usefixtures("one_phrase_copy_evidence")
def test_copy_between_asr_word_spans_is_turned_down_with_the_words(tmp_path: Path) -> None:
    project = _episode(tmp_path, direct_lag_sec=0.14)
    host_words = project.transcript_for_track("host").words
    host_words[1].end = 1.6
    host_words[2].start = 2.4
    before, after = _gated(project, tmp_path)
    assert _gain_db(before, after, 1.6, 2.4) == pytest.approx(-20.0, abs=0.2)


TALK_START = 1.0
LAB_COUPLING_DB = -16.0
LAB_LAG_SEC = 0.14


def _talk_words(end: float) -> list[tuple[float, float]]:
    """Words of uneven length and spacing from 1 s to ``end``, so no shift repeats them."""
    rng = np.random.default_rng(3)
    words: list[tuple[float, float]] = []
    start = TALK_START
    while (finish := start + rng.uniform(0.2, 0.4)) <= end:
        words.append((start, finish))
        start = finish + rng.uniform(0.05, 0.15)
    return words


def _db(samples: np.ndarray) -> float:
    return 10 * np.log10(float(np.mean(samples**2)))


def _peer_voice(words: list[tuple[float, float]], clock: np.ndarray) -> np.ndarray:
    """Separate words, each two syllables of speech-band noise, like the peer's speech."""
    noise = np.convolve(np.random.default_rng(11).normal(0, 1, clock.size), np.ones(16), "same")
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


def _talking_over(
    tmp_path: Path,
    *,
    own: tuple[str, float, float, float] | None = None,
    talk_end: float = 31.0,
    transcribed_at: tuple[float, float] | None = None,
) -> EpisodeProject:
    """The peer talks from 1 s to ``talk_end``; the host mic carries a coloured copy 16 dB down.

    The peer's direct track runs 140 ms late, as on the lab tape. ``own`` adds the
    host's own sound (kind, start, end, level in dB against the direct track) on top
    of the copy.
    """
    duration = talk_end + 1.0
    project = EpisodeProject.create("talking over", str(tmp_path))
    project.ensure_dirs()
    clock = np.arange(int(duration * RATE)) / RATE
    words = _talk_words(talk_end)
    voice = _peer_voice(words, clock)
    talk = slice(round(TALK_START * RATE), round(talk_end * RATE))
    host = _colored(voice)
    host *= 10 ** ((LAB_COUPLING_DB + _db(voice[talk]) - _db(host[talk])) / 20)
    mine = (clock >= 0.2) & (clock < 0.7)
    host[mine] += 0.2 * np.sin(2 * np.pi * 173 * clock[mine])
    if own is not None:
        kind, start, end, level_db = own
        inside = (clock >= start) & (clock < end)
        sound = {
            "laugh": lambda: _laugh(clock, start, end),
            "tone": lambda: np.where(inside, np.sin(2 * np.pi * 181 * clock), 0.0),
        }.get(kind, lambda: _voiced(clock, start, end, {"mm": 1, "uh-huh": 2, "talk": 5}[kind]))()
        window = slice(round(start * RATE), round(end * RATE))
        host += sound * 10 ** ((level_db + _db(voice[talk]) - _db(sound[window])) / 20)
    direct = np.roll(voice, round(LAB_LAG_SEC * RATE))
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
                TranscriptWord(text=f"w{n}", start=start + LAB_LAG_SEC, end=end + LAB_LAG_SEC)
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


def test_pure_foreign_copy_at_lab_coupling_drops_20_db(tmp_path: Path) -> None:
    before, after = _gated_over(_talking_over(tmp_path), tmp_path)
    assert _gain_db(before, after, 1.05, 30.95) == pytest.approx(-20.0, abs=0.2)


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
    project = _talking_over(tmp_path, own=(kind, start, end, level_db))
    before, after = _gated_over(project, tmp_path)
    own = slice(round(start * RATE), round(end * RATE))
    np.testing.assert_array_equal(after[own], before[own])
    assert _gain_db(before, after, 1.05, 3.95) == pytest.approx(-20.0, abs=0.2)
    assert _gain_db(before, after, 7.45, 10.55) == pytest.approx(-20.0, abs=0.2)


@pytest.mark.parametrize("level_db", [-10.0, -8.0, -6.0])
def test_quiet_untranscribed_owner_overlapping_foreign_audio_stays_audible(
    tmp_path: Path, level_db: float
) -> None:
    project = _talking_over(tmp_path, own=("tone", 6.0, 6.6, level_db))
    before, after = _gated_over(project, tmp_path)
    own = slice(round(6.0 * RATE), round(6.6 * RATE))
    np.testing.assert_array_equal(after[own], before[own])
    assert _gain_db(before, after, 1.05, 3.95) == pytest.approx(-20.0, abs=0.2)


def test_backchannel_transcribed_early_is_kept_where_it_sounds(tmp_path: Path) -> None:
    project = _talking_over(tmp_path, own=("uh-huh", 6.2, 6.5, -10.0), transcribed_at=(5.0, 5.3))
    before, after = _gated_over(project, tmp_path)
    own = slice(round(6.2 * RATE), round(6.5 * RATE))
    np.testing.assert_array_equal(after[own], before[own])
    assert _gain_db(before, after, 1.05, 3.95) == pytest.approx(-20.0, abs=0.2)
    assert _gain_db(before, after, 7.45, 10.55) == pytest.approx(-20.0, abs=0.2)


@pytest.mark.parametrize(
    ("talk_end", "attenuated"),
    [
        pytest.param(29.0, False, id="28s-of-peer-speech-abstains"),
        pytest.param(31.0, True, id="30s"),
    ],
)
def test_copy_path_needs_thirty_seconds_of_peer_speech(
    tmp_path: Path, talk_end: float, attenuated: bool
) -> None:
    plan = build_bleed_gate_plan(_talking_over(tmp_path, talk_end=talk_end), "host")
    assert bool(plan.attenuation_spans) is attenuated
    assert plan.reasons == (() if attenuated else ("uncertain_foreign_ownership",))
