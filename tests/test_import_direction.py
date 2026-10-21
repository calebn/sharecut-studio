"""Services must not import podcast_mcp.gui at module level for projection types."""

from __future__ import annotations

import ast
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_SRC = _REPO / "src" / "podcast_mcp"

_NO_TOP_LEVEL_GUI = (
    "services/document_sync/projections.py",
    "services/document_sync/service.py",
    "services/collaboration/share.py",
)


def _gui_modules(node: ast.AST) -> list[str]:
    found: list[str] = []
    if isinstance(node, ast.Import):
        for alias in node.names:
            if alias.name == "podcast_mcp.gui" or alias.name.startswith("podcast_mcp.gui."):
                found.append(alias.name)
    elif isinstance(node, ast.ImportFrom):
        mod = node.module or ""
        if mod == "podcast_mcp.gui" or mod.startswith("podcast_mcp.gui."):
            found.append(mod)
    return found


def _top_level_gui_imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: list[str] = []
    for node in tree.body:
        found.extend(_gui_modules(node))
    return found


def _all_gui_imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: list[str] = []
    for node in ast.walk(tree):
        found.extend(_gui_modules(node))
    return found


def test_projection_services_have_no_top_level_gui_imports() -> None:
    offenders: list[str] = []
    for rel in _NO_TOP_LEVEL_GUI:
        path = _SRC / rel
        for name in _top_level_gui_imports(path):
            offenders.append(f"{rel}: {name}")
    assert not offenders, "services must not import podcast_mcp.gui at module level:\n" + "\n".join(
        offenders
    )


def test_projection_types_have_no_gui_imports() -> None:
    rel = "services/document_sync/projection_types.py"
    found = _all_gui_imports(_SRC / rel)
    assert not found, f"{rel} must stay GUI-free, found: {found}"


def test_importing_one_edits_module_loads_no_cut_stack() -> None:
    """``podcast_mcp.edits`` resolves its names lazily, so a leaf import does not drag in
    cut_application, tighten or transcript_cuts (the cycle the cut modules once hid behind
    inline imports, #1813)."""
    import subprocess
    import sys

    code = (
        "import sys, podcast_mcp.edits.ripple;"
        "heavy = [m for m in ('podcast_mcp.edits.cut_application', 'podcast_mcp.edits.tighten',"
        " 'podcast_mcp.edits.transcript_cuts') if m in sys.modules];"
        "print(heavy); sys.exit(1 if heavy else 0)"
    )
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stdout + done.stderr


def test_engines_import_nothing_from_edits() -> None:
    """``engines`` sits below ``edits``: no engines module imports it, inline or not (#1813)."""
    offenders: list[str] = []
    for path in sorted((_SRC / "engines").rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"), filename=str(path))):
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                names = [mod] + (
                    [f"{mod}.{a.name}" for a in node.names] if mod == "podcast_mcp" else []
                )
            else:
                continue
            if any(n == "podcast_mcp.edits" or n.startswith("podcast_mcp.edits.") for n in names):
                offenders.append(f"{path.relative_to(_SRC)}:{node.lineno}")
    assert not offenders, offenders
