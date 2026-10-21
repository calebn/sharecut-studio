from __future__ import annotations

import ast
from unittest.mock import patch

from podcast_mcp.config.defaults import repo_root
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


def _bounded_caches() -> set[str]:
    src = repo_root() / "src"
    found: set[str] = set()
    for path in sorted(src.rglob("*.py")):
        module = ".".join(path.relative_to(src).with_suffix("").parts)
        for node in ast.parse(path.read_text(encoding="utf-8")).body:
            if isinstance(node, ast.AnnAssign | ast.Assign) and _is_bounded_cache(node.value):
                targets = [node.target] if isinstance(node, ast.AnnAssign) else node.targets
                found.update(f"{module}:{t.id}" for t in targets if isinstance(t, ast.Name))
    return found


def _is_bounded_cache(value: ast.expr | None) -> bool:
    return isinstance(value, ast.Call) and _decorator_name(value) == "BoundedCache"


def test_every_cache_is_classified_for_test_isolation() -> None:
    classified = set(ISOLATED) | set(SHARED)
    assert _cached_functions() | _bounded_caches() == classified


def test_bounded_caches_are_found_by_the_scan() -> None:
    assert "podcast_mcp.util.binaries:_PAIR_CACHE" in _bounded_caches()


def test_isolated_and_shared_do_not_overlap() -> None:
    assert not set(ISOLATED) & set(SHARED)


def test_reset_clears_an_isolated_bounded_cache() -> None:
    from podcast_mcp.services.media import object_store_cors

    object_store_cors._cache.put(("host", "origin"), (0.0, object_store_cors.CorsProbe("ok", "o")))
    reset_isolated_caches()
    assert len(object_store_cors._cache) == 0


def test_reset_clears_a_poisoned_silero_lookup() -> None:
    with patch.object(vad_silero, "is_available", return_value=False):
        assert vad_silero.get_shared_vad() is None
    assert vad_silero.get_shared_vad() is None

    reset_isolated_caches()

    assert vad_silero.get_shared_vad() is not None
