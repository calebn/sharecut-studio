"""The deploy-config CI job runs real caddy and Compose validation over everything in deploy/."""

from __future__ import annotations

import os
import re
from pathlib import Path

from github_yaml import load_github_yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "deploy-config.yml"
SCRIPT = ROOT / "scripts" / "check_deploy_config.sh"


def test_workflow_is_path_filtered_to_deploy_and_runs_the_script() -> None:
    data = load_github_yaml(WORKFLOW)
    expected = [
        "deploy/**",
        "scripts/check_deploy_config.sh",
        ".github/workflows/deploy-config.yml",
    ]
    assert data["on"]["pull_request"]["paths"] == expected
    assert data["on"]["push"]["paths"] == expected
    assert data["permissions"] == {"contents": "read"}
    runs = [step.get("run") for step in data["jobs"]["validate"]["steps"]]
    assert "./scripts/check_deploy_config.sh" in runs


def test_script_pins_the_caddy_image_by_digest() -> None:
    text = SCRIPT.read_text(encoding="utf-8")
    pins = re.findall(r'^CADDY_IMAGE="(caddy@sha256:[0-9a-f]{64})"$', text, flags=re.MULTILINE)
    assert len(pins) == 1
    assert os.access(SCRIPT, os.X_OK)


def test_script_discovers_every_caddyfile_and_compose_file_under_deploy() -> None:
    text = SCRIPT.read_text(encoding="utf-8")
    assert "find deploy -type f -name 'Caddyfile*'" in text
    assert "find deploy -type f -name 'docker-compose*.yml'" in text
    assert list((ROOT / "deploy").rglob("Caddyfile*"))
    assert list((ROOT / "deploy").rglob("docker-compose*.yml"))
