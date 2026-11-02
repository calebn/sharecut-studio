"""The episode MCP tools, CLI and document-sync handlers keep their JSON shape (#1811)."""

from __future__ import annotations

import json

from typer.testing import CliRunner

from podcast_mcp.cli.episode import episode_app
from podcast_mcp.mcp.tools import episode as tools
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EpisodeService
from podcast_mcp.services.document_sync.handlers import apply_command


def _keys(result: dict) -> list[str]:
    return list(result)


def test_mcp_tools_return_the_documented_keys_in_order(minimal_project, sample_wav):
    p = str(minimal_project)
    added = tools.track_add_empty_tool(p, "a")
    assert added == {"track_id": "a", "label": "a", "role": "dialogue"}
    assert _keys(added) == ["track_id", "label", "role"]

    labelled = tools.track_add_empty_tool(p, "b", role="music", label="Bee", speaker="Bo")
    assert labelled == {"track_id": "b", "label": "Bee", "role": "music"}

    media = tools.track_set_media_tool(p, "a", str(sample_wav))
    assert _keys(media) == ["track_id", "media_path", "duration_sec"]
    assert media["track_id"] == "a"
    assert media["duration_sec"] == 2.0

    meta = tools.track_set_meta_tool(p, "a", label="L", role="dialogue", speaker="S")
    assert meta == {"track_id": "a", "label": "L", "role": "dialogue", "speaker": "S"}
    assert _keys(meta) == ["track_id", "label", "role", "speaker"]

    volume = tools.track_set_volume_tool(p, "a", -6.5)
    assert volume == {"track_id": "a", "fader_db": -6.5, "output_gain_db": -6.5}
    assert _keys(volume) == ["track_id", "fader_db", "output_gain_db"]

    mute = tools.track_set_mute_tool(p, "a", True)
    assert mute == {"track_id": "a", "muted": True}

    reordered = tools.track_reorder_tool(p, "b", 0)
    assert reordered == {"track_id": "b", "index": 0, "track_ids": ["b", "a"]}
    assert _keys(reordered) == ["track_id", "index", "track_ids"]

    removed = tools.track_remove_tool(p, "b")
    assert removed == {"track_id": "b", "removed": True}


def test_document_sync_handlers_return_plain_dicts_with_the_same_keys(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)

    assert apply_command(ws, "RenameProject", {"name": " Show "}) == {"name": "Show"}
    added = apply_command(ws, "AddTrack", {"track_id": "a", "label": "Alpha"})
    assert added == {"track_id": "a", "label": "Alpha", "role": "dialogue"}
    assert _keys(added) == ["track_id", "label", "role"]
    apply_command(ws, "AddTrack", {"track_id": "b"})
    reordered = apply_command(ws, "ReorderTrack", {"track_id": "b", "index": 0})
    assert reordered == {"track_id": "b", "index": 0, "track_ids": ["b", "a"]}
    assert apply_command(ws, "RemoveTrack", {"track_id": "b"}) == {
        "track_id": "b",
        "removed": True,
    }


def test_cli_prints_the_same_json_keys(minimal_project):
    p = str(minimal_project)
    ws = ProjectWorkspace.open(p)
    EpisodeService(ws).add_empty_track("a")
    EpisodeService(ws).add_empty_track("b")

    def run(*args: str) -> dict:
        result = CliRunner().invoke(episode_app, [*args, "--project", p])
        assert result.exit_code == 0, result.output
        return json.loads(result.output)

    assert run("set-track-volume", "--id", "a", "--db", "-6.5") == {
        "track_id": "a",
        "fader_db": -6.5,
        "output_gain_db": -6.5,
    }
    assert run("set-track-mute", "--id", "a", "--muted") == {"track_id": "a", "muted": True}
    assert run("reorder-track", "--id", "b", "--index", "0") == {
        "track_id": "b",
        "index": 0,
        "track_ids": ["b", "a"],
    }
    assert run("mark-streams-current") == {"analysis_reads_first_audio_stream": True}
