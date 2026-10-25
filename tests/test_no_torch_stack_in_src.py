"""No second ML stack under ``src/`` (#2257).

Production inference runs on ONNX (``engines/word_align.py``, ``engines/ctc_forced_align.py``,
the ONNX ECAPA speaker model). A direct import of torch, speechbrain, resemblyzer,
transformers, librosa or numba would bring back a duplicate stack and its multi-GB install.
This AST scan fails on any such import except the exact ``(file, module)`` pairs named in
``ALLOWED_TORCH_STACK_IMPORTS``, so a new banned import in an exempt file still fails.

Detection is literal-name only: ``import x``, ``from x import y``,
``importlib.import_module("x")`` / ``import_module(name="x")`` and ``__import__("x")``. A
module name built at run time (a variable, f-string or concatenation) is not caught, and
relative imports are ignored.
"""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

BANNED_TOP_LEVEL = frozenset(
    {"torch", "speechbrain", "resemblyzer", "transformers", "librosa", "numba"}
)

# (file, module) pairs that still import a banned package, with the reason. Empty since #2256;
# by convention never grow it (nothing fails if you do). The guard also fails when a pair no
# longer occurs, so a finished removal cannot leave a stale exemption.
ALLOWED_TORCH_STACK_IMPORTS: dict[tuple[str, str], str] = {}


def _top_level(name: str) -> str:
    return name.split(".", 1)[0]


def banned_imports(source: str) -> set[str]:
    """Banned top-level packages that ``source`` imports, statically or by literal name."""
    found: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found.update(_top_level(a.name) for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                found.add(_top_level(node.module))
        elif isinstance(node, ast.Call):
            func = node.func
            callee = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
            args = [node.args[0]] if node.args else []
            args += [k.value for k in node.keywords if k.arg == "name"]
            if callee in {"import_module", "__import__"}:
                found.update(
                    _top_level(a.value)
                    for a in args[:1]
                    if isinstance(a, ast.Constant) and isinstance(a.value, str)
                )
    return found & BANNED_TOP_LEVEL


def _offenders() -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for path in sorted(SRC.rglob("*.py")):
        rel = path.relative_to(ROOT).as_posix()
        out.update((rel, mod) for mod in banned_imports(path.read_text(encoding="utf-8")))
    return out


def test_src_does_not_import_the_torch_stack() -> None:
    unexpected = sorted(_offenders() - ALLOWED_TORCH_STACK_IMPORTS.keys())
    assert not unexpected, (
        f"{unexpected} import a banned package; use the ONNX path instead (#2257)"
    )


def test_allow_list_has_no_stale_entries() -> None:
    stale = sorted(ALLOWED_TORCH_STACK_IMPORTS.keys() - _offenders())
    assert not stale, f"drop {stale} from ALLOWED_TORCH_STACK_IMPORTS: no longer imported"


def test_scanner_catches_every_import_form() -> None:
    source = (
        "import torch.nn\n"
        "from speechbrain.inference import X\n"
        "def f():\n"
        "    import resemblyzer as r\n"
        "    import importlib\n"
        "    importlib.import_module('transformers.models')\n"
        "    importlib.import_module(name='librosa')\n"
        "    __import__('numba')\n"
        "    __import__('numpy')\n"
        "    importlib.import_module(some_variable)\n"
    )
    assert banned_imports(source) == BANNED_TOP_LEVEL
    assert banned_imports("import numpy\nfrom . import torch\nfrom .x import torch\n") == set()
