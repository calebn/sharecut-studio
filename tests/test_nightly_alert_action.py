"""The nightly-alert composite action against a scripted gh."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from github_yaml import load_github_yaml

ROOT = Path(__file__).resolve().parents[1]
ACTION = ROOT / ".github" / "actions" / "nightly-alert" / "action.yml"
LEGACY = "Nightly test run failed\nNightly desktop run failed\n"


def run_action(tmp_path: Path, results: str, legacy: str) -> list[list[str]]:
    script = next(step["run"] for step in load_github_yaml(ACTION)["runs"]["steps"])
    fake = tmp_path / "bin" / "gh"
    fake.parent.mkdir()
    fake.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "args = sys.argv[1:]\n"
        "with open(os.environ['GH_LOG'], 'a') as log:\n"
        "    log.write(json.dumps(args) + '\\n')\n"
        "if args[:2] == ['issue', 'list']:\n"
        "    search = args[args.index('--search') + 1]\n"
        "    numbers = {'Nightly promote run failed': 5, 'Nightly test run failed': 11}\n"
        "    rows = [{'number': n, 'title': t} for t, n in numbers.items() if t in search]\n"
        "    rows.append({'number': 99, 'title': search.strip('\"').removesuffix(' in:title') + ' again'})\n"
        "    if '--jq' in args:\n"
        "        print(*[r['number'] for r in rows if r['title'] in numbers][:1])\n"
        "    else:\n"
        "        print(json.dumps(rows))\n"
    )
    fake.chmod(0o755)
    log = tmp_path / "gh.log"
    env = {
        **os.environ,
        "PATH": f"{fake.parent}{os.pathsep}{os.environ['PATH']}",
        "GH_LOG": str(log),
        "GH_TOKEN": "t",
        "WORKFLOW": "promote",
        "RESULTS": results,
        "LEGACY_TITLES": legacy,
        "REPO": "o/r",
        "RUN_URL": "https://example.test/run",
        "SHA": "abc",
    }
    subprocess.run(["bash", "-c", script], check=True, env=env, capture_output=True, text=True)
    return [json.loads(line) for line in log.read_text().splitlines()]


def closed(calls: list[list[str]]) -> list[str]:
    return [call[2] for call in calls if call[:2] == ["issue", "close"]]


def test_a_green_run_closes_the_legacy_issues_it_replaces(tmp_path: Path) -> None:
    calls = run_action(tmp_path, "success", LEGACY)

    searches = [c[c.index("--search") + 1] for c in calls if c[:2] == ["issue", "list"]]
    assert '"Nightly test run failed" in:title' in searches
    assert '"Nightly desktop run failed" in:title' in searches
    assert closed(calls) == ["5", "11"]


def test_a_red_run_leaves_the_legacy_issues_open(tmp_path: Path) -> None:
    calls = run_action(tmp_path, "failure", LEGACY)

    assert closed(calls) == []
    assert any(
        call[:2] == ["issue", "create"] or call[:2] == ["issue", "comment"] for call in calls
    )


def test_no_legacy_titles_closes_only_the_own_issue(tmp_path: Path) -> None:
    calls = run_action(tmp_path, "success", "")

    assert closed(calls) == ["5"]


def test_promote_passes_the_legacy_titles() -> None:
    workflow = load_github_yaml(ROOT / ".github" / "workflows" / "promote.yml")
    step = next(
        s
        for s in workflow["jobs"]["nightly-alert"]["steps"]
        if s.get("uses") == "./.github/actions/nightly-alert"
    )
    assert step["with"]["legacy-titles"] == LEGACY
