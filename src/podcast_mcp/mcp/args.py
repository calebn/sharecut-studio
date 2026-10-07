"""MCP tool argument contract: structures are typed, free text arrives verbatim.

A tool that takes a list or an object declares it as a typed parameter, never as
JSON-encoded text in a ``str`` parameter:

* id / name lists are ``list[str]``;
* free-form objects are ``JsonObject`` and lists of them ``JsonObjectList``.

The SDK validates the value at the boundary and advertises its shape in the tool's
input schema, so a tool body receives a ``list`` / ``dict`` and does no JSON parsing
of its own. Clients that stringify a structure still work: the SDK's
``FuncMetadata.pre_parse_json`` decodes a JSON string for any parameter not annotated
exactly ``str`` before validating it (#1173).

That decoding also hit free-text ``str | None`` parameters: ``"null"`` became ``None``
(an update or ``expected_text`` guard silently skipped) and ``"[1]"`` became a list the
field then rejected (#1175). ``install_free_text_args`` fixes it once for every tool: it
swaps each registered tool's metadata for ``FreeTextFuncMetadata``, which never decodes
a string sent to a free-text parameter. Only a JSON ``null`` (or omitting the argument)
means "not given". ``tests/test_mcp_structured_args.py`` and
``tests/test_mcp_free_text_args.py`` enforce both halves for every registered tool.

This works around an open SDK bug, modelcontextprotocol/python-sdk#3055 (``pre_parse_json``
decodes strings meant for ``str | None``). Delete ``FreeTextFuncMetadata`` and
``install_free_text_args`` once an mcp release fixes it; the tests above then still pass.
"""

from __future__ import annotations

from types import NoneType, UnionType
from typing import Any, TypeAlias, Union, get_args, get_origin

from mcp.server import MCPServer
from mcp.server.mcpserver.tools import Tool
from mcp.server.mcpserver.utilities.func_metadata import FuncMetadata

JsonObject: TypeAlias = dict[str, Any]
JsonObjectList: TypeAlias = list[JsonObject]


def is_free_text(annotation: Any) -> bool:
    """True for ``str`` and ``str | None``: every value the parameter takes is text."""
    arms = get_args(annotation) if get_origin(annotation) in (Union, UnionType) else (annotation,)
    return {arm for arm in arms if arm is not NoneType} == {str}


class FreeTextFuncMetadata(FuncMetadata):
    """``FuncMetadata`` whose JSON pre-parse leaves free-text arguments as sent."""

    def pre_parse_json(self, data: dict[str, Any]) -> dict[str, Any]:
        text_keys = {
            field.alias or name
            for name, field in self.arg_model.model_fields.items()
            if is_free_text(field.annotation)
        }
        structured = super().pre_parse_json({k: v for k, v in data.items() if k not in text_keys})
        return {key: data[key] if key in text_keys else structured[key] for key in data}


def _keep_free_text(tool: Tool) -> Tool:
    meta = tool.fn_metadata
    if not isinstance(meta, FreeTextFuncMetadata):
        # Copy every field, so one the SDK adds later is not silently dropped.
        tool.fn_metadata = FreeTextFuncMetadata(
            **{name: getattr(meta, name) for name in type(meta).model_fields}
        )
    return tool


def install_free_text_args(server: MCPServer) -> None:
    """Make every tool added to ``server`` from now on keep free text verbatim.

    Install before ``register_all``. Idempotent: a second call is a no-op.
    """
    manager = server._tool_manager
    if getattr(manager, "_podcast_free_text_installed", False):
        return
    original_add_tool = manager.add_tool

    def add_tool(*args: Any, **kwargs: Any) -> Tool:
        return _keep_free_text(original_add_tool(*args, **kwargs))

    manager.add_tool = add_tool  # type: ignore[method-assign]
    manager._podcast_free_text_installed = True  # type: ignore[attr-defined]
