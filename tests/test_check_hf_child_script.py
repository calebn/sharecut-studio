"""scripts/check_hf_child.py keeps exit 2 for "inconclusive"; usage errors exit 64 (#1998)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_hf_child.py"


@pytest.mark.parametrize("args", [["--bogus"], ["--python"], ["extra"]])
def test_a_usage_error_exits_64_not_the_inconclusive_code(args: list[str]) -> None:
    done = subprocess.run(
        [sys.executable, str(SCRIPT), *args], capture_output=True, text=True, timeout=60
    )

    assert done.returncode == 64
    assert "usage:" in done.stderr


def test_help_exits_zero() -> None:
    done = subprocess.run(
        [sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True, timeout=60
    )

    assert done.returncode == 0
