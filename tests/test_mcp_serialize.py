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


def test_to_json_stringifies_unencodable_values_inside_dataclasses_and_lists():
    from datetime import datetime
    from pathlib import Path

    @dataclass
    class Located:
        where: Path
        when: datetime

    when = datetime(2026, 11, 2, 5, 0, 0)
    expected = {"where": "x", "when": str(when)}

    assert json.loads(to_json(Located(Path("x"), when))) == expected
    assert json.loads(to_json([Located(Path("x"), when)])) == [expected]


def test_to_json_model_list_matches_the_single_model_encoding():
    from datetime import datetime

    class Stamped(BaseModel):
        at: datetime

    stamped = Stamped(at=datetime(2026, 11, 2, 5, 0, 0))

    assert json.loads(to_json([stamped])) == [json.loads(to_json(stamped))]


def test_to_json_list_of_models_and_dataclasses_converts_each_item():
    items = [SampleModel(name="b", value=2), SampleDataclass(name="c", value=3), {"raw": 1}]

    assert json.loads(to_json(items)) == [
        {"name": "b", "value": 2},
        {"name": "c", "value": 3},
        {"raw": 1},
    ]
    assert to_json([]) == "[]"


def test_to_json_keeps_the_text_of_a_list_that_starts_with_a_plain_item():
    model = SampleModel(name="b", value=2)

    assert json.loads(to_json([{"raw": 1}, model])) == [{"raw": 1}, str(model)]
