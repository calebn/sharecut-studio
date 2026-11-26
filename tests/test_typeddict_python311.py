"""Pydantic rejects ``typing.TypedDict`` on Python < 3.12; ``requires-python`` is >=3.11."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

pytestmark = pytest.mark.unscoped_ok

SRC = Path(__file__).resolve().parents[1] / "src" / "podcast_mcp"


def _offenders() -> list[str]:
    found: list[str] = []
    for path in sorted(SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        typing_names = {"typing"}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                typing_names |= {a.asname or a.name for a in node.names if a.name == "typing"}
        for node in ast.walk(tree):
            from_typing = (
                isinstance(node, ast.ImportFrom)
                and node.module == "typing"
                and any(alias.name == "TypedDict" for alias in node.names)
            )
            dotted = (
                isinstance(node, ast.Attribute)
                and node.attr == "TypedDict"
                and isinstance(node.value, ast.Name)
                and node.value.id in typing_names
            )
            if from_typing or dotted:
                found.append(f"{path.relative_to(SRC)}:{node.lineno}")
    return found


def test_source_takes_typeddict_from_typing_extensions() -> None:
    assert _offenders() == []


def test_kit_offer_validates_in_a_pydantic_type_adapter() -> None:
    from pydantic import TypeAdapter

    from podcast_mcp.segments.kit_offer import KitOffer

    adapter = TypeAdapter(KitOffer)
    value = {"offer": False, "reason": "none", "kits": [], "unusable": []}
    assert adapter.validate_python(value) == value
