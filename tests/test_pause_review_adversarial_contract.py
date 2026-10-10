from __future__ import annotations

import pytest

from pause_policy_public_helpers import (
    configure,
    defaults,
    files,
    project,
    workspace,
)
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.models import Clip, MediaAsset, SourceRecording, Track, TrackRole, load_project
from podcast_mcp.services.document import EditService
from test_pause_current_operation_contract import _fresh_join_review, _stored_remove
from test_source_remove_geometry import _cut


def test_all_safe_cannot_authorize_a_fresh_join_review(tmp_path, monkeypatch):
    observed = _fresh_join_review(monkeypatch)
    ws = workspace(_stored_remove(tmp_path, seed=1512))
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    assert ws.project.edit_decisions[0].review_required is False
    with pytest.raises(ScopeChangedAtApproval):
        EditService(ws).approve_eligible_tighten(["stored-remove"])
    assert observed
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    assert load_project(ws.path).model_dump(mode="json") == before_model


def test_auto_pause_cannot_treat_a_join_scorer_exception_as_pass(tmp_path, monkeypatch):
    _fresh_join_review(monkeypatch)
    observed = []

    def unavailable(_project, track_id, cut_start, cut_end, **kwargs):
        observed.append((track_id, cut_start, cut_end, kwargs["timebase"]))
        raise OSError("join scorer decode unavailable")

    monkeypatch.setattr("podcast_mcp.edits.join_continuity.assess_proposed_cut", unavailable)
    ws = workspace(_stored_remove(tmp_path, seed=1512))
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    assert EditService(ws).apply_auto() == 0
    assert observed
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    assert load_project(ws.path).model_dump(mode="json") == before_model


def test_source_remove_refuses_replay_under_equivalent_media_path(tmp_path, monkeypatch):
    configure(monkeypatch, defaults(acoustic=False))
    result = project(tmp_path)
    result.sources.append(SourceRecording(id="host-alias", path="raw/./host.wav", duration_sec=6))
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
            id="aliased-replay",
            track_id="music",
            source_id="host-alias",
            source_start=1,
            source_end=2,
            timeline_start=6,
        )
    )
    result.timeline.duration_sec = 7
    result.edit_decisions = [_cut()]
    ws = workspace(result)
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    with pytest.raises(ScopeChangedAtApproval):
        EditService(ws).approve(["cut"], confirm_cut_speech=True)
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    assert load_project(ws.path).model_dump(mode="json") == before_model
