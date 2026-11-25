"""Ratchet for #1815: what tests may patch on ``podcast_mcp.engines.ffmpeg``.

A test may patch ``FFmpegEngine`` and its members. Any other name on the module is listed in
ALLOWLIST, which equals what the tests patch today, so it only shrinks.

Read: a ``podcast_mcp.engines.ffmpeg.<name>`` string, and a ``setattr``/``delattr``/``patch.object``/
``patch.multiple`` call (builtin or method, positional or keyword) whose target is the module through
any import spelling: ``from podcast_mcp.engines import ffmpeg [as x]``, ``import ... as x``, bare
``import podcast_mcp.engines.ffmpeg`` or an ``engines.ffmpeg`` chain. A whole-module
``patch("podcast_mcp.engines.ffmpeg")`` is a target of its own.

Still blind (the ratchet cannot see these; review by hand): a target or name built at run time (a
variable, an f-string or concatenation after the literal prefix, a loop over names); the module
reached through ``importlib``, ``sys.modules``, an alias by reassignment (``m = ff``) or a fixture;
``patch.dict(ff.__dict__)``, ``monkeypatch.setitem(vars(ff), ...)`` and plain assignment
``ff.run = x``; and a patch of the name where another module uses it. The ratchet is on names, not
counts: another patch of an allowlisted name still passes.
"""

from __future__ import annotations

import ast
import functools
from pathlib import Path

import pytest

from podcast_mcp.engines import ffmpeg
from podcast_mcp.engines.ffmpeg import FFmpegEngine

TESTS = Path(__file__).resolve().parent
MODULE = "podcast_mcp.engines.ffmpeg"
PATCHERS = {"setattr", "delattr", "object", "patch", "multiple"}

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


DYNAMIC = "<dynamic target>"
WHOLE_MODULE = "<whole module>"
MULTIPLE_OPTIONS = {"target", "spec", "create", "spec_set", "autospec", "new_callable"}


def _target(segments: list[str]) -> tuple[str, str | None]:
    """The module attribute a dotted path names, and the engine member under it when it is the engine."""
    name = segments[0] or DYNAMIC
    member = segments[1] if name == "FFmpegEngine" and len(segments) > 1 else None
    return name, member


def _imports(tree: ast.AST) -> dict[str, str]:
    """The dotted module path each imported name denotes (``import a.b`` binds ``a``)."""
    names: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and not node.level:
            for alias in node.names:
                names[alias.asname or alias.name] = f"{node.module}.{alias.name}"
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    names[alias.asname] = alias.name
                else:
                    root = alias.name.split(".")[0]
                    names[root] = root
    return names


def _below_the_module(expr: ast.expr, imports: dict[str, str]) -> list[str] | None:
    """The attributes under the ffmpeg module that ``expr`` reaches (empty for the module), else None.

    Reads a name bound by an import and the dotted chain after it, so ``ff.run``,
    ``podcast_mcp.engines.ffmpeg.run`` and ``engines.ffmpeg.run`` are all seen.
    """
    attrs: list[str] = []
    while isinstance(expr, ast.Attribute):
        attrs.append(expr.attr)
        expr = expr.value
    if not (isinstance(expr, ast.Name) and expr.id in imports):
        return None
    dotted = ".".join([imports[expr.id], *reversed(attrs)])
    if dotted == MODULE:
        return []
    if dotted.startswith(MODULE + "."):
        return dotted[len(MODULE) + 1 :].split(".")
    return None


def _call_name(func: ast.expr) -> str | None:
    if isinstance(func, ast.Name):
        return func.id
    return func.attr if isinstance(func, ast.Attribute) else None


def _argument(node: ast.Call, position: int, *keywords: str) -> ast.expr | None:
    """The positional argument at ``position``, else the first of the keywords that is given."""
    if len(node.args) > position:
        return node.args[position]
    return next((kw.value for kw in node.keywords if kw.arg in keywords), None)


def _text(expr: ast.expr | None) -> str | None:
    if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
        return expr.value
    return None


def _call_targets(node: ast.Call, imports: dict[str, str]) -> set[tuple[str, str | None]]:
    """The module attributes a patching call names through its target and name arguments."""
    caller = _call_name(node.func)
    if caller not in PATCHERS:
        return set()
    target = _argument(node, 0, "target")
    base = _below_the_module(target, imports) if target is not None else None
    if base is None and _text(target) == MODULE:
        base = []
    if base is None:
        return set()
    if caller == "multiple":
        return {
            _target([*base, kw.arg])
            for kw in node.keywords
            if kw.arg and kw.arg not in MULTIPLE_OPTIONS
        }
    if caller == "patch" and not base:
        return {(WHOLE_MODULE, None)}
    name = _text(_argument(node, 1, "attribute", "name"))
    if name is None or caller == "patch":
        return set()
    return {_target([*base, *name.split(".")])}


def _found_in(source: str) -> set[tuple[str, str | None]]:
    tree = ast.parse(source)
    imports = _imports(tree)
    found: set[tuple[str, str | None]] = set()
    for node in ast.walk(tree):
        text = _text(node) if isinstance(node, ast.Constant) else None
        if text is not None and text.startswith(MODULE + "."):
            found.add(_target(text[len(MODULE) + 1 :].split(".")))
        elif isinstance(node, ast.Call):
            found |= _call_targets(node, imports)
    return found


@functools.cache
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


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        pytest.param(
            "from podcast_mcp.engines import ffmpeg as ff\nsetattr(ff, 'run', x)",
            {("run", None)},
            id="builtin setattr",
        ),
        pytest.param(
            "from podcast_mcp.engines import ffmpeg as ff\ndelattr(ff, 'popen')",
            {("popen", None)},
            id="builtin delattr",
        ),
        pytest.param(
            "from podcast_mcp.engines import ffmpeg as ff\n"
            "patch.object(target=ff, attribute='run', new=x)",
            {("run", None)},
            id="patch.object keywords",
        ),
        pytest.param(
            "from podcast_mcp.engines import ffmpeg as ff\nmonkeypatch.setattr(ff, name='popen', value=x)",
            {("popen", None)},
            id="setattr name keyword",
        ),
        pytest.param(
            "from podcast_mcp.engines import ffmpeg as ff\npatch.multiple(ff, run=x, popen=y)",
            {("run", None), ("popen", None)},
            id="patch.multiple alias",
        ),
        pytest.param(
            "patch.multiple('podcast_mcp.engines.ffmpeg', create=True, shutil=x)",
            {("shutil", None)},
            id="patch.multiple string target",
        ),
        pytest.param(
            "import podcast_mcp.engines.ffmpeg\npatch.object(podcast_mcp.engines.ffmpeg, 'run', x)",
            {("run", None)},
            id="bare dotted import",
        ),
        pytest.param(
            "import podcast_mcp.engines.ffmpeg\n"
            "monkeypatch.setattr(podcast_mcp.engines.ffmpeg.FFmpegEngine, 'probe', x)",
            {("FFmpegEngine", "probe")},
            id="bare dotted import engine member",
        ),
        pytest.param(
            "from podcast_mcp import engines\nsetattr(engines.ffmpeg, 'threading', x)",
            {("threading", None)},
            id="engines.ffmpeg chain",
        ),
        pytest.param(
            "import podcast_mcp.engines as eng\nsetattr(eng.ffmpeg, 'run', x)",
            {("run", None)},
            id="package alias chain",
        ),
        pytest.param(
            "import podcast_mcp as pm\nsetattr(pm.engines.ffmpeg, 'run', x)",
            {("run", None)},
            id="top package alias chain",
        ),
        pytest.param(
            "patch('podcast_mcp.engines.ffmpeg')",
            {(WHOLE_MODULE, None)},
            id="whole module string",
        ),
        pytest.param(
            "patch(target='podcast_mcp.engines.ffmpeg', new=x)",
            {(WHOLE_MODULE, None)},
            id="whole module keyword",
        ),
        pytest.param(
            "n = 'run'\npatch(f'podcast_mcp.engines.ffmpeg.{n}')",
            {(DYNAMIC, None)},
            id="f-string target is reported, not skipped",
        ),
        pytest.param(
            "from podcast_mcp.engines import ffmpeg as ff\nsetattr(ff, name, x)\nsetattr(ff, 'a' + b, x)",
            set(),
            id="dynamic names stay blind",
        ),
        pytest.param(
            "import os\nsetattr(os, 'run', x)\npatch.object(os.path, 'join', x)\n"
            "monkeypatch.setattr('os.path.join', x)",
            set(),
            id="other modules are ignored",
        ),
    ],
)
def test_the_scanner_closes_the_blind_forms(
    source: str, expected: set[tuple[str, str | None]]
) -> None:
    assert _found_in(source) == expected


def test_the_scan_runs_once() -> None:
    assert _found() is _found()
