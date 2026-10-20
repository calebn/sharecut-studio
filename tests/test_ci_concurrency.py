from __future__ import annotations

import json
import subprocess
from pathlib import Path

from github_yaml import load_github_yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = (
    "test",
    "desktop",
    "storybook",
    "extras-import",
    "release-wheel",
    "secret-scan",
    "registry-backup-windows",
    "relay-ci",
)


def test_workflow_groups_cancel_only_superseded_prs_and_coalesce_main() -> None:
    settings = {
        name: load_github_yaml(ROOT / ".github" / "workflows" / f"{name}.yml")["concurrency"]
        for name in WORKFLOWS
    }
    script = r"""
const settings = JSON.parse(process.argv[1]);
const format = (template, ...args) => template.replace(/\{(\d+)\}/g, (_, n) => args[n]);
const results = {};
for (const [workflow, expressions] of Object.entries(settings)) {
  results[workflow] = [];
  for (const [event_name, ref, number, run_id, run_attempt] of [
    ['pull_request', 'refs/pull/12/merge', 12, 100, 1],
    ['pull_request', 'refs/pull/12/merge', 12, 101, 1],
    ['pull_request', 'refs/pull/13/merge', 13, 102, 1],
    ['pull_request', 'refs/pull/12/merge', 12, 100, 2],
    ['push', 'refs/heads/main', null, 103, 1],
    ['push', 'refs/heads/main', null, 104, 1],
    ['schedule', 'refs/heads/main', null, 105, 1],
    ['schedule', 'refs/heads/main', null, 106, 1],
    ['workflow_dispatch', 'refs/heads/main', null, 107, 1],
    ['workflow_dispatch', 'refs/heads/main', null, 108, 1],
    ['workflow_dispatch', 'refs/heads/release', null, 109, 1],
  ]) {
    const github = {workflow: 'reusable-caller', event_name, ref, run_id, run_attempt,
      event: number === null ? {} : {pull_request: {number}}};
    const evaluate = value => typeof value === 'string'
      ? Function('github', 'format', `return (${value.slice(3, -2)});`)(github, format)
      : value;
    results[workflow].push([
      evaluate(expressions.group), evaluate(expressions['cancel-in-progress'])
    ]);
  }
}
process.stdout.write(JSON.stringify(results));
"""
    result = subprocess.run(
        ["node", "-e", script, json.dumps(settings)],
        check=True,
        capture_output=True,
        text=True,
    )
    observed = json.loads(result.stdout)
    all_groups = [set(group for group, _ in cases) for cases in observed.values()]
    for index, groups in enumerate(all_groups):
        assert all(groups.isdisjoint(other) for other in all_groups[index + 1 :])
    for workflow, cases in observed.items():
        groups = [group for group, _ in cases]
        assert groups[0] == groups[1], workflow
        assert groups[0] != groups[2], workflow
        assert groups[3] not in (groups[0], groups[2]), workflow
        assert groups[4] == groups[5], workflow
        isolated = [groups[3], *groups[6:]]
        assert len(set(isolated)) == len(isolated), workflow
        assert set(isolated).isdisjoint((groups[0], groups[2], groups[4])), workflow
        assert [cancel for _, cancel in cases] == [True, True, True, *([False] * 8)]
