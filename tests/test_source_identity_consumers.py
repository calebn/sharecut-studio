from pathlib import Path

import pytest

from podcast_mcp.edits.decisions import approve_edits
from podcast_mcp.edits.pending_preview import _timeline_span
from podcast_mcp.edits.transcript_cuts import cut_text_match, cut_words, search_transcript
from podcast_mcp.engines.level_profile import LevelProfile
from podcast_mcp.export.transcript import combined_transcript_markdown
from podcast_mcp.gui.mapper import map_pending_edits_to_timeline
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _two_take_project() -> EpisodeProject:
    project = EpisodeProject.create("two-takes", "/tmp/two-takes")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            speaker="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/a.wav", duration_sec=30.0),
        )
    ]
    project.sources = [
        SourceRecording(id="A", path="raw/a.wav"),
        SourceRecording(id="B", path="raw/b.wav"),
    ]
    project.clips = [
        Clip(
            id="a", track_id="host", source_id="A", source_start=0, source_end=2, timeline_start=0
        ),
        Clip(
            id="b1", track_id="host", source_id="B", source_start=0, source_end=2, timeline_start=10
        ),
        Clip(
            id="b2", track_id="host", source_id="B", source_start=4, source_end=6, timeline_start=20
        ),
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            source_id="A",
            words=[TranscriptWord(text="alpha", start=0.1, end=0.4)],
        ),
        Transcript(
            track_id="host",
            source_id="B",
            words=[
                TranscriptWord(text="beta", start=0.1, end=0.4),
                TranscriptWord(text="hidden", start=0.5, end=0.7, suppressed=True),
                TranscriptWord(text="deleted", start=2.5, end=2.8),
                TranscriptWord(text="later", start=4.1, end=4.4),
            ],
        ),
    ]
    return project


def test_search_matches_keep_source_from_combined_and_transcript_branches() -> None:
    matches = search_transcript(_two_take_project(), "beta", track_id="host")

    assert [match.source_id for match in matches if match.utterance_index is not None] == ["B"]
    assert [match.source_id for match in matches if match.word_start_index is not None] == ["B"]


def test_text_match_cut_keeps_matched_source_through_ordinary_approval() -> None:
    project = _two_take_project()
    before_a = [
        (clip.source_start, clip.source_end, clip.timeline_start)
        for clip in project.clips
        if clip.source_id == "A"
    ]

    decision = cut_text_match(project, "beta", track_id="host", use_inaudible_opt=False)[0]

    assert decision.source_id == "B"
    assert decision.source_timeline_span is not None
    assert decision.source_timeline_span.model_dump() == {"start": 10.1, "end": 10.4}
    assert decision.exact_range is None
    assert approve_edits(project, [decision.id]) == 1
    assert [
        (clip.source_start, clip.source_end, clip.timeline_start)
        for clip in project.clips
        if clip.source_id == "A"
    ] == before_a
    assert any(
        clip.source_id == "B" and clip.source_start == pytest.approx(0.4) for clip in project.clips
    )


def test_pending_cut_projection_uses_selected_placement_and_marks_stale() -> None:
    project = _two_take_project()
    decision = cut_words(project, "host", 0, 0, source_id="B", use_inaudible_opt=False)

    row = map_pending_edits_to_timeline(project, [decision])[0]

    assert row["mappable"] is True
    assert row["timeline_spans"] == [{"start": 10.1, "end": 10.4}]
    assert row["source_start_timeline"] == pytest.approx(10.1)
    assert _timeline_span(project, decision) == (10.1, 10.4, True)

    project.clips[1].timeline_start = 11.0
    stale = map_pending_edits_to_timeline(project, [decision])[0]

    assert stale["mappable"] is False
    assert stale["timeline_spans"] == []
    assert _timeline_span(project, decision) == (0.0, 0.0, False)


def test_combined_markdown_uses_each_take_placement_and_drops_unplaced_or_suppressed_words() -> (
    None
):
    project = _two_take_project()

    markdown = combined_transcript_markdown(project)

    assert markdown == (
        "# two-takes\n\n"
        "**Host** [0.1s]: alpha\n\n"
        "**Host** [10.1s]: beta\n\n"
        "**Host** [20.1s]: later\n"
    )
    assert "hidden" not in markdown
    assert "deleted" not in markdown


def test_source_cut_absorbs_trailing_silence_using_selected_source_profile(monkeypatch) -> None:
    from podcast_mcp.edits import inaudible_cuts
    from podcast_mcp.edits.inaudible_cuts import CutWordIndex, InaudibleCutConfig

    project = _two_take_project()
    selected = project.transcript_for_source("host", "B")
    assert selected is not None
    primary_profile = LevelProfile(room_db=-60.0, speech_db=-10.0, loud_db=-8.0)
    selected_profile = LevelProfile(room_db=-75.0, speech_db=-30.0, loud_db=-20.0)
    thresholds: list[float] = []

    monkeypatch.setattr(
        inaudible_cuts, "recording_audio_path", lambda *_args: Path("/virtual/B.wav")
    )
    monkeypatch.setattr(
        inaudible_cuts, "_snap_boundary_to_waveform", lambda _path, at, **_kwargs: at
    )
    monkeypatch.setattr(
        inaudible_cuts,
        "_extend_end_past_trailing_energy",
        lambda _path, _start, end, **_kwargs: (end, False),
    )
    monkeypatch.setattr(inaudible_cuts, "file_level_profile", lambda _path: selected_profile)
    monkeypatch.setattr(inaudible_cuts, "_next_word_start_at_or_after", lambda *_args: 1.6)
    monkeypatch.setattr(
        inaudible_cuts,
        "track_level_profile",
        lambda *_args, **_kwargs: primary_profile,
    )

    def region_is_quiet(*_args, quiet_db: float, **_kwargs) -> bool:
        thresholds.append(quiet_db)
        return quiet_db <= -50.0

    monkeypatch.setattr(inaudible_cuts, "_region_is_quiet", region_is_quiet)
    result = inaudible_cuts.optimize_source_cut_range(
        project,
        "host",
        0.5,
        1.0,
        config=InaudibleCutConfig(absorb_trailing_silence_quiet_over_floor_db=-3.0),
        force_enabled=True,
        source_id="B",
        word_index=CutWordIndex.from_transcript(selected, "host"),
    )

    assert thresholds == [selected_profile.voice_floor_db - 3.0]
    assert result.end == pytest.approx(1.2)
    assert result.details["absorb_trailing_silence"] is True
