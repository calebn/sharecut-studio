from pathlib import Path

from github_yaml import load_github_yaml

ROOT = Path(__file__).parents[1]


def test_browser_setup_installs_locked_dependencies_with_bounded_transport() -> None:
    workflow = load_github_yaml(ROOT / ".github/workflows/test.yml")
    job = workflow["jobs"]["frontend-e2e-suites"]
    steps = job["steps"]
    policies = [
        step for step in steps if step.get("name") == "Configure bounded Ubuntu acquisition"
    ]
    assert len(policies) == 1
    policy = policies[0]
    install = next(step for step in steps if "playwright install" in step.get("run", ""))
    assert steps.index(policy) < steps.index(install)
    assert policy["run"] == "sudo /usr/bin/python3 scripts/ci_apt_method.py configure"
    assert not policy.get("if") and not policy.get("continue-on-error")
    assert "npm ci" in install["run"]
    assert "npx playwright install --with-deps ${{ matrix.browser }}" in install["run"]
    assert install["timeout-minutes"] == 10
    assert job["timeout-minutes"] == 60
