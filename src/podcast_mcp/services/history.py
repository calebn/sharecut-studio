from __future__ import annotations

import json

from podcast_mcp.engines.play_audit import invalidate_stem_hashes
from podcast_mcp.engines.reconciliation_state import mark_reconciliation_stale
from podcast_mcp.engines.render_invalidations import replace_with_whole_track
from podcast_mcp.history import HistoryManager
from podcast_mcp.history.diff import diff_snapshots
from podcast_mcp.history.summary import format_history_group_title, summarize_diff
from podcast_mcp.render import render_preview_result, rerender_preview
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.tracks import dialogue_track_ids


def _group_history_entries(entries: list) -> list[dict]:
    groups: list[dict] = []
    i = 0
    while i < len(entries):
        entry = entries[i]
        if (
            i + 1 < len(entries)
            and entry.label.startswith("before ")
            and entries[i + 1].label.startswith("after ")
        ):
            after = entries[i + 1]
            label = after.label.removeprefix("after ")
            groups.append(
                {
                    "kind": "mutation",
                    "before_index": i,
                    "after_index": i + 1,
                    "before_id": entry.id,
                    "after_id": after.id,
                    "label": label,
                    "operation": after.operation,
                    "params": after.params,
                    "created_at": after.created_at,
                    "title": format_history_group_title(
                        kind="mutation",
                        label=label,
                        operation=after.operation,
                        params=after.params or {},
                    ),
                }
            )
            i += 2
        else:
            groups.append(
                {
                    "kind": "snapshot",
                    "index": i,
                    "id": entry.id,
                    "label": entry.label,
                    "operation": entry.operation,
                    "params": entry.params,
                    "created_at": entry.created_at,
                    "title": format_history_group_title(
                        kind="snapshot",
                        label=entry.label,
                        operation=entry.operation,
                        params=entry.params or {},
                    ),
                }
            )
            i += 1
    return groups


class HistoryService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace
        self._mgr = HistoryManager(workspace.path)

    def undo(self, *, rerender: bool = False) -> dict:
        status = self._mgr.undo(self.ws.project)
        mark_reconciliation_stale(self.ws.project)
        invalidate_stem_hashes(self.ws.project)
        replace_with_whole_track(
            self.ws.project, dialogue_track_ids(self.ws.project), reason="other"
        )
        result = dict(status.__dict__)
        if rerender:
            rerender_preview(self.ws.project)
            result["preview"] = json.loads(render_preview_result(self.ws.project, rerender=False))
        self.ws.save()
        return result

    def redo(self, *, rerender: bool = False) -> dict:
        status = self._mgr.redo(self.ws.project)
        mark_reconciliation_stale(self.ws.project)
        invalidate_stem_hashes(self.ws.project)
        replace_with_whole_track(
            self.ws.project, dialogue_track_ids(self.ws.project), reason="other"
        )
        result = dict(status.__dict__)
        if rerender:
            rerender_preview(self.ws.project)
            result["preview"] = json.loads(render_preview_result(self.ws.project, rerender=False))
        self.ws.save()
        return result

    def goto(self, index: int, *, rerender: bool = False) -> dict:
        status = self._mgr.goto(self.ws.project, index)
        mark_reconciliation_stale(self.ws.project)
        invalidate_stem_hashes(self.ws.project)
        replace_with_whole_track(
            self.ws.project, dialogue_track_ids(self.ws.project), reason="other"
        )
        result = dict(status.__dict__)
        if rerender:
            rerender_preview(self.ws.project)
            result["preview"] = json.loads(render_preview_result(self.ws.project, rerender=False))
        self.ws.save()
        return result

    def status(self) -> dict:
        status = self._mgr.status(self.ws.project)
        return dict(status.__dict__)

    def list_entries(self) -> dict:
        status = self._mgr.status(self.ws.project)
        entries = self._mgr.list_entries(self.ws.project)
        flat = [
            {
                "index": i,
                "id": e.id,
                "label": e.label,
                "created_at": e.created_at,
                "operation": e.operation,
                "params": e.params,
                "current": i == status.cursor,
            }
            for i, e in enumerate(entries)
        ]
        return {
            "cursor": status.cursor,
            "can_undo": status.can_undo,
            "can_redo": status.can_redo,
            "entries": flat,
            "groups": _group_history_entries(entries),
        }

    def diff(
        self,
        from_index: int | None = None,
        to_index: int | None = None,
    ) -> dict:
        history = self._mgr._load_index(self.ws.project)
        entries = history.entries
        if not entries:
            return {
                "diff": {},
                "summary": [],
                "from_index": None,
                "to_index": None,
            }
        to_idx = history.cursor if to_index is None else to_index
        from_idx = to_idx - 1 if from_index is None else from_index
        if from_idx < 0 or to_idx < 0 or from_idx >= len(entries) or to_idx >= len(entries):
            raise ValueError("history diff index out of range")
        before = self._mgr._read_snapshot(self.ws.project, entries[from_idx])
        after = self._mgr._read_snapshot(self.ws.project, entries[to_idx])
        raw = diff_snapshots(before, after)
        after_entry = entries[to_idx]
        return {
            "from_index": from_idx,
            "to_index": to_idx,
            "from_label": entries[from_idx].label,
            "to_label": after_entry.label,
            "operation": after_entry.operation,
            "params": after_entry.params,
            "diff": raw,
            "summary": summarize_diff(
                raw,
                operation=after_entry.operation,
                params=after_entry.params or {},
                label=after_entry.label,
            ),
        }

    def record(self, label: str = "manual") -> str:
        return self.ws.record_snapshot(label, force=True)
