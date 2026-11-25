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
from podcast_mcp.engines.onnx_session import OnnxOverrideUnsupportedError
from podcast_mcp.models import EpisodeProject, TrackRole, load_project
from podcast_mcp.services.jobs import LIVE_JOB_STATUSES, JobManager, JobSlotBusyError
from podcast_mcp.services.pipeline import (
    config_store,
    ensure_whisper_cached_for_run,
    ensure_word_aligner_for_run,
    ensure_word_aligner_override_supported_for_run,
    merge_pipeline_config,
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
    launch_project: Path | None = None


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
    ensure_word_aligner_override_supported_for_run(entry.config, skip_steps=entry.skip_steps)
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
        self._launch_project = initial_project.resolve() if initial_project else None
        self._parked: dict[Path, tuple[str | None, str | None]] = {}

    def _read(self) -> list[SetupRun]:
        try:
            return _RUNS.validate_json(self.path.read_bytes())
        except FileNotFoundError:
            return []

    def _replace(self, entries: list[SetupRun]) -> None:
        atomic_write(self.path, lambda handle: handle.write(_RUNS.dump_json(entries)))

    def _owns(self, entry: SetupRun) -> bool:
        return self._launch_project is None or self._launch_project in (
            entry.path,
            entry.launch_project,
        )

    def waiting(self, project_path: Path | str) -> bool:
        path = Path(project_path).resolve()
        try:
            parked = self._parked.get(path) == self._model_epoch()
            return not parked and any(
                entry.path == path and self._owns(entry) for entry in self._read()
            )
        except (OSError, ValueError):
            logger.warning("Could not read queued setup runs")
            return False

    def _downloading_whisper_model(self) -> str | None:
        download = self.jobs.get_bootstrap_job()
        if (
            download is not None
            and download.status in LIVE_JOB_STATUSES
            and not download.cancel_requested
            and "whisper" in download.components
        ):
            return download.whisper_model
        return None

    def _model_epoch(self) -> tuple[str | None, str | None]:
        download = self.jobs.get_bootstrap_job()
        return (None, None) if download is None else (download.id, download.status)

    def _resolve_model(self, entry: SetupRun, downloading_model: str | None) -> SetupRun:
        config = merge_pipeline_config(entry.config)
        if downloading_model is not None:
            config["transcribe"]["model"] = downloading_model
        return entry.model_copy(update={"config": config})

    def enqueue(self, project_path: Path) -> bool:
        path = project_path.resolve()
        project = load_project(path)
        if (
            not _needs_transcription(project)
            or host_platform.current().transcription == "unavailable"
        ):
            return False
        working = config_store().get(path, stage=False)
        # Home applies the current Prepare defaults before upload. The Whisper model for a
        # first run follows Setup, whose preference may change while the episode is waiting.
        transcribe = working.config.get("transcribe")
        staged_model = transcribe.pop("model", None) if isinstance(transcribe, dict) else None
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
            launch_project=self._launch_project,
        )
        with hold_shared_file_lock(self.path.with_suffix(".lock"), timeout=2):
            self._parked.pop(path, None)
            entries = self._read()
            existing = next((entry for entry in entries if entry.path == path), None)
            if existing is not None:
                return self._owns(existing)
            downloading_model = self._downloading_whisper_model()
            run = self._resolve_model(intent, downloading_model)
            model_changed = (
                staged_model is not None and staged_model != run.config["transcribe"]["model"]
            )
            if downloading_model is not None or model_changed:
                ensure_word_aligner_override_supported_for_run(
                    run.config, skip_steps=run.skip_steps
                )
            elif _models_ready(run):
                return False
            self._replace([*entries, intent])
        return True

    def moved(self, old_project: Path, new_project: Path) -> None:
        """Follow an episode Studio moved: queued runs that name its old project file name the new one.

        That covers the episode's own run and the runs a Studio launched on it queued for other
        episodes, so the queue still starts them and this Studio still owns them.
        """
        old, new = old_project.resolve(), new_project.resolve()
        if self._launch_project == old:
            self._launch_project = new
        with hold_shared_file_lock(self.path.with_suffix(".lock"), timeout=2):
            if old in self._parked:
                self._parked[new] = self._parked.pop(old)
            entries = self._read()

            def follow(path: Path | None) -> Path | None:
                return new if path == old else path

            followed = [
                entry.model_copy(
                    update={
                        "path": follow(entry.path),
                        "launch_project": follow(entry.launch_project),
                    }
                )
                for entry in entries
            ]
            if followed != entries:
                self._replace(followed)

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
            if not self._owns(entry):
                continue
            epoch = self._model_epoch()
            try:
                project = load_project(entry.path)
            except FileNotFoundError:
                if entry.path.parent.is_dir():
                    self._parked.pop(entry.path, None)
                    self._remove(entry)
                continue
            except (OSError, ValueError):
                continue
            if project.created_at != entry.created_at or not _needs_transcription(project):
                self._parked.pop(entry.path, None)
                self._remove(entry)
                continue
            if self._parked.get(entry.path) == epoch:
                continue
            run = self._resolve_model(entry, self._downloading_whisper_model())
            try:
                if not _models_ready(run):
                    continue
            except OnnxOverrideUnsupportedError:
                # The pipeline job reports the refusal before it opens a model.
                pass
            if stop.is_set():
                return
            try:
                job = self.jobs.start(
                    entry.path,
                    config=run.config,
                    skip_steps=entry.skip_steps,
                    unattended=entry.unattended,
                )
            except JobSlotBusyError:
                return
            while job.status in LIVE_JOB_STATUSES:
                if stop.wait(_POLL_SECONDS):
                    return
            if job.error_code == "model_needed":
                self._parked[entry.path] = epoch
            else:
                self._parked.pop(entry.path, None)
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
