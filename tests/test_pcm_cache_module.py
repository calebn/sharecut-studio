"""The RMS cache classes live in ``engines/pcm_cache`` and nothing reaches them through audio_audit (#1815)."""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from podcast_mcp.engines import pcm_cache

ROOT = Path(__file__).resolve().parent.parent
AUDIT = "podcast_mcp.engines.audio_audit"
MOVED = {
    "TrackRmsCache",
    "TrackRmsCacheSet",
    "CopyPath",
    "RMS_SAMPLE_RATE",
    "_RMS_SAMPLE_RATE",
    "ONE_WAY_RATIO",
}
DOTTED = re.compile(r"audio_audit\.(" + "|".join(sorted(MOVED)) + r")\b")


def _sources() -> list[Path]:
    paths = [*(ROOT / "src").rglob("*.py"), *(ROOT / "tests").rglob("*.py")]
    return [path for path in paths if path != Path(__file__).resolve()]


def _audit_aliases(tree: ast.AST) -> set[str]:
    aliases: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "podcast_mcp.engines":
            aliases.update(a.asname or a.name for a in node.names if a.name == "audio_audit")
        elif isinstance(node, ast.Import):
            aliases.update(a.asname for a in node.names if a.name == AUDIT and a.asname)
    return aliases


def _strays(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    aliases = _audit_aliases(tree) | {"audio_audit"}
    found: list[str] = []
    for node in ast.walk(tree):
        line = getattr(node, "lineno", 0)
        if isinstance(node, ast.ImportFrom) and node.module == AUDIT:
            found += [f"{path}:{line} imports {a.name}" for a in node.names if a.name in MOVED]
        elif isinstance(node, ast.Attribute) and node.attr in MOVED:
            base = node.value
            if (isinstance(base, ast.Name) and base.id in aliases) or (
                isinstance(base, ast.Attribute) and base.attr == "audio_audit"
            ):
                found.append(f"{path}:{line} uses audio_audit.{node.attr}")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if DOTTED.search(node.value):
                found.append(f"{path}:{line} names {node.value!r}")
        elif isinstance(node, (ast.Tuple, ast.List)):
            strings = [e.value for e in node.elts if isinstance(e, ast.Constant)]
            if AUDIT in strings and MOVED.intersection(strings):
                found.append(f"{path}:{line} pairs {AUDIT} with a moved name")
        elif isinstance(node, ast.Call) and node.args:
            first = node.args[0]
            if isinstance(first, ast.Name) and first.id in aliases:
                named = [a.value for a in node.args[1:] if isinstance(a, ast.Constant)]
                found += [f"{path}:{line} patches audio_audit.{n}" for n in named if n in MOVED]
    return found


@pytest.mark.parametrize("name", ["TrackRmsCache", "TrackRmsCacheSet", "CopyPath"])
def test_classes_are_defined_in_pcm_cache(name: str) -> None:
    assert getattr(pcm_cache, name).__module__ == "podcast_mcp.engines.pcm_cache"


def test_constants_are_public_on_pcm_cache() -> None:
    assert pcm_cache.RMS_SAMPLE_RATE == 8000
    assert pcm_cache.ONE_WAY_RATIO == 50
    assert not hasattr(pcm_cache, "_RMS_SAMPLE_RATE")


def test_nothing_reaches_the_moved_names_through_audio_audit() -> None:
    strays = [stray for path in _sources() for stray in _strays(path)]
    assert not strays, "\n".join(strays)
