import wave
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.cut_application import apply_auto_edits, approve_edits
from podcast_mcp.edits.cut_placement import CutScopeHold
from podcast_mcp.edits.decisions import update_pending_edit
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.edits.pending_preview import _timeline_span
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.transcript_cuts import cut_text_match, cut_words
from podcast_mcp.edits.transcript_search import search_transcript
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


def _two_take_project(tmp_path) -> EpisodeProject:
    project = EpisodeProject.create("two-takes", str(tmp_path))
    for name in ("a", "b"):
        _write_quiet_recording(tmp_path / f"raw/{name}.wav", seconds=30)
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


def test_search_matches_keep_source_from_combined_and_transcript_branches(tmp_path) -> None:
    matches = search_transcript(
        _two_take_project(tmp_path), "beta", track_id="host", defaults=load_defaults()
    )

    assert [match.source_id for match in matches if match.utterance_index is not None] == ["B"]
    assert [match.source_id for match in matches if match.word_start_index is not None] == ["B"]


def test_text_match_cut_keeps_matched_source_through_ordinary_approval(tmp_path) -> None:
    project = _two_take_project(tmp_path)
    before_a = [
        (clip.source_start, clip.source_end, clip.timeline_start)
        for clip in project.clips
        if clip.source_id == "A"
    ]

    decision = cut_text_match(
        project, "beta", track_id="host", use_inaudible_opt=False, defaults=load_defaults()
    )[0]

    assert decision.source_id == "B"
    assert decision.source_timeline_span is not None
    assert decision.source_timeline_span.model_dump() == {"start": 10.1, "end": 10.4}
    assert decision.exact_range is None
    assert approve_edits(project, [decision.id], defaults=load_defaults()) == 1
    assert [
        (clip.source_start, clip.source_end, clip.timeline_start)
        for clip in project.clips
        if clip.source_id == "A"
    ] == before_a
    assert any(
        clip.source_id == "B" and clip.source_start == pytest.approx(0.4) for clip in project.clips
    )


def test_pending_cut_projection_uses_selected_placement_and_marks_stale(tmp_path) -> None:
    project = _two_take_project(tmp_path)
    decision = cut_words(
        project, "host", 0, 0, source_id="B", use_inaudible_opt=False, defaults=load_defaults()
    )

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


def test_pending_source_remove_resizes_on_the_same_unique_placement(tmp_path) -> None:
    project = _two_take_project(tmp_path)
    decision = cut_words(
        project, "host", 0, 0, source_id="B", use_inaudible_opt=False, defaults=load_defaults()
    )

    updated = update_pending_edit(
        project, decision.id, start=0.05, end=0.45, snap=False, defaults=load_defaults()
    )

    assert (updated.start, updated.end) == (0.05, 0.45)
    assert updated.source_id == "B"
    assert updated.source_timeline_span is not None
    assert (updated.source_timeline_span.start, updated.source_timeline_span.end) == pytest.approx(
        (10.05, 10.45)
    )
    assert project.edit_decisions[0] == updated


def test_edit_service_persists_resized_source_geometry(tmp_path: Path) -> None:
    project = _two_take_project(tmp_path)
    project.meta.workspace_dir = str(tmp_path)
    decision = cut_words(
        project, "host", 0, 0, source_id="B", use_inaudible_opt=False, defaults=load_defaults()
    )
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


@pytest.mark.parametrize(
    ("snap", "requested_range"),
    [(False, (2.1, 2.3)), (True, (0.1, 0.3))],
)
def test_edit_service_resize_does_not_retarget_another_source_occurrence(
    tmp_path: Path, monkeypatch, snap: bool, requested_range: tuple[float, float]
) -> None:
    project = _two_take_project(tmp_path)
    project.meta.workspace_dir = str(tmp_path)
    project.clips[1].source_end = 1.0
    project.clips[2].source_start = 2.0
    project.clips[2].source_end = 3.0
    project.clips[2].timeline_start = 30.0
    selected = project.transcript_for_source("host", "B")
    assert selected is not None
    selected.words[0].end = 0.3
    decision = cut_words(
        project, "host", 0, 0, source_id="B", use_inaudible_opt=False, defaults=load_defaults()
    )
    assert decision.source_timeline_span is not None
    assert (
        decision.source_timeline_span.start,
        decision.source_timeline_span.end,
    ) == pytest.approx((10.1, 10.3))
    if snap:
        monkeypatch.setattr(
            "podcast_mcp.edits.decisions.optimize_source_cut_range",
            lambda *_args, **_kwargs: SimpleNamespace(
                start=2.1, end=2.3, mode="waveform_only", confidence=0.9
            ),
        )
    path = save_project(project, tmp_path / "episode.project.json")
    before = path.read_bytes()

    with pytest.raises(ScopeChangedAtApproval):
        EditService(ProjectWorkspace.open(path)).update_pending(
            decision.id, start=requested_range[0], end=requested_range[1], snap=snap
        )

    assert path.read_bytes() == before
    assert load_project(path).edit_decisions[0] == decision


def _source_overlap_project(tmp_path, *, scope: str = "track", overlap: bool = True):
    project = _two_take_project(tmp_path)
    project.clips[0].timeline_start = 10.0
    project.clips[1].timeline_start = 5.0
    decision = cut_words(
        project, "host", 0, 0, source_id="A", use_inaudible_opt=False, defaults=load_defaults()
    )
    decision.scope = scope
    if overlap:
        project.clips[1].timeline_start = 10.3
    assert decision.source_timeline_span is not None
    assert (
        decision.source_timeline_span.start,
        decision.source_timeline_span.end,
    ) == pytest.approx((10.1, 10.4))
    return project, decision


def _write_quiet_recording(path: Path, *, seconds: int = 6) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16_000)
        audio.writeframes(b"\0\0" * (16_000 * seconds))


def test_source_witness_geometry_matches_with_and_without_proof_caches(
    tmp_path: Path, monkeypatch
) -> None:
    from podcast_mcp.engines.audio_audit import TrackRmsCacheSet

    outcomes: dict[tuple[bool, bool], tuple[Any, ...]] = {}
    for overlap in (True, False):
        for caches_enabled in (False, True):
            case = tmp_path / f"overlap-{overlap}-cache-{caches_enabled}"
            _write_quiet_recording(case / "raw" / "a.wav")
            _write_quiet_recording(case / "raw" / "b.wav")
            project, decision = _source_overlap_project(tmp_path, scope="session", overlap=overlap)
            project.meta.workspace_dir = str(case)
            before = _clip_geometry(project)

            with monkeypatch.context() as patch:
                if not caches_enabled:
                    patch.setattr(
                        "podcast_mcp.edits.cut_proof.shared_timeline_rms_caches",
                        lambda _project, **_kw: TrackRmsCacheSet(),
                    )
                    patch.setattr(
                        "podcast_mcp.edits.cut_proof.shared_source_audio_caches",
                        lambda _project, **_kw: {},
                    )
                try:
                    applied = approve_edits(project, [decision.id], defaults=load_defaults())
                except ScopeChangedAtApproval as held:
                    result = (
                        "held",
                        held.held[0].reason,
                        _clip_geometry(project),
                        project.edit_decisions[0].applied,
                    )
                else:
                    result = (
                        "applied",
                        applied,
                        _clip_geometry(project),
                        len(project.edit_decisions),
                    )

            outcomes[(overlap, caches_enabled)] = result
            if overlap:
                assert result == ("held", "source_geometry", before, False)
            else:
                assert result[0] == "applied"
                assert result[1] == 1
                assert result[3] == 0
                source_a_windows = [
                    value
                    for row in result[2]
                    if row[2] == "A"
                    for value in (row[3], row[4], row[5])
                ]
                assert source_a_windows == pytest.approx([0.0, 0.1, 10.0, 0.4, 2.0, 10.1])
                b_after = [(row[2], row[3], row[4], row[5]) for row in result[2] if row[2] == "B"]
                assert b_after == [("B", 0.0, 2.0, 5.0), ("B", 4.0, 6.0, 19.7)]

    assert outcomes[(True, False)] == outcomes[(True, True)]
    for cache_mode in (False, True):
        applied = outcomes[(False, cache_mode)]
        assert applied[:2] == ("applied", 1)
        assert applied[3] == 0
    applied_geometry = [
        (row[1], row[2], row[3], row[4], row[5]) for row in outcomes[(False, False)][2]
    ]
    cached_geometry = [
        (row[1], row[2], row[3], row[4], row[5]) for row in outcomes[(False, True)][2]
    ]
    assert applied_geometry == cached_geometry


def _clip_geometry(
    project: EpisodeProject,
) -> list[tuple[str, str, str | None, float, float, float]]:
    return [
        (
            clip.id,
            clip.track_id,
            clip.source_id,
            clip.source_start,
            clip.source_end,
            clip.timeline_start,
        )
        for clip in project.clips
    ]


@pytest.mark.parametrize("scope", ["track", "session"])
def test_source_witness_rejects_foreign_overlap_before_persisted_approval(
    tmp_path: Path, scope: str
) -> None:
    project, decision = _source_overlap_project(tmp_path, scope=scope)
    project.meta.workspace_dir = str(tmp_path)
    path = save_project(project, tmp_path / "episode.project.json")
    before_bytes = path.read_bytes()
    before_geometry = _clip_geometry(load_project(path))

    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ProjectWorkspace.open(path)).approve([decision.id])

    assert held.value.held[0].reason == "source_geometry"
    assert path.read_bytes() == before_bytes
    saved = load_project(path)
    assert _clip_geometry(saved) == before_geometry
    assert saved.edit_decisions[0].applied is False


def test_source_witness_foreign_overlap_is_stale_in_preview_and_update(tmp_path: Path) -> None:
    project, decision = _source_overlap_project(tmp_path)
    project.meta.workspace_dir = str(tmp_path)
    path = save_project(project, tmp_path / "episode.project.json")
    before = path.read_bytes()

    assert _timeline_span(project, decision) == (0.0, 0.0, False)
    with pytest.raises(ScopeChangedAtApproval):
        EditService(ProjectWorkspace.open(path)).update_pending(
            decision.id, start=0.1, end=0.4, snap=False
        )

    assert path.read_bytes() == before


def test_source_witness_foreign_overlap_blocks_suggested_snapshot(tmp_path) -> None:
    from podcast_mcp.edits.pending_preview import apply_for_suggested, resolve_pending_preview

    project, decision = _source_overlap_project(tmp_path, scope="session")
    window = resolve_pending_preview(project, decision.id)
    preview = project.model_copy(deep=True)
    before = _clip_geometry(preview)

    with pytest.raises(ScopeChangedAtApproval):
        apply_for_suggested(preview, window, defaults=load_defaults())

    assert _clip_geometry(preview) == before
    assert preview.edit_decisions[0].applied is False


def test_source_witness_rejects_foreign_overlap_when_staging(tmp_path) -> None:
    project = _two_take_project(tmp_path)
    project.clips[0].timeline_start = 10.0
    project.clips[1].timeline_start = 10.3

    with pytest.raises(ScopeChangedAtApproval) as held:
        cut_words(
            project, "host", 0, 0, source_id="A", use_inaudible_opt=False, defaults=load_defaults()
        )

    assert held.value.held[0].reason == "source_geometry"
    assert project.edit_decisions == []


def test_source_witness_allows_nonoverlapping_foreign_clip(tmp_path) -> None:
    project, decision = _source_overlap_project(tmp_path, overlap=False)
    before_b = project.clips[1].model_copy(deep=True)

    assert approve_edits(project, [decision.id], defaults=load_defaults()) == 1
    after_b = next(clip for clip in project.clips if clip.id == before_b.id)
    assert (after_b.source_start, after_b.source_end, after_b.timeline_start) == (
        before_b.source_start,
        before_b.source_end,
        before_b.timeline_start,
    )


def test_partial_approval_drops_held_source_from_next_batch(tmp_path, monkeypatch) -> None:
    project = _two_take_project(tmp_path)
    first = cut_words(
        project, "host", 0, 0, source_id="B", use_inaudible_opt=False, defaults=load_defaults()
    )
    later = cut_words(
        project, "host", 3, 3, source_id="B", use_inaudible_opt=False, defaults=load_defaults()
    )
    seen: list[tuple[str, tuple[tuple[float, float], ...]]] = []

    def hold(_project, edit, *, batch, **_kwargs):
        seen.append((edit.id, tuple((item.start, item.end) for item in batch)))
        return CutScopeHold(edit.id, (), reason="source_geometry")

    monkeypatch.setattr("podcast_mcp.edits.cut_application._apply_source_remove", hold)
    before = _clip_geometry(project)
    held: list = []
    asked: list = []

    assert (
        approve_edits(
            project, [first.id, later.id], held_out=held, asked_out=asked, defaults=load_defaults()
        )
        == 0
    )
    assert [item.edit_id for item in held] == [later.id, first.id]
    assert asked == []
    assert seen == [
        (later.id, ((first.start, first.end), (later.start, later.end))),
        (first.id, ((first.start, first.end),)),
    ]
    assert _clip_geometry(project) == before


def test_auto_apply_drops_held_source_from_next_batch(tmp_path, monkeypatch) -> None:
    project = _two_take_project(tmp_path)
    first = cut_words(
        project, "host", 0, 0, source_id="B", use_inaudible_opt=False, defaults=load_defaults()
    )
    later = cut_words(
        project, "host", 3, 3, source_id="B", use_inaudible_opt=False, defaults=load_defaults()
    )
    for decision in project.edit_decisions:
        decision.reason = "filler:um"
        decision.review_required = False
    seen: list[tuple[str, tuple[tuple[float, float], ...]]] = []

    def hold(_project, edit, *, batch, **_kwargs):
        seen.append((edit.id, tuple((item.start, item.end) for item in batch)))
        return CutScopeHold(edit.id, (), reason="source_geometry")

    monkeypatch.setattr("podcast_mcp.edits.cut_application._apply_source_remove", hold)
    before = _clip_geometry(project)

    assert apply_auto_edits(project, defaults=load_defaults()) == 0
    assert sorted(edit.id for edit in project.edit_decisions) == sorted([first.id, later.id])
    assert seen == [
        (later.id, ((first.start, first.end), (later.start, later.end))),
        (first.id, ((first.start, first.end),)),
    ]
    assert _clip_geometry(project) == before


def test_source_witness_allows_one_equivalent_recording_alias_clip(tmp_path) -> None:
    project = _two_take_project(tmp_path)
    project.clips[1].timeline_start = 5.0
    project.sources.append(SourceRecording(id="A-alias", path="raw/a.wav"))
    project.tracks.append(
        Track(
            id="take-lane",
            label="Take lane",
            speaker="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/b.wav", duration_sec=30.0),
        )
    )
    project.clips[0].source_id = "A-alias"
    project.clips[0].track_id = "take-lane"
    project.clips[0].timeline_start = 10.0
    decision = cut_words(
        project, "host", 0, 0, source_id="A", use_inaudible_opt=False, defaults=load_defaults()
    )
    decision.scope = "session"

    assert project.equivalent_source_ids("host", "A") >= {"A", "A-alias"}
    assert approve_edits(project, [decision.id], defaults=load_defaults()) == 1


def test_source_witness_allows_primary_clip_with_explicit_take_selection(tmp_path) -> None:
    project = _two_take_project(tmp_path)
    project.clips[1].timeline_start = 5.0
    project.clips[0].source_id = None
    project.clips[0].timeline_start = 10.0
    decision = cut_words(
        project, "host", 0, 0, source_id="A", use_inaudible_opt=False, defaults=load_defaults()
    )

    assert None in project.equivalent_source_ids("host", "A")
    assert approve_edits(project, [decision.id], defaults=load_defaults()) == 1


def test_source_witness_rejects_identical_overlapping_selected_clip(tmp_path) -> None:
    project, decision = _source_overlap_project(tmp_path, overlap=False)
    project.clips.append(project.clips[0].model_copy(update={"id": "a-duplicate"}))

    assert _timeline_span(project, decision) == (0.0, 0.0, False)
    with pytest.raises(ScopeChangedAtApproval) as held:
        approve_edits(project, [decision.id], defaults=load_defaults())

    assert held.value.held[0].reason == "source_geometry"


def test_source_witness_rejects_duplicate_during_staging(tmp_path) -> None:
    project = _two_take_project(tmp_path)
    project.clips[0].timeline_start = 10.0
    project.clips.append(project.clips[0].model_copy(update={"id": "a-duplicate"}))

    with pytest.raises(ScopeChangedAtApproval) as held:
        cut_words(
            project, "host", 0, 0, source_id="A", use_inaudible_opt=False, defaults=load_defaults()
        )

    assert held.value.held[0].reason == "source_geometry"
    assert project.edit_decisions == []


def test_source_witness_allows_adjacent_contiguous_selected_clips(tmp_path) -> None:
    project = _two_take_project(tmp_path)
    project.clips[1].timeline_start = 5.0
    project.clips[0] = project.clips[0].model_copy(
        update={"source_end": 0.25, "timeline_start": 10.0}
    )
    project.clips.append(
        project.clips[0].model_copy(
            update={
                "id": "a-next",
                "source_start": 0.25,
                "source_end": 2.0,
                "timeline_start": 10.25,
            }
        )
    )
    decision = cut_words(
        project, "host", 0, 0, source_id="A", use_inaudible_opt=False, defaults=load_defaults()
    )

    assert decision.source_timeline_span is not None
    assert (
        decision.source_timeline_span.start,
        decision.source_timeline_span.end,
    ) == pytest.approx((10.1, 10.4))
    assert approve_edits(project, [decision.id], defaults=load_defaults()) == 1


def test_source_witness_allows_moved_selected_clip_for_session_scope(tmp_path) -> None:
    project = _two_take_project(tmp_path)
    project.clips[0].timeline_start = 10.0
    project.clips[1].timeline_start = 5.0
    project.tracks.append(
        Track(
            id="take-lane",
            label="Take lane",
            speaker="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/b.wav", duration_sec=30.0),
        )
    )
    selected = next(clip for clip in project.clips if clip.id == "a")
    selected.track_id = "take-lane"
    decision = cut_words(
        project, "host", 0, 0, source_id="A", use_inaudible_opt=False, defaults=load_defaults()
    )
    decision.scope = "session"

    assert approve_edits(project, [decision.id], defaults=load_defaults()) == 1


@pytest.mark.parametrize("foreign_lane", ["host", "take-lane"])
def test_source_witness_rejects_foreign_overlap_on_origin_or_selected_lane(
    tmp_path,
    foreign_lane: str,
) -> None:
    project = _two_take_project(tmp_path)
    project.clips[0].timeline_start = 10.0
    project.clips[1].timeline_start = 5.0
    project.tracks.append(
        Track(
            id="take-lane",
            label="Take lane",
            speaker="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/b.wav", duration_sec=30.0),
        )
    )
    selected = next(clip for clip in project.clips if clip.id == "a")
    selected.track_id = "take-lane"
    decision = cut_words(
        project, "host", 0, 0, source_id="A", use_inaudible_opt=False, defaults=load_defaults()
    )
    decision.scope = "session"
    foreign = next(clip for clip in project.clips if clip.id == "b1")
    foreign.track_id = foreign_lane
    foreign.timeline_start = 10.3

    with pytest.raises(ScopeChangedAtApproval) as held:
        approve_edits(project, [decision.id], defaults=load_defaults())

    assert held.value.held[0].reason == "source_geometry"


def test_source_witness_rejects_equivalent_clip_on_different_source_clock(tmp_path) -> None:
    project, decision = _source_overlap_project(tmp_path, overlap=False)
    project.sources.append(SourceRecording(id="A-alias", path="raw/a.wav"))
    project.clips.append(
        Clip(
            id="a-shifted-alias",
            track_id="host",
            source_id="A-alias",
            source_start=5.0,
            source_end=6.2,
            timeline_start=10.3,
        )
    )

    with pytest.raises(ScopeChangedAtApproval) as held:
        approve_edits(project, [decision.id], defaults=load_defaults())

    assert held.value.held[0].reason == "source_geometry"


@pytest.mark.parametrize("scope", ["track", "session"])
def test_auto_filler_keeps_witnessed_window_when_optimizer_would_enter_next_take(
    tmp_path, scope: str, monkeypatch
) -> None:
    project = _two_take_project(tmp_path)
    selected = next(clip for clip in project.clips if clip.id == "a")
    next_take = next(clip for clip in project.clips if clip.id == "b1")
    selected.source_end = 0.42
    selected.timeline_start = 10.0
    next_take.timeline_start = 5.0
    decision = cut_words(
        project, "host", 0, 0, source_id="A", use_inaudible_opt=False, defaults=load_defaults()
    )
    decision = update_pending_edit(
        project, decision.id, start=0.12, end=0.42, snap=False, defaults=load_defaults()
    )
    assert decision.source_timeline_span is not None
    decision.reason = "filler:um"
    decision.review_required = False
    decision.scope = scope
    next_take.timeline_start = decision.source_timeline_span.end
    project.timeline.duration_sec = max(clip.timeline_end for clip in project.clips)
    assert decision.boundary_mode is None
    assert decision.source_timeline_span is not None

    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    optimize_calls = []

    def optimize(_project, _track_id, start, _end, **_kwargs):
        optimize_calls.append((start, _end))
        return OptimizedCutRange(
            start=start,
            end=start + 0.38,
            mode="exact",
            shifted_start_ms=0,
            shifted_end_ms=80,
            confidence=1,
            details={},
        )

    def optimized_ripple(_project, start, _end, _use_inaudible_opt):
        optimize_calls.append((start, _end))
        return start, start + 0.38

    monkeypatch.setattr("podcast_mcp.edits.inaudible_cuts.optimize_timeline_cut_range", optimize)
    monkeypatch.setattr("podcast_mcp.edits.timeline_ops._optimized_ripple_span", optimized_ripple)
    cfg = {"tighten": {"inaudible_opt": True, "edit_mode": "ripple"}}

    assert apply_auto_edits(project, defaults=cfg) == 1

    remaining_b = sorted(
        (clip.source_start, clip.source_end)
        for clip in project.clips
        if clip.id == "b1" or clip.id.startswith("b1")
    )
    assert remaining_b == [(0, 2)]
    assert optimize_calls == []
    record = project.editorial.edit_log[-1]
    assert (record.timeline_start, record.timeline_end) == pytest.approx(
        (
            decision.source_timeline_span.start,
            decision.source_timeline_span.end,
        )
    )
    assert (record.source_start, record.source_end) == pytest.approx((0.12, 0.42))
    assert record.params["use_inaudible_opt"] is False


@pytest.mark.parametrize("stale_geometry", ["moved", "duplicate", "uncovered"])
def test_pending_source_remove_resize_keeps_geometry_holds(tmp_path, stale_geometry: str) -> None:
    project = _two_take_project(tmp_path)
    decision = cut_words(
        project, "host", 0, 0, source_id="B", use_inaudible_opt=False, defaults=load_defaults()
    )
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
            defaults=load_defaults(),
        )

    assert held.value.ids == (decision.id,)
    assert project.edit_decisions[0] == before


@pytest.mark.parametrize("source_id", [None, "B"])
def test_pending_source_remove_snap_keeps_source_identity(tmp_path, source_id, monkeypatch) -> None:
    if source_id == "B":
        project = _two_take_project(tmp_path)
        decision = cut_words(
            project, "host", 0, 0, source_id="B", use_inaudible_opt=False, defaults=load_defaults()
        )
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
        defaults=load_defaults(),
    )

    assert (observed["track_id"], observed["start"], observed["end"]) == (
        "host",
        decision.start,
        decision.end,
    )
    assert observed["kwargs"]["source_id"] == source_id
    if source_id is None:
        assert {k: v for k, v in observed["kwargs"].items() if k != "defaults"} == {
            "source_id": None
        }
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


def test_combined_markdown_uses_each_take_placement_and_drops_unplaced_or_suppressed_words(
    tmp_path,
) -> None:
    project = _two_take_project(tmp_path)

    markdown = combined_transcript_markdown(project, defaults=load_defaults())

    assert markdown == (
        "# two-takes\n\n"
        "**Host** [0.1s]: alpha\n\n"
        "**Host** [10.1s]: beta\n\n"
        "**Host** [20.1s]: later\n"
    )
    assert "hidden" not in markdown
    assert "deleted" not in markdown


def test_source_cut_absorbs_trailing_silence_using_selected_source_profile(
    tmp_path, monkeypatch
) -> None:
    from podcast_mcp.edits import inaudible_cuts
    from podcast_mcp.edits.inaudible_cuts import CutWordIndex, InaudibleCutConfig

    project = _two_take_project(tmp_path)
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
        defaults=load_defaults(),
    )

    assert thresholds == [selected_profile.voice_floor_db - 3.0]
    assert result.end == pytest.approx(1.2)
    assert result.details["absorb_trailing_silence"] is True


def _primary_alias_project(
    tmp_path, *, combined_only: bool, clip_source_id: str | None = "A"
) -> EpisodeProject:
    project = EpisodeProject.create("primary-alias", str(tmp_path))
    _write_quiet_recording(tmp_path / "raw/a.wav")
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


def test_primary_transcript_cut_resolves_explicit_same_recording_clip_for_approval(
    tmp_path,
) -> None:
    project = _primary_alias_project(tmp_path, combined_only=False)

    decision = cut_text_match(
        project, "hello", track_id="host", use_inaudible_opt=False, defaults=load_defaults()
    )[0]

    assert decision.source_id is None
    assert decision.source_timeline_span is not None
    assert decision.source_timeline_span.model_dump() == {"start": 6.0, "end": 6.4}
    assert approve_edits(project, [decision.id], defaults=load_defaults()) == 1
    assert all(not (clip.source_start < 1.4 and clip.source_end > 1.0) for clip in project.clips)


def test_combined_only_primary_alias_maps_pending_preview_and_markdown(tmp_path) -> None:
    project = _primary_alias_project(tmp_path, combined_only=True)

    decision = cut_text_match(
        project, "hello", track_id="host", use_inaudible_opt=False, defaults=load_defaults()
    )[0]
    row = map_pending_edits_to_timeline(project, [decision])[0]

    assert row["mappable"] is True
    assert row["timeline_spans"] == [{"start": 6.0, "end": 6.4}]
    assert _timeline_span(project, decision) == (6.0, 6.4, True)
    approval_project = project.model_copy(deep=True)
    assert approve_edits(approval_project, [decision.id], defaults=load_defaults()) == 1
    assert combined_transcript_markdown(project, defaults=load_defaults()) == (
        "# primary-alias\n\n**Host** [6.0s]: hello\n"
    )


def test_combined_only_literal_primary_clip_maps_pending_preview_and_markdown(tmp_path) -> None:
    project = _primary_alias_project(tmp_path, combined_only=True, clip_source_id=None)

    decision = cut_text_match(
        project, "hello", track_id="host", use_inaudible_opt=False, defaults=load_defaults()
    )[0]
    row = map_pending_edits_to_timeline(project, [decision])[0]

    assert row["mappable"] is True
    assert row["timeline_spans"] == [{"start": 6.0, "end": 6.4}]
    assert _timeline_span(project, decision) == (6.0, 6.4, True)
    assert combined_transcript_markdown(project, defaults=load_defaults()) == (
        "# primary-alias\n\n**Host** [6.0s]: hello\n"
    )


def test_primary_combined_text_does_not_fall_back_to_unrelated_explicit_source(tmp_path) -> None:
    project = _primary_alias_project(tmp_path, combined_only=True, clip_source_id="B")
    project.sources.append(SourceRecording(id="B", path="raw/b.wav"))

    with pytest.raises(ScopeChangedAtApproval, match="selected cut was not applied"):
        cut_text_match(
            project, "hello", track_id="host", use_inaudible_opt=False, defaults=load_defaults()
        )


def test_explicit_primary_alias_without_clips_uses_primary_media(tmp_path) -> None:
    project = _primary_alias_project(tmp_path, combined_only=False)
    project.clips = []

    decision = cut_words(
        project, "host", 0, 0, source_id="A", use_inaudible_opt=False, defaults=load_defaults()
    )
    row = map_pending_edits_to_timeline(project, [decision])[0]

    assert decision.source_timeline_span is not None
    assert decision.source_timeline_span.model_dump() == {"start": 1.0, "end": 1.4}
    assert row["mappable"] is True
    assert _timeline_span(project, decision) == (1.0, 1.4, True)
    assert (
        approve_edits(project.model_copy(deep=True), [decision.id], defaults=load_defaults()) == 1
    )

    markdown_project = _primary_alias_project(tmp_path, combined_only=True)
    markdown_project.clips = []
    utterance = markdown_project.combined_transcript.utterances[0]
    markdown_project.combined_transcript.utterances[0] = utterance.model_copy(
        update={"source_id": "A"}
    )

    assert combined_transcript_markdown(markdown_project, defaults=load_defaults()) == (
        "# primary-alias\n\n**Host** [1.0s]: hello\n"
    )


def test_primary_alias_cut_holds_after_geometry_changes_or_repeats(tmp_path) -> None:
    moved_project = _primary_alias_project(tmp_path, combined_only=False)
    decision = cut_text_match(
        moved_project, "hello", track_id="host", use_inaudible_opt=False, defaults=load_defaults()
    )[0]
    moved_project.clips[0].timeline_start += 1.0

    with pytest.raises(
        ScopeChangedAtApproval, match="no longer has one complete, continuous placement"
    ):
        approve_edits(moved_project, [decision.id], defaults=load_defaults())

    repeated_project = _primary_alias_project(tmp_path, combined_only=False)
    repeated_project.clips.append(
        repeated_project.clips[0].model_copy(update={"id": "a-repeat", "timeline_start": 15.0})
    )

    with pytest.raises(ScopeChangedAtApproval, match="selected cut was not applied"):
        cut_text_match(
            repeated_project,
            "hello",
            track_id="host",
            use_inaudible_opt=False,
            defaults=load_defaults(),
        )
