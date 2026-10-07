"""Structured MCP arguments reach tools as lists / objects through a real client (#1173).

Tools take arrays and objects as typed parameters (``podcast_mcp.mcp.args``), never as
JSON-encoded text in a ``str`` parameter. These tests go through the SDK's argument
parsing (``mcp.client.Client`` or the registered tool's ``fn_metadata``), which a
direct function call skips.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import pytest
from mcp.client import Client
from pydantic import TypeAdapter

from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.services.pipeline import AudioExportResult

# How an agent may send a structure: as a JSON value, or stringified (some clients do).
ENCODINGS = ("native", "json_text")


def _as_sent(value: Any, encoding: str) -> Any:
    return value if encoding == "native" else json.dumps(value)


async def _call(name: str, arguments: dict[str, Any]) -> Any:
    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool(name, arguments)
    assert not result.is_error, result.content
    return json.loads(result.content[0].text)


@pytest.mark.asyncio
@pytest.mark.parametrize("encoding", ENCODINGS)
async def test_client_array_args_reach_add_comment(tmp_path, sample_wav, encoding) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    mcp_server.track_add(path, "host", str(sample_wav), role="dialogue")

    created = await _call(
        "add_comment_tool",
        {
            "project_path": path,
            "body": "Trim intro",
            "author": "agent",
            "timeline_start": 1.0,
            "track_ids": _as_sent(["host"], encoding),
            "action_texts": _as_sent(["Cut filler"], encoding),
        },
    )

    assert created["track_ids"] == ["host"]
    assert [item["text"] for item in created["action_items"]] == ["Cut filler"]


@pytest.mark.asyncio
@pytest.mark.parametrize("encoding", ENCODINGS)
async def test_client_object_and_array_args_reach_pipeline_set_config(
    tmp_path, sample_wav, encoding
) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    mcp_server.track_add(path, "host", str(sample_wav), role="dialogue")

    cleared = await _call(
        "pipeline_set_config_tool",
        {"project_path": path, "enabled_steps": _as_sent([], encoding)},
    )
    updated = await _call(
        "pipeline_set_config_tool",
        {
            "project_path": path,
            "config": _as_sent({"balance": {"dialogue_lufs": -18.0}}, encoding),
            "enabled_steps": _as_sent(["export_deliverables"], encoding),
        },
    )

    assert cleared["enabled_steps"] == []
    assert updated["config"]["balance"]["dialogue_lufs"] == -18.0
    assert "export_deliverables" in updated["enabled_steps"]


@pytest.mark.asyncio
@pytest.mark.parametrize("encoding", ENCODINGS)
async def test_client_array_of_objects_reaches_export_audio(tmp_path, encoding) -> None:
    """The #1173 repro: ``formats`` arrives as the list the agent sent."""
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    formats = [{"ext": "mp3", "codec": "libmp3lame"}]
    with patch("podcast_mcp.mcp.tools.pipeline.PipelineService") as pipe:
        pipe.return_value.export_audio.return_value = AudioExportResult([], None)
        await _call(
            "export_audio_tool",
            {"project_path": path, "formats": _as_sent(formats, encoding)},
        )
    pipe.return_value.export_audio.assert_called_once_with(formats)


@pytest.mark.asyncio
async def test_client_rejects_a_structure_of_the_wrong_shape(tmp_path) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool(
            "pipeline_set_config_tool", {"project_path": path, "config": ["not", "an", "object"]}
        )
    assert result.is_error
    assert "config" in result.content[0].text


# --- Every structured parameter on every registered tool ------------------------------


def _registered_tools() -> list[Any]:
    return mcp_server.mcp._tool_manager.list_tools()


def _variants(schema: dict[str, Any]) -> list[dict[str, Any]]:
    return [s for s in schema.get("anyOf", [schema]) if s.get("type") != "null"]


def _is_structured(schema: dict[str, Any]) -> bool:
    return any(s.get("type") in ("array", "object") for s in _variants(schema))


def _sample(schema: dict[str, Any]) -> Any:
    """A small valid value for a JSON schema (arrays and objects get one member)."""
    variants = _variants(schema)
    kind = variants[0].get("type") if variants else None
    if kind == "array":
        return [_sample(variants[0].get("items", {}))]
    if kind == "object":
        members = variants[0].get("additionalProperties", True)
        return {"key": _sample(members) if isinstance(members, dict) else 1}
    if kind == "string":
        return "value"
    if kind == "boolean":
        return True
    return 1


def _structured_params() -> list[Any]:
    rows = []
    for tool in _registered_tools():
        for name, schema in tool.parameters.get("properties", {}).items():
            if _is_structured(schema):
                rows.append(pytest.param(tool, name, schema, id=f"{tool.name}.{name}"))
    return rows


STRUCTURED_PARAMS = _structured_params()


def test_structured_param_table_covers_the_1173_params() -> None:
    covered = {p.id for p in STRUCTURED_PARAMS}
    for row in (
        "export_audio_tool.formats",
        "bounce_audio_tool.track_ids",
        "bounce_audio_tool.formats",
        "pipeline_run.skip_steps",
        "pipeline_run.config",
        "pipeline_set_config_tool.config",
        "export_social_clips_tool.ids",
        "set_session_selection_tool.selection",
        "add_comment_tool.action_texts",
        "apply_bleed_suppression_tool.exclude_words",
    ):
        assert row in covered


@pytest.mark.parametrize(("tool", "name", "schema"), STRUCTURED_PARAMS)
def test_structured_param_accepts_native_and_json_text(tool, name, schema) -> None:
    """The SDK's own boundary (pre-parse + field validation) yields the structure either way."""
    field = next(
        f for n, f in tool.fn_metadata.arg_model.model_fields.items() if (f.alias or n) == name
    )
    value = _sample(schema)
    adapter = TypeAdapter(field.annotation)
    for sent in (value, json.dumps(value)):
        parsed = tool.fn_metadata.pre_parse_json({name: sent})[name]
        assert adapter.validate_python(parsed) == value


@pytest.mark.parametrize("tool", _registered_tools(), ids=lambda t: t.name)
def test_no_tool_takes_json_encoded_text(tool) -> None:
    """Structures are typed parameters; a ``*_json`` text parameter is the #1173 bug shape."""
    names = tool.parameters.get("properties", {})
    assert not [n for n in names if n.endswith("_json")]
