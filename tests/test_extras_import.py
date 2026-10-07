"""Every optional extra installs and imports in a clean, unlocked environment (#1168).

`uv.lock` pins one resolution, so a locked `uv sync` can pass while a user's
`pip install "podcast-mcp[extra]"` resolves newer transitive releases and breaks.
The slow test builds a fresh venv per extra, installs the project with that extra
ignoring the lock, and imports the modules the code reaches for. It is opt-in
(`PODCAST_CHECK_EXTRAS=1`) because it downloads wheels; `extras-import.yml` runs it.

The fast test keeps `EXTRA_IMPORTS` in step with `[project.optional-dependencies]`,
so a new extra cannot ship without a clean-install check.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

from github_yaml import load_github_yaml

ROOT = Path(__file__).resolve().parents[1]

# Modules each extra must make importable, matching how src/ imports them.
EXTRA_IMPORTS: dict[str, tuple[str, ...]] = {
    "dev": (
        "pytest",
        "pytest_cov",
        "pytest_asyncio",
        "xdist",
        "pytest_timeout",
        "mypy",
        "bandit",
        "vulture",
        "deptry",
        "pre_commit",
        "hatchling",
        "editables",
    ),
    "speaker": ("torch", "speechbrain.inference.speaker"),
    "speaker-lite": ("resemblyzer",),
    "joinqc": ("torch", "librosa", "transformers"),
    "bootstrap": ("static_ffmpeg",),
    "gui": (
        "anyio",
        "fastapi",
        "uvicorn",
        "httpx",
        "websockets",
        "boto3",
        "botocore",
        "starlette",
        "podcast_mcp.gui.server",
    ),
    "object-store": ("boto3", "botocore.client"),
    "relay": ("fastapi", "uvicorn", "websockets", "starlette", "podcast_relay"),
    "prosody": ("parselmouth.praat",),
}
ALL_EXTRA = "all"


def _declared_extras() -> set[str]:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return set(data["project"]["optional-dependencies"])


def _imports_for(extra: str) -> tuple[str, ...]:
    if extra == ALL_EXTRA:
        runtime = (mods for name, mods in EXTRA_IMPORTS.items() if name != "dev")
        return tuple(dict.fromkeys(mod for mods in runtime for mod in mods))
    return EXTRA_IMPORTS[extra]


def test_every_declared_extra_has_an_import_check() -> None:
    assert _declared_extras() == {*EXTRA_IMPORTS, ALL_EXTRA}


def _run(cmd: list[str], *, timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)


@pytest.mark.extras_install
@pytest.mark.skipif(
    not os.environ.get("PODCAST_CHECK_EXTRAS"),
    reason="downloads wheels; set PODCAST_CHECK_EXTRAS=1 (extras-import workflow)",
)
@pytest.mark.skipif(shutil.which("uv") is None, reason="needs uv to build a clean venv")
@pytest.mark.parametrize("extra", sorted((*EXTRA_IMPORTS, ALL_EXTRA)))
def test_extra_imports_in_clean_venv(extra: str, tmp_path: Path) -> None:
    venv = tmp_path / "venv"
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    created = _run(["uv", "venv", str(venv), "--python", sys.executable], timeout=120)
    assert created.returncode == 0, created.stderr

    # Unlocked on purpose: a user's `pip install` ignores uv.lock. CPU torch keeps the
    # speaker/joinqc/all downloads small on Linux.
    installed = _run(
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(python),
            "--torch-backend",
            "cpu",
            f"{ROOT}[{extra}]",
        ],
        timeout=1500,
    )
    assert installed.returncode == 0, installed.stderr[-4000:]

    imports = ", ".join(_imports_for(extra))
    # Run from tmp_path so the checkout's src/ cannot shadow the installed package.
    probe = subprocess.run(
        [str(python), "-c", f"import {imports}"],
        capture_output=True,
        text=True,
        timeout=300,
        cwd=tmp_path,
        check=False,
    )
    assert probe.returncode == 0, f"extra [{extra}] failed to import:\n{probe.stderr[-4000:]}"


def test_extras_workflow_runs_the_clean_venv_check() -> None:
    workflow = load_github_yaml(ROOT / ".github" / "workflows" / "extras-import.yml")
    steps = workflow["jobs"]["extras"]["steps"]
    run = next(s for s in steps if "extras_install" in s.get("run", ""))
    assert run["env"]["PODCAST_CHECK_EXTRAS"] == "1"
    assert "tests/test_extras_import.py" in run["run"]
    assert "schedule" in workflow["on"]
