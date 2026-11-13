from __future__ import annotations

import ast
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "src" / "podcast_mcp"
TABLE = ENGINE / "util" / "host_platform.py"

BANNED = sorted(
    tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["tool"]["ruff"]["lint"][
        "flake8-tidy-imports"
    ]["banned-api"]
)

ENGINE_FILES = [
    "src/podcast_mcp/util/example.py",
    "src/podcast_mcp/services/example.py",
    "src/podcast_mcp/gui/example.py",
    "src/podcast_mcp/engines/example.py",
    "src/podcast_mcp/cli/example.py",
    "src/podcast_mcp/edits/example.py",
    "src/podcast_mcp/mcp/tools/example.py",
]


def _use(name: str) -> str:
    module, attribute = name.split(".")
    return f"import {module}\n\nVALUE = {module}.{attribute}\n"


def _banned(filename: str, source: str) -> list[str]:
    done = subprocess.run(
        [
            sys.executable,
            "-m",
            "ruff",
            "check",
            "--select",
            "TID251",
            "--output-format",
            "concise",
            "--stdin-filename",
            filename,
            "-",
        ],
        input=source,
        capture_output=True,
        text=True,
        check=False,
    )
    return [line.split(" ")[1] for line in done.stdout.splitlines() if " TID251 " in line]


def test_the_ban_list_names_every_platform_query() -> None:
    assert BANNED == [
        "os.name",
        "os.uname",
        "platform.libc_ver",
        "platform.mac_ver",
        "platform.machine",
        "platform.node",
        "platform.platform",
        "platform.processor",
        "platform.release",
        "platform.system",
        "platform.uname",
        "platform.win32_ver",
        "sys.getwindowsversion",
        "sys.platform",
        "sysconfig.get_platform",
    ]


@pytest.mark.parametrize("name", BANNED)
@pytest.mark.parametrize("filename", ENGINE_FILES)
def test_no_engine_package_may_read_the_platform(filename: str, name: str) -> None:
    assert _banned(filename, _use(name)) == ["TID251"]


@pytest.mark.parametrize("name", BANNED)
@pytest.mark.parametrize(
    "filename",
    ["src/podcast_mcp/util/host_platform.py", "tests/example.py", "scripts/example.py"],
)
def test_the_table_and_code_outside_the_engine_may(filename: str, name: str) -> None:
    assert _banned(filename, _use(name)) == []


def _computed_reads(source: str) -> list[int]:
    """Lines of ``getattr(sys, "platform")`` style reads of a banned name."""
    banned = {name.split(".")[1] for name in BANNED}
    owners = {name.split(".")[0] for name in BANNED}
    lines = []
    for node in ast.walk(ast.parse(source)):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "getattr"
            and len(node.args) >= 2
            and isinstance(node.args[0], ast.Name)
            and node.args[0].id in owners
            and isinstance(node.args[1], ast.Constant)
            and node.args[1].value in banned
        ):
            lines.append(node.lineno)
    return lines


@pytest.mark.parametrize(
    ("source", "lines"),
    [
        ('import sys\nX = getattr(sys, "platform")\n', [2]),
        ('import sys\nX = getattr(sys, "platform", "")\n', [2]),
        ('import os\nX = getattr(os, "name", None)\n', [2]),
        ('import os\nX = getattr(os, "O_BINARY", 0)\n', []),
    ],
)
def test_the_computed_read_detector_finds_the_bypass(source: str, lines: list[int]) -> None:
    assert _computed_reads(source) == lines


def test_no_engine_module_reads_the_platform_through_getattr() -> None:
    # Ruff's banned-api rule only sees attribute access, so getattr(sys, "platform") with a
    # literal name would bypass it; this is the one form that needs its own check.
    found = [
        f"{path.relative_to(ROOT)}:{line}"
        for path in sorted(ENGINE.rglob("*.py"))
        if path != TABLE
        for line in _computed_reads(path.read_text(encoding="utf-8"))
    ]
    assert found == []
