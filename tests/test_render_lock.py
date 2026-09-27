from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest
from filelock import Timeout

from podcast_mcp.engines.play_audit import publish_stem, stem_path
from podcast_mcp.models import EpisodeProject, load_project
from podcast_mcp.pipeline.runner import PipelineRunner
from podcast_mcp.services import PipelineService, ProjectWorkspace
from podcast_mcp.util.progress import CancelledProgress
from podcast_mcp.util.project_state import (
    RenderBusyError,
    project_commit_lock,
    render_cancel_scope,
    render_lock,
    render_lock_held,
)


@contextmanager
def _held_elsewhere(project: EpisodeProject) -> Iterator[None]:
    held, release = threading.Event(), threading.Event()

    def hold() -> None:
        with render_lock(project):
            held.set()
            release.wait(10)

    thread = threading.Thread(target=hold)
    thread.start()
    assert held.wait(5)
    try:
        yield
    finally:
        release.set()
        thread.join(5)


def test_a_render_lock_wait_past_its_timeout_raises_render_busy(minimal_project) -> None:
    project = load_project(minimal_project)
    started = time.monotonic()
    with _held_elsewhere(project), pytest.raises(RenderBusyError) as info:
        with render_lock(project, timeout=0.3):
            pass
    assert isinstance(info.value, Timeout)
    assert "another render" in str(info.value)
    assert time.monotonic() - started < 5


def test_render_lock_held_is_per_thread(minimal_project) -> None:
    project = load_project(minimal_project)
    assert render_lock_held(project) is False
    with render_lock(project):
        assert render_lock_held(project) is True
    with _held_elsewhere(project):
        assert render_lock_held(project) is False


def test_a_render_lock_wait_stops_when_cancelled(minimal_project) -> None:
    project = load_project(minimal_project)
    started = time.monotonic()
    with _held_elsewhere(project), pytest.raises(CancelledProgress):
        with render_lock(project, cancel_check=lambda: True):
            pass
    assert time.monotonic() - started < 5


def test_render_cancel_scope_cancels_waits_in_its_context(minimal_project) -> None:
    project = load_project(minimal_project)
    with _held_elsewhere(project), render_cancel_scope(lambda: True):
        with pytest.raises(CancelledProgress):
            with render_lock(project):
                pass


def test_a_pipeline_step_waiting_for_the_render_lock_stops_on_cancel(minimal_project) -> None:
    project = load_project(minimal_project)
    answers = iter([False])  # the runner's own pre-step check passes, the wait sees True
    started = time.monotonic()
    with _held_elsewhere(project), pytest.raises(CancelledProgress):
        PipelineRunner(defaults={}).run(
            project, only_step="mix_with_music", cancel_check=lambda: next(answers, True)
        )
    assert time.monotonic() - started < 5


def test_an_export_waiting_for_the_render_lock_stops_on_cancel(minimal_project) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    with _held_elsewhere(ws.project), pytest.raises(CancelledProgress):
        PipelineService(ws).export_audio([{"ext": "mp3"}], cancel_check=lambda: True)


def test_a_refresh_waiting_for_the_render_lock_stops_on_cancel(minimal_project) -> None:
    ws = ProjectWorkspace.open(minimal_project)
    started = time.monotonic()
    with _held_elsewhere(ws.project), pytest.raises(CancelledProgress):
        PipelineService(ws).render_preview(rerender=True, cancel_check=lambda: True)
    assert time.monotonic() - started < 5


def test_render_lock_refuses_a_first_acquire_under_the_commit_lock(minimal_project) -> None:
    project = load_project(minimal_project)
    with project_commit_lock(project), pytest.raises(RuntimeError, match="lock order"):
        with render_lock(project):
            pass
    with render_lock(project), project_commit_lock(project):
        with render_lock(project):  # re-entrant: already held by this thread
            assert render_lock_held(project)


def test_publish_stem_on_a_worker_of_the_holder_never_waits_for_the_render_lock(
    minimal_project,
) -> None:
    project = load_project(minimal_project)
    with render_lock(project), ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(
            publish_stem,
            project,
            "host",
            lambda tmp: tmp.write_bytes(b"RIFF"),
            clear_invalidations=False,
        )
        assert future.result(timeout=5) == stem_path(project, "host")
