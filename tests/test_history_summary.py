from __future__ import annotations

from podcast_mcp.history.summary import format_history_group_title, summarize_diff


def test_format_history_group_title_with_range() -> None:
    title = format_history_group_title(
        kind="mutation",
        operation="ripple_delete",
        params={
            "timeline_start": 60.0,
            "timeline_end": 72.5,
            "track_ids": ["host", "guest"],
        },
    )
    assert "ripple delete" in title
    assert "1:00.0-1:12.5" in title
    assert "12.5s" in title
    assert "host, guest" in title


def test_format_pipeline_snapshot_title() -> None:
    title = format_history_group_title(
        kind="snapshot",
        label="after transcribe",
    )
    assert title == "pipeline: transcribe"


def test_summarize_diff_edit_log_and_duration() -> None:
    lines = summarize_diff(
        {
            "clips": {"added": [], "removed": [{"id": "c1"}], "changed": []},
            "edit_decisions": {"added": [], "removed": []},
            "edit_log": {
                "added": [
                    {
                        "operation": "ripple_delete",
                        "timeline_start": 10.0,
                        "timeline_end": 12.0,
                        "track_ids": ["olga"],
                        "reason": "tangent",
                    }
                ]
            },
            "tracks": {"changed": []},
            "mix_changed": False,
            "timeline_duration_sec": {"old": 100.0, "new": 98.0},
            "meta_changed": False,
        }
    )
    assert any("ripple delete" in line and "olga" in line for line in lines)
    assert any("tangent" in line for line in lines)
    assert any("1 clip removed" in line for line in lines)
    assert any("duration" in line and "-2.0s" in line for line in lines)


def test_summarize_diff_empty_falls_back_to_operation() -> None:
    lines = summarize_diff(
        {
            "clips": {"added": [], "removed": [], "changed": []},
            "edit_decisions": {"added": [], "removed": []},
            "edit_log": {"added": []},
            "tracks": {"changed": []},
            "mix_changed": False,
            "timeline_duration_sec": {"old": 10.0, "new": 10.0},
            "meta_changed": False,
        },
        operation="approve_edits",
        params={},
    )
    assert lines == ["approve edits"]


def test_reproposed_hit_with_moved_edges_shows_as_changed() -> None:
    from podcast_mcp.history.diff import diff_snapshots
    from podcast_mcp.models.history import ProjectStateSnapshot

    def snapshot(end: float) -> ProjectStateSnapshot:
        return ProjectStateSnapshot(
            timeline={"clips": [], "tracks": []},
            editorial={
                "edit_decisions": [
                    {"id": "cut_pause_1271400_1288770_ab", "start": 1271.4, "end": end}
                ]
            },
        )

    diff = diff_snapshots(snapshot(1288.77), snapshot(1288.98))

    assert diff["edit_decisions"] == {
        "added": [],
        "removed": [],
        "changed": [
            {
                "id": "cut_pause_1271400_1288770_ab",
                "fields": [{"field": "end", "old": 1288.77, "new": 1288.98}],
            }
        ],
    }
    assert "1 pending edit changed" in summarize_diff(diff)
