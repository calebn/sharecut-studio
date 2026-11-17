from __future__ import annotations

import ast
import subprocess
from pathlib import Path

import pytest

from podcast_mcp.util import process

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "src" / "podcast_mcp"
OWNER = ENGINE / "util" / "process.py"

SPAWNERS = ("system", "popen", "exec", "spawn", "posix_spawn")


def _is_spawner(name: str) -> bool:
    return name.startswith(SPAWNERS)


def _offences(source: str) -> list[tuple[int, str]]:
    """Line and text of each subprocess import and each os spawn call."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found += [
                (node.lineno, f"import {alias.name}")
                for alias in node.names
                if alias.name.split(".")[0] == "subprocess"
            ]
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and (node.module or "").split(".")[0] == "subprocess":
                found.append((node.lineno, f"from {node.module} import ..."))
            elif node.level == 0 and node.module == "os":
                found += [
                    (node.lineno, f"from os import {alias.name}")
                    for alias in node.names
                    if _is_spawner(alias.name)
                ]
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "os"
            and _is_spawner(node.func.attr)
        ):
            found.append((node.lineno, f"os.{node.func.attr}(...)"))
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
    ],
)
def test_the_detector_finds_every_way_to_spawn(
    source: str, expected: list[tuple[int, str]]
) -> None:
    assert _offences(source) == expected


def test_only_util_process_may_import_subprocess_or_spawn() -> None:
    found = [
        f"{path.relative_to(ROOT)}:{line}: {what}"
        for path in sorted(ENGINE.rglob("*.py"))
        if path != OWNER
        for line, what in _offences(path.read_text(encoding="utf-8"))
    ]
    assert found == [], "only src/podcast_mcp/util/process.py may spawn; offenders:\n" + "\n".join(
        found
    )


@pytest.mark.parametrize(
    "name", ["CalledProcessError", "SubprocessError", "CompletedProcess", "TimeoutExpired"]
)
def test_process_exports_the_subprocess_classes_themselves(name: str) -> None:
    assert getattr(process, name) is getattr(subprocess, name)
