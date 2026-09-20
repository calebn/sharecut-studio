from __future__ import annotations

from unittest.mock import patch

import pytest

from podcast_mcp.edits.join_modes import crossfade_joins, fade_joins, set_clip_join_mode
from podcast_mcp.edits.timeline_ops import (
    batch_ripple_delete,
    duplicate_segment,
    fill_with_room_tone,
    insert_gap,
    list_clips,
    move_by_text,
    move_segment,
    ripple_delete,
    ripple_delete_text,
    set_clip_fade,
    shorten_word_gaps,
    split_clip,
)
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    CombinedTranscript,
    CombinedUtterance,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _two_track_project() -> EpisodeProject:
    p = EpisodeProject.create("tl_test", "/tmp/ws")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            speaker="Guest",
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        ),
    ]
    for tid in ("host", "guest"):
        p.timeline.clips.append(
            Clip(
                id=f"full_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=10.0,
                timeline_start=0.0,
            )
        )
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=1.0),
                TranscriptWord(text="world", start=8.0, end=9.0),
            ],
        )
    ]
    p.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=1.0,
                text="hello",
            )
        ]
    )
    return p


def test_ripple_delete_shortens_clips() -> None:
    p = _two_track_project()
    summary = ripple_delete(p, 2.0, 5.0)
    assert summary["operation"] == "ripple_delete"
    host_clips = [c for c in p.clips if c.track_id == "host"]
    assert len(host_clips) >= 1
    assert max(c.timeline_start + (c.source_end - c.source_start) for c in host_clips) == 7.0


def test_insert_gap_shifts_clips() -> None:
    p = _two_track_project()
    insert_gap(p, 3.0, 1.0)
    host = sorted((c for c in p.clips if c.track_id == "host"), key=lambda c: c.timeline_start)
    assert len(host) == 2
    assert host[0].timeline_start == pytest.approx(0.0)
    assert host[0].source_end == pytest.approx(3.0)
    assert host[1].timeline_start == pytest.approx(4.0)
    assert host[1].source_start == pytest.approx(3.0)
    assert host[1].source_end == pytest.approx(10.0)


def test_insert_gap_at_clip_boundary_only_shifts_later() -> None:
    p = _two_track_project()
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=3.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=3.0,
            source_end=6.0,
            timeline_start=3.0,
        ),
        Clip(
            id="g",
            track_id="guest",
            source_start=0.0,
            source_end=6.0,
            timeline_start=0.0,
        ),
    ]
    insert_gap(p, 3.0, 0.5)
    host = sorted((c for c in p.clips if c.track_id == "host"), key=lambda c: c.timeline_start)
    assert host[0].timeline_start == pytest.approx(0.0)
    assert host[1].timeline_start == pytest.approx(3.5)


def test_fade_joins_sets_mode_and_caps_fades() -> None:
    p = _two_track_project()
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
            fade_out_ms=0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=2.0,
            source_end=4.0,
            timeline_start=2.0,
            fade_in_ms=0,
        ),
    ]
    summary = fade_joins(p, fade_ms=30)
    assert summary["operation"] == "fade_joins"
    assert summary["join_count"] == 1
    a, b = sorted((c for c in p.clips if c.track_id == "host"), key=lambda c: c.timeline_start)
    assert b.join_in_mode == ClipJoinMode.FADE
    assert a.fade_out_ms <= 40
    assert b.fade_in_ms <= 40


def test_fade_joins_without_explicit_ms() -> None:
    p = _two_track_project()
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=2.0,
            source_end=4.0,
            timeline_start=2.0,
        ),
    ]
    with patch("podcast_mcp.edits.join_modes.recommend_cut_fade_ms", return_value=12):
        summary = fade_joins(p)
    assert summary["join_count"] == 1
    b = next(c for c in p.clips if c.id == "b")
    assert b.join_in_mode == ClipJoinMode.FADE
    assert b.fade_in_ms == 12


def test_crossfade_joins_sets_mode() -> None:
    p = _two_track_project()
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=2.0,
            source_end=4.0,
            timeline_start=2.0,
        ),
    ]
    summary = crossfade_joins(p, fade_ms=40)
    assert summary["operation"] == "crossfade_joins"
    b = next(c for c in p.clips if c.id == "b")
    assert b.join_in_mode == ClipJoinMode.CROSSFADE
    assert b.fade_in_ms == 40


def test_crossfade_joins_default_fade_ms() -> None:
    p = _two_track_project()
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=2.0,
            source_end=4.0,
            timeline_start=2.0,
        ),
    ]
    summary = crossfade_joins(p, defaults={"tighten": {"crossfade_ms": 33}})
    assert summary["fade_ms"] == 33


def test_fade_joins_dry_run_and_speaker_scope() -> None:
    p = _two_track_project()
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=2.0,
            source_end=4.0,
            timeline_start=2.0,
        ),
        Clip(
            id="c",
            track_id="guest",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="d",
            track_id="guest",
            source_start=2.0,
            source_end=4.0,
            timeline_start=2.0,
        ),
    ]
    dry = fade_joins(p, speaker="Host", dry_run=True)
    assert dry["join_count"] == 1
    assert dry["affected_tracks"] == ["host"]
    b = next(c for c in p.clips if c.id == "b")
    assert b.join_in_mode == ClipJoinMode.FADE
    assert b.fade_in_ms == 0


def test_fade_joins_skips_non_abutting_clips() -> None:
    p = _two_track_project()
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=2.0,
            source_end=4.0,
            timeline_start=3.0,
        ),
    ]
    assert fade_joins(p, fade_ms=10)["join_count"] == 0


def test_fade_joins_music_track_not_capped() -> None:
    p = EpisodeProject.create("music", "/tmp/ws")
    p.timeline.tracks = [
        Track(
            id="bed",
            label="Bed",
            role=TrackRole.MUSIC,
            media=MediaAsset(path="raw/bed.wav", duration_sec=10.0),
        )
    ]
    p.clips = [
        Clip(
            id="a",
            track_id="bed",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="bed",
            source_start=2.0,
            source_end=4.0,
            timeline_start=2.0,
        ),
    ]
    fade_joins(p, track_id="bed", fade_ms=40)
    a, b = p.clips
    assert a.fade_out_ms == 40
    assert b.fade_in_ms == 40


def test_list_clips() -> None:
    p = _two_track_project()
    data = list_clips(p)
    assert data["clip_count"] == 2
    assert "host" in data["tracks"]


def test_ripple_delete_text() -> None:
    p = _two_track_project()
    summary = ripple_delete_text(p, "hello", use_inaudible_opt=False)
    assert summary["operation"] == "ripple_delete"


def test_move_segment_preserves_transcript_words() -> None:
    p = _two_track_project()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=1.0),
                TranscriptWord(text="middle", start=2.0, end=3.0),
                TranscriptWord(text="world", start=8.0, end=9.0),
            ],
        )
    ]
    move_segment(p, 2.0, 3.0, 8.0)
    words = p.transcript_for_track("host").words
    texts = [w.text for w in words]
    assert "middle" in texts
    assert "hello" in texts
    assert "world" in texts


def test_move_by_text_prefers_tightest_match() -> None:
    p = _two_track_project()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=1.0),
                TranscriptWord(text="there", start=1.0, end=2.0),
                TranscriptWord(text="friend", start=2.0, end=3.0),
                TranscriptWord(text="world", start=8.0, end=9.0),
            ],
        )
    ]
    p.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=0.0,
                end=3.0,
                text="hello there friend",
            ),
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=8.0,
                end=9.0,
                text="world",
            ),
        ]
    )
    # Utterance match for "there" would be the whole 0-3s line; word match is tighter.
    summary = move_by_text(p, "there", "world", position="before")
    assert summary["source_end"] - summary["source_start"] == pytest.approx(1.0, abs=0.05)


def test_move_resolve_falls_back_to_search_and_rejects_unmapped() -> None:
    from podcast_mcp.edits.timeline_ops import (
        _exact_phrase_match,
        _resolve_move_match,
        _tightest_timeline_match,
    )
    from podcast_mcp.edits.transcript_cuts import TranscriptMatch

    p = _two_track_project()
    assert _exact_phrase_match(p, "   ") is None
    assert _exact_phrase_match(p, "hello there friend world extra") is None
    # Combined-only fuzzy hit (no exact word phrase "hell")
    p.combined_transcript.utterances[0].text = "hello there"
    match = _resolve_move_match(p, "hello", label="source")
    assert match.timeline_start is not None
    with pytest.raises(ValueError, match="no source match"):
        _resolve_move_match(p, "zzznomatchzzz", label="source")
    with pytest.raises(ValueError, match="removed timeline"):
        _tightest_timeline_match(
            [TranscriptMatch(track_id="host", start=0.0, end=1.0, text="x")],
            label="source",
            query="x",
        )


def test_move_by_text() -> None:
    p = _two_track_project()
    p.combined_transcript.utterances.append(
        CombinedUtterance(
            track_id="host",
            speaker="Host",
            start=8.0,
            end=9.0,
            text="world",
        )
    )
    summary = move_by_text(p, "hello", "world", position="before")
    assert summary["operation"] == "move_segment"


def test_move_by_text_uses_timeline_clocks_not_source() -> None:
    """After an early ripple, source word times diverge from timeline - move must use timeline."""
    p = _two_track_project()
    # Cut [1, 3) so later material keeps source times but sits earlier on the timeline.
    ripple_delete(p, 1.0, 3.0)
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="alpha", start=0.0, end=0.8),
                TranscriptWord(text="keep", start=4.0, end=4.5),
                TranscriptWord(text="move", start=5.0, end=5.5),
                TranscriptWord(text="me", start=5.5, end=6.0),
            ],
        )
    ]
    p.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=4.0,
                end=4.5,
                text="keep",
            ),
            CombinedUtterance(
                track_id="host",
                speaker="Host",
                start=5.0,
                end=6.0,
                text="move me",
            ),
        ]
    )
    # Destination "keep" source ends 4.5; timeline ends ~2.5 after the 2s ripple.
    summary = move_by_text(p, "move me", "keep", position="after")
    assert summary["operation"] == "move_segment"
    assert summary["insert_at"] == pytest.approx(2.5, abs=0.15)
    assert summary["source_start"] == pytest.approx(3.0, abs=0.15)


def test_move_by_text_rejects_destination_inside_source() -> None:
    p = _two_track_project()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=1.0),
                TranscriptWord(text="there", start=1.0, end=2.0),
                TranscriptWord(text="world", start=2.0, end=3.0),
            ],
        )
    ]
    with pytest.raises(ValueError, match="inside the source span"):
        move_by_text(p, "hello there world", "there", position="after")


def test_split_clip_and_set_fade() -> None:
    p = _two_track_project()
    split_clip(p, "host", 5.0)
    host_clips = [c for c in p.clips if c.track_id == "host"]
    assert len(host_clips) >= 2
    fade = set_clip_fade(p, host_clips[0].id, 5, 10)
    assert fade["operation"] == "set_clip_fade"
    assert host_clips[0].fade_in_ms == 5


def test_set_clip_fade_caps_dialogue() -> None:
    p = _two_track_project()
    clip = next(c for c in p.clips if c.track_id == "host")
    set_clip_fade(p, clip.id, 40, 50)
    assert clip.fade_in_ms == 40
    assert clip.fade_out_ms == 40


def test_set_clip_join_mode() -> None:
    p = _two_track_project()
    clip = next(c for c in p.clips if c.track_id == "host")
    summary = set_clip_join_mode(p, clip.id, ClipJoinMode.CROSSFADE)
    assert summary["operation"] == "set_clip_join_mode"
    assert clip.join_in_mode == ClipJoinMode.CROSSFADE
    set_clip_join_mode(p, clip.id, "cut")
    assert clip.join_in_mode == ClipJoinMode.CUT


def test_set_clip_join_mode_unknown_id() -> None:
    p = _two_track_project()
    try:
        set_clip_join_mode(p, "missing", ClipJoinMode.FADE)
    except ValueError as exc:
        assert "unknown clip_id" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_duplicate_segment() -> None:
    p = _two_track_project()
    summary = duplicate_segment(p, 1.0, 2.0, 6.0)
    assert summary["operation"] == "duplicate_segment"


def test_paste_segment_after_extract() -> None:
    from podcast_mcp.edits.timeline_ops import paste_segment

    p = _two_track_project()
    extracts = [
        {
            "track_id": "host",
            "source_start": 1.0,
            "source_end": 2.0,
            "relative_timeline_start": 0.0,
        },
        {
            "track_id": "guest",
            "source_start": 1.0,
            "source_end": 2.0,
            "relative_timeline_start": 0.0,
        },
    ]
    before = max((c.timeline_end for c in p.clips), default=0.0)
    summary = paste_segment(p, insert_at=6.0, duration=1.0, extracts=extracts)
    assert summary["operation"] == "paste_segment"
    after = max((c.timeline_end for c in p.clips), default=0.0)
    assert after >= before + 1.0 - 1e-6


def test_shorten_word_gaps() -> None:
    p = _two_track_project()
    summary = shorten_word_gaps(p, max_gap_sec=0.2, use_inaudible_opt=False)
    assert summary["operation"] == "shorten_word_gaps"


def test_batch_ripple_empty_ranges() -> None:
    p = _two_track_project()
    summary = batch_ripple_delete(p, [])
    assert summary["affected_tracks"] == []


def test_fill_with_room_tone_two_clips() -> None:
    p = _two_track_project()
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=4.0,
            source_end=6.0,
            timeline_start=3.0,
        ),
    ]
    summary = fill_with_room_tone(p, "host", sample_duration_sec=0.25)
    assert summary["operation"] == "fill_with_room_tone"
    host = sorted((c for c in p.clips if c.track_id == "host"), key=lambda c: c.timeline_start)
    # 1s gap at 2.0-3.0 tiled with 0.25s samples → 4 fill clips + 2 speech
    assert len(host) == 6
    assert host[0].timeline_end == pytest.approx(2.0)
    assert host[-1].timeline_start == pytest.approx(3.0)
    assert host[-2].timeline_end == pytest.approx(3.0)


def test_ripple_delete_invalid_range() -> None:
    p = _two_track_project()
    try:
        ripple_delete(p, 5.0, 5.0)
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError")


def test_set_clip_fade_unknown_id() -> None:
    p = _two_track_project()
    try:
        set_clip_fade(p, "missing", 0, 0)
    except ValueError as exc:
        assert "unknown clip_id" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_batch_ripple_delete_with_ranges() -> None:
    p = _two_track_project()
    summary = batch_ripple_delete(p, [(2.0, 5.0)], use_inaudible_opt=False)
    assert summary["operation"] == "batch_ripple_delete"
    assert summary["affected_tracks"] == ["host", "guest"]


def test_batch_ripple_delete_with_inaudible_opt() -> None:
    p = _two_track_project()

    def fake_opt(_project, _tid, start, end, force_enabled=None):
        if _tid == "host":
            return type("R", (), {"start": start + 0.1, "end": end - 0.1})()
        return type("R", (), {"start": start, "end": end})()

    with patch(
        "podcast_mcp.edits.timeline_ops.optimize_timeline_cut_range",
        side_effect=fake_opt,
    ):
        summary = batch_ripple_delete(p, [(2.0, 5.0)])
    assert summary["operation"] == "batch_ripple_delete"


def test_batch_ripple_inverted_median_fallback() -> None:
    p = _two_track_project()

    def fake_opt(_project, tid, start, end, force_enabled=None):
        if tid == "host":
            return type("R", (), {"start": end, "end": start})()
        return type("R", (), {"start": start, "end": end})()

    with patch(
        "podcast_mcp.edits.timeline_ops.optimize_timeline_cut_range",
        side_effect=fake_opt,
    ):
        batch_ripple_delete(p, [(2.0, 5.0)])

    host_clips = [c for c in p.clips if c.track_id == "host"]
    assert host_clips


def test_ripple_delete_text_no_match() -> None:
    p = _two_track_project()
    try:
        ripple_delete_text(p, "missing phrase")
    except ValueError as exc:
        assert "no transcript match" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_insert_gap_invalid_duration() -> None:
    p = _two_track_project()
    try:
        insert_gap(p, 1.0, 0.0)
    except ValueError as exc:
        assert "duration_sec must be positive" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_move_segment_invalid_range() -> None:
    p = _two_track_project()
    try:
        move_segment(p, 3.0, 3.0, 5.0)
    except ValueError as exc:
        assert "source_end must be after source_start" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_move_segment_insert_within_source() -> None:
    p = _two_track_project()
    summary = move_segment(p, 1.0, 3.0, 2.0)
    assert summary["operation"] == "move_segment"


def test_move_by_text_no_source_match() -> None:
    p = _two_track_project()
    try:
        move_by_text(p, "missing", "hello")
    except ValueError as exc:
        assert "no source match" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_move_by_text_no_destination_match() -> None:
    p = _two_track_project()
    try:
        move_by_text(p, "hello", "missing")
    except ValueError as exc:
        assert "no destination match" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_split_clip_no_clip_at_time() -> None:
    p = _two_track_project()
    try:
        split_clip(p, "host", 10.0)
    except ValueError as exc:
        assert "no clip at timeline" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_split_clip_applies_micro_fades() -> None:
    p = _two_track_project()
    split_clip(p, "host", 5.0)
    host_clips = sorted(
        (c for c in p.clips if c.track_id == "host"),
        key=lambda c: c.timeline_start,
    )
    assert host_clips[0].fade_out_ms > 0
    assert host_clips[1].fade_in_ms > 0


def test_list_clips_filtered_by_track() -> None:
    p = _two_track_project()
    data = list_clips(p, track_id="host")
    assert data["clip_count"] == 1
    assert "host" in data["tracks"]
    assert "guest" not in data["tracks"]


def test_shorten_word_gaps_merges_overlapping_ranges() -> None:
    p = _two_track_project()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="one", start=0.0, end=0.5),
                TranscriptWord(text="two", start=1.5, end=2.0),
                TranscriptWord(text="three", start=3.5, end=4.0),
            ],
        )
    ]
    summary = shorten_word_gaps(p, max_gap_sec=0.2, use_inaudible_opt=False)
    assert summary["operation"] == "shorten_word_gaps"


def test_fill_with_room_tone_single_clip() -> None:
    p = _two_track_project()
    summary = fill_with_room_tone(p, "host")
    assert summary["operation"] == "fill_with_room_tone"
    assert len([c for c in p.clips if c.track_id == "host"]) == 1


def test_fill_with_room_tone_missing_track() -> None:
    p = _two_track_project()
    p.timeline.tracks = [t for t in p.timeline.tracks if t.id != "host"]
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=4.0,
            source_end=6.0,
            timeline_start=3.0,
        ),
    ]
    with pytest.raises(ValueError, match="not found"):
        fill_with_room_tone(p, "host")


def test_fill_with_room_tone_no_media() -> None:
    p = _two_track_project()
    p.timeline.tracks[0].media = None
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=4.0,
            source_end=6.0,
            timeline_start=3.0,
        ),
    ]
    try:
        fill_with_room_tone(p, "host")
    except ValueError as exc:
        assert "has no media" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_fill_with_room_tone_skips_small_gap() -> None:
    p = _two_track_project()
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=4.0,
            source_end=6.0,
            timeline_start=2.01,
        ),
    ]
    before = len(p.clips)
    fill_with_room_tone(p, "host", min_gap_sec=0.05)
    assert len([c for c in p.clips if c.track_id == "host"]) == before


def test_fill_with_room_tone_uses_word_end_and_short_sample() -> None:
    p = _two_track_project()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hi", start=0.0, end=0.05),
            ],
        )
    ]
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=0.06,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=4.0,
            source_end=6.0,
            timeline_start=1.0,
        ),
    ]
    fill_with_room_tone(p, "host", sample_duration_sec=0.25, min_gap_sec=0.05)
    host_clips = [c for c in p.clips if c.track_id == "host"]
    assert len(host_clips) >= 3


def test_room_tone_helpers_edge_cases() -> None:
    from unittest.mock import patch

    from podcast_mcp.edits.timeline_ops import (
        _expand_intervals,
        _merge_occupied_intervals,
        _own_word_source_occupancy,
        _peer_speech_source_occupancy,
        _room_tone_edge_margin_sec,
    )

    assert _merge_occupied_intervals([]) == []
    assert _merge_occupied_intervals([(0.0, 1.0), (0.5, 1.5), (2.0, 2.5)]) == [
        (0.0, 1.5),
        (2.0, 2.5),
    ]
    assert _expand_intervals([(1.0, 2.0)], margin_sec=0.0, clip_start=0.0, clip_end=5.0) == [
        (1.0, 2.0)
    ]
    assert _expand_intervals([(1.0, 1.0)], margin_sec=0.1, clip_start=1.05, clip_end=1.05) == []

    p = _two_track_project()
    clip = p.clips[0]
    p.transcripts = []
    assert _own_word_source_occupancy(p, "host", clip) == []
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="x", start=1.0, end=1.0)],
        )
    ]
    assert _own_word_source_occupancy(p, "host", clip) == []

    # Peer track with no transcript is a no-op.
    p.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="hi", start=0.0, end=0.2)])
    ]
    assert _peer_speech_source_occupancy(p, "host", clip) == []

    p.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="hi", start=0.0, end=0.2)]),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="zero", start=1.0, end=1.0),
                TranscriptWord(text="far", start=50.0, end=51.0),
                TranscriptWord(text="here", start=2.0, end=2.5),
            ],
        ),
    ]
    # timeline_to_source None → no peer_lo/hi filter; map empty → no occupancy.
    with (
        patch(
            "podcast_mcp.engines.session_timeline.SessionTimeline.timeline_to_source",
            return_value=None,
        ),
        patch(
            "podcast_mcp.engines.session_timeline.SessionTimeline.map_source_span",
            return_value=[],
        ),
    ):
        assert _peer_speech_source_occupancy(p, "host", clip) == []

    # Peer window filter skips far words; overlapping map outside clip is dropped.
    with (
        patch(
            "podcast_mcp.engines.session_timeline.SessionTimeline.timeline_to_source",
            side_effect=lambda _tid, sec: type("S", (), {"__float__": lambda self: float(sec)})(),
        ),
        patch(
            "podcast_mcp.engines.session_timeline.SessionTimeline.map_source_span",
            side_effect=lambda _tid, a, b: [(20.0, 21.0)],  # outside clip 0-10
        ),
    ):
        assert _peer_speech_source_occupancy(p, "host", clip) == []

    assert _room_tone_edge_margin_sec({"tighten": {"room_tone_edge_margin_sec": 0.2}}) == 0.2
    assert _room_tone_edge_margin_sec({"tighten": {"room_tone_edge_margin_sec": "nope"}}) == 0.15
    assert _room_tone_edge_margin_sec({"tighten": {"room_tone_edge_margin_sec": None}}) == 0.15
    assert _room_tone_edge_margin_sec({"tighten": {"room_tone_edge_margin_sec": -1}}) == 0.0


def test_room_tone_span_skips_tiny_right_air_for_long_sample() -> None:
    """Don't tile a multi-second gap with 60ms pre-word air - use left trailing."""
    from podcast_mcp.edits.timeline_ops import _room_tone_source_span

    p = _two_track_project()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="bye", start=1.5, end=1.7),
                TranscriptWord(text="hi", start=4.06, end=4.3),
            ],
        )
    ]
    left = Clip(
        id="a",
        track_id="host",
        source_start=0.0,
        source_end=2.0,
        timeline_start=0.0,
    )
    right = Clip(
        id="b",
        track_id="host",
        source_start=4.0,
        source_end=6.0,
        timeline_start=3.0,
    )
    p.clips = [left, right]
    span = _room_tone_source_span(
        p, "host", left, duration_sec=0.25, right=right, edge_margin_sec=0.05
    )
    assert span is not None
    start, end, _sid = span
    assert end - start == pytest.approx(0.25)
    # Word-free air after "bye" (1.7→2.0), margin 0.05 → 1.75→2.0; take last 0.25s.
    assert start == pytest.approx(1.75)
    assert end == pytest.approx(2.0)


def test_room_tone_span_never_samples_overlapping_words() -> None:
    """Fallback must not tile the last word when trailing air is tiny."""
    from podcast_mcp.edits.timeline_ops import _room_tone_source_span

    p = _two_track_project()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="early", start=0.5, end=0.8),
                TranscriptWord(text="that's,", start=1.7, end=1.95, suppressed=True),
                TranscriptWord(text="hi", start=3.1, end=3.3),
            ],
        )
    ]
    left = Clip(
        id="a",
        track_id="host",
        source_start=0.0,
        source_end=2.0,
        timeline_start=0.0,
    )
    right = Clip(
        id="b",
        track_id="host",
        source_start=3.0,
        source_end=5.0,
        timeline_start=4.0,
    )
    p.clips = [left, right]
    span = _room_tone_source_span(
        p, "host", left, duration_sec=0.25, right=right, edge_margin_sec=0.05
    )
    assert span is not None
    start, end, _sid = span
    # Must come from the gap after "early" (0.8→1.7), not "that's,".
    assert end <= 1.7 + 1e-6
    assert start >= 0.8 - 1e-6
    assert not (start < 1.95 and end > 1.7)


def test_room_tone_span_skips_peer_speech_bleed() -> None:
    """Word-free own-track air is unsafe when a peer is speaking (bleed)."""
    from podcast_mcp.edits.timeline_ops import _room_tone_source_span

    p = _two_track_project()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="yeah", start=1.0, end=1.2),
                TranscriptWord(text="and", start=1.6, end=1.8),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                # Guest talks through host's 1.2-1.6 "air" → bleed on host mic.
                TranscriptWord(text="exactly", start=1.15, end=1.55),
            ],
        ),
    ]
    left = Clip(
        id="a",
        track_id="host",
        source_start=0.0,
        source_end=2.0,
        timeline_start=0.0,
    )
    right = Clip(
        id="b",
        track_id="host",
        source_start=3.0,
        source_end=5.0,
        timeline_start=3.0,
    )
    # Word at right head so leading-air preference does not win.
    p.transcripts[0].words.append(TranscriptWord(text="next", start=3.0, end=3.2))
    p.clips = [
        left,
        right,
        Clip(
            id="g",
            track_id="guest",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        ),
    ]
    span = _room_tone_source_span(
        p, "host", left, duration_sec=0.25, right=right, edge_margin_sec=0.05
    )
    assert span is not None
    start, end, _sid = span
    # Bleed window 1.15-1.55 must not be sampled; nearest full safe gap is
    # pre-speech air ending before "yeah" (margin 0.05 → 0.70-0.95).
    assert not (start < 1.55 and end > 1.15)
    assert start == pytest.approx(0.70)
    assert end == pytest.approx(0.95)


def test_room_tone_span_returns_none_when_only_bleed_air() -> None:
    """Skip fill entirely when the only near-cut air is peer bleed."""
    from podcast_mcp.edits.timeline_ops import _room_tone_source_span

    p = _two_track_project()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=0.0, end=0.2)],
        ),
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="talk", start=0.2, end=2.0)],
        ),
    ]
    left = Clip(
        id="a",
        track_id="host",
        source_start=0.0,
        source_end=2.0,
        timeline_start=0.0,
    )
    p.clips = [
        left,
        Clip(
            id="g",
            track_id="guest",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        ),
    ]
    assert _room_tone_source_span(p, "host", left, duration_sec=0.25, edge_margin_sec=0.05) is None


def test_room_tone_span_skips_digital_silence() -> None:
    """Do not tile gated / digital-silent pre-roll as a fake room-tone bed."""
    from unittest.mock import patch

    from podcast_mcp.edits.timeline_ops import (
        _pick_room_tone_from_gaps,
        _room_tone_min_rms_db,
        _room_tone_source_span,
        _room_tone_span_has_audible_air,
    )

    assert _room_tone_min_rms_db({"tighten": {"room_tone_min_rms_db": -60}}) == -60.0
    assert _room_tone_min_rms_db({"tighten": {"room_tone_min_rms_db": "nope"}}) == -65.0

    p = _two_track_project()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hi", start=1.5, end=1.8)],
        )
    ]
    left = Clip(
        id="a",
        track_id="host",
        source_start=0.0,
        source_end=2.0,
        timeline_start=0.0,
    )
    p.clips = [left]

    with patch(
        "podcast_mcp.engines.audio_audit.measure_window_rms_db",
        return_value=-80.0,
    ):
        assert _room_tone_span_has_audible_air(p, "host", 0.0, 0.25) is False
        assert (
            _room_tone_source_span(p, "host", left, duration_sec=0.25, edge_margin_sec=0.05) is None
        )

    with patch(
        "podcast_mcp.engines.audio_audit.measure_window_rms_db",
        return_value=None,
    ):
        assert _room_tone_span_has_audible_air(p, "host", 0.0, 0.25) is True

    # Prefer a later audible gap over earlier digital silence.
    with patch(
        "podcast_mcp.engines.audio_audit.measure_window_rms_db",
        side_effect=lambda path, s, e, **kw: -80.0 if s < 0.5 else -50.0,
    ):
        span = _pick_room_tone_from_gaps(
            [(0.0, 0.5), (0.9, 1.4)],
            duration_sec=0.25,
            prefer_end=True,
            accept=lambda s, e: _room_tone_span_has_audible_air(p, "host", s, e),
        )
        assert span == pytest.approx((1.15, 1.4))

    # No media → not usable.
    p.tracks[0].media = None
    assert _room_tone_span_has_audible_air(p, "host", 0.0, 0.25) is False


def test_room_tone_span_skips_interword_micro_gap() -> None:
    """Do not tile the tiny air between adjacent words (speech skirts / bleed)."""
    from podcast_mcp.edits.timeline_ops import _room_tone_source_span

    p = _two_track_project()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="student", start=1.0, end=1.3),
                # 0.47s micro-gap - looks empty on ASR but is not room tone.
                TranscriptWord(text="You", start=1.77, end=2.0),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="student", start=1.0, end=1.35),
                TranscriptWord(text="you're", start=1.9, end=2.2),
            ],
        ),
    ]
    left = Clip(
        id="a",
        track_id="host",
        source_start=0.0,
        source_end=2.0,
        timeline_start=0.0,
    )
    p.clips = [
        left,
        Clip(
            id="g",
            track_id="guest",
            source_start=0.0,
            source_end=3.0,
            timeline_start=0.0,
        ),
    ]
    # Default 0.15 margin collapses the micro-gap; pre-speech air (0→1.0)
    # still yields a full 0.25s sample away from the micro-gap.
    span = _room_tone_source_span(p, "host", left, duration_sec=0.25)
    assert span is not None
    start, end, _sid = span
    assert end <= 1.0 + 1e-6
    assert not (start < 1.77 and end > 1.3)

    # When pre-speech air is too short, refuse rather than steal the micro-gap.
    left_short = Clip(
        id="a2",
        track_id="host",
        source_start=1.0,
        source_end=2.0,
        timeline_start=1.0,
    )
    p.clips[0] = left_short
    assert _room_tone_source_span(p, "host", left_short, duration_sec=0.25) is None


def test_room_tone_span_prefers_near_cut_not_first_word() -> None:
    """Long left clips must not sample from the first word (punch-in dialogue bug)."""
    from podcast_mcp.edits.timeline_ops import _room_tone_source_span

    p = _two_track_project()
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="2016", start=0.5, end=1.0),
                TranscriptWord(text="you", start=1.0, end=1.3),
                TranscriptWord(text="so", start=17.5, end=17.9),
                TranscriptWord(text="really", start=19.0, end=19.3),
            ],
        )
    ]
    left = Clip(
        id="a",
        track_id="host",
        source_start=0.0,
        source_end=18.0,
        timeline_start=0.0,
    )
    right = Clip(
        id="b",
        track_id="host",
        source_start=18.5,
        source_end=30.0,
        timeline_start=18.0,
    )
    p.clips = [left, right]
    span = _room_tone_source_span(
        p, "host", left, duration_sec=0.28, right=right, edge_margin_sec=0.05
    )
    assert span is not None
    start, end, _sid = span
    # Must not be the early "you" region (~1.0)
    assert start >= 17.0
    assert end - start == pytest.approx(0.28) or end - start >= 0.05


def test_ripple_delete_median_fallback_when_inverted() -> None:
    p = _two_track_project()

    def fake_opt(_project, tid, start, end, force_enabled=None):
        if tid == "host":
            return type("R", (), {"start": end, "end": start})()
        return type("R", (), {"start": start, "end": end})()

    with patch(
        "podcast_mcp.edits.timeline_ops.optimize_timeline_cut_range",
        side_effect=fake_opt,
    ):
        summary = ripple_delete(p, 2.0, 5.0)
    assert summary["operation"] == "ripple_delete"


def test_move_segment_insert_after_source() -> None:
    p = _two_track_project()
    summary = move_segment(p, 1.0, 2.0, 8.0)
    assert summary["operation"] == "move_segment"


def test_room_tone_source_span_prefers_recorded_bed() -> None:
    from podcast_mcp.edits.timeline_ops import _room_tone_source_span, room_tone_source_id

    p = _two_track_project()
    host = p.track_by_id("host")
    assert host is not None
    host.room_tone = MediaAsset(path="raw/room-tone/p_host.wav", duration_sec=3.0)
    p.sources.append(
        SourceRecording(
            id=room_tone_source_id("host"),
            path="raw/room-tone/p_host.wav",
            duration_sec=3.0,
            sample_rate=48000,
            channels=1,
        )
    )
    left = Clip(
        id="a",
        track_id="host",
        source_start=0.0,
        source_end=2.0,
        timeline_start=0.0,
    )
    span = _room_tone_source_span(p, "host", left, duration_sec=0.25)
    assert span == (0.0, 0.25, room_tone_source_id("host"))


def test_room_tone_bed_span_skips_silent_bed(monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.edits.timeline_ops import _room_tone_bed_span, room_tone_source_id

    p = _two_track_project()
    host = p.track_by_id("host")
    assert host is not None
    host.room_tone = MediaAsset(path="raw/room-tone/p_host.wav", duration_sec=3.0)
    p.sources.append(
        SourceRecording(
            id=room_tone_source_id("host"),
            path="raw/room-tone/p_host.wav",
            duration_sec=3.0,
            sample_rate=48000,
            channels=1,
        )
    )
    monkeypatch.setattr(
        "podcast_mcp.engines.audio_audit.measure_window_rms_db",
        lambda *_args, **_kwargs: -80.0,
    )
    assert _room_tone_bed_span(p, "host", duration_sec=0.25) is None


def test_insert_room_tone_pad_tiles_recorded_bed() -> None:
    from podcast_mcp.edits.timeline_ops import insert_room_tone_pad, room_tone_source_id

    p = _two_track_project()
    host = p.track_by_id("host")
    assert host is not None
    host.room_tone = MediaAsset(path="raw/room-tone/p_host.wav", duration_sec=0.2)
    p.sources.append(
        SourceRecording(
            id=room_tone_source_id("host"),
            path="raw/room-tone/p_host.wav",
            duration_sec=0.2,
            sample_rate=48000,
            channels=1,
        )
    )
    p.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=1.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=1.0, source_end=2.0, timeline_start=1.0),
    ]
    insert_room_tone_pad(p, 1.0, 0.5)
    pads = [
        c for c in p.clips if c.track_id == "host" and c.source_id == room_tone_source_id("host")
    ]
    assert pads
    assert pads[0].source_start == pytest.approx(0.0)
    assert pads[0].fade_in_ms == 10
    assert all(pad.fade_in_ms == 0 for pad in pads[1:])
    assert sum(c.source_end - c.source_start for c in pads) == pytest.approx(0.5)


def test_fill_with_room_tone_prefers_recorded_bed() -> None:
    from podcast_mcp.edits.timeline_ops import room_tone_source_id

    p = _two_track_project()
    host = p.track_by_id("host")
    assert host is not None
    host.room_tone = MediaAsset(path="raw/room-tone/p_host.wav", duration_sec=0.2)
    p.sources.append(
        SourceRecording(
            id=room_tone_source_id("host"),
            path="raw/room-tone/p_host.wav",
            duration_sec=0.2,
            sample_rate=48000,
            channels=1,
        )
    )
    p.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=1.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=1.0, source_end=2.0, timeline_start=1.2),
    ]
    fill_with_room_tone(p, "host", sample_duration_sec=0.2, min_gap_sec=0.05)
    pads = [
        c for c in p.clips if c.track_id == "host" and c.source_id == room_tone_source_id("host")
    ]
    assert pads
    assert sum(c.source_end - c.source_start for c in pads) == pytest.approx(0.2)


def test_insert_room_tone_pad_falls_back_without_bed() -> None:
    from podcast_mcp.edits.timeline_ops import insert_room_tone_pad, room_tone_source_id

    p = _two_track_project()
    p.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=1.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=1.0, source_end=2.0, timeline_start=1.0),
    ]
    insert_room_tone_pad(p, 1.0, 0.2)
    pads = [
        c for c in p.clips if c.track_id == "host" and c.source_id == room_tone_source_id("host")
    ]
    assert pads == []
