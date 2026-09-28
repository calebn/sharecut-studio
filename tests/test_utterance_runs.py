from __future__ import annotations

import random

from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.engines.utterance_runs import utterance_runs, utterance_speaker, utterance_text
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _minimal() -> EpisodeProject:
    p = EpisodeProject.create("gui", "/tmp/gui")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    p.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=5.0, source_end=10.0, timeline_start=5.0),
    ]
    return p


def _random_track_words(rng: random.Random) -> list[TranscriptWord]:
    words: list[TranscriptWord] = []
    t = 0.0
    for i in range(rng.randint(1, 14)):
        t = round(t + rng.choice([0.0, 0.1, 0.2, 0.5, 0.9, 1.5]), 1)
        duration = rng.choice([0.0, 0.0, 0.1, 0.2, 0.3])
        words.append(
            TranscriptWord(
                text=f"w{i}",
                start=t,
                end=round(t + duration, 1),
                suppressed=rng.random() < 0.4,
                ignored=rng.random() < 0.3,
            )
        )
    return words


def test_utterance_runs_empty() -> None:
    assert utterance_runs([]) == []


def test_utterance_runs_splits_only_above_threshold() -> None:
    words = [
        TranscriptWord(text="a", start=0.0, end=0.2),
        TranscriptWord(text="b", start=1.0, end=1.1),
        TranscriptWord(text="c", start=2.0, end=2.1),
    ]
    assert utterance_runs(words) == [range(0, 2), range(2, 3)]


def test_utterance_runs_custom_threshold() -> None:
    words = [
        TranscriptWord(text="a", start=0.0, end=0.2),
        TranscriptWord(text="b", start=1.0, end=1.1),
        TranscriptWord(text="c", start=2.0, end=2.1),
    ]
    assert utterance_runs(words, gap_threshold=0.5) == [range(0, 1), range(1, 2), range(2, 3)]


def test_utterance_speaker_falls_back_to_track_id() -> None:
    p = _minimal()
    p.timeline.tracks[0].speaker = "Ada"
    assert utterance_speaker(p, "host") == "Ada"
    assert utterance_speaker(p, "unknown") == "unknown"
    p.timeline.tracks[0].speaker = None
    assert utterance_speaker(p, "host") == "host"


def test_utterance_text_joins_and_strips() -> None:
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.2),
        TranscriptWord(text="world", start=0.3, end=0.5),
    ]
    assert utterance_text(words) == "hello world"


def test_merge_transcripts_uses_shared_runs() -> None:
    """merge_transcripts equals a brute-force copy of the old buffer/flush loop, on random layouts."""

    def brute_force_merge(project: EpisodeProject) -> list[dict]:
        utterances: list[dict] = []
        for transcript in project.transcripts:
            track = project.track_by_id(transcript.track_id)
            speaker = (track.speaker if track else None) or transcript.track_id
            if not transcript.words:
                continue
            buf: list[TranscriptWord] = []
            gap_threshold = 0.8

            def flush(
                *,
                _buf: list[TranscriptWord] = buf,
                _transcript: Transcript = transcript,
                _speaker: str = speaker,
            ) -> None:
                if not _buf:
                    return
                text = " ".join(w.text for w in _buf).strip()
                utterances.append(
                    {
                        "track_id": _transcript.track_id,
                        "speaker": _speaker,
                        "start": _buf[0].start,
                        "end": _buf[-1].end,
                        "text": text,
                    }
                )
                _buf.clear()

            for word in transcript.words:
                if word.suppressed:
                    continue
                if buf and word.start - buf[-1].end > gap_threshold:
                    flush()
                buf.append(word)
            flush()

        utterances.sort(key=lambda u: u["start"])
        return utterances

    rng = random.Random(758)
    for _ in range(200):
        project = _minimal()
        project.transcripts = [Transcript(track_id="host", words=_random_track_words(rng))]
        expected = brute_force_merge(project)
        actual = TranscriptionEngine().merge_transcripts(project).model_dump()["utterances"]
        actual_compare = [
            {
                "track_id": u["track_id"],
                "speaker": u["speaker"],
                "start": u["start"],
                "end": u["end"],
                "text": u["text"],
            }
            for u in actual
        ]
        assert actual_compare == expected
