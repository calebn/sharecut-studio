from __future__ import annotations

import pytest

from podcast_mcp.models.history import HistoryEntry, ProjectHistory


def test_edit_head_skips_automatic_preview_entries() -> None:
    def entry(id_: str, operation: str) -> HistoryEntry:
        return HistoryEntry.model_construct(id=id_, operation=operation)

    history = ProjectHistory.model_construct(
        entries=[entry("a", "cut"), entry("b", "cut"), entry("p", "render_preview")],
        cursor=2,
    )
    assert history.head_id() == "p"
    assert history.edit_head_id() == "b"
    history.cursor = 0
    assert history.edit_head_id() == "a"
    assert ProjectHistory().edit_head_id() == "root"


def test_edit_head_is_the_state_before_a_rebuild_pair() -> None:
    from podcast_mcp.services.document.history import _group_history_entries

    before = HistoryEntry.model_construct(
        id="before", label="before render_preview", operation=None
    )
    after = HistoryEntry.model_construct(
        id="after", label="after render_preview", operation="render_preview", params=None
    )
    history = ProjectHistory.model_construct(entries=[before, after], cursor=1)
    assert history.edit_head_id() == "before"
    (group,) = _group_history_entries(history.entries)
    assert (group.before_id, group.after_id, group.operation) == (
        "before",
        "after",
        "render_preview",
    )


def test_export_result_reports_the_head_only_when_recorded() -> None:
    from pathlib import Path

    from podcast_mcp.services.pipeline import AudioExportResult

    assert "edit_head_id" not in AudioExportResult([Path("a.wav")], None).job_result()
    assert AudioExportResult([Path("a.wav")], None, "b").job_result()["edit_head_id"] == "b"


def _edit_head_cases() -> list[dict]:
    import json
    from pathlib import Path

    path = Path(__file__).parent / "fixtures" / "edit_head" / "cases.json"
    return json.loads(path.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", _edit_head_cases(), ids=lambda c: c["name"])
def test_edit_head_matches_the_shared_fixture(case: dict) -> None:
    history = ProjectHistory.model_construct(
        entries=[
            HistoryEntry.model_construct(snapshot_file="", **entry) for entry in case["entries"]
        ],
        cursor=case["cursor"],
    )
    assert history.edit_head_id() == case["expected"]
