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
    "secret-scan",
    "registry-backup-windows",
    "relay-ci",
)


COALESCED_REFS = {
    "storybook": ("refs/heads/main",),
}
DEFAULT_COALESCED_REFS = ("refs/heads/main", "refs/heads/develop")


def test_workflow_groups_cancel_only_superseded_prs_and_coalesce_the_release_and_integration_branches() -> (
    None
):
    settings = {
        name: load_github_yaml(ROOT / ".github" / "workflows" / f"{name}.yml")["concurrency"]
        for name in WORKFLOWS
    }
    coalesced = {name: COALESCED_REFS.get(name, DEFAULT_COALESCED_REFS) for name in WORKFLOWS}
    script = r"""
const settings = JSON.parse(process.argv[1]);
const coalesced = JSON.parse(process.argv[2]);
const format = (template, ...args) => template.replace(/\{(\d+)\}/g, (_, n) => args[n]);
const results = {};
for (const [workflow, expressions] of Object.entries(settings)) {
  results[workflow] = [];
  for (const [event_name, ref, number, run_id, run_attempt] of [
    ['pull_request', 'refs/pull/12/merge', 12, 100, 1],
    ['pull_request', 'refs/pull/12/merge', 12, 101, 1],
    ['pull_request', 'refs/pull/13/merge', 13, 102, 1],
    ['pull_request', 'refs/pull/12/merge', 12, 100, 2],
    ['push', coalesced[workflow][0], null, 103, 1],
    ['push', coalesced[workflow][0], null, 104, 1],
    ['push', coalesced[workflow][0], null, 103, 2],
    ['push', coalesced[workflow][0], null, 104, 2],
    ['schedule', coalesced[workflow][0], null, 105, 1],
    ['schedule', coalesced[workflow][0], null, 106, 1],
    ['workflow_dispatch', coalesced[workflow][0], null, 107, 1],
    ['workflow_dispatch', coalesced[workflow][0], null, 108, 1],
    ['workflow_dispatch', 'refs/heads/promote/0123456789ab-110-1', null, 109, 1],
    ['workflow_dispatch', 'refs/heads/promote/0123456789ab-110-1', null, 111, 1],
    ['workflow_dispatch', 'refs/heads/promote/0123456789ab-110-2', null, 112, 2],
    ['push', coalesced[workflow].at(-1), null, 113, 1],
    ['push', coalesced[workflow].at(-1), null, 114, 1],
    ['push', 'refs/heads/feature/x', null, 115, 1],
    ['push', 'refs/heads/feature/x', null, 116, 1],
  ]) {
    const github = {workflow, event_name, ref, run_id, run_attempt,
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
        ["node", "-e", script, json.dumps(settings), json.dumps(coalesced)],
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
        assert groups[15] == groups[16], workflow
        assert (
            groups[4] != groups[15]
            or len(COALESCED_REFS.get(workflow, DEFAULT_COALESCED_REFS)) == 1
        )
        isolated = [groups[3], *groups[6:15], *groups[17:]]
        assert len(set(isolated)) == len(isolated), workflow
        assert set(isolated).isdisjoint((groups[0], groups[2], groups[4], groups[15])), workflow
        assert [cancel for _, cancel in cases] == [True, True, True, *([False] * 16)]
