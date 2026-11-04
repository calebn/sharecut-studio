from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from conftest import shard_of
from github_yaml import load_github_yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"
REPO_CONFTEST = ROOT / "tests" / "conftest.py"

HOOK_CONFTEST = textwrap.dedent(
    f"""
    import importlib.util
    import sys

    sys.path.insert(0, {str(REPO_CONFTEST.parent)!r})
    spec = importlib.util.spec_from_file_location("repo_conftest", {str(REPO_CONFTEST)!r})
    repo = importlib.util.module_from_spec(spec)
    sys.modules["repo_conftest"] = repo
    spec.loader.exec_module(repo)
    pytest_collection_modifyitems = repo.pytest_collection_modifyitems
    """
)


def _collect(tmp_path: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    (tmp_path / "conftest.py").write_text(HOOK_CONFTEST)
    (tmp_path / "test_six.py").write_text(
        "\n".join(f"def test_{name}(): pass" for name in "abcdef") + "\n"
    )
    clean = {key: value for key, value in os.environ.items() if not key.startswith("PYTEST_SHARD_")}
    return subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider"],
        cwd=tmp_path,
        env={**clean, **env},
        text=True,
        capture_output=True,
        check=False,
    )


def _ids(result: subprocess.CompletedProcess[str]) -> set[str]:
    return {line for line in result.stdout.splitlines() if "::" in line}


@pytest.mark.parametrize(
    ("nodeid", "count", "expected"),
    [
        ("tests/test_a.py::test_one", 4, 4),
        ("tests/test_a.py::test_one", 1, 1),
        ("tests/e2e/test_b.py::TestB::test_two[param]", 4, 2),
    ],
)
def test_shard_of_is_a_stable_one_based_hash_of_the_node_id(
    nodeid: str, count: int, expected: int
) -> None:
    assert shard_of(nodeid, count) == expected


def test_two_shards_partition_the_collected_tests(tmp_path: Path) -> None:
    whole = _ids(_collect(tmp_path, {}))
    first = _ids(_collect(tmp_path, {"PYTEST_SHARD_INDEX": "1", "PYTEST_SHARD_COUNT": "2"}))
    second = _ids(_collect(tmp_path, {"PYTEST_SHARD_INDEX": "2", "PYTEST_SHARD_COUNT": "2"}))
    assert len(whole) == 6
    assert first | second == whole
    assert not first & second
    assert first and second


@pytest.mark.parametrize(
    "env",
    [
        {"PYTEST_SHARD_INDEX": "1"},
        {"PYTEST_SHARD_COUNT": "2"},
        {"PYTEST_SHARD_INDEX": "x", "PYTEST_SHARD_COUNT": "2"},
        {"PYTEST_SHARD_INDEX": "1", "PYTEST_SHARD_COUNT": "0"},
        {"PYTEST_SHARD_INDEX": "0", "PYTEST_SHARD_COUNT": "2"},
        {"PYTEST_SHARD_INDEX": "3", "PYTEST_SHARD_COUNT": "2"},
    ],
)
def test_a_bad_shard_environment_is_a_usage_error(tmp_path: Path, env: dict[str, str]) -> None:
    result = _collect(tmp_path, env)
    assert result.returncode == 4
    assert "PYTEST_SHARD" in result.stderr


def _aggregate_verdict() -> str:
    steps = load_github_yaml(WORKFLOW)["jobs"]["pytest"]["steps"]
    return next(step["run"] for step in steps if step.get("name", "").startswith("Require"))


@pytest.mark.parametrize(
    ("plan", "scope", "quality", "shards", "accepted"),
    [
        ("success", "full", "success", "success", True),
        ("success", "web", "success", "success", True),
        ("success", "docs", "success", "success", True),
        ("success", "release", "success", "success", True),
        ("success", "full", "success", "skipped", False),
        ("success", "", "success", "success", False),
        ("success", "other", "success", "success", False),
        ("failure", "full", "success", "success", False),
        ("success", "full", "cancelled", "success", False),
        ("success", "full", "success", "failure", False),
        ("skipped", "", "skipped", "skipped", False),
    ],
)
def test_the_pytest_check_requires_the_plan_quality_and_every_shard(
    plan: str, scope: str, quality: str, shards: str, accepted: bool
) -> None:
    result = subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", _aggregate_verdict()],
        env={
            **os.environ,
            "PLAN": plan,
            "SCOPE": scope,
            "QUALITY": quality,
            "SHARDS": shards,
        },
        text=True,
        capture_output=True,
        check=False,
    )
    assert (result.returncode == 0) is accepted, result.stderr
    if not accepted:
        assert f"{plan}/{scope}/{quality}/{shards}" in result.stderr


def test_the_matrix_length_is_the_shard_count_the_hook_and_aggregate_expect() -> None:
    jobs = load_github_yaml(WORKFLOW)["jobs"]
    shard = jobs["pytest-shard"]
    assert shard["env"]["PYTEST_SHARD_COUNT"] == "${{ strategy.job-total }}"
    matrix = shard["strategy"]["matrix"]["shard"]
    (full,) = re.findall(r"== 'full' && '(\[[\d,]+\])'", matrix)
    assert json.loads(full) == [1, 2, 3, 4]
    combine = next(
        step["run"]
        for step in jobs["pytest"]["steps"]
        if step.get("name", "").startswith("Combine coverage")
    )
    assert f"-eq {len(json.loads(full))} " in combine


def test_combining_coverage_fails_unless_every_shard_file_arrived(tmp_path: Path) -> None:
    jobs = load_github_yaml(WORKFLOW)["jobs"]
    combine = next(
        step["run"]
        for step in jobs["pytest"]["steps"]
        if step.get("name", "").startswith("Combine coverage")
    )
    guard = combine.splitlines()[0]
    (tmp_path / "cov").mkdir()
    for count in range(5):
        (tmp_path / "cov" / f"shard-{count + 1}").write_text("")
        result = subprocess.run(
            ["bash", "-e", "-o", "pipefail", "-c", guard],
            cwd=tmp_path,
            text=True,
            capture_output=True,
            check=False,
        )
        assert (result.returncode == 0) is (count == 3), result.stderr
