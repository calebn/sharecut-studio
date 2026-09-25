from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

from pydantic import ValidationError

from podcast_mcp.history import HistoryManager, run_mutation
from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.history import HistoryEntry
from podcast_mcp.project_io import open_project, resolve_project_path
from podcast_mcp.project_merge import ProjectMergeConflict, merge_project_data, project_merge_data
from podcast_mcp.project_store import ProjectStore, history_index_path, restore_history_index
from podcast_mcp.util.atomic_json import load_json_object
from podcast_mcp.util.project_state import (
    FileRevision,
    file_revision,
    project_commit_lock,
    project_state_lock,
)

T = TypeVar("T")

MERGED_HISTORY_LABEL = "after merging concurrent edits"


class ProjectWorkspace:
    def __init__(self, path: Path, project: EpisodeProject) -> None:
        self.path = path
        self.project = project
        self._store = ProjectStore(path)
        self._loaded_file_signature: FileRevision | None = None
        self._merge_base: dict[str, Any] | None = None

    @classmethod
    def open(cls, project_path: Path | str) -> ProjectWorkspace:
        path = resolve_project_path(project_path)
        before = file_revision(path)
        _, project = open_project(path)
        ws = cls(path, project)
        signature = file_revision(path)
        if signature == before:
            ws._loaded_file_signature = signature
        return ws

    def reload(self) -> EpisodeProject:
        with project_state_lock(self.project):
            signature = file_revision(self.path)
            if signature == self._loaded_file_signature:
                return self.project
            self.project = self._store.load()
            self._loaded_file_signature = (
                signature if file_revision(self.path) == signature else None
            )
            return self.project

    def save(self) -> None:
        with project_state_lock(self.project):
            self._store.commit(self.project)
            # A separate process may replace the file as this commit finishes.
            # Re-read once before trusting a revision for this in-memory model.
            self._loaded_file_signature = None

    def checkpoint(self) -> EpisodeProject:
        """Reload the saved project and remember it as the base ``save_merged`` merges onto.

        Long jobs (pipeline run, export) call this before their slow work so a
        change another request commits meanwhile is merged in, not overwritten.
        Unsaved edits already on ``self.project`` count as this job's changes only
        while the file is unchanged since this workspace loaded it. If the file
        changed since then (another writer committed, or this workspace saved),
        ``self.project`` is replaced by the saved file and those unsaved edits are
        dropped.
        """
        with project_state_lock(self.project):
            before = file_revision(self.path)
            saved = self._store.load()
            stable = file_revision(self.path) == before
            if not (stable and before == self._loaded_file_signature):
                # The file changed since load (or while being read): adopt it.
                self.project = saved
                self._loaded_file_signature = before if stable else None
            # Otherwise keep the in-memory copy: unsaved edits on it are this job's
            # changes. Either way the base is this one read of the saved file.
            self._merge_base = project_merge_data(saved)
            return self.project

    def save_merged(self, history_label: str | None = None) -> None:
        """Commit this workspace's changes since ``checkpoint`` on top of the saved file.

        ``history_label`` first records this job's state as an undo entry (a pipeline
        step's ``after <step>``) in the same locked commit. Another writer's change since
        checkpoint is merged in, recorded as ``after merging concurrent edits`` and adopted
        in place (later steps see it). Raises ``ProjectMergeConflict``, saving nothing,
        when both changed one value, or when one side undid/redid past the checkpoint
        state while the other recorded history.

        Nothing is adopted until the commit lands: on a conflict or a failed commit,
        ``history/index.json`` and ``self.project.history`` are put back and snapshots
        recorded by this call are removed, so ``self.project`` keeps only the job's own
        unsaved changes. If the project file was written but a later cache write failed,
        the saved state is adopted before the error propagates.

        The merge replaces whole sections (``tracks``, ``pipeline_runs``, ``render``, ...)
        on ``self.project`` in place: re-fetch sub-objects after this call instead of
        keeping references taken before it.
        """
        with project_state_lock(self.project):
            if self._merge_base is None:
                raise RuntimeError("save_merged() needs checkpoint() first")
            with project_commit_lock(self.project):
                revision = file_revision(self.path)
                saved = project_merge_data(self._store.load())
                index_path = history_index_path(self.project)
                index_before = load_json_object(index_path)
                history_before = self.project.history.model_copy(deep=True)
                created: list[HistoryEntry] = []
                to_save: EpisodeProject | None = None
                try:
                    to_save = self._merged_with(saved, history_label, created)
                    self._store.commit(to_save)
                except BaseException:
                    if to_save is not None and file_revision(self.path) != revision:
                        # The project file was replaced; only a later write failed.
                        self._adopt_saved(to_save)
                    else:
                        self.project.history = history_before
                        restore_history_index(index_path, index_before)
                        for entry in created:
                            (self.project.workspace_path() / entry.snapshot_file).unlink(
                                missing_ok=True
                            )
                    raise
                finally:
                    self._loaded_file_signature = None
                self._adopt_saved(to_save)

    def _merged_with(
        self,
        saved: dict[str, Any],
        history_label: str | None,
        created: list[HistoryEntry],
    ) -> EpisodeProject:
        """The project to commit: ``self.project`` or, when the file moved, a merged copy.

        Records history on it (appending new entries to ``created``) but never adopts
        a merge into ``self.project``; ``save_merged`` does that after the commit.
        """
        assert self._merge_base is not None
        mgr = HistoryManager(self.path)

        def record(project: EpisodeProject, label: str) -> None:
            known = {e.id for e in project.history.entries}
            entry = mgr.record(project, label)
            if entry.id not in known:
                created.append(entry)

        if history_label is not None:
            record(self.project, history_label)
        if saved == self._merge_base:
            return self.project
        merged = merge_project_data(self._merge_base, project_merge_data(self.project), saved)
        try:
            adopted = EpisodeProject.model_validate(merged)
        except ValidationError as exc:
            raise ProjectMergeConflict(["(merged project is invalid)"]) from exc
        record(adopted, MERGED_HISTORY_LABEL)
        return adopted

    def _adopt_saved(self, project: EpisodeProject) -> None:
        if project is not self.project:
            _adopt_project_state(self.project, project)
        self._merge_base = project_merge_data(self.project)

    def mutate(
        self,
        label_before: str,
        label_after: str,
        fn: Callable[[EpisodeProject], T],
        *,
        operation: str | None = None,
        params: dict | None = None,
        reload_first: bool = False,
    ) -> T:
        """Run ``fn`` on the project as an undoable mutation and commit it.

        ``reload_first`` re-reads the saved project first when the file changed since
        this workspace loaded it. Unsaved edits on ``self.project`` are then discarded,
        and anything still holding the old ``self.project`` object keeps a detached copy.
        """
        with project_state_lock(self.project):
            if reload_first:
                # Mutate the saved project: this copy may predate another request's commit.
                self.reload()
            try:
                return run_mutation(
                    self.path,
                    self.project,
                    label_before,
                    label_after,
                    fn,
                    operation=operation,
                    params=params,
                )
            finally:
                # Even a failed save may have changed the in-memory project,
                # so the next reload reads the file instead of trusting it.
                self._loaded_file_signature = None

    def record_snapshot(self, label: str, *, force: bool = False) -> str:
        entry = HistoryManager(self.path).record(self.project, label, force=force)
        self.save()
        return f"{entry.id}: {entry.label}"

    @staticmethod
    def create(workspace_dir: Path | str, name: str = "episode") -> ProjectWorkspace:
        workspace = Path(workspace_dir).expanduser().resolve()
        project = EpisodeProject.create(name, str(workspace))
        project.ensure_dirs()
        path = resolve_project_path(workspace)
        store = ProjectStore(path)
        store.commit(project)
        loaded = store.load()
        HistoryManager(path).record(loaded, "initial", force=True)
        store.commit(loaded)
        return ProjectWorkspace(path, loaded)


def _adopt_project_state(target: EpisodeProject, source: EpisodeProject) -> None:
    """Copy ``source``'s sections into ``target`` in place, so holders of ``target`` see them.

    Not ``history.manager.apply_snapshot_to_project``: that copies only
    ``EDITABLE_FIELDS``, and a merge also changes history and ``pipeline_runs``.
    """
    for name in type(target).model_fields:
        value = getattr(source, name)
        if getattr(target, name) != value:
            setattr(target, name, value)
