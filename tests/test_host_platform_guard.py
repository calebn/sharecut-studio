from __future__ import annotations

import subprocess
import sys

import pytest

SOURCE = "import os\nimport platform\nimport sys\n\nA = (sys.platform, platform.system(), platform.machine(), os.name)\n"


def _banned(filename: str) -> list[str]:
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
        input=SOURCE,
        capture_output=True,
        text=True,
        check=False,
    )
    return [line.split(" ")[1] for line in done.stdout.splitlines() if " TID251 " in line]


def test_the_engine_package_may_not_read_the_platform() -> None:
    assert _banned("src/podcast_mcp/util/example.py") == ["TID251"] * 4


@pytest.mark.parametrize(
    "filename",
    ["src/podcast_mcp/util/host_platform.py", "tests/example.py", "scripts/example.py"],
)
def test_the_table_and_code_outside_the_engine_may(filename: str) -> None:
    assert _banned(filename) == []
