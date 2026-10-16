from __future__ import annotations

import ast
from pathlib import Path


def test_breath_protection_has_one_production_entry_point() -> None:
    edits = Path(__file__).parents[1] / "src/podcast_mcp/edits"
    raw_guard = "protect_cut_breaths"
    consumers = []
    for path in edits.glob("*.py"):
        if path.name == "cut_safety.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.ImportFrom)
                and node.module == "podcast_mcp.edits.breath_detect"
                and any(alias.name == raw_guard for alias in node.names)
            ):
                consumers.append(path.name)
    assert consumers == []


def test_breath_protection_is_defined_in_cut_safety() -> None:
    root = Path(__file__).parents[1] / "src/podcast_mcp/edits"
    definitions = []
    for path in root.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        definitions.extend(
            path.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "protect_cut_breaths"
        )
    assert definitions == ["cut_safety.py"]
