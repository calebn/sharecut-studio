from __future__ import annotations

import ast
import subprocess
from pathlib import Path

import pytest

from podcast_mcp.util import process

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
OWNER = SRC / "podcast_mcp" / "util" / "process.py"

OS_SPAWNERS = ("system", "popen", "exec", "spawn", "posix_spawn")
ASYNCIO_SPAWNERS = ("create_subprocess_exec", "create_subprocess_shell")
LOADERS = ("import_module", "__import__")


def _os_spawner(name: str) -> bool:
    return name.startswith(OS_SPAWNERS)


def _loads_subprocess(node: ast.Call) -> bool:
    return (
        bool(node.args)
        and isinstance(node.args[0], ast.Constant)
        and isinstance(node.args[0].value, str)
        and node.args[0].value.split(".")[0] == "subprocess"
    )


def _offences(source: str) -> list[tuple[int, str]]:
    """Line and text of each way a module can reach subprocess or start a program.

    A name computed at run time is an accepted limit: this is a tripwire, not a sandbox.
    """
    tree = ast.parse(source)
    aliases: dict[str, set[str]] = {"os": set(), "asyncio": set(), "importlib": set()}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in aliases:
                    aliases[alias.name].add(alias.asname or alias.name)
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found += [
                (node.lineno, f"import {alias.name}")
                for alias in node.names
                if alias.name.split(".")[0] == "subprocess"
            ]
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            module = node.module or ""
            if module.split(".")[0] == "subprocess":
                found.append((node.lineno, f"from {module} import ..."))
            for alias in node.names:
                if (module == "os" and (alias.name == "*" or _os_spawner(alias.name))) or (
                    module == "asyncio" and alias.name in ASYNCIO_SPAWNERS
                ):
                    found.append((node.lineno, f"from {module} import {alias.name}"))
        elif isinstance(node, ast.Call):
            func = node.func
            if (
                isinstance(func, ast.Attribute)
                and isinstance(func.value, ast.Name)
                and (
                    (func.value.id in aliases["os"] and _os_spawner(func.attr))
                    or (func.value.id in aliases["asyncio"] and func.attr in ASYNCIO_SPAWNERS)
                )
            ):
                found.append((node.lineno, f"{func.value.id}.{func.attr}(...)"))
            name = (
                func.attr
                if isinstance(func, ast.Attribute)
                and isinstance(func.value, ast.Name)
                and func.value.id in aliases["importlib"]
                else func.id
                if isinstance(func, ast.Name)
                else ""
            )
            if name in LOADERS and _loads_subprocess(node):
                found.append((node.lineno, f"{name}('subprocess')"))
    return sorted(found)


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("import subprocess\n", [(1, "import subprocess")]),
        ("import os, subprocess as sp\n", [(1, "import subprocess")]),
        ("from subprocess import CalledProcessError\n", [(1, "from subprocess import ...")]),
        ("import os\nos.system('x')\n", [(2, "os.system(...)")]),
        ("import os\nos.popen('x')\n", [(2, "os.popen(...)")]),
        ("import os\nos.execvp('x', [])\n", [(2, "os.execvp(...)")]),
        ("import os\nos.spawnl(0, 'x')\n", [(2, "os.spawnl(...)")]),
        ("import os\nos.posix_spawnp('x', [], {})\n", [(2, "os.posix_spawnp(...)")]),
        ("from os import system\n", [(1, "from os import system")]),
        ("import os\nos.path.join('a')\nos.getpid()\n", []),
        ("from podcast_mcp.util.process import CalledProcessError\n", []),
        ("import os as o\no.system('x')\n", [(2, "o.system(...)")]),
        ("import os as o\no.path.join('a')\n", []),
        ("from os import *\n", [(1, "from os import *")]),
        (
            "import importlib\nimportlib.import_module('subprocess')\n",
            [(2, "import_module('subprocess')")],
        ),
        (
            "from importlib import import_module\nimport_module('subprocess.x')\n",
            [(2, "import_module('subprocess')")],
        ),
        ("__import__('subprocess')\n", [(1, "__import__('subprocess')")]),
        ("import importlib\nimportlib.import_module('json')\n", []),
        (
            "import asyncio\nasyncio.create_subprocess_exec('x')\n",
            [(2, "asyncio.create_subprocess_exec(...)")],
        ),
        (
            "import asyncio as a\na.create_subprocess_shell('x')\n",
            [(2, "a.create_subprocess_shell(...)")],
        ),
        (
            "from asyncio import create_subprocess_exec\n",
            [(1, "from asyncio import create_subprocess_exec")],
        ),
        ("import asyncio\nasyncio.sleep(0)\n", []),
        ("import subprocess.x\n", [(1, "import subprocess.x")]),
        ("from subprocess.x import y\n", [(1, "from subprocess.x import ...")]),
        ("from .subprocess import z\n", []),
        ("from . import subprocess\n", []),
        ("import importlib\nimportlib.import_module()\n__import__()\n", []),
        (
            "import os\nos.system('a')\nimport subprocess\n__import__('subprocess')\n",
            [(2, "os.system(...)"), (3, "import subprocess"), (4, "__import__('subprocess')")],
        ),
    ],
)
def test_the_detector_finds_every_way_to_spawn(
    source: str, expected: list[tuple[int, str]]
) -> None:
    assert _offences(source) == expected


def _scan(root: Path, exempt: Path) -> tuple[list[str], int]:
    """Offences under ``root`` outside ``exempt``, and how many files were read."""
    found = []
    paths = [path for path in sorted(root.rglob("*.py")) if path != exempt]
    for path in paths:
        found += [
            f"{path.relative_to(root)}:{line}: {what}"
            for line, what in _offences(path.read_text(encoding="utf-8"))
        ]
    return found, len(paths)


def test_the_scan_reports_a_planted_offender_and_passes_a_clean_tree(tmp_path: Path) -> None:
    owner = tmp_path / "pkg" / "owner.py"
    owner.parent.mkdir()
    owner.write_text("import subprocess\n", encoding="utf-8")
    (tmp_path / "pkg" / "clean.py").write_text("import os\nos.getpid()\n", encoding="utf-8")
    assert _scan(tmp_path, owner) == ([], 1)
    deep = tmp_path / "pkg" / "deep" / "bad.py"
    deep.parent.mkdir()
    deep.write_text("import os\n\nos.system('x')\n", encoding="utf-8")
    assert _scan(tmp_path, owner) == (["pkg/deep/bad.py:3: os.system(...)"], 2)


def test_the_real_scan_reaches_every_package_under_src() -> None:
    found, count = _scan(SRC, OWNER)
    scanned = {path.relative_to(SRC).as_posix() for path in SRC.rglob("*.py") if path != OWNER}
    assert {
        "podcast_mcp/util/hardware.py",
        "podcast_mcp/edits/cut_safety.py",
        "podcast_mcp/engines/render_clock.py",
        "podcast_relay/app.py",
    } <= scanned
    assert "podcast_mcp/util/process.py" not in scanned
    assert count > 500
    assert found == [], "only src/podcast_mcp/util/process.py may spawn; offenders:\n" + "\n".join(
        found
    )


@pytest.mark.parametrize(
    "name", ["CalledProcessError", "SubprocessError", "CompletedProcess", "TimeoutExpired"]
)
def test_process_exports_the_subprocess_classes_themselves(name: str) -> None:
    assert getattr(process, name) is getattr(subprocess, name)
