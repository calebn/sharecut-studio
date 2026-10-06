"""Word-span plausibility trim (#979).

Synthetic gated tracks: a 180 Hz harmonic "vowel" for voice and digital silence between
words, the shape of the lab recording's Lana track where Whisper stretched ``-huh.`` to
5.84 s and the aligner stretched ``Uh`` to 5.98 s.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.word_spans import (
    WordSpanCaps,
    trim_implausible_words,
    trim_project_word_spans,
)
from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.models import (
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)

RATE = 16_000
CAPS = WordSpanCaps.from_defaults(load_defaults())


def _track(seconds: float, *voice: tuple[float, float]) -> np.ndarray:
    samples = np.zeros(int(seconds * RATE), dtype=np.float32)
    for start, end in voice:
        n = int((end - start) * RATE)
        t = np.arange(n) / RATE
        tone = sum(np.sin(2 * np.pi * 180.0 * k * t) / k for k in range(1, 6))
        tone = tone / np.sqrt(np.mean(tone**2)) * 0.1
        samples[int(start * RATE) : int(start * RATE) + n] = tone.astype(np.float32)
    return samples


def _spans(words: list[TranscriptWord]) -> list[tuple[str, float, float]]:
    return [(w.text, round(w.start, 2), round(w.end, 2)) for w in words]


def test_shipped_caps_class_backchannel_halves_and_fillers_as_short() -> None:
    assert CAPS.cap_for(TranscriptWord(text="-huh.", start=0, end=1)) == 1.0
    assert CAPS.cap_for(TranscriptWord(text="Uh", start=0, end=1)) == 1.0
    assert CAPS.cap_for(TranscriptWord(text="Mm-hmm,", start=0, end=1)) == 1.0
    assert CAPS.cap_for(TranscriptWord(text="fashion", start=0, end=1)) == 2.0


def test_backchannel_over_silence_is_trimmed_onto_its_voice_at_the_end() -> None:
    audio = TrackRmsCache(_track(9.0, (1.0, 1.4), (7.6, 8.0)), RATE)
    words = [
        TranscriptWord(text="hair.", start=1.0, end=1.4),
        TranscriptWord(text="-huh.", start=2.0, end=8.0),
    ]

    assert trim_implausible_words(words, audio, CAPS) == (1, 0)

    assert _spans(words) == [("hair.", 1.0, 1.4), ("-huh.", 7.59, 8.01)]
    assert words[1].trimmed_from == (2.0, 8.0)
    assert words[0].trimmed_from is None


def test_stretch_with_no_voice_inside_keeps_the_last_cap_of_the_span() -> None:
    audio = TrackRmsCache(_track(9.0, (8.3, 8.6)), RATE)
    words = [TranscriptWord(text="Uh", start=2.0, end=7.98)]

    assert trim_implausible_words(words, audio, CAPS) == (1, 0)

    assert _spans(words) == [("Uh", 6.98, 7.98)]


def test_voice_nearest_the_end_wins_and_earlier_runs_join_only_inside_the_cap() -> None:
    audio = TrackRmsCache(_track(9.0, (1.2, 1.5), (6.6, 6.8), (7.0, 7.3)), RATE)
    words = [TranscriptWord(text="Uh", start=1.0, end=8.0)]

    trim_implausible_words(words, audio, CAPS)

    assert _spans(words) == [("Uh", 6.59, 7.31)]


def test_ordinary_word_and_held_word_under_the_cap_are_untouched() -> None:
    audio = TrackRmsCache(_track(4.0, (0.5, 0.9), (1.5, 3.3)), RATE)
    words = [
        TranscriptWord(text="well", start=0.5, end=0.9),
        TranscriptWord(text="soooo", start=1.5, end=3.3),
        TranscriptWord(text="ignored", start=0.0, end=4.0, ignored=True),
    ]
    before = [w.model_dump() for w in words]

    assert trim_implausible_words(words, audio, CAPS) == (0, 0)

    assert [w.model_dump() for w in words] == before


def test_voice_just_past_the_span_end_is_where_the_token_lands() -> None:
    audio = TrackRmsCache(_track(14.0, (2.0, 2.1), (2.7, 2.8), (8.04, 8.7)), RATE)
    words = [
        TranscriptWord(text="-huh.", start=2.0, end=8.0),
        TranscriptWord(text="Big", start=13.0, end=13.4),
    ]

    assert trim_implausible_words(words, audio, CAPS) == (1, 0)

    assert _spans(words) == [("-huh.", 8.03, 8.3), ("Big", 13.0, 13.4)]


def test_voice_past_the_span_end_that_the_next_word_starts_on_stays_with_it() -> None:
    audio = TrackRmsCache(_track(10.0, (7.6, 7.8), (8.04, 8.7)), RATE)
    words = [
        TranscriptWord(text="Uh", start=2.0, end=8.0),
        TranscriptWord(text="-huh.", start=8.04, end=8.7),
    ]

    trim_implausible_words(words, audio, CAPS)

    assert _spans(words) == [("Uh", 7.59, 7.81), ("-huh.", 8.04, 8.7)]


def test_token_holding_more_voice_than_its_cap_is_untouched_and_marked_overlong() -> None:
    audio = TrackRmsCache(_track(7.0, (2.0, 2.4), (3.0, 5.0)), RATE)
    words = [
        TranscriptWord(text="-huh.", start=1.0, end=6.0),
        TranscriptWord(text="soooo", start=6.0, end=6.5),
    ]

    assert trim_implausible_words(words, audio, CAPS) == (0, 1)

    assert _spans(words) == [("-huh.", 1.0, 6.0), ("soooo", 6.0, 6.5)]
    assert [(w.overlong, w.trimmed_from) for w in words] == [(True, None), (False, None)]


def test_ordinary_word_voiced_past_its_cap_is_marked_overlong() -> None:
    audio = TrackRmsCache(_track(5.0, (0.5, 3.5)), RATE)
    words = [TranscriptWord(text="soooo", start=0.5, end=3.5)]

    assert trim_implausible_words(words, audio, CAPS) == (0, 1)

    assert _spans(words) == [("soooo", 0.5, 3.5)]
    assert words[0].overlong is True


def test_second_pass_changes_nothing() -> None:
    audio = TrackRmsCache(_track(30.0, (7.6, 8.0), (18.0, 18.2), (20.0, 23.0), (25.04, 25.5)), RATE)
    words = [
        TranscriptWord(text="-huh.", start=2.0, end=8.0),
        TranscriptWord(text="Uh", start=9.0, end=15.0),
        TranscriptWord(text="anyway", start=15.0, end=18.25),
        TranscriptWord(text="-huh.", start=19.5, end=23.5),
        TranscriptWord(text="Uh", start=23.6, end=25.0),
    ]
    assert trim_implausible_words(words, audio, CAPS) == (4, 1)
    once = [w.model_dump() for w in words]

    assert trim_implausible_words(words, audio, CAPS) == (0, 1)

    assert [w.model_dump() for w in words] == once
    assert [w.trimmed_from for w in words] == [
        (2.0, 8.0),
        (9.0, 15.0),
        (15.0, 18.25),
        None,
        (23.6, 25.0),
    ]
    assert _spans(words)[-1] == ("Uh", 25.03, 25.3)


def _write_wav(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes((samples * 32767).astype("<i2").tobytes())


@pytest.mark.parametrize("readable", [True, False])
def test_project_pass_trims_each_dialogue_transcript_from_its_recording(
    tmp_path: Path, readable: bool
) -> None:
    wav = tmp_path / "raw" / "lana.wav"
    if readable:
        _write_wav(wav, _track(9.0, (7.6, 8.0)))
    else:
        wav.parent.mkdir(parents=True)
        wav.write_bytes(b"not audio")
    project = EpisodeProject.create("trim", str(tmp_path))
    project.tracks.append(
        Track(
            id="lana",
            label="Lana",
            role=TrackRole.DIALOGUE,
            speaker="Lana",
            media=MediaAsset(path="raw/lana.wav"),
        )
    )
    project.transcripts.append(
        Transcript(track_id="lana", words=[TranscriptWord(text="-huh.", start=2.0, end=8.0)])
    )

    counts = trim_project_word_spans(project, load_defaults())

    words = project.transcripts[0].words
    if readable:
        assert counts == {"Track lana": (1, 0)}
        assert _spans(words) == [("-huh.", 7.59, 8.01)]
    else:
        assert counts == {}
        assert _spans(words) == [("-huh.", 2.0, 8.0)]
