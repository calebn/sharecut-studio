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


def test_a_level_name_that_only_contains_an_offset_word_is_still_flagged(tmp_path: Path) -> None:
    planted = tmp_path / "names.py"
    planted.write_text(
        "COVERAGE_DB = -45.0\n"  # "coverage" is not "over"
        "THRESH = -40\n"
        "BOUNDS = {'floor': -50.0, 'drop_db': -3.0}\n"
        "clamped = max(-55.0, level)\n"
        "ONSET_OVER_FLOOR_DB = -3.0\n"
        "fixed_gain_db = -60\n"  # an offset by name: reviewed, not linted
    )
    assert [(line, literal) for line, literal, _ in lint.violations(planted)] == [
        (1, "-45.0"),
        (2, "-40"),
        (3, "-50.0"),
        (4, "-55.0"),
    ]


def test_a_linear_amplitude_threshold_is_flagged_and_other_numbers_are_not(tmp_path: Path) -> None:
    planted = tmp_path / "linear.py"
    planted.write_text(
        "_SILENCE_STD = 1e-4\n"
        "def onset(path, rms_threshold: float = 0.02, min_ncc: float = 0.5, hold_sec=0.3):\n"
        "    if _rms(window) < 1e-4:\n"
        "        return None\n"
        "    loud = rms >= 0.2 * speech_rms\n"  # a multiple of a level is an offset
        "    return abs(rms_a - rms_b) >= 0.5\n"  # a difference of levels is an offset
        "ENERGY_WEIGHT = 0.65\n"
        "total_energy = float(x) or 1e-12\n"  # a numerical guard, under -120 dBFS
        "cfg = dict(min_rms=0.0001)\n"
    )
    assert [(line, literal) for line, literal, _ in lint.violations(planted)] == [
        (1, "0.0001"),
        (2, "0.02"),
        (3, "0.0001"),
        (9, "0.0001"),
    ]
