from __future__ import annotations

import pytest

from pause_policy_public_helpers import (
    configure,
    defaults,
    files,
    project,
    room,
    workspace,
    write_wav,
)
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.models import Clip, MediaAsset, SourceRecording, Track, TrackRole, load_project
from podcast_mcp.services.document import EditService
from test_pause_current_operation_contract import _fresh_join_review, _stored_remove
from test_source_remove_geometry import _cut


def _alias_path(tmp_path, spelling):
    if spelling == "absolute":
        return str(tmp_path / "raw" / "host.wav")
    if spelling == "symlink":
        (tmp_path / "raw" / "host-link.wav").symlink_to("host.wav")
        return "raw/host-link.wav"
    return "raw/./host.wav"


def _parked_music(result, source_id):
    result.tracks.append(
        Track(
            id="music",
            label="Music",
            role=TrackRole.MUSIC,
            timeline_empty=True,
            media=MediaAsset(path="raw/music.wav", duration_sec=7),
        )
    )
    result.clips.append(
        Clip(
            id="parked",
            track_id="music",
            source_id=source_id,
            source_start=1,
            source_end=2,
            timeline_start=6,
        )
    )
    result.timeline.duration_sec = 7


@pytest.mark.parametrize("spelling", ["dot", "absolute", "symlink"])
def test_equivalent_path_replay_holds_without_mutation(tmp_path, monkeypatch, spelling):
    configure(monkeypatch, defaults(acoustic=False))
    result = project(tmp_path)
    result.sources.append(
        SourceRecording(id="alias", path=_alias_path(tmp_path, spelling), duration_sec=6)
    )
    _parked_music(result, "alias")
    result.edit_decisions = [_cut()]
    ws = workspace(result)
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")

    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["cut"], confirm_cut_speech=True)

    assert held.value.ids == ("cut",)
    assert held.value.held[0].reason == "source_geometry"
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    assert load_project(ws.path).model_dump(mode="json") == before_model


@pytest.mark.parametrize("spelling", ["dot", "absolute", "symlink"])
def test_single_placement_alias_remains_consumable(tmp_path, monkeypatch, spelling):
    configure(monkeypatch, defaults(acoustic=False))
    result = project(tmp_path)
    result.sources.append(
        SourceRecording(id="alias", path=_alias_path(tmp_path, spelling), duration_sec=6)
    )
    result.clips[0].source_id = "alias"
    result.edit_decisions = [_cut()]
    ws = workspace(result)

    assert EditService(ws).approve(["cut"], confirm_cut_speech=True) == 1

    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == 5
    assert [
        (clip.source_start, clip.source_end, clip.timeline_start, clip.source_id)
        for clip in saved.clips
    ] == [(0, 1, 0, "alias"), (2, 6, 1, "alias")]


def test_different_file_on_music_does_not_block_host_remove(tmp_path, monkeypatch):
    configure(monkeypatch, defaults(acoustic=False))
    result = project(tmp_path)
    write_wav(tmp_path / "raw" / "other.wav", room(seed=1513))
    result.sources.append(SourceRecording(id="other", path="raw/other.wav", duration_sec=6))
    _parked_music(result, "other")
    result.edit_decisions = [_cut()]
    ws = workspace(result)

    assert EditService(ws).approve(["cut"], confirm_cut_speech=True) == 1

    saved = load_project(ws.path)
    assert [
        (clip.source_start, clip.source_end, clip.timeline_start)
        for clip in saved.clips
        if clip.track_id == "host"
    ] == [(0, 1, 0), (2, 6, 1)]
    parked = next(clip for clip in saved.clips if clip.id == "parked")
    assert (parked.source_id, parked.source_start, parked.source_end) == ("other", 1, 2)


def test_selected_approval_cannot_authorize_unavailable_join_evidence(tmp_path, monkeypatch):
    _fresh_join_review(monkeypatch)
    observed = []

    def unavailable(_project, track_id, cut_start, cut_end, **kwargs):
        observed.append((track_id, cut_start, cut_end, kwargs["timebase"]))
        raise OSError("join scorer decode unavailable")

    monkeypatch.setattr("podcast_mcp.edits.join_continuity.assess_proposed_cut", unavailable)
    ws = workspace(_stored_remove(tmp_path, seed=1512))
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")

    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["stored-remove"])

    assert observed
    assert held.value.held[0].reason == "pause_air"
    assert held.value.held[0].detail == "no_air"
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    assert load_project(ws.path).model_dump(mode="json") == before_model
