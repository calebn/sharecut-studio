"""The detectors hold no absolute dB level (#1443, ``scripts/check_level_literals.py``)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "check_level_literals", ROOT / "scripts" / "check_level_literals.py"
)
assert _SPEC is not None and _SPEC.loader is not None
lint = importlib.util.module_from_spec(_SPEC)
sys.modules["check_level_literals"] = lint
_SPEC.loader.exec_module(lint)


def test_the_detectors_hold_no_absolute_level() -> None:
    assert lint.main([]) == 0


def test_an_absolute_level_is_flagged_and_an_offset_is_not(tmp_path: Path) -> None:
    planted = tmp_path / "detector.py"
    planted.write_text(
        "OPEN_DB = -60.0\n"
        "QUIET_OVER_FLOOR_DB = -3.0\n"
        "def gate(level, floor_db=-80):\n"
        "    return level > -50 and level[-1] < floor_db\n"
        "SILENT = rms_db(x, floor_db=-200.0)\n"
    )
    assert [(line, literal) for line, literal, _ in lint.violations(planted)] == [
        (1, "-60.0"),
        (3, "-80"),
        (4, "-50"),
        (5, "-200.0"),
    ]
