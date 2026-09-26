from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, TypeVar

from pydantic import ValidationError

from podcast_mcp.history import HistoryManager, run_mutation
from podcast_mcp.history.manager import record_and_commit
from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.project_io import open_project, resolve_project_path
from podcast_mcp.project_merge import (
    RERUN_ADVICE,
    ConflictAdvice,
    ProjectMergeConflict,
    merge_project_data,
    project_merge_data,
)
from podcast_mcp.project_store import (
    ProjectStore,
    commit_landed,
    history_index_path,
    history_index_to_restore,
    history_snapshot_ids,
    rollback_history,
)
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
        self._transaction_depth = 0

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

    @contextmanager
    def transaction(self) -> Iterator[EpisodeProject]:
        """Serialize reload -> mutate -> commit on this workspace across threads and processes (#213).

        Holds ``project_commit_lock`` (in-process state lock, then the per-workspace file
        lock). The outermost transaction first adopts the saved project in place when the
        file changed since this workspace loaded or committed it (unsaved edits are then
        dropped); nested ones reuse the state already read. Commit only through this
        workspace inside it. Other processes' commits wait up to
        ``PROJECT_COMMIT_LOCK_TIMEOUT_SEC``, then raise ``filelock.Timeout``.

        Adopting replaces whole sections of ``self.project`` in place (as ``save_merged``
        does): re-fetch sub-objects inside the transaction instead of keeping references
        taken before it, and read ``self.project`` from other threads only under
        ``project_state_lock``.
        """
        with project_commit_lock(self.project):
            if self._transaction_depth == 0:
                self._adopt_saved_if_changed_locked()
            self._transaction_depth += 1
            try:
                yield self.project
            finally:
                self._transaction_depth -= 1

    def _adopt_saved_if_changed_locked(self) -> None:
        """Under ``project_commit_lock``: adopt the saved file in place if another writer moved it."""
        try:
            signature = file_revision(self.path)
        except FileNotFoundError:
            return  # nothing saved yet
        if signature == self._loaded_file_signature:
            return
        _adopt_project_state(self.project, self._store.load())
        # Writers are excluded by the lock, so this revision is exact.
        self._loaded_file_signature = signature

    def save(self) -> None:
        """Commit ``self.project`` as is. Read-modify-save callers wrap this in ``transaction()``."""
        with project_commit_lock(self.project):
            try:
                self._store.commit(self.project)
            except BaseException:
                self._loaded_file_signature = None
                raise
            # Inside the lock no other writer can replace the file: this revision is exact.
            self._loaded_file_signature = project_file_revision(self.project)

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

    def discard_changes(self) -> EpisodeProject:
        """Drop unsaved in-memory changes and any checkpoint; re-read the saved project.

        For a job whose slow work failed after ``checkpoint()``: the workspace then
        matches the file again, so a later ``save()`` / ``save_merged()`` cannot persist
        the failed work's partial state. ``save_merged()`` needs a new ``checkpoint()``.
        """
        with project_state_lock(self.project):
            self._loaded_file_signature = None
            self._merge_base = None
            return self.reload()

    def save_merged(
        self,
        history_label: str | None = None,
        *,
        advice: ConflictAdvice = RERUN_ADVICE,
    ) -> None:
        """Commit this workspace's changes since ``checkpoint`` on top of the saved file.

        ``history_label`` first records this job's state as an undo entry (a pipeline
        step's ``after <step>``) in the same locked commit. Another writer's change since
        checkpoint is merged in, recorded as ``after merging concurrent edits`` and adopted
        in place (later steps see it). Raises ``ProjectMergeConflict``, saving nothing,
        when both changed one value, or (``history.lineage``) when one side undid/redid
        past the checkpoint state while the other recorded history. ``advice`` ends that message
        (what the caller should do next).

        Nothing is adopted until the commit lands: on a conflict or a failed commit,
        ``history/index.json`` and ``self.project.history`` are put back and snapshot files
        written during this call are removed, so ``self.project`` keeps only the job's own
        unsaved changes. If the project file was written but a later cache write failed,
        the saved state is adopted. If the file cannot be stat'ed afterwards, only ``self.project.history`` is put back; the index and snapshots are left as they are. Cleanup failures are logged; the original error is the
        one raised. An unreadable index is restored from the saved project's history.

        Assumes every writer of ``episode.project.json`` and ``history/`` holds
        ``project_commit_lock``, as every in-tree writer does in every process
        (``transaction()``, ``save()``, ``HistoryManager``): the "file replaced, so
        adopt" check and the snapshot cleanup would misread a writer outside it.

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
                index_before = history_index_to_restore(index_path, saved_project.history)
                snapshots_before = history_snapshot_ids(index_path)
                history_before = self.project.history.model_copy(deep=True)
                to_save: EpisodeProject | None = None
                try:
                    to_save = self._merged_with(saved, history_label, advice)
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
        replaced = commit_landed(self.project, revision)  # None: unknown whether it landed
        if to_save is not None and replaced:
            # The project file was replaced; only a later write (transcript cache) failed.
            try:
                self._adopt_saved(to_save)
            except Exception:
                log.warning("Could not adopt the saved project after a failed save", exc_info=True)
            return
        self.project.history = history_before
        if replaced is None:
            # The file may hold the new entries: keep the index and snapshots (orphans are
            # harmless; deleting snapshots the saved file references would break undo).
            log.warning("Leaving %s and its snapshots in place after a failed save", index_path)
            return
        try:
            new_ids = history_snapshot_ids(index_path) - snapshots_before
            rollback_history(index_path, index_before, new_ids)
        except Exception:
            log.warning("Could not roll back %s after a failed save", index_path, exc_info=True)

    def _merged_with(
        self,
        saved: dict[str, Any],
        history_label: str | None,
        advice: ConflictAdvice,
    ) -> EpisodeProject:
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
        merged = merge_project_data(
            self._merge_base,
            project_merge_data(self.project),
            saved,
            advice=advice,
        )
        try:
            adopted = EpisodeProject.model_validate(merged)
        except ValidationError as exc:
            raise ProjectMergeConflict(["(merged project is invalid)"], advice=advice) from exc
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
    ) -> T:
        """Run ``fn`` on the saved project as an undoable mutation and commit it, inside ``transaction()``.

        The file lock is held from the reload through the commit, so no writer in any
                process commits in between (#213). A slow ``fn`` holds it for its whole run.
        ``transaction()`` may first adopt the saved project in place: ``fn`` receives the
        current project, so do not keep sub-object references from before the call.
        """
        with self.transaction():
            try:
                result = run_mutation(
                    self.path,
                    self.project,
                    label_before,
                    label_after,
                    fn,
                    operation=operation,
                    params=params,
                )
            except BaseException:
                # A failed save may have changed the in-memory project or the file.
                self._loaded_file_signature = None
                raise
            self._loaded_file_signature = project_file_revision(self.project)
            return result

    def record_snapshot(self, label: str, *, force: bool = False) -> str:
        """Record ``label`` as a history entry and commit it; a failure rolls the entry back."""
        with self.transaction():
            try:
                entry = record_and_commit(self._store, self.project, label, force=force)
            except BaseException:
                # A failed commit may still have replaced the file; re-read before trusting it.
                self._loaded_file_signature = None
                raise
            self._loaded_file_signature = project_file_revision(self.project)
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
