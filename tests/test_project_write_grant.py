from __future__ import annotations

import asyncio
import contextvars
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from podcast_mcp.mcp.tools.agent_notify import notify_after_mutation
from podcast_mcp.project.store import (
    ProjectStore,
    UnscopedProjectWriteError,
    WriteGrantKind,
    active_write_grant,
    reset_write_counts_for_tests,
    write_counts,
    write_grant,
    write_guard_mode,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync.external_apply import apply_external_document_edit


@pytest.fixture
def store(minimal_project) -> ProjectStore:
    return ProjectStore(minimal_project)


def test_strict_guard_rejects_a_commit_with_no_grant(store: ProjectStore) -> None:
    assert write_guard_mode() == "strict"
    with pytest.raises(UnscopedProjectWriteError, match="test_project_write_grant"):
        store.commit(store.load())
    assert write_counts() == {"unscoped": 1}


@pytest.mark.parametrize("kind", list(WriteGrantKind))
def test_each_grant_kind_allows_a_commit_and_is_counted(
    store: ProjectStore, kind: WriteGrantKind
) -> None:
    with write_grant(kind):
        store.commit(store.load())
    assert write_counts() == {kind.value: 1}
    assert active_write_grant() is None


def test_grant_does_not_outlive_its_context(store: ProjectStore) -> None:
    with write_grant(WriteGrantKind.DISPATCHER):
        pass
    with pytest.raises(UnscopedProjectWriteError):
        store.commit(store.load())


def test_warn_mode_logs_once_per_caller_and_counts_every_commit(
    store: ProjectStore, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr("podcast_mcp.project.store._guard_mode", "warn")
    project = store.load()
    with caplog.at_level(logging.WARNING, logger="podcast_mcp.project.store"):
        for _ in range(2):
            store.commit(project)
    lines = [r.getMessage() for r in caplog.records if "unscoped_project_write" in r.getMessage()]
    assert len(lines) == 1
    assert "caller=test_project_write_grant:test_warn_mode" in lines[0]
    assert write_counts() == {"unscoped": 2}


def test_dispatcher_commit_carries_a_dispatcher_grant(minimal_project) -> None:
    from podcast_mcp.services.document_sync import DocumentSyncService
    from podcast_mcp.services.document_sync.commands import DocumentCommand

    result = DocumentSyncService.open(minimal_project).submit(
        DocumentCommand(
            type="AddComment",
            payload={"body": "Granted", "author": "viewer", "timeline_start": 1.0},
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert result["ok"] is True
    counts = write_counts()
    assert counts.get("dispatcher", 0) >= 1
    assert "unscoped" not in counts


def test_cli_wrapper_issues_a_legacy_cli_grant(minimal_project) -> None:
    ws = ProjectWorkspace.open(minimal_project)

    def edit() -> None:
        assert active_write_grant() is not None
        assert active_write_grant().kind is WriteGrantKind.LEGACY_CLI  # type: ignore[union-attr]
        ws.mutate("before cli", "after cli", lambda project: setattr(project, "name", "cli"))

    apply_external_document_edit(ws, edit)
    assert write_counts()["legacy_cli"] >= 1
    assert "unscoped" not in write_counts()


def test_mcp_wrapper_grants_the_tool_call_but_not_the_notify(
    minimal_project, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, object] = {}
    monkeypatch.setattr(
        "podcast_mcp.mcp.tools.agent_notify.agent_mutated",
        lambda project: seen.__setitem__("notify", active_write_grant()),
    )

    @notify_after_mutation
    def tool(project_path: str) -> str:
        seen["tool"] = active_write_grant()
        ProjectWorkspace.open(project_path).mutate(
            "before mcp", "after mcp", lambda project: setattr(project, "name", "mcp")
        )
        return "ok"

    assert tool(str(minimal_project)) == "ok"
    assert seen["tool"].kind is WriteGrantKind.LEGACY_MCP  # type: ignore[attr-defined]
    assert seen["notify"] is None
    assert write_counts() == {"legacy_mcp": 1}


def test_grant_is_isolated_across_threads_and_follows_copy_context(
    store: ProjectStore,
) -> None:
    project = store.load()
    bare: list[BaseException] = []

    def commit_bare() -> None:
        try:
            store.commit(project)
        except UnscopedProjectWriteError as exc:
            bare.append(exc)

    with write_grant(WriteGrantKind.DISPATCHER):
        worker = threading.Thread(target=commit_bare)
        worker.start()
        worker.join()
        assert len(bare) == 1

        ctx = contextvars.copy_context()
        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(ctx.run, store.commit, project).result() == store.project_path
        with ThreadPoolExecutor(max_workers=1) as pool:
            with pytest.raises(UnscopedProjectWriteError):
                pool.submit(store.commit, project).result()


def test_grant_does_not_leak_between_asyncio_tasks(store: ProjectStore) -> None:
    project = store.load()

    async def main() -> None:
        inside = asyncio.Event()
        checked = asyncio.Event()

        async def granted() -> None:
            with write_grant(WriteGrantKind.LEGACY_MCP):
                inside.set()
                await checked.wait()
                store.commit(project)

        async def ungranted() -> None:
            await inside.wait()
            with pytest.raises(UnscopedProjectWriteError):
                store.commit(project)
            checked.set()

        await asyncio.gather(granted(), ungranted())

    asyncio.run(main())


@pytest.mark.unscoped_ok
def test_unscoped_ok_marker_runs_the_guard_in_warn_mode(store: ProjectStore) -> None:
    assert write_guard_mode() == "warn"
    reset_write_counts_for_tests()
    store.commit(store.load())
    assert write_counts() == {"unscoped": 1}


def test_unscoped_ok_module_list_names_only_existing_modules() -> None:
    from conftest import unscoped_ok_modules

    tests_dir = Path(__file__).parent
    missing = sorted(m for m in unscoped_ok_modules() if not (tests_dir / m).is_file())
    assert missing == []
