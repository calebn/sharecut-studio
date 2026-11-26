#!/usr/bin/env python3
"""Duration-balanced shards for the main Playwright suite.

The plan lives in `gui/web/e2e/shard-plan.json`; see docs/testing-ci.md, "E2E shard plan".
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
E2E_DIR = ROOT / "gui" / "web" / "e2e"
PLAN_PATH = E2E_DIR / "shard-plan.json"
SPEC_GLOB = "**/*.spec.ts"
REPORT_NAME = re.compile(r"main-\d+of\d+\.json")


def spec_paths() -> list[str]:
    """Every spec under the e2e directory, as posix paths relative to it, sorted."""
    return sorted(path.relative_to(E2E_DIR).as_posix() for path in E2E_DIR.glob(SPEC_GLOB))


def load_plan(path: Path = PLAN_PATH) -> dict[str, Any]:
    plan: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return plan


def plan_shards(plan: Mapping[str, Any]) -> list[list[str]]:
    shards: Mapping[str, Sequence[str]] = plan["shards"]
    return [list(shards[str(i)]) for i in range(1, len(shards) + 1)]


def balance(durations: Mapping[str, float], count: int) -> list[list[str]]:
    """Greedy longest-first: each spec goes to the lightest shard, ties to the lowest index."""
    loads = [0.0] * count
    shards: list[list[str]] = [[] for _ in range(count)]
    for spec in sorted(durations, key=lambda name: (-durations[name], name)):
        lightest = loads.index(min(loads))
        shards[lightest].append(spec)
        loads[lightest] += durations[spec]
    return [sorted(shard) for shard in shards]


def shard_seconds(shards: Sequence[Sequence[str]], durations: Mapping[str, float]) -> list[float]:
    return [round(sum(durations[spec] for spec in shard), 3) for shard in shards]


def ideal_seconds(durations: Mapping[str, float], count: int) -> float:
    return sum(durations.values()) / count


def check_plan(plan: Mapping[str, Any], specs: Iterable[str]) -> list[str]:
    """Problems that make *plan* disagree with the specs on disk; empty when it is sound."""
    problems: list[str] = []
    keys = set(plan["shards"])
    if keys != {str(i) for i in range(1, len(keys) + 1)}:
        return [f"shard keys must be exactly 1..N, found: {', '.join(sorted(keys))}"]
    shards = plan_shards(plan)
    planned = [spec for shard in shards for spec in shard]
    duplicates = sorted({spec for spec in planned if planned.count(spec) > 1})
    on_disk = set(specs)
    missing = sorted(on_disk - set(planned))
    stale = sorted(set(planned) - on_disk)
    unmeasured = sorted(set(planned) - set(plan["durations"]))
    if missing:
        problems.append(f"specs missing from the plan: {', '.join(missing)}")
    if stale:
        problems.append(f"plan names specs that do not exist: {', '.join(stale)}")
    if duplicates:
        problems.append(f"specs planned in more than one shard: {', '.join(duplicates)}")
    if unmeasured:
        problems.append(f"planned specs without a duration: {', '.join(unmeasured)}")
    for number, shard in enumerate(shards, start=1):
        if not shard:
            problems.append(f"shard {number} has no specs")
        if shard != sorted(shard):
            problems.append(f"shard {number} is not in alphabetical order")
    contained = sorted(
        f"e2e/{inner} in e2e/{outer}"
        for inner in set(planned)
        for outer in set(planned)
        if inner != outer and f"e2e/{inner}" in f"e2e/{outer}"
    )
    if contained:
        problems.append(
            f"spec paths that are substrings of another (Playwright filters match substrings): "
            f"{', '.join(contained)}"
        )
    return problems


def planned_shards(
    count: int,
    plan: Mapping[str, Any] | None = None,
    specs: Sequence[str] | None = None,
) -> list[list[str]]:
    """The spec list of each of *count* shards, from the checked-in plan.

    A spec on disk but absent from the plan joins the lightest shard by planned seconds (ties
    to the lowest index) so a CI run never skips it; a planned spec that no longer exists is
    dropped. `check` is the gate: this fallback is only a safety net.
    """
    plan = load_plan() if plan is None else plan
    on_disk = set(spec_paths() if specs is None else specs)
    seen: set[str] = set()
    shards: list[list[str]] = []
    for shard in plan_shards(plan):
        kept = [spec for spec in dict.fromkeys(shard) if spec in on_disk and spec not in seen]
        seen.update(kept)
        shards.append(kept)
    if len(shards) != count:
        raise ValueError(f"shard-plan.json has {len(shards)} shards, expected {count}")
    durations: Mapping[str, float] = plan["durations"]
    fallback = float(plan["median_seconds"])
    loads = [sum(durations.get(spec, fallback) for spec in shard) for shard in shards]
    for spec in sorted(on_disk - seen):
        lightest = loads.index(min(loads))
        shards[lightest].append(spec)
        loads[lightest] += fallback
    return [sorted(shard) for shard in shards]


def _spec_importers(helper: str) -> list[str]:
    stem = re.escape(Path(helper).with_suffix("").as_posix())
    pattern = re.compile(rf"""from\s+["']\./{stem}["']""")
    return [
        spec
        for spec in spec_paths()
        if pattern.search((E2E_DIR / spec).read_text(encoding="utf-8"))
    ]


def _report_files(run: Path) -> list[Path]:
    if run.is_file():
        if not REPORT_NAME.fullmatch(run.name):
            raise ValueError(f"{run.name} is not a main-<i>of<n>.json shard report")
        return [run]
    return sorted(path for path in run.rglob("main-*.json") if REPORT_NAME.fullmatch(path.name))


def _file_seconds(report: Mapping[str, Any]) -> dict[str, float]:
    seconds: dict[str, float] = {}

    def walk(suite: Mapping[str, Any]) -> None:
        for spec in suite.get("specs", []):
            attempts = sum(
                result["duration"] for test in spec["tests"] for result in test["results"]
            )
            seconds[spec["file"]] = seconds.get(spec["file"], 0.0) + attempts / 1000
        for child in suite.get("suites", []):
            walk(child)

    for suite in report["suites"]:
        walk(suite)
    return seconds


def run_seconds(run: Path) -> dict[str, float]:
    """Seconds per spec in one run. Tests a helper module registers count for its importers."""
    files = _report_files(run)
    if not files:
        raise ValueError(f"no main-<i>of<n>.json Playwright report under {run}")
    seconds: dict[str, float] = {}
    specs = set(spec_paths())
    for path in files:
        for file, value in _file_seconds(json.loads(path.read_text(encoding="utf-8"))).items():
            owners = [file] if file in specs else _spec_importers(file)
            for owner in owners:
                seconds[owner] = seconds.get(owner, 0.0) + value / len(owners)
    return seconds


def build_plan(
    runs: Sequence[Mapping[str, float]], specs: Sequence[str], count: int
) -> dict[str, Any]:
    on_disk = set(specs)
    recorded: dict[str, float] = {}
    for spec in on_disk:
        seen = [run[spec] for run in runs if spec in run]
        if seen:
            recorded[spec] = sum(seen) / len(seen)
    median = statistics.median(recorded.values())
    durations = {spec: round(recorded.get(spec, median), 3) for spec in sorted(on_disk)}
    shards = balance(durations, count)
    return {
        "median_seconds": round(median, 3),
        "shards": {str(i): shard for i, shard in enumerate(shards, start=1)},
        "durations": durations,
    }


def render_loads(plan: Mapping[str, Any]) -> str:
    shards = plan_shards(plan)
    loads = shard_seconds(shards, plan["durations"])
    ideal = ideal_seconds(plan["durations"], len(shards))
    lines = [
        f"shard {i}: {len(shard):3d} specs {load:8.1f} s"
        for i, (shard, load) in enumerate(zip(shards, loads, strict=True), start=1)
    ]
    lines.append(
        f"max {max(loads):.1f} s, ideal {ideal:.1f} s ({max(loads) / ideal - 1:+.1%} over ideal)"
    )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check", help="fail on a plan that does not run every spec exactly once")
    commands.add_parser("show", help="print planned seconds per shard")
    build = commands.add_parser("build", help="rebalance from Playwright JSON reports")
    build.add_argument("runs", nargs="+", type=Path, help="a directory or file of reports per run")
    build.add_argument("--shards", type=int, required=True)
    args = parser.parse_args(argv)

    if args.command == "build":
        specs = spec_paths()
        plan = build_plan([run_seconds(run) for run in args.runs], specs, args.shards)
        PLAN_PATH.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
        print(render_loads(plan))
        return 0

    plan = load_plan()
    if args.command == "show":
        print(render_loads(plan))
        return 0
    problems = check_plan(plan, spec_paths())
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        print(
            "Rebuild with `python3 scripts/e2e_shards.py build --shards N RUN...`.", file=sys.stderr
        )
        return 1
    print(render_loads(plan))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
