"""Host-owned first runs for episodes imported while Studio setup is pending."""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from filelock import Timeout
from pydantic import BaseModel, TypeAdapter

from podcast_mcp import settings
from podcast_mcp.models import EpisodeProject, TrackRole, load_project
from podcast_mcp.services.jobs import LIVE_JOB_STATUSES, JobManager, JobSlotBusyError
from podcast_mcp.services.pipeline import (
    config_store,
    ensure_whisper_cached_for_run,
    ensure_word_aligner_for_run,
    skip_steps_from_enabled,
)
from podcast_mcp.util import host_platform
from podcast_mcp.util.atomic_file import atomic_write
from podcast_mcp.util.file_locks import hold_shared_file_lock
from podcast_mcp.util.model_missing import ModelMissing

logger = logging.getLogger(__name__)

_POLL_SECONDS = 2.0


class SetupRun(BaseModel):
    path: Path
    created_at: str
    config: dict[str, Any]
    skip_steps: list[str] | None
    unattended: bool


_RUNS = TypeAdapter(list[SetupRun])


def _needs_transcription(project: EpisodeProject) -> bool:
    dialogue = {
        track.id for track in project.tracks if track.media and track.role == TrackRole.DIALOGUE
    }
    return any(
        project.transcript_for_source(track_id, source_id) is None
        for track_id, source_id in {
            (clip.track_id, clip.source_id) for clip in project.clips if clip.track_id in dialogue
        }
    )


def _models_ready(entry: SetupRun) -> bool:
    try:
        ensure_whisper_cached_for_run(
            config=entry.config, skip_steps=entry.skip_steps, memoize=True
        )
        ensure_word_aligner_for_run(entry.config, skip_steps=entry.skip_steps)
    except ModelMissing:
        return False
    return True


class SetupRunQueue:
    """Persist import intent outside the project and use the existing pipeline job slot."""

    def __init__(
        self,
        jobs: JobManager,
        path: Path | None = None,
        *,
        initial_project: Path | None = None,
    ) -> None:
        self.jobs = jobs
        self.path = path or settings.config_dir() / "setup-runs.json"
        self._projects = {initial_project.resolve()} if initial_project else None

    def _read(self) -> list[SetupRun]:
        try:
            return _RUNS.validate_json(self.path.read_bytes())
        except FileNotFoundError:
            return []

    def _replace(self, entries: list[SetupRun]) -> None:
        atomic_write(self.path, lambda handle: handle.write(_RUNS.dump_json(entries)))

    def waiting(self, project_path: Path | str) -> bool:
        path = Path(project_path).resolve()
        try:
            return any(entry.path == path for entry in self._read())
        except (OSError, ValueError):
            logger.warning("Could not read queued setup runs")
            return False

    def enqueue(self, project_path: Path) -> bool:
        path = project_path.resolve()
        project = load_project(path)
        if (
            not _needs_transcription(project)
            or host_platform.current().transcription == "unavailable"
        ):
            return False
        working = config_store().get(path, stage=False)
        intent = SetupRun(
            path=path,
            created_at=project.created_at,
            config=working.config,
            skip_steps=(
                skip_steps_from_enabled(working.enabled_steps)
                if working.enabled_steps is not None
                else None
            ),
            unattended=working.unattended,
        )
        with hold_shared_file_lock(self.path.with_suffix(".lock"), timeout=2):
            entries = self._read()
            if not any(entry.path == path for entry in entries):
                if _models_ready(intent):
                    return False
                self._replace([*entries, intent])
            if self._projects is not None:
                self._projects.add(path)
        return True

    def _remove(self, entry: SetupRun) -> None:
        with hold_shared_file_lock(self.path.with_suffix(".lock"), timeout=2):
            self._replace([queued for queued in self._read() if queued != entry])

    def _dispatch(self, stop: threading.Event) -> None:
        job = self.jobs.get_job()
        if job is not None and job.status in LIVE_JOB_STATUSES:
            return
        for entry in self._read():
            if stop.is_set():
                return
            if self._projects is not None and entry.path not in self._projects:
                continue
            if not _models_ready(entry):
                continue
            try:
                project = load_project(entry.path)
            except (OSError, ValueError):
                continue
            if project.created_at != entry.created_at or not _needs_transcription(project):
                self._remove(entry)
                continue
            if stop.is_set():
                return
            try:
                job = self.jobs.start(
                    entry.path,
                    config=entry.config,
                    skip_steps=entry.skip_steps,
                    unattended=entry.unattended,
                )
            except JobSlotBusyError:
                return
            while job.status in LIVE_JOB_STATUSES:
                if stop.wait(_POLL_SECONDS):
                    return
            if job.error_code != "model_needed":
                self._remove(entry)
            return

    def _run(self, stop: threading.Event) -> None:
        while not stop.wait(_POLL_SECONDS):
            if not self.path.is_file():
                continue
            try:
                with hold_shared_file_lock(self.path.with_suffix(".dispatch.lock"), timeout=0):
                    self._dispatch(stop)
            except Timeout:
                continue
            except Exception:
                logger.exception("Could not dispatch a first-run episode")
                if stop.wait(30):
                    return

    @asynccontextmanager
    async def running(self) -> AsyncIterator[None]:
        stop = threading.Event()
        thread = threading.Thread(
            target=self._run, args=(stop,), name="setup-run-queue", daemon=True
        )
        thread.start()
        try:
            yield
        finally:
            stop.set()
            await asyncio.to_thread(thread.join)
