"""The tests hold no new fixed wait (D5, #1446, ``scripts/check_test_waits.py``)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "check_test_waits", ROOT / "scripts" / "check_test_waits.py"
)
assert _SPEC is not None and _SPEC.loader is not None
lint = importlib.util.module_from_spec(_SPEC)
sys.modules["check_test_waits"] = lint
_SPEC.loader.exec_module(lint)


def test_the_tests_hold_no_wait_beyond_the_allowlist() -> None:
    assert lint.main([]) == 0


def test_python_sleeps_are_counted_and_look_alikes_are_not(tmp_path: Path) -> None:
    planted = tmp_path / "test_planted.py"
    planted.write_text(
        "import asyncio\n"
        "import asyncio as aio\n"
        "import time\n"
        "from asyncio import sleep as nap\n"
        "# time.sleep(1) in a comment\n"
        'NOTE = "asyncio.sleep(2)"\n'
        "def test_waits():\n"
        "    time.sleep(0.1)\n"
        "    nap(1)\n"
        "async def test_async():\n"
        "    await asyncio.sleep(0.2)\n"
        "    clock.sleep(3)\n"
        "    aio.sleep(4)\n"
    )
    assert lint.python_waits(planted) == [8, 9, 11, 13]


def test_typescript_wait_for_timeout_is_counted_outside_comments(tmp_path: Path) -> None:
    planted = tmp_path / "planted.spec.ts"
    planted.write_text(
        "await page.waitForTimeout(500);\n"
        "// await page.waitForTimeout(500);\n"
        "await expect(page.getByRole('button')).toBeVisible();\n"
        "await  page.waitForTimeout (50); // settle\n"
        "/* await page.waitForTimeout(1); */ await page.goto('http://x'); await page.waitForTimeout(5);\n"
    )
    assert lint.typescript_waits(planted) == [1, 4, 5]


def test_a_new_wait_fails_and_a_removed_wait_asks_for_a_lower_allowlist() -> None:
    allowed = {"tests/test_a.py": 2, "gui/web/e2e/b.spec.ts": 1}
    new_file = list(lint.problems({"tests/test_a.py": 2, "tests/test_new.py": 1}, allowed))
    assert [m.split(":")[0] for m in new_file] == ["gui/web/e2e/b.spec.ts", "tests/test_new.py"]
    assert "lower the allowlist" in new_file[0]
    assert "Wait on an event or a state" in new_file[1]
    more = list(lint.problems({"tests/test_a.py": 3, "gui/web/e2e/b.spec.ts": 1}, allowed))
    assert len(more) == 1 and more[0].startswith("tests/test_a.py: 3 fixed wait(s), 2 allowed")
    assert list(lint.problems(dict(allowed), allowed)) == []


def test_python_aliases_resolve_after_calls_and_keep_duplicate_line_numbers(tmp_path: Path) -> None:
    planted = tmp_path / "test_late_imports.py"
    planted.write_text(
        "def waits():\n"
        "    nap(1); clock.sleep(2)\n"
        "    asyncio.sleep(3)\n"
        "    nested.clock.sleep(4)\n"
        "    unrelated(5)\n"
        "from time import sleep as nap\n"
        "import time as clock\n",
        encoding="utf-8",
    )
    assert lint.python_waits(planted) == [2, 2, 3]
