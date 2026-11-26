"""scripts/e2e_shards.py: the checked-in duration-balanced plan for the main Playwright shards."""

from __future__ import annotations

import copy
import json
import shutil
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

from script_loader import load_script

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "gui" / "web"
PLAYWRIGHT = WEB / "node_modules" / ".bin" / "playwright"
MAX_OVER_IDEAL = 0.15

es = load_script("e2e_shards", register=True)
cp = load_script("ci_plan", register=True)


@pytest.fixture(scope="module")
def plan() -> dict[str, Any]:
    return es.load_plan()


def test_plan_names_every_e2e_spec_exactly_once(plan: dict[str, Any]) -> None:
    assert es.check_plan(plan, es.spec_paths()) == []


def test_check_command_passes_on_the_committed_plan() -> None:
    assert es.main(["check"]) == 0


def test_plan_has_one_shard_per_main_job(plan: dict[str, Any]) -> None:
    assert len(es.plan_shards(plan)) == cp.MAIN_SHARDS


def test_plan_is_what_the_recorded_durations_balance_to(plan: dict[str, Any]) -> None:
    assert es.plan_shards(plan) == es.balance(plan["durations"], cp.MAIN_SHARDS)


def test_slowest_planned_shard_is_within_15_percent_of_the_ideal(plan: dict[str, Any]) -> None:
    loads = es.shard_seconds(es.plan_shards(plan), plan["durations"])
    ideal = es.ideal_seconds(plan["durations"], len(loads))
    assert max(loads) <= ideal * (1 + MAX_OVER_IDEAL), (loads, ideal)


def test_largest_spec_is_the_only_bound_the_plan_cannot_beat(plan: dict[str, Any]) -> None:
    assert max(plan["durations"].values()) < es.ideal_seconds(plan["durations"], cp.MAIN_SHARDS)


def test_check_reports_missing_stale_and_duplicate_specs(plan: dict[str, Any]) -> None:
    specs = es.spec_paths()
    broken = copy.deepcopy(plan)
    dropped = broken["shards"]["1"].pop()
    broken["shards"]["2"].append("ghost.spec.ts")
    duplicated = broken["shards"]["3"][0]
    broken["shards"]["4"].append(duplicated)
    problems = "\n".join(es.check_plan(broken, specs))
    assert dropped in problems
    assert "ghost.spec.ts" in problems
    assert duplicated in problems
    assert "missing" in problems
    assert "do not exist" in problems
    assert "more than one shard" in problems


def test_planner_matches_the_plan_when_nothing_changed(plan: dict[str, Any]) -> None:
    assert es.planned_shards(cp.MAIN_SHARDS, plan, es.spec_paths()) == es.plan_shards(plan)


def test_planner_puts_an_unplanned_spec_in_the_lightest_shard_ties_to_lowest_index() -> None:
    plan = {
        "median_seconds": 5.0,
        "durations": {"a.spec.ts": 30.0, "b.spec.ts": 10.0, "c.spec.ts": 10.0},
        "shards": {"1": ["a.spec.ts"], "2": ["b.spec.ts"], "3": ["c.spec.ts"]},
    }
    specs = ["a.spec.ts", "b.spec.ts", "c.spec.ts", "new.spec.ts", "newer.spec.ts"]
    assert es.planned_shards(3, plan, specs) == [
        ["a.spec.ts"],
        ["b.spec.ts", "new.spec.ts"],
        ["c.spec.ts", "newer.spec.ts"],
    ]


def test_planner_drops_a_planned_spec_that_no_longer_exists(plan: dict[str, Any]) -> None:
    specs = [spec for spec in es.spec_paths() if spec != "home-states.spec.ts"]
    shards = es.planned_shards(cp.MAIN_SHARDS, plan, specs)
    assert Counter(spec for shard in shards for spec in shard) == Counter(specs)


def test_planner_refuses_a_plan_for_another_shard_count(plan: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="expected 4"):
        es.planned_shards(4, plan, es.spec_paths())


def test_ci_plan_commands_list_every_spec_once_with_anchored_paths(plan: dict[str, Any]) -> None:
    prefix = "npm run test:e2e -- "
    commands = [job.command for job in cp.main_shards()]
    assert all(command.startswith(prefix) for command in commands)
    listed = [arg for command in commands for arg in command.removeprefix(prefix).split()]
    assert all(arg.startswith("e2e/") and arg.endswith(".spec.ts") for arg in listed)
    assert sorted(arg.removeprefix("e2e/") for arg in listed) == es.spec_paths()
    assert max(map(len, commands)) < 4000


def test_build_averages_runs_and_gives_unrecorded_specs_the_median() -> None:
    specs = ["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts"]
    runs = [{"a.spec.ts": 10.0, "b.spec.ts": 20.0}, {"a.spec.ts": 30.0, "gone.spec.ts": 99.0}]
    built = es.build_plan(runs, specs, 2)
    assert built["durations"] == {
        "a.spec.ts": 20.0,
        "b.spec.ts": 20.0,
        "c.spec.ts": 20.0,
        "d.spec.ts": 20.0,
    }
    assert built["estimated"] == ["c.spec.ts", "d.spec.ts"]
    assert es.check_plan(built, specs) == []


def _listed_tests(config: Path, filters: list[str]) -> Counter[tuple[str, int, str]]:
    result = subprocess.run(
        [str(PLAYWRIGHT), "test", f"--config={config}", "--list", "--reporter=json", *filters],
        cwd=WEB,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    report = json.loads(result.stdout)
    assert report["errors"] == [], report["errors"]
    tests: Counter[tuple[str, int, str]] = Counter()

    def walk(suite: dict[str, Any]) -> None:
        for spec in suite.get("specs", []):
            tests[(spec["file"], spec["line"], spec["title"])] += len(spec["tests"])
        for child in suite.get("suites", []):
            walk(child)

    for suite in report["suites"]:
        walk(suite)
    return tests


@pytest.mark.skipif(
    shutil.which("node") is None or not PLAYWRIGHT.exists(),
    reason="needs node and gui/web/node_modules (run `npm ci` in gui/web); `playwright test --list` runs offline without browsers",
)
def test_listing_each_shard_unions_to_the_full_playwright_list(tmp_path: Path) -> None:
    config = tmp_path / "list.config.mjs"
    config.write_text(
        f"export default {{ testDir: {json.dumps(str(WEB / 'e2e'))}, testMatch: '**/*.spec.ts' }};\n",
        encoding="utf-8",
    )
    full = _listed_tests(config, [])
    assert full
    union: Counter[tuple[str, int, str]] = Counter()
    for job in cp.main_shards():
        filters = job.command.removeprefix("npm run test:e2e -- ").split()
        listed = _listed_tests(config, filters)
        assert listed, f"{job.name} lists no tests"
        union.update(listed)
    assert union == full
