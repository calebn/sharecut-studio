import json
import re
import subprocess
from pathlib import Path

from github_yaml import load_github_yaml

ROOT = Path(__file__).parents[1]
IMAGE_ACTION = ROOT / ".github/actions/playwright-image/action.yml"


def test_image_action_names_the_image_for_the_locked_playwright_version(tmp_path: Path) -> None:
    lock = json.loads((ROOT / "gui/web/package-lock.json").read_text())
    version = lock["packages"]["node_modules/@playwright/test"]["version"]
    step = load_github_yaml(IMAGE_ACTION)["runs"]["steps"][0]
    output = tmp_path / "out"
    subprocess.run(
        ["bash", "-ec", step["run"]],
        check=True,
        cwd=ROOT,
        env={"PATH": "/usr/bin:/bin:/usr/local/bin", "GITHUB_OUTPUT": str(output)},
    )
    assert output.read_text() == f"image=mcr.microsoft.com/playwright:v{version}-noble\n"


def test_playwright_packages_stay_in_lockstep() -> None:
    packages = json.loads((ROOT / "gui/web/package-lock.json").read_text())["packages"]
    versions = {
        packages[f"node_modules/{name}"]["version"]
        for name in ("@playwright/test", "playwright", "playwright-core")
    }
    assert len(versions) == 1


def test_e2e_suites_run_in_the_playwright_image_and_install_nothing_from_apt() -> None:
    workflow = load_github_yaml(ROOT / ".github/workflows/test.yml")
    job = workflow["jobs"]["frontend-e2e-suites"]
    assert job["container"] == {
        "image": "${{ needs.changes.outputs.playwright-image }}",
        "options": "--init --ipc=host",
    }
    commands = "\n".join(step.get("run", "") for step in job["steps"])
    assert not re.search(r"\b(apt|apt-get|sudo)\b", commands)


def test_storybook_jobs_run_in_the_playwright_image_without_installing_browsers() -> None:
    workflow = load_github_yaml(ROOT / ".github/workflows/storybook.yml")
    jobs = workflow["jobs"]
    assert jobs["image"]["outputs"]["playwright"] == "${{ steps.playwright.outputs.image }}"
    for name in ("sweep", "build"):
        job = jobs[name]
        assert job["needs"] == "image"
        assert job["container"]["image"] == "${{ needs.image.outputs.playwright }}"
        assert all("playwright install" not in step.get("run", "") for step in job["steps"])


def test_no_workflow_uses_ubuntu_latest() -> None:
    for path in (ROOT / ".github/workflows").glob("*.yml"):
        assert "ubuntu-latest" not in path.read_text(), path.name
