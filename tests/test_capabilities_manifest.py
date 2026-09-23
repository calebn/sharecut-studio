"""Capability manifest stays aligned with COMMANDS / keymap / MCP / skills."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]


def test_capabilities_manifest_check_passes() -> None:
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "check_capabilities_manifest.py")],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout


def test_capabilities_docs_export_check_passes() -> None:
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "export_capabilities_docs.py"), "--check"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout


def test_gui_capability_without_presence_is_an_error() -> None:
    mod = load_script("check_capabilities_manifest")
    errors = mod.presence_errors(
        {
            "id": "daw.example",
            "surfaces": {"gui": ["x"], "command": "example"},
        }
    )
    assert any("presence block" in e for e in errors)
    ok = mod.presence_errors(
        {
            "id": "daw.example",
            "surfaces": {"gui": ["x"], "command": "example"},
            "presence": {"cursor": "none", "follow": "none"},
        }
    )
    assert ok == []
