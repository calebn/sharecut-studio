from __future__ import annotations

import asyncio
import errno
import tempfile
from pathlib import Path

import pytest
from mcp.client import Client
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import EpisodeProject, load_project, save_project
from podcast_mcp.project.store import ProjectStore
from podcast_mcp.segments.kit import KitStore
from podcast_mcp.services.document import submit_kit_apply
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.util.coded_error import GENERIC_GUEST_MESSAGE, CodedError
from podcast_mcp.util.tool_refusal import tool_refusal
from test_kits import _kit, _show_kit
from test_segments_insert import _save

runner = CliRunner()


@pytest.fixture
def project(tmp_path: Path) -> str:
    episode = EpisodeProject.create("Disposable", str(tmp_path / "episode"))
    episode.ensure_dirs()
    return str(save_project(episode))


@pytest.fixture
def library(tmp_path: Path) -> tuple[str, str]:
    return _save(tmp_path, "Intro").id, _save(tmp_path, "Outro").id


@pytest.mark.parametrize("position", [1, 2, 3])
@pytest.mark.parametrize("after_save", [False, True], ids=["before-copy", "after-save"])
def test_uncoded_kit_failure_reports_completed_calls_without_promising_rollback(
    project: str,
    library: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
    position: int,
    after_save: bool,
) -> None:
    intro, outro = library
    kit = _kit("Four entries", (intro, "end"), (outro, "end"), (intro, "end"), (outro, "end"))
    KitStore().add(kit)
    original = OSError(errno.EMFILE, "private diagnostic", "/private/recording.wav")
    copied: list[int] = []
    mkstemp = tempfile.mkstemp
    mirror = ProjectStore._mirror_transcript_cache

    def fail_copy(*args, **kwargs):
        if kwargs.get("prefix") == ".segment-":
            copied.append(1)
            if len(copied) == position:
                raise original
        return mkstemp(*args, **kwargs)

    def fail_after_save(store: ProjectStore, episode: EpisodeProject) -> None:
        if sum(clip.segment_ref is not None for clip in episode.clips) == position:
            raise original
        mirror(store, episode)

    if after_save:
        monkeypatch.setattr(ProjectStore, "_mirror_transcript_cache", fail_after_save)
    else:
        monkeypatch.setattr(tempfile, "mkstemp", fail_copy)
    with pytest.raises(OSError) as err:
        submit_kit_apply(project, kit.id)

    earlier = position - 1
    placed = [clip for clip in load_project(Path(project)).clips if clip.segment_ref]
    assert len(placed) == earlier + int(after_save)
    assert len(DocumentSyncService.open(project).store.commands_after(0)) == earlier
    if not after_save:
        assert len(copied) == position
    error = err.value
    assert isinstance(error, CodedError)
    assert error.code == "kit_apply_failed"
    assert error.__cause__ is original
    message = str(error)
    assert f"Kit entry {position} of 4 ({kit.entries[earlier].label()})" in message
    assert (
        "No earlier entries completed.",
        "1 earlier entry completed.",
        "2 earlier entries completed.",
    )[earlier] in message
    assert "This entry may already have changed the episode." in message
    assert "Check the episode and History before retrying the kit" in message
    assert "retrying can insert entries again" in message
    assert "Nothing was changed" not in message
    assert "private diagnostic" not in message and "/private/recording.wav" not in message
    guest = tool_refusal(error, for_guest=True)
    assert guest is not None and guest.code == "kit_apply_failed"
    assert guest.message == GENERIC_GUEST_MESSAGE


@pytest.mark.parametrize("surface", ["cli", "mcp"])
def test_uncoded_kit_failure_reaches_the_host_without_raw_file_details(
    project: str, library: tuple[str, str], monkeypatch: pytest.MonkeyPatch, surface: str
) -> None:
    from podcast_mcp.services.document import kit_apply

    kit = _show_kit(library)

    def fail(*args, **kwargs):
        raise OSError(errno.EMFILE, "private diagnostic", "/private/recording.wav")

    monkeypatch.setattr(kit_apply, "submit_segment_insert", fail)
    if surface == "cli":
        result = runner.invoke(app, ["kit", "apply", kit.id, project])
        assert result.exit_code == 1
        assert "(code kit_apply_failed)" in result.output
        message = result.output
    else:

        async def call():
            async with Client(mcp_server.mcp) as client:
                return await client.call_tool(
                    "kit_apply_tool", {"project_path": project, "kit_id": kit.id}
                )

        response = asyncio.run(call())
        assert response.is_error
        assert response.structured_content["error_code"] == "kit_apply_failed"
        message = response.structured_content["error"]
        assert response.content[0].text == message
    assert "Kit entry 1 of 2" in message
    assert "No earlier entries completed." in message
    assert "This entry may already have changed the episode." in message
    assert "private diagnostic" not in message and "/private/recording.wav" not in message
    assert DocumentSyncService.open(project).store.commands_after(0) == []


def test_kit_apply_does_not_turn_programming_errors_into_file_failures(
    project: str, library: tuple[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.document import kit_apply

    kit = _show_kit(library)
    original = TypeError("implementation bug")

    def fail(*args, **kwargs):
        raise original

    monkeypatch.setattr(kit_apply, "submit_segment_insert", fail)
    with pytest.raises(TypeError) as err:
        submit_kit_apply(project, kit.id)
    assert err.value is original


@pytest.mark.parametrize("position", [1, 2])
def test_kit_apply_preserves_existing_coded_failure_contract(
    project: str, library: tuple[str, str], monkeypatch: pytest.MonkeyPatch, position: int
) -> None:
    from podcast_mcp.services.document import kit_apply
    from podcast_mcp.util.write_failure import ProjectWriteFailedError

    kit = _show_kit(library)
    original = ProjectWriteFailedError("The disk is full.", status=507)
    real = kit_apply.submit_segment_insert
    calls = 0

    def fail(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == position:
            raise original
        return real(*args, **kwargs)

    monkeypatch.setattr(kit_apply, "submit_segment_insert", fail)
    with pytest.raises(CodedError) as err:
        submit_kit_apply(project, kit.id)
    tail = (
        " Nothing was changed."
        if position == 1
        else " 1 earlier entry was already applied; each is its own undo step in History."
    )
    assert str(err.value) == (
        f"Kit entry {position} of 2 ({kit.entries[position - 1].label()}) failed: "
        f"The disk is full.{tail}"
    )
    assert err.value.code == "project_write_failed"
    assert err.value.__cause__ is original
    assert len(DocumentSyncService.open(project).store.commands_after(0)) == position - 1
