"""Three-way merge of saved projects (#426)."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

from podcast_mcp.models import EpisodeProject, MediaAsset, Track, TrackRole
from podcast_mcp.models.episode import PipelineRun
from podcast_mcp.project_merge import (
    ProjectMergeConflict,
    merge_project_data,
    project_merge_data,
)


def _base(tmp_path: Path) -> dict:
    project = EpisodeProject.create("m", str(tmp_path))
    project.tracks = [
        Track(
            id=tid,
            label=tid,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
        for tid in ("host", "guest")
    ]
    return project_merge_data(project)


def _track(data: dict, track_id: str) -> dict:
    return next(t for t in data["timeline"]["tracks"] if t["id"] == track_id)


def _entry(entry_id: str, created_at: str) -> dict:
    return {
        "id": entry_id,
        "label": entry_id,
        "created_at": created_at,
        "snapshot_file": f"{entry_id}.json",
        "operation": None,
        "params": None,
    }


def test_disjoint_changes_both_survive(tmp_path):
    base = _base(tmp_path)
    ours, theirs = copy.deepcopy(base), copy.deepcopy(base)
    _track(theirs, "host")["fader_db"] = -6.0
    _track(ours, "host")["gain_db"] = 2.0
    host = _track(merge_project_data(base, ours, theirs), "host")
    assert host["fader_db"] == -6.0
    assert host["gain_db"] == 2.0


def test_keyed_lists_union_additions(tmp_path):
    base = _base(tmp_path)
    ours, theirs = copy.deepcopy(base), copy.deepcopy(base)
    theirs["review"]["comments"].append(
        {"id": "c1", "body": "hi", "author": "a", "created_at": "t", "timeline_start": 1.0}
    )
    run = PipelineRun(id="r1", started_at="t").model_dump(mode="json", by_alias=True)
    ours["render"]["pipeline_runs"].append(run)
    merged = merge_project_data(base, ours, theirs)
    assert [c["id"] for c in merged["review"]["comments"]] == ["c1"]
    assert [r["id"] for r in merged["render"]["pipeline_runs"]] == ["r1"]
    EpisodeProject.model_validate(merged)


def test_same_value_changed_both_ways_conflicts(tmp_path):
    base = _base(tmp_path)
    ours, theirs = copy.deepcopy(base), copy.deepcopy(base)
    _track(ours, "host")["gain_db"] = 2.0
    _track(theirs, "host")["gain_db"] = 5.0
    with pytest.raises(ProjectMergeConflict) as exc:
        merge_project_data(base, ours, theirs)
    assert "timeline.tracks[host].gain_db" in exc.value.paths


def test_delete_vs_untouched_deletes_and_delete_vs_edit_conflicts(tmp_path):
    base = _base(tmp_path)
    ours, theirs = copy.deepcopy(base), copy.deepcopy(base)
    ours["timeline"]["tracks"] = [_track(ours, "host")]
    merged = merge_project_data(base, ours, theirs)
    assert [t["id"] for t in merged["timeline"]["tracks"]] == ["host"]
    _track(theirs, "guest")["gain_db"] = 3.0
    with pytest.raises(ProjectMergeConflict):
        merge_project_data(base, ours, theirs)


def test_theirs_reorder_kept_when_ours_did_not_reorder(tmp_path):
    base = _base(tmp_path)
    ours, theirs = copy.deepcopy(base), copy.deepcopy(base)
    theirs["timeline"]["tracks"].reverse()
    _track(ours, "host")["gain_db"] = 1.0
    merged = merge_project_data(base, ours, theirs)
    assert [t["id"] for t in merged["timeline"]["tracks"]] == ["guest", "host"]
    assert _track(merged, "host")["gain_db"] == 1.0


def test_envelopes_merge_by_track_and_parameter(tmp_path):
    base = _base(tmp_path)
    base["mix"]["automation_envelopes"] = [
        {"track_id": "host", "parameter": "volume", "points": []}
    ]
    ours, theirs = copy.deepcopy(base), copy.deepcopy(base)
    theirs["mix"]["automation_envelopes"].append(
        {"track_id": "guest", "parameter": "volume", "points": []}
    )
    ours["mix"]["automation_envelopes"][0]["points"] = [{"id": "p1", "time": 1.0, "value": -3.0}]
    merged = merge_project_data(base, ours, theirs)
    envs = {e["track_id"]: e for e in merged["mix"]["automation_envelopes"]}
    assert set(envs) == {"host", "guest"}
    assert len(envs["host"]["points"]) == 1


def test_history_entries_union_sorted_and_cursor_at_tip(tmp_path):
    base = _base(tmp_path)
    base["history"] = {"cursor": 0, "entries": [_entry("e0", "2026-01-01T00:00:00")]}
    ours, theirs = copy.deepcopy(base), copy.deepcopy(base)
    ours["history"]["entries"].append(_entry("ours", "2026-01-01T00:00:03"))
    theirs["history"]["entries"].append(_entry("theirs", "2026-01-01T00:00:02"))
    ours["history"]["cursor"] = theirs["history"]["cursor"] = 1
    history = merge_project_data(base, ours, theirs)["history"]
    assert [e["id"] for e in history["entries"]] == ["e0", "theirs", "ours"]
    assert history["cursor"] == 2


def test_history_cursor_follows_the_side_that_moved(tmp_path):
    base = _base(tmp_path)
    base["history"] = {
        "cursor": 1,
        "entries": [_entry("e0", "2026-01-01T00:00:00"), _entry("e1", "2026-01-01T00:00:01")],
    }
    ours, theirs = copy.deepcopy(base), copy.deepcopy(base)
    theirs["history"]["cursor"] = 0
    _track(ours, "host")["gain_db"] = 1.0
    history = merge_project_data(base, ours, theirs)["history"]
    assert history["entries"][history["cursor"]]["id"] == "e0"


def _two_entry_history(base: dict, cursor: int) -> dict:
    base["history"] = {
        "cursor": cursor,
        "entries": [_entry("e0", "2026-01-01T00:00:00"), _entry("e1", "2026-01-01T00:00:01")],
    }
    return base


def _assert_lineage_conflict(base, ours, theirs):
    with pytest.raises(ProjectMergeConflict) as exc:
        merge_project_data(base, ours, theirs)
    assert "history.lineage" in exc.value.paths


def test_history_conflicts_when_theirs_undid_and_ours_recorded(tmp_path):
    base = _two_entry_history(_base(tmp_path), 1)
    ours, theirs = copy.deepcopy(base), copy.deepcopy(base)
    theirs["history"]["cursor"] = 0
    ours["history"]["entries"].append(_entry("s1", "2026-01-01T00:00:02"))
    ours["history"]["cursor"] = 2
    _assert_lineage_conflict(base, ours, theirs)


def test_history_conflicts_when_theirs_undid_then_recorded(tmp_path):
    base = _two_entry_history(_base(tmp_path), 1)
    ours, theirs = copy.deepcopy(base), copy.deepcopy(base)
    theirs["history"] = {
        "cursor": 1,
        "entries": [_entry("e0", "2026-01-01T00:00:00"), _entry("t1", "2026-01-01T00:00:03")],
    }
    ours["history"]["entries"].append(_entry("s1", "2026-01-01T00:00:02"))
    ours["history"]["cursor"] = 2
    _assert_lineage_conflict(base, ours, theirs)


def test_history_conflicts_when_ours_undid_and_theirs_recorded(tmp_path):
    base = _two_entry_history(_base(tmp_path), 1)
    ours, theirs = copy.deepcopy(base), copy.deepcopy(base)
    ours["history"]["cursor"] = 0
    theirs["history"]["entries"].append(_entry("s1", "2026-01-01T00:00:02"))
    theirs["history"]["cursor"] = 2
    _assert_lineage_conflict(base, ours, theirs)


def test_history_redo_tail_truncated_by_ours_merges_as_deletion(tmp_path):
    base = _two_entry_history(_base(tmp_path), 0)
    ours, theirs = copy.deepcopy(base), copy.deepcopy(base)
    ours["history"] = {
        "cursor": 1,
        "entries": [_entry("e0", "2026-01-01T00:00:00"), _entry("s1", "2026-01-01T00:00:02")],
    }
    history = merge_project_data(base, ours, theirs)["history"]
    assert [e["id"] for e in history["entries"]] == ["e0", "s1"]
    assert history["cursor"] == 1


def test_unkeyed_lists_conflict_as_a_whole():
    base = {"words": [{"text": "a", "start": 0.0}, {"text": "b", "start": 1.0}]}
    ours = copy.deepcopy(base)
    ours["words"][0]["suppressed"] = True
    theirs = copy.deepcopy(base)
    theirs["words"][1]["text"] = "B"
    with pytest.raises(ProjectMergeConflict) as exc:
        merge_project_data(base, ours, theirs)
    assert exc.value.paths == ["words"]


def test_conflict_message_truncates():
    exc = ProjectMergeConflict([f"p{i}" for i in range(7)])
    assert "and 2 more" in str(exc)
    assert str(exc).endswith("re-run it")


def test_lineage_conflict_message_names_the_undo():
    msg = str(ProjectMergeConflict(["history.lineage"]))
    assert msg.startswith("an undo or redo changed the project while this job ran")
    assert msg.endswith("re-run it")
    assert str(ProjectMergeConflict(["history.cursor"])).startswith(
        "an undo or redo changed the project while this job ran"
    )
    assert str(ProjectMergeConflict(["tracks[host].gain_db"])).startswith("project changed")


def test_history_cursor_moved_both_ways_conflicts_as_undo_redo(tmp_path):
    base = _base(tmp_path)
    base["history"] = {
        "cursor": 2,
        "entries": [
            _entry("e0", "2026-01-01T00:00:00"),
            _entry("e1", "2026-01-01T00:00:01"),
            _entry("e2", "2026-01-01T00:00:02"),
        ],
    }
    ours, theirs = copy.deepcopy(base), copy.deepcopy(base)
    ours["history"]["cursor"] = 0
    theirs["history"]["cursor"] = 1
    with pytest.raises(ProjectMergeConflict) as exc:
        merge_project_data(base, ours, theirs)
    assert "history.cursor" in exc.value.paths
    assert str(exc.value).startswith("an undo or redo changed the project")
