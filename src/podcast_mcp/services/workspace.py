from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

from pydantic import ValidationError

from podcast_mcp.history import HistoryManager, run_mutation
from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.project_io import open_project, resolve_project_path
from podcast_mcp.project_merge import ProjectMergeConflict, merge_project_data, project_merge_data
from podcast_mcp.project_store import (
    ProjectStore,
    history_index_path,
    history_snapshot_ids,
    rollback_history,
)
from podcast_mcp.util.atomic_json import load_json_object
from podcast_mcp.util.project_state import (
    FileRevision,
    file_revision,
    project_commit_lock,
    project_file_revision,
    project_state_lock,
)

T = TypeVar("T")

log = logging.getLogger(__name__)

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
        when both changed one value, or (``history.lineage``) when one side undid/redid
        past the checkpoint state while the other recorded history.

        Nothing is adopted until the commit lands: on a conflict or a failed commit,
        ``history/index.json`` and ``self.project.history`` are put back and snapshot files
        written during this call are removed, so ``self.project`` keeps only the job's own
        unsaved changes. If the project file was written but a later cache write failed,
        the saved state is adopted. Cleanup failures are logged; the original error is the
        one raised. An unreadable index is restored from the saved project's history.

        Assumes every writer of ``episode.project.json`` and ``history/`` holds
        ``project_commit_lock``, as every in-tree writer does: the "file replaced, so
        adopt" check and the snapshot cleanup would misread a writer outside it, such as
        another process (#213).

        The merge replaces whole sections (``tracks``, ``pipeline_runs``, ``render``, ...)
        on ``self.project`` in place: re-fetch sub-objects after this call instead of
        keeping references taken before it.
        """
        with project_state_lock(self.project):
            if self._merge_base is None:
                raise RuntimeError("save_merged() needs checkpoint() first")
            with project_commit_lock(self.project):
                revision = project_file_revision(self.project)
                saved_project = self._store.load()
                saved = project_merge_data(saved_project)
                index_path = history_index_path(self.project)
                index_before = _index_to_restore(index_path, saved_project)
                snapshots_before = history_snapshot_ids(index_path)
                history_before = self.project.history.model_copy(deep=True)
                to_save: EpisodeProject | None = None
                try:
                    to_save = self._merged_with(saved, history_label)
                    self._store.commit(to_save)
                except BaseException:
                    self._recover_failed_save(
                        to_save,
                        revision,
                        history_before,
                        index_path,
                        index_before,
                        snapshots_before,
                    )
                    raise
                finally:
                    self._loaded_file_signature = None
                self._adopt_saved(to_save)

    def _recover_failed_save(
        self,
        to_save: EpisodeProject | None,
        revision: FileRevision | None,
        history_before: ProjectHistory,
        index_path: Path,
        index_before: dict[str, Any] | None,
        snapshots_before: set[str],
    ) -> None:
        """Best-effort cleanup after a failed ``save_merged``; logs and never raises."""
        try:
            replaced = project_file_revision(self.project) != revision
        except OSError:
            log.warning("Could not stat the project file after a failed save", exc_info=True)
            replaced = False
        if to_save is not None and replaced:
            # The project file was replaced; only a later write (transcript cache) failed.
            try:
                self._adopt_saved(to_save)
            except Exception:
                log.warning("Could not adopt the saved project after a failed save", exc_info=True)
            return
        self.project.history = history_before
        try:
            new_ids = history_snapshot_ids(index_path) - snapshots_before
            rollback_history(index_path, index_before, new_ids)
        except Exception:
            log.warning("Could not roll back %s after a failed save", index_path, exc_info=True)

    def _merged_with(self, saved: dict[str, Any], history_label: str | None) -> EpisodeProject:
        """The project to commit: ``self.project`` or, when the file moved, a merged copy.

        Records history on it but never adopts a merge into ``self.project``;
        ``save_merged`` does that after the commit.
        """
        assert self._merge_base is not None
        mgr = HistoryManager(self.path)
        if history_label is not None:
            mgr.record(self.project, history_label)
        if saved == self._merge_base:
            return self.project
        merged = merge_project_data(self._merge_base, project_merge_data(self.project), saved)
        try:
            adopted = EpisodeProject.model_validate(merged)
        except ValidationError as exc:
            raise ProjectMergeConflict(["(merged project is invalid)"]) from exc
        mgr.record(adopted, MERGED_HISTORY_LABEL)
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


def _index_to_restore(index_path: Path, saved: EpisodeProject) -> dict[str, Any] | None:
    """``history/index.json`` as a failed ``save_merged`` puts it back (``None``: absent).

    An unreadable index falls back to the saved project's history, which the next commit
    writes anyway, so a corrupt index does not stop every long job.
    """
    try:
        return load_json_object(index_path)
    except ValueError:
        log.warning(
            "Unreadable %s; a failed save restores it from the project file",
            index_path,
            exc_info=True,
        )
        return saved.history.model_dump(mode="json")


def _adopt_project_state(target: EpisodeProject, source: EpisodeProject) -> None:
    """Copy ``source``'s sections into ``target`` in place, so holders of ``target`` see them.

    Not ``history.manager.apply_snapshot_to_project``: that copies only
    ``EDITABLE_FIELDS``, and a merge also changes history and ``pipeline_runs``.
    """
    for name in type(target).model_fields:
        value = getattr(source, name)
        if getattr(target, name) != value:
            setattr(target, name, value)
