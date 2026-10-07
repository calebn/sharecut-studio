from __future__ import annotations

import ast
from unittest.mock import patch

from podcast_mcp.config import repo_root
from podcast_mcp.engines import vad_silero
from process_caches import ISOLATED, SHARED, reset_isolated_caches

_CACHE_DECORATORS = {"cache", "lru_cache"}


def _decorator_name(node: ast.expr) -> str:
    if isinstance(node, ast.Call):
        node = node.func
    if isinstance(node, ast.Attribute):
        return node.attr
    return node.id if isinstance(node, ast.Name) else ""


def _cached_functions() -> set[str]:
    src = repo_root() / "src"
    found: set[str] = set()
    for path in sorted(src.rglob("*.py")):
        module = ".".join(path.relative_to(src).with_suffix("").parts)
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and any(
                _decorator_name(d) in _CACHE_DECORATORS for d in node.decorator_list
            ):
                found.add(f"{module}:{node.name}")
    return found


def test_every_cached_function_is_classified_for_test_isolation() -> None:
    classified = set(ISOLATED) | set(SHARED)
    assert _cached_functions() == classified


def test_isolated_and_shared_do_not_overlap() -> None:
    assert not set(ISOLATED) & set(SHARED)


def test_reset_clears_a_poisoned_silero_lookup() -> None:
    with patch.object(vad_silero, "is_available", return_value=False):
        assert vad_silero.get_shared_vad() is None
    assert vad_silero.get_shared_vad() is None

    reset_isolated_caches()

    assert vad_silero.get_shared_vad() is not None
