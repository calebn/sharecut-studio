from pathlib import Path
from types import SimpleNamespace

import pytest

from podcast_mcp.edits.decisions import approve_edits, update_pending_edit
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.edits.pending_preview import _timeline_span
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.transcript_cuts import cut_text_match, cut_words, search_transcript
from podcast_mcp.engines.level_profile import LevelProfile
from podcast_mcp.export.transcript import combined_transcript_markdown
from podcast_mcp.gui.mapper import map_pending_edits_to_timeline
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService


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


def test_pending_source_remove_resizes_on_the_same_unique_placement() -> None:
    project = _two_take_project()
    decision = cut_words(project, "host", 0, 0, source_id="B", use_inaudible_opt=False)

    updated = update_pending_edit(project, decision.id, start=0.05, end=0.45, snap=False)

    assert (updated.start, updated.end) == (0.05, 0.45)
    assert updated.source_id == "B"
    assert updated.source_timeline_span is not None
    assert (updated.source_timeline_span.start, updated.source_timeline_span.end) == pytest.approx(
        (10.05, 10.45)
    )
    assert project.edit_decisions[0] == updated


def test_edit_service_persists_resized_source_geometry(tmp_path: Path) -> None:
    project = _two_take_project()
    project.meta.workspace_dir = str(tmp_path)
    decision = cut_words(project, "host", 0, 0, source_id="B", use_inaudible_opt=False)
    path = save_project(project, tmp_path / "episode.project.json")

    updated = EditService(ProjectWorkspace.open(path)).update_pending(
        decision.id, start=0.05, end=0.45, snap=False
    )
    saved = load_project(path).edit_decisions[0]

    assert (updated.start, updated.end) == (0.05, 0.45)
    assert saved == updated
    assert saved.source_id == "B"
    assert saved.source_timeline_span is not None
    assert (saved.source_timeline_span.start, saved.source_timeline_span.end) == pytest.approx(
        (10.05, 10.45)
    )


@pytest.mark.parametrize("stale_geometry", ["moved", "duplicate", "uncovered"])
def test_pending_source_remove_resize_keeps_geometry_holds(stale_geometry: str) -> None:
    project = _two_take_project()
    decision = cut_words(project, "host", 0, 0, source_id="B", use_inaudible_opt=False)
    if stale_geometry == "moved":
        project.clips[1].timeline_start += 1
        new_bounds = (0.05, 0.45)
    elif stale_geometry == "duplicate":
        project.clips.append(
            Clip(
                id="b-overlap",
                track_id="host",
                source_id="B",
                source_start=1.0,
                source_end=2.0,
                timeline_start=30,
            )
        )
        new_bounds = (1.2, 1.8)
    else:
        new_bounds = (1.9, 2.5)
    before = decision.model_copy(deep=True)

    with pytest.raises(ScopeChangedAtApproval) as held:
        update_pending_edit(
            project,
            decision.id,
            start=new_bounds[0],
            end=new_bounds[1],
            snap=False,
        )

    assert held.value.ids == (decision.id,)
    assert project.edit_decisions[0] == before


@pytest.mark.parametrize("source_id", [None, "B"])
def test_pending_source_remove_snap_keeps_source_identity(source_id, monkeypatch) -> None:
    if source_id == "B":
        project = _two_take_project()
        decision = cut_words(project, "host", 0, 0, source_id="B", use_inaudible_opt=False)
    else:
        project = EpisodeProject.create("primary", "/tmp/primary-source")
        project.tracks = [
            Track(
                id="host",
                label="Host",
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
            )
        ]
        project.clips = [
            Clip(id="primary", track_id="host", source_start=0, source_end=2, timeline_start=10)
        ]
        decision = EditDecision(
            id="primary-cut",
            track_id="host",
            start=0.5,
            end=0.7,
            reason="manual",
            applied=False,
            source_id=None,
            source_timeline_span=RangeInterval(start=10.5, end=10.7),
        )
        project.edit_decisions = [decision]
    observed = {}

    def optimize(_project, track_id, start, end, **kwargs):
        observed.update(track_id=track_id, start=start, end=end, kwargs=kwargs)
        return SimpleNamespace(
            start=start + 0.01,
            end=end - 0.01,
            mode="waveform_only",
            confidence=0.9,
        )

    monkeypatch.setattr("podcast_mcp.edits.decisions.optimize_source_cut_range", optimize)
    updated = update_pending_edit(
        project,
        decision.id,
        start=decision.start,
        end=decision.end,
        snap=True,
    )

    assert (observed["track_id"], observed["start"], observed["end"]) == (
        "host",
        decision.start,
        decision.end,
    )
    assert observed["kwargs"]["source_id"] == source_id
    if source_id is None:
        assert observed["kwargs"] == {"source_id": None}
    else:
        word_index = observed["kwargs"]["word_index"]
        assert isinstance(word_index, CutWordIndex)
        assert word_index.starts == (0.1, 0.5, 2.5, 4.1)
    assert updated.source_id == source_id
    assert (updated.start, updated.end) == pytest.approx(
        (decision.start + 0.01, decision.end - 0.01)
    )
    assert updated.source_timeline_span is not None
    assert (updated.source_timeline_span.start, updated.source_timeline_span.end) == pytest.approx(
        (10 + updated.start, 10 + updated.end)
    )


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


def _primary_alias_project(
    *, combined_only: bool, clip_source_id: str | None = "A"
) -> EpisodeProject:
    project = EpisodeProject.create("primary-alias", "/tmp/primary-alias")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            speaker="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/a.wav", duration_sec=5.0),
        )
    ]
    project.sources = [SourceRecording(id="A", path="raw/a.wav")]
    project.clips = [
        Clip(
            id="a",
            track_id="host",
            source_id=clip_source_id,
            source_start=0,
            source_end=5,
            timeline_start=5,
        )
    ]
    if combined_only:
        from podcast_mcp.models import CombinedTranscript, CombinedUtterance

        project.combined_transcript = CombinedTranscript(
            utterances=[
                CombinedUtterance(track_id="host", speaker="Host", start=1.0, end=1.4, text="hello")
            ]
        )
    else:
        project.transcripts = [
            Transcript(
                track_id="host",
                source_id=None,
                words=[TranscriptWord(text="hello", start=1.0, end=1.4)],
            )
        ]
    return project


def test_primary_transcript_cut_resolves_explicit_same_recording_clip_for_approval() -> None:
    project = _primary_alias_project(combined_only=False)

    decision = cut_text_match(project, "hello", track_id="host", use_inaudible_opt=False)[0]

    assert decision.source_id is None
    assert decision.source_timeline_span is not None
    assert decision.source_timeline_span.model_dump() == {"start": 6.0, "end": 6.4}
    assert approve_edits(project, [decision.id]) == 1
    assert all(not (clip.source_start < 1.4 and clip.source_end > 1.0) for clip in project.clips)


def test_combined_only_primary_alias_maps_pending_preview_and_markdown() -> None:
    project = _primary_alias_project(combined_only=True)

    decision = cut_text_match(project, "hello", track_id="host", use_inaudible_opt=False)[0]
    row = map_pending_edits_to_timeline(project, [decision])[0]

    assert row["mappable"] is True
    assert row["timeline_spans"] == [{"start": 6.0, "end": 6.4}]
    assert _timeline_span(project, decision) == (6.0, 6.4, True)
    approval_project = project.model_copy(deep=True)
    assert approve_edits(approval_project, [decision.id]) == 1
    assert combined_transcript_markdown(project) == ("# primary-alias\n\n**Host** [6.0s]: hello\n")


def test_combined_only_literal_primary_clip_maps_pending_preview_and_markdown() -> None:
    project = _primary_alias_project(combined_only=True, clip_source_id=None)

    decision = cut_text_match(project, "hello", track_id="host", use_inaudible_opt=False)[0]
    row = map_pending_edits_to_timeline(project, [decision])[0]

    assert row["mappable"] is True
    assert row["timeline_spans"] == [{"start": 6.0, "end": 6.4}]
    assert _timeline_span(project, decision) == (6.0, 6.4, True)
    assert combined_transcript_markdown(project) == ("# primary-alias\n\n**Host** [6.0s]: hello\n")


def test_primary_combined_text_does_not_fall_back_to_unrelated_explicit_source() -> None:
    project = _primary_alias_project(combined_only=True, clip_source_id="B")
    project.sources.append(SourceRecording(id="B", path="raw/b.wav"))

    with pytest.raises(ScopeChangedAtApproval, match="selected cut was not applied"):
        cut_text_match(project, "hello", track_id="host", use_inaudible_opt=False)


def test_explicit_primary_alias_without_clips_uses_primary_media() -> None:
    project = _primary_alias_project(combined_only=False)
    project.clips = []

    decision = cut_words(project, "host", 0, 0, source_id="A", use_inaudible_opt=False)
    row = map_pending_edits_to_timeline(project, [decision])[0]

    assert decision.source_timeline_span is not None
    assert decision.source_timeline_span.model_dump() == {"start": 1.0, "end": 1.4}
    assert row["mappable"] is True
    assert _timeline_span(project, decision) == (1.0, 1.4, True)
    assert approve_edits(project.model_copy(deep=True), [decision.id]) == 1

    markdown_project = _primary_alias_project(combined_only=True)
    markdown_project.clips = []
    utterance = markdown_project.combined_transcript.utterances[0]
    markdown_project.combined_transcript.utterances[0] = utterance.model_copy(
        update={"source_id": "A"}
    )

    assert combined_transcript_markdown(markdown_project) == (
        "# primary-alias\n\n**Host** [1.0s]: hello\n"
    )


def test_primary_alias_cut_holds_after_geometry_changes_or_repeats() -> None:
    moved_project = _primary_alias_project(combined_only=False)
    decision = cut_text_match(moved_project, "hello", track_id="host", use_inaudible_opt=False)[0]
    moved_project.clips[0].timeline_start += 1.0

    with pytest.raises(
        ScopeChangedAtApproval, match="no longer has one complete, continuous placement"
    ):
        approve_edits(moved_project, [decision.id])

    repeated_project = _primary_alias_project(combined_only=False)
    repeated_project.clips.append(
        repeated_project.clips[0].model_copy(update={"id": "a-repeat", "timeline_start": 15.0})
    )

    with pytest.raises(ScopeChangedAtApproval, match="selected cut was not applied"):
        cut_text_match(repeated_project, "hello", track_id="host", use_inaudible_opt=False)
