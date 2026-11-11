import json
import subprocess
from pathlib import Path

from github_yaml import load_github_yaml

ROOT = Path(__file__).parents[1]
IMAGE_ACTION = ROOT / ".github/actions/playwright-image/action.yml"


def locked_image() -> str:
    lock = json.loads((ROOT / "gui/web/package-lock.json").read_text())
    version = lock["packages"]["node_modules/@playwright/test"]["version"]
    return f"mcr.microsoft.com/playwright:v{version}-noble"


def test_image_action_names_the_image_for_the_locked_playwright_version(tmp_path: Path) -> None:
    action = load_github_yaml(IMAGE_ACTION)
    step = action["runs"]["steps"][0]
    output = tmp_path / "out"
    subprocess.run(
        ["bash", "-ec", step["run"]],
        check=True,
        cwd=ROOT,
        env={
            "PATH": "/usr/bin:/bin:/usr/local/bin",
            "LOCKFILE": "gui/web/package-lock.json",
            "GITHUB_OUTPUT": str(output),
        },
    )
    assert output.read_text() == f"image={locked_image()}\n"
    assert action["outputs"]["image"]["value"] == "${{ steps.resolve.outputs.image }}"


def test_e2e_suites_run_in_the_playwright_image_without_installing_browsers() -> None:
    workflow = load_github_yaml(ROOT / ".github/workflows/test.yml")
    jobs = workflow["jobs"]
    job = jobs["frontend-e2e-suites"]
    assert job["container"]["image"] == "${{ needs.changes.outputs.playwright-image }}"
    assert jobs["changes"]["outputs"]["playwright-image"] == "${{ steps.playwright.outputs.image }}"
    resolve = next(s for s in jobs["changes"]["steps"] if s.get("id") == "playwright")
    assert resolve["uses"] == "./.github/actions/playwright-image"
    commands = "\n".join(step.get("run", "") for step in job["steps"])
    assert "playwright install" not in commands
    assert "apt" not in commands.split()
    assert "sudo" not in commands


def test_storybook_jobs_run_in_the_playwright_image_without_installing_browsers() -> None:
    workflow = load_github_yaml(ROOT / ".github/workflows/storybook.yml")
    jobs = workflow["jobs"]
    assert jobs["image"]["outputs"]["playwright"] == "${{ steps.playwright.outputs.image }}"
    for name in ("sweep", "build"):
        job = jobs[name]
        assert job["needs"] == "image"
        assert job["container"]["image"] == "${{ needs.image.outputs.playwright }}"
        assert all("playwright install" not in step.get("run", "") for step in job["steps"])


def test_runners_are_pinned_to_one_ubuntu_release() -> None:
    for path in (ROOT / ".github/workflows").glob("*.yml"):
        assert "ubuntu-latest" not in path.read_text(), path.name
