from __future__ import annotations

from podcast_mcp.export.transcript import (
    CaptionLimits,
    combined_transcript_markdown,
    resolve_caption_limits,
    utterances_to_srt,
    utterances_to_vtt,
    write_combined_transcript_markdown,
)
from podcast_mcp.models import (
    Clip,
    CombinedTranscript,
    CombinedUtterance,
    EpisodeProject,
    MediaAsset,
    Track,
    Transcript,
    TranscriptWord,
)


def _project_with_combined() -> EpisodeProject:
    project = EpisodeProject.create("export-test", "/tmp/ws")
    project.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.5,
                text="Hello world",
            ),
            CombinedUtterance(
                track_id="guest",
                speaker="Guest",
                start=2.0,
                end=4.25,
                text="Thanks for listening",
            ),
        ]
    )
    return project


def test_combined_transcript_markdown():
    md = combined_transcript_markdown(_project_with_combined())
    assert "# export-test" in md
    assert "**Host** [0.0s]: Hello world" in md
    assert "**Guest** [2.0s]: Thanks for listening" in md


def test_write_combined_transcript_markdown(tmp_path):
    project = EpisodeProject.create("export-test", str(tmp_path))
    project.combined_transcript = _project_with_combined().combined_transcript
    out = write_combined_transcript_markdown(project)
    assert out.is_file()
    assert out.name == "export-test.md"
    assert "Hello world" in out.read_text(encoding="utf-8")


def _project_with_words() -> EpisodeProject:
    """Two short (unsplit) word-timed utterances, on the timeline clock's caption path."""
    project = EpisodeProject.create("export-test", "/tmp/ws")
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Hello", start=0.0, end=0.7),
                TranscriptWord(text="world", start=0.8, end=1.5),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="Thanks", start=2.0, end=2.5),
                TranscriptWord(text="for", start=2.6, end=2.8),
                TranscriptWord(text="listening", start=2.9, end=4.25),
            ],
        ),
    ]
    return project


def test_utterances_to_srt():
    srt = utterances_to_srt(_project_with_words())
    assert "00:00:00,000 --> 00:00:01,500" in srt
    assert "Hello world" in srt
    assert "00:00:02,000 --> 00:00:04,250" in srt


def test_utterances_to_vtt():
    vtt = utterances_to_vtt(_project_with_words())
    assert vtt.startswith("WEBVTT")
    assert "00:00:00.000 --> 00:00:01.500" in vtt
    assert "Thanks for listening" in vtt


def _compressed_project(tmp_path) -> EpisodeProject:
    """Source 0-60 kept, 60-90 cut, 90-200 kept (30s removed at 60s)."""
    project = EpisodeProject.create("compressed", str(tmp_path))
    project.timeline.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav", duration_sec=200.0))
    ]
    project.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=60.0, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=90.0, source_end=200.0, timeline_start=60.0),
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="early", start=10.0, end=12.0),
                TranscriptWord(text="cut", start=70.0, end=72.5),
                TranscriptWord(text="away", start=72.6, end=75.0),
                TranscriptWord(text="later", start=100.0, end=102.0),
            ],
        )
    ]
    return project


def test_srt_uses_timeline_clock_and_drops_cut_utterances(tmp_path):
    srt = utterances_to_srt(_compressed_project(tmp_path))
    # "later" at source 100 must map to timeline 70, not 100.
    assert "00:00:10,000 --> 00:00:12,000" in srt
    assert "00:01:10,000 --> 00:01:12,000" in srt
    assert "later" in srt
    # The utterance entirely inside the removed 60-90s region is dropped.
    assert "cut away" not in srt
    assert "00:01:40" not in srt


def _timed_words(
    tokens: list[str], *, word_dur: float = 0.28, gap: float = 0.07
) -> list[TranscriptWord]:
    words = []
    t = 0.0
    for tok in tokens:
        words.append(TranscriptWord(text=tok, start=round(t, 2), end=round(t + word_dur, 2)))
        t = round(t + word_dur + gap, 2)
    return words


def test_resolve_caption_limits_defaults_and_overrides():
    assert resolve_caption_limits({}) == CaptionLimits(
        max_duration_sec=7.0, max_chars_per_line=42, max_lines=2
    )
    assert resolve_caption_limits(
        {"captions": {"max_duration_sec": 5.0, "max_chars_per_line": 30, "max_lines": 1}}
    ) == CaptionLimits(max_duration_sec=5.0, max_chars_per_line=30, max_lines=1)


def test_long_utterance_splits_at_sentence_boundary_over_duration_cap():
    """One long run (~8.4s) exceeds the 7s default cap; it splits at the sentence period
    rather than at an arbitrary word count, even though duration alone would allow ~20
    words per cue before overflowing (#770)."""
    tokens = [
        "ana",
        "bob",
        "cid",
        "dan",
        "eve",
        "fay",
        "gus",
        "hal",
        "ivy",
        "jon",
        "ken",
        "lea.",
        "mia",
        "nat",
        "oli",
        "pat",
        "quo",
        "ron",
        "sam",
        "tia",
        "uma",
        "van",
        "wes",
        "xen.",
    ]
    project = EpisodeProject.create("long-utterance", "/tmp/ws")
    project.transcripts = [Transcript(track_id="host", words=_timed_words(tokens))]

    srt = utterances_to_srt(project)
    assert srt == (
        "1\n"
        "00:00:00,000 --> 00:00:04,129\n"
        "ana bob cid dan eve fay gus hal ivy jon\n"
        "ken lea.\n"
        "\n"
        "2\n"
        "00:00:04,200 --> 00:00:08,330\n"
        "mia nat oli pat quo ron sam tia uma van\n"
        "wes xen.\n"
    )
    for block in srt.split("\n\n"):
        lines = block.splitlines()[2:]
        assert len(lines) <= 2
        assert all(len(line) <= 42 for line in lines)


def test_long_utterance_respects_custom_limits():
    tokens = [
        "ana",
        "bob",
        "cid",
        "dan",
        "eve",
        "fay",
        "gus",
        "hal",
        "ivy",
        "jon",
        "ken",
        "lea.",
        "mia",
        "nat",
        "oli",
        "pat",
        "quo",
        "ron",
        "sam",
        "tia",
        "uma",
        "van",
        "wes",
        "xen.",
    ]
    project = EpisodeProject.create("long-utterance", "/tmp/ws")
    project.transcripts = [Transcript(track_id="host", words=_timed_words(tokens))]

    srt = utterances_to_srt(
        project, limits=CaptionLimits(max_duration_sec=100.0, max_chars_per_line=10, max_lines=1)
    )
    for block in srt.split("\n\n"):
        lines = block.splitlines()[2:]
        assert len(lines) <= 1
        assert all(len(line) <= 10 for line in lines)


def test_single_word_longer_than_line_limit_is_not_split():
    words = [
        TranscriptWord(text="Short", start=0.0, end=0.3),
        TranscriptWord(text="pneumonoultramicroscopicsilicovolcanoconiosis", start=0.4, end=2.0),
        TranscriptWord(text="word.", start=2.1, end=2.4),
    ]
    project = EpisodeProject.create("long-word", "/tmp/ws")
    project.transcripts = [Transcript(track_id="host", words=words)]

    srt = utterances_to_srt(project)
    # The long word appears intact, whole, on its own cue.
    assert "pneumonoultramicroscopicsilicovolcanoconiosis" in srt
    assert "pneumonoultramicroscopicsilicovolcanoconiosis\n" in srt
    blocks = [b for b in srt.split("\n\n") if b.strip()]
    assert len(blocks) == 3
    assert blocks[1].splitlines()[2] == "pneumonoultramicroscopicsilicovolcanoconiosis"


def test_suppressed_words_are_skipped():
    words = [
        TranscriptWord(text="keep", start=0.0, end=0.3),
        TranscriptWord(text="dropped", start=0.4, end=0.7, suppressed=True),
        TranscriptWord(text="this", start=0.8, end=1.0),
    ]
    project = EpisodeProject.create("suppressed", "/tmp/ws")
    project.transcripts = [Transcript(track_id="host", words=words)]

    srt = utterances_to_srt(project)
    assert "dropped" not in srt
    assert "keep this" in srt
    # The suppressed word is skipped entirely (not just blanked): the surviving words
    # stay one run since only the gap between kept words counts.
    assert "00:00:00,000 --> 00:00:01,000" in srt


def test_phrase_punctuation_is_a_weaker_break_preference_than_sentence():
    """A comma break is only used when no sentence-ending break is available in the window."""
    tokens = ["wan,", "tuo,", "tre,", "forr,", "fivv,", "sixxx,", "sevvn,", "eighht."]
    project = EpisodeProject.create("phrase-break", "/tmp/ws")
    project.transcripts = [
        Transcript(
            track_id="host",
            words=_timed_words(tokens, word_dur=0.05, gap=0.02),
        )
    ]
    srt = utterances_to_srt(
        project, limits=CaptionLimits(max_duration_sec=100.0, max_chars_per_line=12, max_lines=1)
    )
    blocks = [b for b in srt.split("\n\n") if b.strip()]
    # Each 1-line/12-char cue breaks at the nearest comma or period, never mid-clause.
    for b in blocks:
        text = b.splitlines()[2]
        assert text.rstrip().endswith((",", "."))
