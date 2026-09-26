from __future__ import annotations

import json
from collections.abc import Callable

from podcast_mcp.engines.play_audit import invalidate_stem_hashes
from podcast_mcp.engines.reconciliation_state import mark_reconciliation_stale
from podcast_mcp.engines.render_invalidations import replace_with_whole_track
from podcast_mcp.history import HistoryManager
from podcast_mcp.history.diff import diff_snapshots
from podcast_mcp.history.summary import format_history_group_title, summarize_diff
from podcast_mcp.models import EpisodeProject
from podcast_mcp.render import render_preview_result, rerender_preview
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.project_state import project_commit_lock
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


class HistoryRerenderError(RuntimeError):
    """A history move was saved, but re-rendering its preview failed."""


class HistoryService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace
        self._mgr = HistoryManager(workspace.path)

    def undo(self, *, rerender: bool = False) -> dict:
        return self._move("undo", self._mgr.undo, rerender=rerender)

    def redo(self, *, rerender: bool = False) -> dict:
        return self._move("redo", self._mgr.redo, rerender=rerender)

    def goto(self, index: int, *, rerender: bool = False) -> dict:
        return self._move("goto", lambda project: self._mgr.goto(project, index), rerender=rerender)

    def _move(
        self, action: str, move: Callable[[EpisodeProject], object], *, rerender: bool
    ) -> dict:
        """Commit a history move with its stale marks; optionally re-render the preview.

        The move and its stale marks are saved in one step under ``project_commit_lock``,
        so no other writer commits between them and is overwritten. A render takes
        seconds, so it runs between ``checkpoint()`` and ``save_merged()``: an edit another
        request commits meanwhile is merged in, not overwritten (#493). If the render or
        the merge fails, the move stays saved, so the error says to re-render the preview,
        not to repeat the move.

        Returns ``status()`` read after the save. When a concurrent edit was merged in,
        its cursor is the ``after merging concurrent edits`` entry, not the move's target.
        """
        project = self.ws.project
        with project_commit_lock(project):
            move(project)
            mark_reconciliation_stale(project)
            invalidate_stem_hashes(project)
            replace_with_whole_track(project, dialogue_track_ids(project), reason="other")
            self.ws.save()
        if not rerender:
            return self.status()
        # save() cleared the loaded-file signature, so checkpoint() adopts the saved file:
        # the stale marks are part of the merge base, not changes this render made.
        project = self.ws.checkpoint()
        try:
            rerender_preview(project)
            preview = json.loads(render_preview_result(project, rerender=False))
        except Exception as exc:
            raise HistoryRerenderError(
                f"the {action} is saved, but re-rendering the preview failed ({exc}); "
                f"re-render the preview instead of repeating the {action}"
            ) from exc
        self.ws.save_merged(
            retry=f"the {action} is saved; re-render the preview instead of repeating the {action}",
            undo_redo_retry="another undo or redo moved the history cursor while the "
            "preview rendered; check history_status before re-rendering the preview",
        )
        return {**self.status(), "preview": preview}

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
