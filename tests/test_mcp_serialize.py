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


def test_no_mcp_tool_imports_json_to_serialize():
    import ast
    from pathlib import Path

    import podcast_mcp.mcp.tools as tools

    offenders = []
    for path in sorted(Path(tools.__file__).parent.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            imports_json = (
                isinstance(node, ast.Import) and any(a.name == "json" for a in node.names)
            ) or (isinstance(node, ast.ImportFrom) and node.module == "json")
            if imports_json:
                offenders.append(f"{path.relative_to(Path(tools.__file__).parent)}:{node.lineno}")
    assert offenders == []
