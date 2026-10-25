"""No second ML stack under ``src/`` (#2257).

Production inference runs on ONNX (``engines/word_align.py``, ``engines/ctc_forced_align.py``,
the ONNX ECAPA speaker model). A direct import of torch, speechbrain, resemblyzer or
transformers would bring back a duplicate stack and its multi-GB install. This AST scan
fails on any such import (``import x``, ``from x import y``, ``importlib.import_module("x")``
or ``__import__("x")``) except in the modules named in ``ALLOWED_TORCH_STACK_MODULES``.
"""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

BANNED_TOP_LEVEL = frozenset({"torch", "speechbrain", "resemblyzer", "transformers"})

# Modules that still import a banned package today, with the reason. Shrink this when the
# owner lands; never grow it. The guard also fails when an entry no longer imports one, so
# a finished removal cannot leave a stale exemption behind.
ALLOWED_TORCH_STACK_MODULES: dict[str, str] = {
    # joinqc extra (torch + transformers WavLM embedding); removed or replaced by #2256.
    "src/podcast_mcp/edits/join_neural.py": "joinqc neural join QC, waits for #2256",
    # Optional `import torch` inside try/except only to report cuda/mps availability.
    "src/podcast_mcp/services/support/diagnostics.py": "optional GPU flag probe in doctor",
}


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
        elif isinstance(node, ast.Call) and node.args:
            func = node.func
            callee = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
            arg = node.args[0]
            if (
                callee in {"import_module", "__import__"}
                and isinstance(arg, ast.Constant)
                and isinstance(arg.value, str)
            ):
                found.add(_top_level(arg.value))
    return found & BANNED_TOP_LEVEL


def _offenders() -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for path in sorted(SRC.rglob("*.py")):
        hits = banned_imports(path.read_text(encoding="utf-8"))
        if hits:
            out[path.relative_to(ROOT).as_posix()] = hits
    return out


def test_src_does_not_import_the_torch_stack() -> None:
    unexpected = {m: h for m, h in _offenders().items() if m not in ALLOWED_TORCH_STACK_MODULES}
    assert not unexpected, (
        f"{unexpected} import a banned package; use the ONNX path instead (#2257)"
    )


def test_allow_list_has_no_stale_entries() -> None:
    offenders = _offenders()
    stale = sorted(m for m in ALLOWED_TORCH_STACK_MODULES if m not in offenders)
    assert not stale, f"drop {stale} from ALLOWED_TORCH_STACK_MODULES: they no longer import it"


def test_scanner_catches_every_import_form() -> None:
    source = (
        "import torch.nn\n"
        "from speechbrain.inference import X\n"
        "def f():\n"
        "    import resemblyzer as r\n"
        "    import importlib\n"
        "    importlib.import_module('transformers.models')\n"
        "    __import__('numpy')\n"
    )
    assert banned_imports(source) == BANNED_TOP_LEVEL
    assert banned_imports("import numpy\nfrom . import torch\nfrom .x import torch\n") == set()
