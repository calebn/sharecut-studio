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


def test_no_mcp_module_imports_json_to_serialize():
    import ast
    from pathlib import Path

    import podcast_mcp.mcp as mcp

    root = Path(mcp.__file__).parent
    offenders = []
    for path in sorted(root.rglob("*.py")):
        if path.name == "serialize.py":
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            imports_json = (
                isinstance(node, ast.Import) and any(a.name == "json" for a in node.names)
            ) or (isinstance(node, ast.ImportFrom) and node.module == "json")
            if imports_json:
                offenders.append(f"{path.relative_to(root)}:{node.lineno}")
    assert offenders == []


def test_to_json_matches_indented_json_dumps_and_stringifies_unencodable_values():
    from pathlib import Path

    payload = {"name": "café", "n": [1, 2], "ok": True}
    assert to_json(payload) == json.dumps(payload, indent=2)
    assert json.loads(to_json({"p": Path("x")})) == {"p": "x"}
