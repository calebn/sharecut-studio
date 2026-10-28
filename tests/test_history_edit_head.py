from __future__ import annotations

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
