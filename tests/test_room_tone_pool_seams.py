"""The host's project load, the warms and Approve record a project's missing room-tone pools (#2882)."""

from __future__ import annotations

import threading
from pathlib import Path

import pytest

from pause_policy_public_helpers import configure, defaults, pause, prepare_pause, workspace
from podcast_mcp.engines import room_tone
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.document import EditService
from test_approve_guard_blocked_ripple import _blocked_filler
from test_pause_policy_integration_contract import _acoustic_project
from test_room_tone_pool_on_open import _Block, _join_pools, _two_speakers

pytestmark = pytest.mark.usefixtures("real_room_tone_scheduling")


def test_the_verdict_warm_and_the_preview_warm_wait_for_the_pool(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.edits import cut_application
    from podcast_mcp.services.document import PlayService
    from podcast_mcp.services.document.approval_warm import warm_pending_checks

    ws = workspace(_two_speakers(tmp_path))
    seen: list[object] = []

    def verdicts(project, ids, **_kwargs):
        seen.append(room_tone.read_room_tone_pool(project, "host"))
        return 0

    monkeypatch.setattr(cut_application, "precompute_verdicts", verdicts)
    monkeypatch.setattr(PlayService, "mix_trim_db", lambda self, **_k: -4.0)
    block = _Block(monkeypatch)
    assert room_tone.schedule_room_tone_pools(ws.project) == 2
    assert block.started.wait(30)

    done: dict[str, threading.Event] = {"checks": threading.Event(), "preview": threading.Event()}

    def run_checks() -> None:
        warm_pending_checks(ws)
        done["checks"].set()

    def run_preview() -> None:
        PlayService(ws).warm_pending_preview(None)
        done["preview"].set()

    threads = [threading.Thread(target=run_checks), threading.Thread(target=run_preview)]
    for thread in threads:
        thread.start()
    assert not done["checks"].wait(0.5) and not done["preview"].wait(0.1)

    block.release.set()
    for thread in threads:
        thread.join(120)
    _join_pools()

    assert all(event.is_set() for event in done.values())
    assert seen and seen[0]
    assert block.recordings == 2


def _approvable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    cfg = defaults(acoustic=True)
    configure(monkeypatch, cfg)
    result = _acoustic_project(tmp_path)
    result.edit_decisions = [prepare_pause(result, pause(start=0.3, end=4.7), cfg)]
    return workspace(result)


def test_a_successful_approve_schedules_the_pools_after_it_applied(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _approvable(tmp_path, monkeypatch)
    calls: list[tuple[EpisodeProject, list[str]]] = []

    def spy(p: EpisodeProject, *_args: object) -> int:
        calls.append((p, [e.id for e in p.edit_decisions if not e.applied]))
        return 0

    monkeypatch.setattr(room_tone, "schedule_room_tone_pools", spy)

    assert EditService(ws).approve(["pause"]) == 1

    assert [c[0] for c in calls] == [ws.project]
    assert calls[0][1] == []  # the edit was already applied when the schedule ran


def test_a_rejected_approve_schedules_nothing_and_leaves_no_pool_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.edits.source_removals import ScopeChangedAtApproval

    ws = workspace(_blocked_filler(tmp_path, monkeypatch)[0])
    calls: list[object] = []
    real = room_tone.schedule_room_tone_pools
    monkeypatch.setattr(
        room_tone, "schedule_room_tone_pools", lambda *a, **k: calls.append(a) or real(*a, **k)
    )

    with pytest.raises(ScopeChangedAtApproval):
        EditService(ws).approve([e.id for e in ws.project.edit_decisions])

    _join_pools()
    assert calls == []
    assert not (tmp_path / "artifacts" / "room_tone_pools").exists()


def test_the_host_queues_the_pools_once_when_it_starts_serving_a_project(
    minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    seen: list[bool] = []
    monkeypatch.setattr(
        room_tone, "schedule_room_tone_pools", lambda p, *_a, **k: seen.append(k["owned"]) or 0
    )

    started = TestClient(create_app(served_project=minimal_project))
    assert seen == [True]
    started.get("/api/document/state", params={"path": str(minimal_project)})
    assert seen == [True]

    opened = TestClient(create_app(), client=("127.0.0.1", 50000))
    assert seen == [True]
    for _ in range(2):
        response = opened.get("/api/document/state", params={"path": str(minimal_project)})
        assert response.status_code == 200
    assert seen == [True, True]


def test_a_project_that_cannot_be_opened_queues_nothing_and_does_not_raise(
    tmp_path: Path,
) -> None:
    from podcast_mcp.services.document import queue_room_tone_pools

    assert queue_room_tone_pools(tmp_path / "missing" / "episode.sharecut") == 0
