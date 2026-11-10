"""Extract and clear a room-tone bed as document commands: MCP, CLI, journal and History undo."""

from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.record_placement import place_room_tone
from podcast_mcp.engines.room_tone import RecordedBedSample, room_tone_bed
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.host_submit import submit_host_document_command
from test_room_tone_extract import (
    NO_CLEAN_STRETCH,
    SPEECH_THEN_ROOM,
    _host_audio,
    _noise,
    _project,
    _write_wav,
)

SR = 16000


def _saved(tmp_path: Path, speech=SPEECH_THEN_ROOM) -> Path:
    project = _project(tmp_path, _host_audio(speech))
    project.ensure_dirs()
    return save_project(project)


def _types(path: Path) -> list[str]:
    return [row["type"] for row in DocumentSyncService.open(str(path)).store.commands_after(0)]


def _undo(path: Path) -> None:
    head = load_project(path).history.head_id()
    submit_host_document_command(path, "UndoHistory", {"expected_head_id": head})


def _extract(path: Path) -> dict:
    return json.loads(mcp_timeline.extract_room_tone_bed_tool(str(path), "host"))


def _clear(path: Path) -> dict:
    return json.loads(mcp_timeline.clear_extracted_room_tone_bed_tool(str(path), "host"))


def test_the_mcp_tools_extract_and_clear_through_the_document_plane(tmp_path: Path) -> None:
    path = _saved(tmp_path)

    extracted = _extract(path)
    assert extracted["extracted"] is True
    assert load_project(path).track_by_id("host").room_tone_origin is not None

    assert _clear(path) == {"track_id": "host", "cleared": True}
    track = load_project(path).track_by_id("host")
    assert track.room_tone is None
    assert track.room_tone_origin is None
    assert _types(path) == ["ExtractRoomToneBed", "ClearExtractedRoomToneBed"]


def test_extract_with_no_clean_stretch_says_why_and_changes_nothing(tmp_path: Path) -> None:
    path = _saved(tmp_path, speech=((0.2, 9.8),))
    before = load_project(path).model_dump_json()

    result = _extract(path)

    assert result["extracted"] is False
    assert result["reason"] in NO_CLEAN_STRETCH
    assert load_project(path).model_dump_json() == before


def test_clear_never_removes_a_recorded_bed(tmp_path: Path) -> None:
    project = _project(tmp_path, _host_audio(SPEECH_THEN_ROOM))
    project.ensure_dirs()
    _write_wav(tmp_path / "raw" / "room-tone" / "host.wav", _noise(-62.0, seed=7)[: 2 * SR])
    place_room_tone(
        project,
        track_id="host",
        label="Host",
        rel="raw/room-tone/host.wav",
        duration_s=2.0,
        sample_rate=SR,
        channels=1,
    )
    path = save_project(project)
    before = load_project(path).model_dump_json()

    assert _clear(path) == {"track_id": "host", "cleared": False, "reason": "recorded_bed"}
    assert load_project(path).model_dump_json() == before


def test_clear_on_a_bedless_track_says_so(tmp_path: Path) -> None:
    path = _saved(tmp_path)

    assert _clear(path) == {"track_id": "host", "cleared": False, "reason": "no_bed"}


def test_history_undo_walks_back_through_clear_and_extract(tmp_path: Path) -> None:
    path = _saved(tmp_path)
    _extract(path)
    origin = load_project(path).track_by_id("host").room_tone_origin
    _clear(path)

    _undo(path)
    restored = load_project(path)
    assert restored.track_by_id("host").room_tone_origin == origin
    assert isinstance(room_tone_bed(restored, "host"), RecordedBedSample)

    _undo(path)
    gone = load_project(path)
    assert gone.track_by_id("host").room_tone is None
    assert gone.source_by_id("room-tone-host") is None


def test_clear_keeps_the_bed_source_so_laid_fills_still_resolve(tmp_path: Path) -> None:
    path = _saved(tmp_path)
    _extract(path)

    _clear(path)

    assert load_project(path).source_by_id("room-tone-host") is not None
    assert _extract(path)["extracted"] is True


def test_the_cli_extracts_and_clears(tmp_path: Path) -> None:
    path = _saved(tmp_path)
    runner = CliRunner()

    out = runner.invoke(
        app, ["track", "room-tone", "extract", "--project", str(path), "--track", "host"]
    )
    assert out.exit_code == 0, out.output
    assert json.loads(out.output)["extracted"] is True

    out = runner.invoke(
        app, ["track", "room-tone", "clear", "--project", str(path), "--track", "host"]
    )
    assert out.exit_code == 0, out.output
    assert json.loads(out.output) == {"track_id": "host", "cleared": True}
