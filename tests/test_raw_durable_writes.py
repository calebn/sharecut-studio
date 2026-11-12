"""Ratchet for #3123 item 5: raw durable writes under ``src/podcast_mcp``.

A crash or a full disk during ``Path.write_text`` or ``open(path, "w")`` leaves a
truncated file at the real path. Durable files go through the atomic helpers
(temp file, fsync, replace, directory fsync) in ``util/atomic_file.py`` and
``util/atomic_json.py``: ``write_json_atomic``, ``write_text_atomic``,
``write_bytes_atomic``, ``copy_file_atomic``, ``atomic_write`` (callback onto an open
temp handle) and ``publish_completed_file`` (a renderer wrote a caller-owned temp file).

The scanner is AST-only and counts these forms per file:

* ``open(path, mode)``, ``io.open`` and ``<path>.open(mode)`` with a literal mode that
  contains ``w``, ``a`` or ``x`` (``mode=`` keyword included);
* ``<path>.write_text(...)`` and ``<path>.write_bytes(...)``;
* ``shutil.copy``, ``shutil.copyfile`` and ``shutil.copy2``.

``json.dump`` onto a handle is not counted: the ``open`` that made the handle is the
offence, and the same call inside an ``atomic_write`` callback is fine.

Never counted: ``util/atomic_*.py`` (the helpers themselves), and a write whose target
is rooted in a name bound from ``tempfile`` (``mkdtemp``, ``TemporaryDirectory``,
``NamedTemporaryFile``, ``mkstemp``, ``gettempdir``) in the same function, which is
scratch space. Whether any other target is a throwaway export artifact needs a human,
so those stay listed.

``RAW_WRITES`` caps the count per file and only shrinks. A file absent from it allows 0.
A count above its cap fails, so a file cannot gain a raw write. A count below its cap
fails too, with the number to write: whoever converts a write lowers (or deletes) the
entry in the same change.
"""

from __future__ import annotations

import ast
from collections import Counter
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "podcast_mcp"

HELPERS = (
    "util.atomic_json.write_json_atomic / write_text_atomic / write_bytes_atomic / "
    "copy_file_atomic, util.atomic_file.atomic_write / publish_completed_file"
)

RAW_WRITES: dict[str, int] = {
    "cli/ingest.py": 2,
    "edits/focus.py": 2,
    "edits/join_labels.py": 1,
    "edits/join_ranker.py": 1,
    "edits/transcript_precorrect.py": 1,
    "engines/ffmpeg.py": 6,
    "engines/render_clock.py": 1,
    "engines/source_proxy_audio.py": 1,
    "engines/speaker_id.py": 1,
    "engines/transcript_gated_play.py": 2,
    "export/audio.py": 1,
    "export/episode.py": 1,
    "feed/writer.py": 2,
    "pipeline/steps.py": 5,
    "project/history/manager.py": 1,
    "project/store.py": 1,
    "segments/bundle.py": 1,
    "segments/store.py": 1,
    "services/collaboration/review_versions.py": 5,
    "services/document/golden_ear.py": 5,
    "services/document/play.py": 2,
    "services/document/transcript.py": 1,
    "services/media/ingest.py": 2,
    "services/media/media_store.py": 5,
    "services/record/upload.py": 1,
    "util/asset_sources.py": 1,
    "util/file_locks.py": 1,
}

_WRITE_MODE_CHARS = frozenset("wax")
_SHUTIL_COPIES = frozenset({"shutil.copy", "shutil.copyfile", "shutil.copy2"})
_TEMPFILE_BINDERS = frozenset(
    {"mkdtemp", "TemporaryDirectory", "NamedTemporaryFile", "mkstemp", "gettempdir"}
)


def _is_write_mode(node: ast.expr | None) -> bool:
    return (
        isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and bool(_WRITE_MODE_CHARS & set(node.value))
    )


def _keyword_value(call: ast.Call, name: str) -> ast.expr | None:
    return next((kw.value for kw in call.keywords if kw.arg == name), None)


def _attr_chain(node: ast.expr) -> str:
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def _root_name(node: ast.expr) -> str | None:
    """The leftmost name a target expression is built from, or None."""
    while True:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute | ast.Subscript):
            node = node.value
        elif isinstance(node, ast.Call):
            if node.args and _attr_chain(node.func) in {"Path", "os.path.join", "str", "Path.cwd"}:
                node = node.args[0]
            else:
                node = node.func
        elif isinstance(node, ast.BinOp):
            node = node.left
        else:
            return None


def _is_tempfile_call(node: ast.expr) -> bool:
    if not isinstance(node, ast.Call):
        return False
    module, _, binder = _attr_chain(node.func).rpartition(".")
    return module == "tempfile" and binder in _TEMPFILE_BINDERS


def _bound_names(target: ast.expr) -> list[str]:
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, ast.Tuple | ast.List):
        return [name for elt in target.elts for name in _bound_names(elt)]
    return []


def _scratch_names(scope: ast.AST) -> set[str]:
    """Names bound from ``tempfile`` or derived from one in ``scope`` (to a fixed point)."""
    pairs: list[tuple[list[str], ast.expr]] = []
    for node in ast.walk(scope):
        if isinstance(node, ast.Assign):
            pairs.append(([n for t in node.targets for n in _bound_names(t)], node.value))
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            pairs.append((_bound_names(node.target), node.value))
        elif isinstance(node, ast.With | ast.AsyncWith):
            pairs.extend(
                (_bound_names(item.optional_vars), item.context_expr)
                for item in node.items
                if item.optional_vars is not None
            )
    scratch: set[str] = set()
    changed = True
    while changed:
        changed = False
        for names, value in pairs:
            root = _root_name(value)
            if _is_tempfile_call(value) or (root is not None and root in scratch):
                new = set(names) - scratch
                if new:
                    scratch |= new
                    changed = True
    return scratch


def _raw_write_target(call: ast.Call) -> ast.expr | bool | None:
    """The written path expression for a banned call, ``None`` if unknown, ``False`` if allowed."""
    func = call.func
    chain = _attr_chain(func)
    if (isinstance(func, ast.Name) and func.id == "open") or chain == "io.open":
        mode = call.args[1] if len(call.args) > 1 else _keyword_value(call, "mode")
        return (call.args[0] if call.args else None) if _is_write_mode(mode) else False
    if not isinstance(func, ast.Attribute):
        return False
    if func.attr == "open":
        mode = call.args[0] if call.args else _keyword_value(call, "mode")
        return func.value if _is_write_mode(mode) else False
    if func.attr in {"write_text", "write_bytes"}:
        return func.value
    if chain in _SHUTIL_COPIES:
        return call.args[1] if len(call.args) > 1 else _keyword_value(call, "dst")
    return False


def scan_source(source: str) -> list[int]:
    """Line numbers of raw durable writes in ``source`` (scratch tempfile writes excluded)."""
    tree = ast.parse(source)
    scopes: list[ast.AST] = [tree] + [
        n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)
    ]
    scratch_by_scope = {id(scope): _scratch_names(scope) for scope in scopes}

    lines: list[int] = []

    def visit(node: ast.AST, scope: ast.AST) -> None:
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            scope = node
        if isinstance(node, ast.Call):
            target = _raw_write_target(node)
            if target is not False:
                root = _root_name(target) if isinstance(target, ast.expr) else None
                if root is None or root not in scratch_by_scope[id(scope)]:
                    lines.append(node.lineno)
        for child in ast.iter_child_nodes(node):
            visit(child, scope)

    visit(tree, tree)
    return sorted(lines)


def _raw_write_counts() -> dict[str, int]:
    found: Counter[str] = Counter()
    for path in sorted(SRC.rglob("*.py")):
        rel = path.relative_to(SRC).as_posix()
        if path.parent.name == "util" and path.name.startswith("atomic_"):
            continue
        count = len(scan_source(path.read_text(encoding="utf-8")))
        if count:
            found[rel] = count
    return dict(found)


def _violations(counts: dict[str, int], caps: dict[str, int]) -> list[str]:
    problems: list[str] = []
    for name in sorted(set(counts) | set(caps)):
        have, cap = counts.get(name, 0), caps.get(name, 0)
        if have > cap:
            problems.append(
                f"{name}: {have} raw durable writes, allowed {cap}. Write through {HELPERS}."
            )
        elif have < cap:
            problems.append(
                f"{name}: {have} raw durable writes left, RAW_WRITES allows {cap}. "
                + (f"Lower it to {have}." if have else "Delete the entry.")
            )
    return problems


def test_raw_durable_writes_match_the_allowlist() -> None:
    problems = _violations(_raw_write_counts(), RAW_WRITES)
    assert not problems, "\n".join(problems)


def test_the_violation_check_is_exact_in_both_directions() -> None:
    assert _violations({"a.py": 2}, {"a.py": 2}) == []
    over = _violations({"a.py": 3}, {"a.py": 2})
    assert len(over) == 1
    assert "3 raw durable writes, allowed 2" in over[0]
    assert "write_json_atomic" in over[0]
    assert "atomic_write" in over[0]
    assert "allowed 0" in _violations({"new.py": 1}, {})[0]
    stale = _violations({"a.py": 1}, {"a.py": 2})
    assert stale == ["a.py: 1 raw durable writes left, RAW_WRITES allows 2. Lower it to 1."]
    gone = _violations({}, {"a.py": 2})
    assert gone == ["a.py: 0 raw durable writes left, RAW_WRITES allows 2. Delete the entry."]


@pytest.mark.parametrize(
    "line",
    [
        'open(p, "w")',
        'open(p, "wb")',
        'open(p, "a")',
        'open(p, "x")',
        'open(p, "w+", encoding="utf-8")',
        'open(p, mode="w")',
        'io.open(p, "w")',
        'p.open("w")',
        'p.open(mode="wb")',
        'root.joinpath("x").open("a")',
        'p.write_text("x")',
        "p.write_bytes(b)",
        "(root / 'x').write_text('y')",
        "shutil.copy(a, b)",
        "shutil.copyfile(a, b)",
        "shutil.copy2(a, dst=b)",
    ],
)
def test_the_scanner_flags_each_banned_form(line: str) -> None:
    assert scan_source(f"def f(p, a, b, root):\n    {line}\n") == [2]


@pytest.mark.parametrize(
    "line",
    [
        "open(p)",
        'open(p, "r")',
        'open(p, "r+")',
        "open(p, mode)",
        'p.open("r")',
        "p.open()",
        "p.read_text()",
        "json.dump(obj, handle)",
        "write_json_atomic(p, obj)",
        "atomic_write(p, lambda h: h.write(b))",
        "shutil.copyfileobj(a, b)",
        "shutil.move(a, b)",
        "handle.write(b)",
    ],
)
def test_the_scanner_allows_reads_and_helper_calls(line: str) -> None:
    assert scan_source(f"def f(p, a, b, obj, handle, mode):\n    {line}\n") == []


def test_the_scanner_skips_writes_under_a_tempfile_root() -> None:
    source = (
        "import tempfile\n"
        "def f(data):\n"
        "    with tempfile.TemporaryDirectory() as tmp:\n"
        "        scratch = Path(tmp) / 'a.json'\n"
        "        scratch.write_text('x')\n"
        "        open(scratch, 'wb')\n"
        "        shutil.copy(data, scratch)\n"
        "        (Path(tmp) / 'b').write_bytes(b'')\n"
        "    work = tempfile.mkdtemp()\n"
        "    (Path(work) / 'c').write_text('x')\n"
        "    fd, name = tempfile.mkstemp()\n"
        "    Path(name).write_bytes(b'')\n"
    )
    assert scan_source(source) == []


def test_the_scanner_still_flags_a_project_write_beside_a_tempdir() -> None:
    source = (
        "import tempfile\n"
        "def f(project, data):\n"
        "    with tempfile.TemporaryDirectory() as tmp:\n"
        "        (Path(tmp) / 'a').write_text('x')\n"
        "        project.path.write_text('y')\n"
        "        shutil.copy(data, project.dest)\n"
        "def g(tmp):\n"
        "    tmp.write_text('x')\n"
    )
    assert scan_source(source) == [5, 6, 8]


def test_the_scanner_counts_module_level_and_async_and_nested_writes() -> None:
    source = (
        "p.write_text('a')\n"
        "async def f(p):\n"
        "    def inner():\n"
        "        p.write_bytes(b'')\n"
        "    open(p, 'w')\n"
    )
    assert scan_source(source) == [1, 4, 5]


def test_the_scan_skips_the_atomic_helpers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "util").mkdir()
    raw = "def f(p):\n    p.write_text('x')\n"
    (tmp_path / "util" / "atomic_file.py").write_text(raw, encoding="utf-8")
    (tmp_path / "util" / "other.py").write_text(raw, encoding="utf-8")
    (tmp_path / "atomic_elsewhere.py").write_text(raw, encoding="utf-8")
    monkeypatch.setattr(f"{__name__}.SRC", tmp_path)
    assert _raw_write_counts() == {"util/other.py": 1, "atomic_elsewhere.py": 1}
