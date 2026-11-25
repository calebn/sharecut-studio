"""Ratchet for #1815: what tests may patch on ``podcast_mcp.engines.ffmpeg``.

A test may patch ``FFmpegEngine`` and its members. Any other name on the module is listed in
ALLOWLIST, which equals what the tests patch today, so it only shrinks. The process seam lives in
``podcast_mcp.engines.ffmpeg.runtime`` and its patchable names are listed in RUNTIME_ALLOWLIST.
Every call site in the package reads a seam name as ``runtime.<name>`` at call time, so a patch of
the runtime binding is the one the calling code reads; nothing re-exports a seam name.

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
from podcast_mcp.engines.ffmpeg import FFmpegEngine, diagnostics, probe, render, runtime

TESTS = Path(__file__).resolve().parent
PACKAGE = TESTS.parent / "src" / "podcast_mcp" / "engines" / "ffmpeg"
SRC = TESTS.parent / "src" / "podcast_mcp"
MODULE = "podcast_mcp.engines.ffmpeg"
PATCHERS = {"setattr", "delattr", "object", "patch", "multiple"}

ALLOWLIST = {
    "threading",
}

RUNTIME = "runtime"
DIAGNOSTICS = "diagnostics"
DIAGNOSTICS_ALLOWLIST = {"_drawtext_font"}
PROBE = "probe"
PROBE_ALLOWLIST = {"_PACKET_SCAN_TIMEOUT_SEC", "_read_audio_extent", "file_revision"}
RENDER = "render"
RENDER_ALLOWLIST = {"negotiated_rates", "spawn_or_too_long"}
RUNTIME_ALLOWLIST = {
    "_run_cancellable",
    "popen",
    "resolve_ffmpeg",
    "resolve_ffmpeg_pair",
    "run",
}


VALUE_USE_CALLEE = "spawn_or_too_long"
PROCESS_MODULE = "podcast_mcp.util.process"
PROCESS_SEAMS = {"run", "popen"}
KNOWN_DIRECT_PROCESS_USES = 1


DYNAMIC = "<dynamic target>"
WHOLE_MODULE = "<whole module>"
MULTIPLE_OPTIONS = {"target", "spec", "create", "spec_set", "autospec", "new_callable"}


def _target(segments: list[str]) -> tuple[str, str | None]:
    """The module attribute a dotted path names, and the engine member under it when it is the engine."""
    name = segments[0] or DYNAMIC
    member = (
        segments[1]
        if name in {"FFmpegEngine", RUNTIME, DIAGNOSTICS, PROBE, RENDER} and len(segments) > 1
        else None
    )
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


def _registry_form(text: str) -> bool:
    """A ``module:name`` registry string: a colon with no later dot, which patches nothing."""
    return ":" in text and "." not in text.partition(":")[2]


def _found_in(source: str) -> set[tuple[str, str | None]]:
    tree = ast.parse(source)
    imports = _imports(tree)
    found: set[tuple[str, str | None]] = set()
    for node in ast.walk(tree):
        text = _text(node) if isinstance(node, ast.Constant) else None
        if text is not None and text.startswith(MODULE + ".") and not _registry_form(text):
            found.add(_target(text[len(MODULE) + 1 :].replace(":", ".").split(".")))
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
    return {
        name
        for name, _ in found
        if name not in {"FFmpegEngine", RUNTIME, DIAGNOSTICS, PROBE, RENDER}
    }


def _runtime_patched(found: set[tuple[str, str | None]]) -> set[str | None]:
    return {member for name, member in found if name == RUNTIME}


def test_tests_patch_only_the_engine_and_the_allowlisted_names() -> None:
    patched = _outside_the_engine(_found())
    assert patched == ALLOWLIST, (
        f"new patch targets on {MODULE}: {sorted(patched - ALLOWLIST)}; "
        f"drop from ALLOWLIST, no test patches them any more: {sorted(ALLOWLIST - patched)}"
    )


def test_tests_patch_only_the_allowlisted_runtime_names() -> None:
    patched = _runtime_patched(_found())
    assert patched == RUNTIME_ALLOWLIST, (
        f"new patch targets on {MODULE}.{RUNTIME}: {sorted(map(str, patched - RUNTIME_ALLOWLIST))}; "
        f"drop from RUNTIME_ALLOWLIST, no test patches them any more: "
        f"{sorted(RUNTIME_ALLOWLIST - patched)}"
    )


def test_diagnostics_submodule_patches_are_the_listed_members() -> None:
    patched = {member for name, member in _found() if name == DIAGNOSTICS}
    assert patched == DIAGNOSTICS_ALLOWLIST
    assert all(hasattr(diagnostics, name) for name in DIAGNOSTICS_ALLOWLIST)


def test_probe_submodule_patches_are_the_listed_members() -> None:
    patched = {member for name, member in _found() if name == PROBE}
    assert patched == PROBE_ALLOWLIST
    assert all(hasattr(probe, name) for name in PROBE_ALLOWLIST)


def test_render_submodule_patches_are_the_listed_members() -> None:
    patched = {member for name, member in _found() if name == RENDER}
    assert patched == RENDER_ALLOWLIST
    assert all(hasattr(render, name) for name in RENDER_ALLOWLIST)


def test_every_engine_member_a_test_patches_exists() -> None:
    members = {member for name, member in _found() if name == "FFmpegEngine" and member}
    assert members
    assert not {m for m in members if not hasattr(FFmpegEngine, m)}


def test_every_allowlisted_name_exists_on_the_module() -> None:
    assert not {name for name in ALLOWLIST if not hasattr(ffmpeg, name)}
    assert not {name for name in RUNTIME_ALLOWLIST if not hasattr(runtime, name)}


def test_no_seam_name_is_reachable_from_the_package() -> None:
    assert not {name for name in RUNTIME_ALLOWLIST if name in vars(ffmpeg)}


@functools.cache
def _package_trees() -> dict[Path, ast.Module]:
    return {p: ast.parse(p.read_text(encoding="utf-8")) for p in sorted(PACKAGE.rglob("*.py"))}


def _readers() -> dict[Path, ast.Module]:
    return {p: t for p, t in _package_trees().items() if p.name != "runtime.py"}


def _runtime_bound(tree: ast.Module) -> bool:
    return any(
        isinstance(node, ast.ImportFrom)
        and (node.module == MODULE or (node.level == 1 and not node.module))
        and any(a.name == RUNTIME and a.asname is None for a in node.names)
        for node in ast.walk(tree)
    )


def _bare_seam_reads(tree: ast.Module) -> set[str]:
    return {
        node.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Name)
        and isinstance(node.ctx, ast.Load)
        and node.id in RUNTIME_ALLOWLIST
    }


def _runtime_attribute_reads(tree: ast.Module) -> set[str]:
    return {
        node.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id == RUNTIME
        and node.attr in RUNTIME_ALLOWLIST
    }


def test_package_call_sites_read_every_seam_name_through_the_runtime_module() -> None:
    trees = _package_trees()
    assert PACKAGE / "runtime.py" in trees
    assert _runtime_bound(trees[PACKAGE / "__init__.py"])
    readers = _readers()
    reads = set().union(*(_runtime_attribute_reads(tree) for tree in readers.values()))
    assert reads == RUNTIME_ALLOWLIST, (
        f"not read through runtime anywhere in the package: {sorted(RUNTIME_ALLOWLIST - reads)}; "
        f"read but not allowlisted: {sorted(reads - RUNTIME_ALLOWLIST)}"
    )
    for path, tree in readers.items():
        assert _bare_seam_reads(tree) == set(), f"{path.name} reads a seam name bare"
        assert not _runtime_attribute_reads(tree) or _runtime_bound(tree), path.name


def _seam_value_uses(tree: ast.Module) -> list[int]:
    """Lines where ``runtime.<seam>`` is not called and not the first argument of ``spawn_or_too_long``."""
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    lines: list[int] = []
    for node in ast.walk(tree):
        if not (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == RUNTIME
            and node.attr in RUNTIME_ALLOWLIST
        ):
            continue
        parent = parents[node]
        called = isinstance(parent, ast.Call) and parent.func is node
        handed = (
            isinstance(parent, ast.Call)
            and _call_name(parent.func) == VALUE_USE_CALLEE
            and bool(parent.args)
            and parent.args[0] is node
        )
        if not (called or handed):
            lines.append(node.lineno)
    return sorted(lines)


def _direct_process_uses(tree: ast.Module) -> list[int]:
    """Lines that read ``run`` or ``popen`` off ``podcast_mcp.util.process`` under any import spelling."""
    imports = _imports(tree)
    lines: list[int] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and node.attr in PROCESS_SEAMS
            and isinstance(node.value, ast.Name)
            and imports.get(node.value.id) == PROCESS_MODULE
        ) or (
            isinstance(node, ast.ImportFrom)
            and node.module == PROCESS_MODULE
            and any(a.name in PROCESS_SEAMS for a in node.names)
        ):
            lines.append(node.lineno)
    return sorted(lines)


def test_no_seam_read_is_kept_as_a_value() -> None:
    offenders = [
        f"{path.name}:{line}"
        for path, tree in _readers().items()
        for line in _seam_value_uses(tree)
    ]
    assert not offenders, f"runtime seam read kept as a value, not called at the site: {offenders}"


def test_no_new_direct_process_seam_use_in_the_package() -> None:
    uses = {
        f"{path.name}:{line}": None
        for path, tree in _package_trees().items()
        if path.name != "runtime.py"
        for line in _direct_process_uses(tree)
    }
    assert len(uses) == KNOWN_DIRECT_PROCESS_USES, (
        f"expected {KNOWN_DIRECT_PROCESS_USES} direct process.run/popen uses outside runtime.py, "
        f"found {len(uses)} at {sorted(uses)}; call runtime.run/runtime.popen instead"
    )


def test_no_module_binds_a_seam_name_from_the_runtime_or_the_package() -> None:
    offenders: list[str] = []
    for path in sorted(SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        in_package = PACKAGE in path.parents
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom):
                continue
            absolute = node.module or ""
            runtime_source = absolute == f"{MODULE}.{RUNTIME}" or (
                in_package and node.level == 1 and absolute == RUNTIME
            )
            package_source = absolute == MODULE or (in_package and node.level == 1 and not absolute)
            names = {a.name for a in node.names}
            if runtime_source and names & RUNTIME_ALLOWLIST:
                offenders.append(
                    f"{path.name}: from runtime import {sorted(names & RUNTIME_ALLOWLIST)}"
                )
            if package_source and names & RUNTIME_ALLOWLIST:
                offenders.append(
                    f"{path.name}: from the package import {sorted(names & RUNTIME_ALLOWLIST)}"
                )
    assert not offenders


def test_every_allowlisted_name_is_read_by_the_package_itself() -> None:
    reads = {
        node.id
        for tree in _readers().values()
        for node in ast.walk(tree)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
    }
    assert reads >= ALLOWLIST


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
            "monkeypatch.setattr(ff.runtime, 'run', x)",
            "patch('podcast_mcp.engines.ffmpeg.runtime.popen')",
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
        ("runtime", "run"),
        ("runtime", "popen"),
    }
    assert _outside_the_engine({("FFmpegEngine", "probe"), ("run", None)}) == {"run"}
    assert _outside_the_engine({("runtime", "run")}) == set()
    assert _runtime_patched({("runtime", "run"), ("run", None)}) == {"run"}


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
            "from podcast_mcp.engines.ffmpeg import runtime as rt\nsetattr(rt, 'run', x)",
            {("runtime", "run")},
            id="runtime module alias",
        ),
        pytest.param(
            "from podcast_mcp.engines import ffmpeg as ff\n"
            "patch.multiple(ff.runtime, run=x, popen=y)",
            {("runtime", "run"), ("runtime", "popen")},
            id="patch.multiple on runtime",
        ),
        pytest.param(
            "patch('podcast_mcp.engines.ffmpeg.runtime')",
            {("runtime", None)},
            id="whole runtime module string",
        ),
        pytest.param(
            "patch('podcast_mcp.engines.ffmpeg.probe:attr.sub')",
            {("probe", "attr")},
            id="colon form with a later dot is scanned as dotted",
        ),
        pytest.param(
            "x = 'podcast_mcp.engines.ffmpeg.probe:_cached_audio_extent'",
            set(),
            id="registry form with no later dot is skipped",
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


@pytest.mark.parametrize(
    ("source", "lines"),
    [
        pytest.param(
            "runtime.run(a)\nruntime.popen(a)\nruntime._run_cancellable(a)", [], id="calls"
        ),
        pytest.param(
            "spawn_or_too_long(runtime.run, a, check=True)", [], id="handed to the spawner"
        ),
        pytest.param("_run = runtime.run", [1], id="alias assignment"),
        pytest.param("x = runtime.popen", [1], id="popen alias"),
        pytest.param("def f(run=runtime.run):\n    pass", [1], id="default argument"),
        pytest.param("g(runtime.run)", [1], id="handed to another callee"),
        pytest.param("spawn_or_too_long(a, runtime.run)", [1], id="not the first argument"),
        pytest.param("spawn_or_too_long(run=runtime.run)", [1], id="keyword argument"),
        pytest.param("y = [runtime.resolve_ffmpeg]", [1], id="other seam name in a list"),
        pytest.param("other.run\nruntime.name", [], id="unrelated attributes"),
    ],
)
def test_the_value_use_scanner(source: str, lines: list[int]) -> None:
    assert _seam_value_uses(ast.parse(source)) == lines


@pytest.mark.parametrize(
    ("source", "lines"),
    [
        pytest.param("from podcast_mcp.util import process\nprocess.run(a)", [2], id="module run"),
        pytest.param(
            "from podcast_mcp.util import process\nprocess.popen(a)", [2], id="module popen"
        ),
        pytest.param(
            "from podcast_mcp.util import process as p\nz = p.run", [2], id="aliased module value"
        ),
        pytest.param("from podcast_mcp.util.process import run", [1], id="from import run"),
        pytest.param("import podcast_mcp.util.process as p\np.popen(a)", [2], id="import as"),
        pytest.param(
            "from podcast_mcp.util import process\nprocess.PIPE\nprocess.is_in_process_media_tool",
            [],
            id="other process names",
        ),
        pytest.param("from podcast_mcp.util.process import PIPE", [], id="other import"),
        pytest.param(
            "import subprocess\nsubprocess.run(a)\nprocess.run(a)", [], id="not the module"
        ),
    ],
)
def test_the_process_use_scanner(source: str, lines: list[int]) -> None:
    assert _direct_process_uses(ast.parse(source)) == lines


KNOWN_MIXIN_BINDINGS = {
    ("probe.py", "threading"),
    ("decode.py", "threading"),
}
KNOWN_RENDER_BINDINGS = {("encode.py", "spawn_or_too_long")}
FACADE_ONLY = {"__init__.py"}
MIXIN_IMPORT_EXEMPT = {"__init__.py", "runtime.py"}
HOST = "host"


def _unguarded(tree: ast.Module) -> list[ast.AST]:
    """Every node outside an ``if TYPE_CHECKING:`` body."""
    guarded: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.If) and (
            (isinstance(node.test, ast.Name) and node.test.id == "TYPE_CHECKING")
            or (isinstance(node.test, ast.Attribute) and node.test.attr == "TYPE_CHECKING")
        ):
            guarded |= {id(child) for stmt in node.body for child in ast.walk(stmt)}
    return [node for node in ast.walk(tree) if id(node) not in guarded]


def _facade_name_bindings(tree: ast.Module, names: set[str] = ALLOWLIST) -> list[tuple[str, int]]:
    """Names from ``names`` a module imports or reads as a bare name, with the line."""
    found: list[tuple[str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in names:
            found.append((node.id, node.lineno))
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                bound = alias.asname or alias.name.split(".")[0]
                if bound in names:
                    found.append((bound, node.lineno))
    return sorted(found, key=lambda item: item[1])


def _is_package_import(node: ast.ImportFrom, relative_ok: bool = True) -> bool:
    return node.module == MODULE or (relative_ok and node.level == 1 and not node.module)


def _package_imports(tree: ast.Module) -> list[tuple[str, int]]:
    """Names a module takes from the package itself at run time, with the line."""
    found: list[tuple[str, int]] = []
    for node in _unguarded(tree):
        if isinstance(node, ast.ImportFrom):
            if _is_package_import(node):
                found.extend((alias.name, node.lineno) for alias in node.names)
            elif node.module == "podcast_mcp.engines" and not node.level:
                found.extend((a.name, node.lineno) for a in node.names if a.name == "ffmpeg")
        elif isinstance(node, ast.Import):
            found.extend((a.name, node.lineno) for a in node.names if a.name == MODULE)
    return sorted(found, key=lambda item: item[1])


def _host_imports(tree: ast.Module, guarded: bool) -> list[int]:
    """Lines importing the host module, outside (or, with ``guarded``, inside) ``if TYPE_CHECKING:``."""
    every = list(ast.walk(tree))
    unguarded = {id(node) for node in _unguarded(tree)}
    lines: list[int] = []
    for node in every:
        if (id(node) in unguarded) == guarded:
            continue
        if isinstance(node, ast.ImportFrom):
            names = {a.name for a in node.names}
            hit = (
                node.module == f"{MODULE}.{HOST}"
                or (node.level == 1 and node.module == HOST)
                or (_is_package_import(node) and HOST in names)
            )
        elif isinstance(node, ast.Import):
            hit = any(a.name == f"{MODULE}.{HOST}" for a in node.names)
        else:
            continue
        if hit:
            lines.append(node.lineno)
    return sorted(lines)


def test_no_mixin_module_binds_a_name_the_facade_is_patched_through() -> None:
    found: dict[tuple[str, str], str] = {}
    for path, tree in _readers().items():
        if path.name not in FACADE_ONLY:
            for name, line in _facade_name_bindings(tree):
                found.setdefault((path.name, name), f"{path.name}:{line}")
    assert set(found) == KNOWN_MIXIN_BINDINGS, (
        f"a patch of an allowlisted name on {MODULE} only reaches readers in __init__.py; "
        f"new in a mixin module: {sorted(found[k] for k in set(found) - KNOWN_MIXIN_BINDINGS)}, "
        f"retarget the patch or read it through the facade; "
        f"gone, drop from KNOWN_MIXIN_BINDINGS: {sorted(KNOWN_MIXIN_BINDINGS - set(found))}"
    )


def test_no_module_but_render_binds_a_name_the_render_module_is_patched_through() -> None:
    found: dict[tuple[str, str], str] = {}
    for path, tree in _readers().items():
        if path.name != "render.py":
            for name, line in _facade_name_bindings(tree, RENDER_ALLOWLIST):
                found.setdefault((path.name, name), f"{path.name}:{line}")
    assert set(found) == KNOWN_RENDER_BINDINGS, (
        f"a patch of {sorted(RENDER_ALLOWLIST)} on {MODULE}.{RENDER} only reaches readers in "
        f"render.py; new elsewhere: {sorted(found[k] for k in set(found) - KNOWN_RENDER_BINDINGS)}; "
        f"gone, drop from KNOWN_RENDER_BINDINGS: {sorted(KNOWN_RENDER_BINDINGS - set(found))}"
    )


def test_mixin_modules_import_only_the_runtime_from_the_package() -> None:
    offenders = [
        f"{path.name}:{line} imports {name}"
        for path, tree in _package_trees().items()
        if path.name not in MIXIN_IMPORT_EXEMPT
        for name, line in _package_imports(tree)
        if name != RUNTIME
    ]
    assert not offenders, f"only `runtime` may come from {MODULE} in a mixin module: {offenders}"


def test_the_host_module_is_imported_only_for_type_checking() -> None:
    offenders = [
        f"{path.name}:{line}"
        for path, tree in _package_trees().items()
        for line in _host_imports(tree, guarded=False)
    ]
    assert not offenders, f"host imported outside `if TYPE_CHECKING:`: {offenders}"
    assert any(_host_imports(tree, guarded=True) for tree in _package_trees().values())


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        pytest.param(
            "from podcast_mcp.engines.render_clock import spawn_or_too_long",
            [("spawn_or_too_long", 1)],
            id="import",
        ),
        pytest.param("import threading", [("threading", 1)], id="plain import"),
        pytest.param(
            "import threading as t\nt.Timer",
            [],
            id="import as binds the alias only",
        ),
        pytest.param("x = 1\nthreading.Timer(a)", [("threading", 2)], id="bare read"),
        pytest.param("negotiated_rates(a)", [("negotiated_rates", 1)], id="call"),
        pytest.param("import os\nruntime.run(a)\nfacade.shutil", [], id="unrelated and attribute"),
        pytest.param("threading = 1", [], id="a store is not a read"),
    ],
)
def test_the_facade_binding_scanner(source: str, expected: list[tuple[str, int]]) -> None:
    names = ALLOWLIST | RENDER_ALLOWLIST
    assert _facade_name_bindings(ast.parse(source), names) == expected


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        pytest.param(
            "from podcast_mcp.engines.ffmpeg import runtime", [("runtime", 1)], id="runtime"
        ),
        pytest.param(
            "from podcast_mcp.engines.ffmpeg import ENCODE_CANCELLED",
            [("ENCODE_CANCELLED", 1)],
            id="absolute name",
        ),
        pytest.param(
            "from . import runtime, probe", [("runtime", 1), ("probe", 1)], id="relative names"
        ),
        pytest.param("import podcast_mcp.engines.ffmpeg", [(MODULE, 1)], id="module import"),
        pytest.param(
            "from podcast_mcp.engines import ffmpeg", [("ffmpeg", 1)], id="engines import"
        ),
        pytest.param(
            "def f():\n    from podcast_mcp.engines.ffmpeg import _x",
            [("_x", 2)],
            id="function local",
        ),
        pytest.param(
            "if TYPE_CHECKING:\n    from podcast_mcp.engines.ffmpeg import _x",
            [],
            id="type checking",
        ),
        pytest.param(
            "from podcast_mcp.engines.audio import Audio\nfrom .runtime import run",
            [],
            id="other modules",
        ),
    ],
)
def test_the_package_import_scanner(source: str, expected: list[tuple[str, int]]) -> None:
    assert _package_imports(ast.parse(source)) == expected


@pytest.mark.parametrize(
    ("source", "bare", "guarded"),
    [
        pytest.param(
            "from podcast_mcp.engines.ffmpeg.host import FFmpegSelf", [1], [], id="absolute"
        ),
        pytest.param("from .host import FFmpegSelf", [1], [], id="relative"),
        pytest.param("from . import host", [1], [], id="relative module"),
        pytest.param("from podcast_mcp.engines.ffmpeg import host", [1], [], id="package import"),
        pytest.param("import podcast_mcp.engines.ffmpeg.host", [1], [], id="plain import"),
        pytest.param("def f():\n    from .host import X", [2], [], id="function local"),
        pytest.param(
            "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from .host import X",
            [],
            [3],
            id="guarded",
        ),
        pytest.param(
            "if typing.TYPE_CHECKING:\n    from .host import X", [], [2], id="attribute guard"
        ),
        pytest.param("from .runtime import run", [], [], id="other module"),
    ],
)
def test_the_host_import_scanner(source: str, bare: list[int], guarded: list[int]) -> None:
    tree = ast.parse(source)
    assert _host_imports(tree, guarded=False) == bare
    assert _host_imports(tree, guarded=True) == guarded


def test_the_package_scan_is_package_wide() -> None:
    names = {p.name for p in _package_trees()}
    assert {"__init__.py", "runtime.py"} <= names
    assert _package_trees() is _package_trees()


def test_the_scan_runs_once() -> None:
    assert _found() is _found()
