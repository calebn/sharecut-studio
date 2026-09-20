from __future__ import annotations

import pytest

from podcast_mcp.edits.transcript_sync import (
    apply_batch_transcript_removes,
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


def _project_with_clip_and_words() -> EpisodeProject:
    p = EpisodeProject.create("sync", "/tmp")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=20.0),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="full",
            track_id="host",
            source_start=0.0,
            source_end=20.0,
            timeline_start=0.0,
        )
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="a", start=0.0, end=1.0),
                TranscriptWord(text="b", start=5.0, end=6.0),
            ],
        )
    ]
    return p


def test_drop_words_in_timeline_range_keeps_source_times() -> None:
    p = _project_with_clip_and_words()
    apply_batch_transcript_removes(p, [(2.0, 4.0)])
    words = p.transcripts[0].words
    assert len(words) == 2
    assert words[1].start == 5.0


def test_apply_batch_transcript_removes_does_not_shift_source_times() -> None:
    p = _project_with_clip_and_words()
    p.transcripts[0].words.append(TranscriptWord(text="late", start=15.0, end=16.0))
    clips_before = {"host": list(p.timeline.clips)}
    apply_batch_transcript_removes(
        p,
        [(2.0, 4.0)],
        rebuild=False,
        clips_before=clips_before,
    )
    words = {w.text: w.start for w in p.transcripts[0].words}
    assert words["a"] == 0.0
    assert words["b"] == 5.0
    assert words["late"] == 15.0


def test_insert_gap_keeps_word_source_times() -> None:
    from podcast_mcp.edits.timeline_ops import insert_gap

    p = _project_with_clip_and_words()
    insert_gap(p, 4.0, 2.0)
    words = {w.text: w.start for w in p.transcripts[0].words}
    # Words stay in source coordinates; only clip placement moves.
    assert words == {"a": 0.0, "b": 5.0}
    clips = [c for c in p.timeline.clips if c.track_id == "host"]
    assert clips[0].timeline_start == 0.0


def test_fill_with_room_tone_keeps_word_source_times() -> None:
    from podcast_mcp.edits.timeline_ops import fill_with_room_tone

    p = _project_with_clip_and_words()
    p.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=10.0, source_end=15.0, timeline_start=6.0),
    ]
    fill_with_room_tone(p, "host")
    words = {w.text: w.start for w in p.transcripts[0].words}
    assert words == {"a": 0.0, "b": 5.0}
    # Fill clips tile across the 5.0-6.0 timeline gap (0.25s samples → 4 tiles).
    fills = [c for c in p.timeline.clips if c.track_id == "host" and c.id not in ("c1", "c2")]
    assert len(fills) == 4
    assert min(c.timeline_start for c in fills) == pytest.approx(5.0)
    assert max(c.timeline_end for c in fills) == pytest.approx(6.0)


def test_timeline_removes_to_source_merges_overlapping() -> None:
    from podcast_mcp.edits.transcript_sync import timeline_removes_to_source_ranges

    clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    merged = timeline_removes_to_source_ranges(clips, [(1.0, 4.0), (3.0, 6.0)])
    assert merged == [(1.0, 6.0)]


def test_apply_batch_transcript_removes_empty_is_noop() -> None:
    p = _project_with_clip_and_words()
    before = list(p.transcripts[0].words)
    apply_batch_transcript_removes(p, [], rebuild=False)
    assert p.transcripts[0].words == before


def test_apply_source_transcript_removes_empty_dict() -> None:
    from podcast_mcp.edits.transcript_sync import apply_source_transcript_removes

    p = _project_with_clip_and_words()
    before = list(p.transcripts[0].words)
    apply_source_transcript_removes(p, {}, rebuild=False)
    assert p.transcripts[0].words == before


def test_strip_silence_transcript_drop_stays_in_source_coords() -> None:
    """Words in removed source ranges are dropped; survivors keep source times."""
    from podcast_mcp.edits.transcript_sync import apply_source_transcript_removes

    p = _project_with_clip_and_words()
    p.transcripts[0].words.append(TranscriptWord(text="cut", start=2.5, end=3.5))
    apply_source_transcript_removes(p, {"host": [(2.0, 4.0)]}, rebuild=False)
    words = {w.text: w.start for w in p.transcripts[0].words}
    assert words == {"a": 0.0, "b": 5.0}


def test_drop_words_skips_when_no_source_ranges() -> None:
    p = EpisodeProject.create("drop-none", "/tmp")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=20.0),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        )
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="keep", start=1.0, end=2.0)],
        )
    ]
    apply_batch_transcript_removes(p, [(20.0, 25.0)])
    assert len(p.transcripts[0].words) == 1
