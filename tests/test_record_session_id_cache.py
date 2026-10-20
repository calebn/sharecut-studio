"""``RecordSessionService.active_session_id`` memoises the share lookup for half a second."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from podcast_mcp.edits.share_registry import SHARE_KIND_RECORD
from podcast_mcp.services.record import service as record_service
from podcast_mcp.services.record.service import (
    RecordSessionService,
    invalidate_record_session_cache,
)


def _project(name: str, tmp_path: Path) -> Any:
    workspace = tmp_path / name
    return SimpleNamespace(workspace_path=lambda: workspace)


@pytest.fixture
def shares(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = [{"kind": SHARE_KIND_RECORD, "session_id": "s1"}]
    monkeypatch.setattr(record_service, "list_usable_shares", lambda project: list(rows))
    return rows


def _clock(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    now = [100.0]
    monkeypatch.setattr(record_service.time, "monotonic", lambda: now[0])
    return now


def test_lookup_is_reused_inside_the_ttl_and_refreshed_after_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, shares: list[dict[str, str]]
) -> None:
    now = _clock(monkeypatch)
    project = _project("a", tmp_path)
    assert RecordSessionService.active_session_id(project) == "s1"
    shares[:] = [{"kind": SHARE_KIND_RECORD, "session_id": "s2"}]
    now[0] += record_service._SID_TTL_S - 0.01
    assert RecordSessionService.active_session_id(project) == "s1"
    now[0] += 0.02
    assert RecordSessionService.active_session_id(project) == "s2"


def test_invalidate_drops_only_that_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, shares: list[dict[str, str]]
) -> None:
    _clock(monkeypatch)
    first, second = _project("a", tmp_path), _project("b", tmp_path)
    assert RecordSessionService.active_session_id(first) == "s1"
    assert RecordSessionService.active_session_id(second) == "s1"
    shares[:] = []
    invalidate_record_session_cache(first)
    assert RecordSessionService.active_session_id(first) is None
    assert RecordSessionService.active_session_id(second) == "s1"


def test_reset_for_tests_clears_the_lookup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, shares: list[dict[str, str]]
) -> None:
    _clock(monkeypatch)
    project = _project("a", tmp_path)
    assert RecordSessionService.active_session_id(project) == "s1"
    shares[:] = []
    record_service.reset_record_runtime_for_tests()
    assert RecordSessionService.active_session_id(project) is None
