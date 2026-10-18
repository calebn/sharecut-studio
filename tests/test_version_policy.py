from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "version_policy.py"
_spec = importlib.util.spec_from_file_location("version_policy", SCRIPT)
assert _spec and _spec.loader
policy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(policy)


def test_repo_versions_agree_and_stay_below_one() -> None:
    assert policy.problems(policy.versions()) == []


def test_drifting_location_is_reported() -> None:
    found = {"a": "0.2.0", "b": "0.2.1"}
    assert "versions disagree" in policy.problems(found)[0]


@pytest.mark.parametrize("version", ["1.0.0", "2.3.4"])
def test_major_one_is_refused(version: str) -> None:
    errors = policy.problems({"a": version})
    assert errors and "0.x cap" in errors[0]


@pytest.mark.parametrize("version", ["0.2.0-beta.1", "0.2", "v0.2.0"])
def test_suffixed_versions_are_refused(version: str) -> None:
    errors = policy.problems({"a": version})
    assert errors and "plain MAJOR.MINOR.PATCH" in errors[0]


def test_release_config_keeps_pre_major_bumps_below_one() -> None:
    config = json.loads((SCRIPT.parents[1] / "release-please-config.json").read_text())
    root = config["packages"]["."]
    assert root["bump-minor-pre-major"] is True
    assert root["bump-patch-for-minor-pre-major"] is True
