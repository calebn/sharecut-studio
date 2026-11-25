"""Ratchet for #1815: what tests may patch on ``podcast_mcp.engines.ffmpeg``.

A test may patch ``FFmpegEngine`` and its members. Any other name on the module is listed in
ALLOWLIST, which equals what the tests patch today, so it only shrinks. Known gap: a target
built at run time (an f-string, a loop variable) is not seen.
"""

from __future__ import annotations

import ast
from pathlib import Path

from podcast_mcp.engines import ffmpeg
from podcast_mcp.engines.ffmpeg import FFmpegEngine

TESTS = Path(__file__).resolve().parent
MODULE = "podcast_mcp.engines.ffmpeg"
PATCHERS = {"setattr", "delattr", "object", "patch"}

ALLOWLIST = {
    "_PACKET_SCAN_TIMEOUT_SEC",
    "_drawtext_font",
    "_read_audio_extent",
    "_run_cancellable",
    "file_revision",
    "negotiated_rates",
    "popen",
    "resolve_ffmpeg",
    "resolve_ffmpeg_pair",
    "run",
    "shutil",
    "spawn_or_too_long",
    "threading",
}


def _target(segments: list[str]) -> tuple[str, str | None]:
    """The module attribute a dotted path names, and the engine member under it when it is the engine."""
    name = segments[0]
    member = segments[1] if name == "FFmpegEngine" and len(segments) > 1 else None
    return name, member


def _aliases(tree: ast.AST) -> set[str]:
    """The names the file binds to the ffmpeg module itself."""
    aliases: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "podcast_mcp.engines":
            aliases.update(a.asname or a.name for a in node.names if a.name == "ffmpeg")
        elif isinstance(node, ast.Import):
            aliases.update(a.asname for a in node.names if a.name == MODULE and a.asname)
    return aliases


def _chain(expr: ast.expr, aliases: set[str]) -> list[str] | None:
    """The attributes under a module alias that ``expr`` reaches, or None when it is not rooted at one."""
    attrs: list[str] = []
    while isinstance(expr, ast.Attribute):
        attrs.append(expr.attr)
        expr = expr.value
    if isinstance(expr, ast.Name) and expr.id in aliases:
        return attrs[::-1]
    return None


def _found_in(source: str) -> set[tuple[str, str | None]]:
    tree = ast.parse(source)
    aliases = _aliases(tree)
    found: set[tuple[str, str | None]] = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and node.value.startswith(MODULE + ".")
        ):
            found.add(_target(node.value[len(MODULE) + 1 :].split(".")))
        if not (isinstance(node, ast.Call) and len(node.args) >= 2):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr in PATCHERS):
            continue
        attrs = _chain(node.args[0], aliases)
        name = node.args[1]
        if attrs is not None and isinstance(name, ast.Constant) and isinstance(name.value, str):
            found.add(_target([*attrs, *name.value.split(".")]))
    return found


def _found() -> set[tuple[str, str | None]]:
    found: set[tuple[str, str | None]] = set()
    for path in sorted(TESTS.rglob("*.py")):
        if path == Path(__file__).resolve():
            continue
        found |= _found_in(path.read_text(encoding="utf-8"))
    return found


def _outside_the_engine(found: set[tuple[str, str | None]]) -> set[str]:
    return {name for name, _ in found if name != "FFmpegEngine"}


def test_tests_patch_only_the_engine_and_the_allowlisted_names() -> None:
    patched = _outside_the_engine(_found())
    assert patched == ALLOWLIST, (
        f"new patch targets on {MODULE}: {sorted(patched - ALLOWLIST)}; "
        f"drop from ALLOWLIST, no test patches them any more: {sorted(ALLOWLIST - patched)}"
    )


def test_every_engine_member_a_test_patches_exists() -> None:
    members = {member for name, member in _found() if name == "FFmpegEngine" and member}
    assert members
    assert not {m for m in members if not hasattr(FFmpegEngine, m)}


def test_every_allowlisted_name_exists_on_the_module() -> None:
    assert not {name for name in ALLOWLIST if not hasattr(ffmpeg, name)}


def test_the_scanner_reads_every_patch_spelling() -> None:
    source = "\n".join(
        [
            "from podcast_mcp.engines import ffmpeg as ff",
            "import podcast_mcp.engines.ffmpeg as other",
            "a = 'podcast_mcp.engines.ffmpeg.run'",
            "b = patch('podcast_mcp.engines.ffmpeg.threading.Timer')",
            "monkeypatch.setattr(ff, 'popen', x)",
            "monkeypatch.setattr(ff.shutil, 'copy', x)",
            "patch.object(other, 'resolve_ffmpeg', x)",
            "patch.object(ff.FFmpegEngine, 'probe', x)",
            "monkeypatch.setattr('podcast_mcp.engines.ffmpeg.FFmpegEngine.mix_tracks', x)",
            "monkeypatch.setattr(unrelated, 'run', x)",
            "monkeypatch.setattr(ff, name, x)",
        ]
    )
    assert _found_in(source) == {
        ("run", None),
        ("threading", None),
        ("popen", None),
        ("shutil", None),
        ("resolve_ffmpeg", None),
        ("FFmpegEngine", "probe"),
        ("FFmpegEngine", "mix_tracks"),
    }
    assert _outside_the_engine({("FFmpegEngine", "probe"), ("run", None)}) == {"run"}
