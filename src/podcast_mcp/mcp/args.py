"""Structured MCP tool arguments: one contract for arrays and objects.

A tool that takes a list or an object declares it as a typed parameter, never as
JSON-encoded text in a ``str`` parameter:

* id / name lists are ``list[str]``;
* free-form objects are ``JsonObject`` and lists of them ``JsonObjectList``.

The SDK validates the value at the boundary and advertises its shape in the tool's
input schema, so a tool body receives a ``list`` / ``dict`` and does no JSON parsing
of its own. Clients that stringify a structure still work: the SDK decodes a JSON
string for any parameter not annotated exactly ``str`` before validating it. That
same decoding is why JSON text in a ``str | None`` parameter broke (#1173).
``tests/test_mcp_structured_args.py`` enforces this for every registered tool.
"""

from __future__ import annotations

from typing import Any, TypeAlias

JsonObject: TypeAlias = dict[str, Any]
JsonObjectList: TypeAlias = list[JsonObject]
