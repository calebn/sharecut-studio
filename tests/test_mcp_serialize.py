from __future__ import annotations

import json
from dataclasses import dataclass

from pydantic import BaseModel

from podcast_mcp.mcp.serialize import to_json


@dataclass
class SampleDataclass:
    name: str
    value: int


class SampleModel(BaseModel):
    name: str
    value: int


def test_to_json_pydantic_model():
    out = to_json(SampleModel(name="demo", value=3))
    data = json.loads(out)
    assert data == {"name": "demo", "value": 3}


def test_to_json_dataclass():
    out = to_json(SampleDataclass(name="demo", value=3))
    data = json.loads(out)
    assert data == {"name": "demo", "value": 3}


def test_to_json_dataclass_list():
    out = to_json([SampleDataclass(name="a", value=1), SampleDataclass(name="b", value=2)])
    data = json.loads(out)
    assert len(data) == 2


def test_to_json_model_list():
    out = to_json([SampleModel(name="a", value=1)])
    data = json.loads(out)
    assert data[0]["name"] == "a"


def test_to_json_plain_dict():
    out = to_json({"ok": True}, indent=None)
    assert json.loads(out) == {"ok": True}


def test_no_mcp_tool_serializes_with_raw_json_dumps():
    import ast
    from pathlib import Path

    import podcast_mcp.mcp.tools as tools

    offenders = []
    for path in sorted(Path(tools.__file__).parent.glob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "dumps"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "json"
            ):
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == []
