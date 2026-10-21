"""A sparse speaker on an ungated track keeps a voice floor (#1324).

Where a speaker talks under a tenth of the time, the track's 90th-percentile level is
room tone, so contrast between voice and room must be read from its loudest frames.
The same recording at any gain gets the same answers by the detectors' one gain contract
(``test_tighten_gain_invariance``).
"""

from __future__ import annotations

from functools import cache
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.word_spans import WordSpanCaps, trim_implausible_words
from podcast_mcp.engines.audio_audit import (
    AnalysisPolicy,
    TrackRmsCache,
    compute_word_audibility_map,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from test_tighten_gain_invariance import RATE, _tone, _write

SECONDS = 120
SPEECH_DB = -26.0
BURST_SEC = 0.6
UH_VOICE = (111.0, 111.31)
UH_TOKEN = (108.0, 114.0)
ON_ROOM = ((104.0, 104.4), (116.0, 116.4))
SPEECH_SHARES = (0.03, 0.06, 0.10)
ROOMS_DB = (-70.0, -55.0)


def _voice(audio: np.ndarray, start: float, end: float, level_db: float) -> None:
    lo, hi = round(start * RATE), round(end * RATE)
    audio[lo:hi] += _tone(hi - lo, level_db)


def _project(tmp_path: Path, audio: np.ndarray, words: list[TranscriptWord]) -> EpisodeProject:
    project = EpisodeProject.create("sparse", str(tmp_path))
    _write(tmp_path / "raw" / "solo.wav", audio, RATE)
    project.timeline.tracks.append(
        Track(
            id="solo",
            label="solo",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/solo.wav", duration_sec=float(SECONDS)),
        )
    )
    project.timeline.clips.append(
        Clip(
            id="c_solo",
            track_id="solo",
            source_start=0.0,
            source_end=float(SECONDS),
            timeline_start=0.0,
        )
    )
    project.transcripts.append(Transcript(track_id="solo", words=words))
    return project


@cache
def _scene(
    speech_share: float, room_db: float
) -> tuple[np.ndarray, tuple[tuple[float, float], ...]]:
    audio = np.random.default_rng(7).normal(0, 10 ** (room_db / 20), SECONDS * RATE)
    uh_sec = UH_VOICE[1] - UH_VOICE[0]
    count = max(1, round((speech_share * SECONDS - uh_sec) / BURST_SEC))
    starts = np.linspace(8.0, 99.0, count)
    bursts = tuple((float(s), float(s) + BURST_SEC) for s in starts)
    for start, end in bursts:
        _voice(audio, start, end, SPEECH_DB)
    _voice(audio, *UH_VOICE, SPEECH_DB)
    return audio, bursts


def _words(bursts: tuple[tuple[float, float], ...]) -> list[TranscriptWord]:
    real = [TranscriptWord(text=f"real{i}", start=s, end=e) for i, (s, e) in enumerate(bursts)]
    ghosts = [TranscriptWord(text=f"ghost{i}", start=s, end=e) for i, (s, e) in enumerate(ON_ROOM)]
    return real + ghosts


@pytest.mark.parametrize("room_db", ROOMS_DB)
@pytest.mark.parametrize("speech_share", SPEECH_SHARES)
def test_words_on_room_tone_are_inaudible(tmp_path: Path, speech_share: float, room_db: float):
    audio, bursts = _scene(speech_share, room_db)
    project = _project(tmp_path, audio, _words(bursts))
    rows = compute_word_audibility_map(project, policy=AnalysisPolicy(), defaults=load_defaults())
    verdicts = {r["text"]: r["audibility_status"] for r in rows}
    expected = {f"real{i}": "audible" for i in range(len(bursts))}
    expected |= {"ghost0": "inaudible", "ghost1": "inaudible"}
    assert verdicts == expected


@pytest.mark.parametrize("room_db", ROOMS_DB)
@pytest.mark.parametrize("speech_share", SPEECH_SHARES)
def test_stretched_token_trims_onto_its_voice(speech_share: float, room_db: float):
    audio, _ = _scene(speech_share, room_db)
    cache = TrackRmsCache(samples=audio, sample_rate=RATE)
    words = [TranscriptWord(text="uh", start=UH_TOKEN[0], end=UH_TOKEN[1])]
    caps = WordSpanCaps.from_defaults({"tighten": {"filler_words": ["uh"]}})
    trim_implausible_words(words, cache, caps)
    assert (round(words[0].start, 1), round(words[0].end, 1)) == (111.0, 111.3)
