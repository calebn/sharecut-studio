#!/usr/bin/env python3
"""Duration-balanced shards for the main Playwright suite.

Usage:
  python3 scripts/e2e_shards.py check            # the plan names every e2e spec exactly once
  python3 scripts/e2e_shards.py show             # planned seconds per shard against the ideal
  python3 scripts/e2e_shards.py build RUN...     # rewrite gui/web/e2e/shard-plan.json

`gui/web/e2e/shard-plan.json` maps each shard to its spec paths (relative to `gui/web/e2e/`,
alphabetical) and keeps the per-spec seconds the plan was balanced on, so checking it needs
no network. `scripts/ci_plan.py` reads it through `planned_shards`.

To regenerate after specs change or get slower, download the JSON reports of one or more
recent successful `test.yml` runs that ran the main shards (a `workflow_dispatch` or
promotion run) and rebuild from them:

  gh run download <run-id> --repo calebn/sharecut-studio \\
      --pattern 'playwright-reports-main-*' --dir /tmp/e2e-reports/<run-id>
  python3 scripts/e2e_shards.py build /tmp/e2e-reports/<run-id> [/tmp/e2e-reports/<other-run-id> ...]

Each RUN is a directory (searched recursively for `main-*.json`) or one report file. Seconds
per spec are summed over a run's reports, retries included, then averaged over the runs that
contain the spec. A spec in no report gets the median recorded duration. Stdlib only.
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
PLAN_SHARDS = 6


def spec_paths(e2e_dir: Path = E2E_DIR) -> list[str]:
    """Every spec under *e2e_dir*, as posix paths relative to it, sorted."""
    return sorted(path.relative_to(e2e_dir).as_posix() for path in e2e_dir.glob(SPEC_GLOB))


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
        if shard != sorted(shard):
            problems.append(f"shard {number} is not in alphabetical order")
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
    shards = [[spec for spec in shard if spec in on_disk] for shard in plan_shards(plan)]
    if len(shards) != count:
        raise ValueError(f"shard-plan.json has {len(shards)} shards, expected {count}")
    durations: Mapping[str, float] = plan["durations"]
    fallback = float(plan["median_seconds"])
    loads = [sum(durations.get(spec, fallback) for spec in shard) for shard in shards]
    planned = {spec for shard in shards for spec in shard}
    for spec in sorted(on_disk - planned):
        lightest = loads.index(min(loads))
        shards[lightest].append(spec)
        loads[lightest] += fallback
    return [sorted(shard) for shard in shards]


def _spec_importers(e2e_dir: Path, helper: str) -> list[str]:
    stem = re.escape(Path(helper).with_suffix("").as_posix())
    pattern = re.compile(rf"""from\s+["']\./{stem}["']""")
    return [
        spec
        for spec in spec_paths(e2e_dir)
        if pattern.search((e2e_dir / spec).read_text(encoding="utf-8"))
    ]


def _report_files(run: Path) -> list[Path]:
    return [run] if run.is_file() else sorted(run.rglob("main-*.json"))


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


def run_seconds(run: Path, e2e_dir: Path = E2E_DIR) -> dict[str, float]:
    """Seconds per spec in one run. Tests a helper module registers count for its importers."""
    files = _report_files(run)
    if not files:
        raise ValueError(f"no main-*.json Playwright report under {run}")
    seconds: dict[str, float] = {}
    specs = set(spec_paths(e2e_dir))
    for path in files:
        for file, value in _file_seconds(json.loads(path.read_text(encoding="utf-8"))).items():
            owners = [file] if file in specs else _spec_importers(e2e_dir, file)
            for owner in owners:
                seconds[owner] = seconds.get(owner, 0.0) + value / len(owners)
    return seconds


def build_plan(
    runs: Sequence[Mapping[str, float]], specs: Sequence[str], count: int = PLAN_SHARDS
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
        "estimated": sorted(on_disk - set(recorded)),
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
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check", help="fail on missing, stale or duplicate specs")
    commands.add_parser("show", help="print planned seconds per shard")
    build = commands.add_parser("build", help="rebalance from Playwright JSON reports")
    build.add_argument("runs", nargs="+", type=Path, help="a directory or file of reports per run")
    build.add_argument("--shards", type=int, default=PLAN_SHARDS)
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
        print("Rebuild with `python3 scripts/e2e_shards.py build RUN...`.", file=sys.stderr)
        return 1
    print(render_loads(plan))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
