from __future__ import annotations

from podcast_mcp.project.history.summary import format_history_group_title, summarize_diff


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


def test_record_land_title_says_when_a_session_starts_the_episode() -> None:
    first = {"session_number": 2, "session_first": True, "session_at_start": True}
    later = {"session_number": 2, "session_first": False, "session_at_start": True}
    staged = {"session_number": 2, "session_first": True, "session_staged": True}
    title = lambda params: format_history_group_title(  # noqa: E731
        kind="mutation", operation="record_land", params=params
    )
    assert title(first) == "Added Session 2 at the start"
    assert title(later) == "Added to Session 2"
    assert title({**staged, "session_at_start": False}) == "Staged Session 2"


def test_format_pipeline_snapshot_title() -> None:
    title = format_history_group_title(
        kind="snapshot",
        label="after transcribe",
    )
    assert title == "pipeline: transcribe"


def test_record_land_title_names_the_session_in_both_group_kinds() -> None:
    first = {"session_id": "abc", "session_number": 2, "session_first": True}
    later = {"session_id": "abc", "session_number": 2, "session_first": False}
    for kind, label in (("mutation", "Added Session 2"), ("snapshot", "after Added Session 2")):
        assert (
            format_history_group_title(
                kind=kind, label=label, operation="record_land", params=first
            )
            == "Added Session 2"
        )
    assert (
        format_history_group_title(
            kind="mutation", label="Added to Session 2", operation="record_land", params=later
        )
        == "Added to Session 2"
    )
    assert (
        format_history_group_title(
            kind="mutation",
            label="record land",
            operation="record_land",
            params={"session_id": "a"},
        )
        == "record land"
    )


def test_staged_and_skipped_session_titles() -> None:
    staged = {
        "session_id": "abc",
        "session_number": 3,
        "session_first": False,
        "session_staged": True,
    }
    assert (
        format_history_group_title(
            kind="snapshot", label="after Staged Session 3", operation="record_land", params=staged
        )
        == "Staged Session 3"
    )
    assert (
        format_history_group_title(
            kind="mutation",
            label="Skipped Session 3",
            operation="skip_session_suggestion",
            params={"suggestion_id": "ss-abc", "session_number": 3},
        )
        == "Skipped Session 3"
    )
    for kind, label in (("mutation", "Added Session 3"), ("snapshot", "after Added Session 3")):
        assert (
            format_history_group_title(
                kind=kind,
                label=label,
                operation="accept_session_suggestion",
                params={"suggestion_id": "ss-abc", "session_id": "abc", "session_number": 3},
            )
            == "Added Session 3"
        )


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
    from podcast_mcp.models.history import ProjectStateSnapshot
    from podcast_mcp.project.history.diff import diff_snapshots

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
