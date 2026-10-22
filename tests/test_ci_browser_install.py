import os
import shlex
import subprocess
from pathlib import Path

import pytest

from github_yaml import load_github_yaml

ROOT = Path(__file__).parents[1]


@pytest.mark.parametrize(
    ("entries", "has_fallback"),
    [
        (
            "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n"
            "https://archive.ubuntu.com/ubuntu/\tpriority:2\n"
            "https://security.ubuntu.com/ubuntu/\tpriority:3\n",
            True,
        ),
        (
            "https://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n"
            "https://archive.ubuntu.com/ubuntu/\tpriority:2\n",
            True,
        ),
        ("https://archive.ubuntu.com/ubuntu/\tpriority:2\n", True),
        (
            "# Runner mirrors\n"
            "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n"
            "https://archive.ubuntu.com/ubuntu/\tpriority:2\n"
            "https://mirror.example/azure.archive.ubuntu.com/ubuntu/\tpriority:3\n",
            True,
        ),
        ("http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n", False),
    ],
)
def test_browser_setup_excludes_the_slow_mirror_and_preserves_fallbacks(
    entries: str, has_fallback: bool, tmp_path: Path
) -> None:
    steps = load_github_yaml(ROOT / ".github/workflows/test.yml")["jobs"]["frontend-e2e-suites"][
        "steps"
    ]
    policies = [step for step in steps if step.get("name") == "Use Ubuntu archive fallback"]
    assert len(policies) == 1, "browser setup still selects the intermittently slow Azure mirror"
    policy = policies[0]
    install = next(step for step in steps if "playwright install" in step.get("run", ""))
    assert steps.index(policy) < steps.index(install)
    assert not policy.get("if") and not policy.get("continue-on-error")
    assert "npx playwright install --with-deps ${{ matrix.browser }}" in install["run"]
    mirrors = tmp_path / "apt mirrors.txt"
    mirrors.write_text(entries)
    sudo = tmp_path / "sudo"
    sudo.write_text('#!/bin/sh\nexec "$@"\n')
    sudo.chmod(0o700)
    command = policy["run"].replace("/etc/apt/apt-mirrors.txt", shlex.quote(str(mirrors)))
    expected = "".join(
        line
        for line in entries.splitlines(keepends=True)
        if not line.startswith(
            ("http://azure.archive.ubuntu.com/ubuntu/", "https://azure.archive.ubuntu.com/ubuntu/")
        )
    )
    for _ in range(2):
        result = subprocess.run(
            ["bash", "-e", "-o", "pipefail", "-c", command],
            env={**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}"},
            capture_output=True,
            text=True,
            check=False,
        )
        assert (result.returncode == 0) == has_fallback, result.stderr
        assert mirrors.read_text() == (expected if has_fallback else entries)
