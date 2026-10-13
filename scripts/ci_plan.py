#!/usr/bin/env python3
"""Decide which `test.yml` jobs a run needs: the one authority the workflow reads.

Usage:
  python3 scripts/ci_plan.py plan --event pull_request --base <sha> --head <sha>
  python3 scripts/ci_plan.py plan --event push          # main, nightly, dispatch: everything
  python3 scripts/ci_plan.py web-tests                  # pytest files that read gui/web

`plan` prints `key=value` lines for `$GITHUB_OUTPUT`: `gui` (run Vitest and the
browser suites), `pytest` (`full` or `web`) and `e2e-matrix` (the browser jobs).
Stdlib only, so CI runs it before installing anything.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Literal

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from docs_sync import Glob

ROOT = Path(__file__).resolve().parents[1]
PULL_REQUEST = "pull_request"
WEB = Glob.parse("gui/web/**")
# A pytest file that names gui/web reads it (source, config, generated copies).
WEB_READER_RE = re.compile(r"""gui/web|["']gui["']\s*(?:/|,)\s*["']web["']""")
MAIN_SHARDS = 4
PR_WEBKIT_SHARDS = 2


class Scope(Enum):
    """Whether a change to a path can change what the browser suites or Vitest see."""

    GUI = "gui"
    OTHER = "other"


# First match wins. A path no rule matches counts as GUI, so a new directory runs
# every browser suite until someone classifies it here.
PATH_RULES: tuple[tuple[Glob, Scope], ...] = tuple(
    (Glob.parse(pattern), scope)
    for pattern, scope in (
        ("gui/web/**", Scope.GUI),
        ("gui/desktop/**", Scope.OTHER),
        # The Python the browser talks to: routes, services, wire models, MCP
        # and extension routes, history, the `podcast gui` CLI and project I/O.
        ("src/podcast_mcp/gui/**", Scope.GUI),
        ("src/podcast_mcp/services/**", Scope.GUI),
        ("src/podcast_mcp/models/**", Scope.GUI),
        ("src/podcast_mcp/mcp/**", Scope.GUI),
        ("src/podcast_mcp/extensions/**", Scope.GUI),
        ("src/podcast_mcp/history/**", Scope.GUI),
        ("src/podcast_mcp/cli/**", Scope.GUI),
        ("src/podcast_mcp/*.py", Scope.GUI),
        # Audio and edit algorithms: pytest owns them on PRs; main and nightly
        # run them through the browser suites too.
        ("src/podcast_mcp/clips/**", Scope.OTHER),
        ("src/podcast_mcp/edits/**", Scope.OTHER),
        ("src/podcast_mcp/effects/**", Scope.OTHER),
        ("src/podcast_mcp/engines/**", Scope.OTHER),
        ("src/podcast_mcp/export/**", Scope.OTHER),
        ("src/podcast_mcp/ingest/**", Scope.OTHER),
        ("src/podcast_mcp/pipeline/**", Scope.OTHER),
        ("src/podcast_mcp/util/**", Scope.OTHER),
        # The hosted relay; relay-ci.yml smoke-tests it and no browser suite runs it.
        ("src/podcast_relay/**", Scope.OTHER),
        ("contracts/**", Scope.GUI),
        ("schemas/**", Scope.GUI),
        ("deploy/brand/**", Scope.GUI),
        ("deploy/**", Scope.OTHER),
        # The projects the browser suites open.
        ("tests/fixtures/aligned_dialogue/**", Scope.GUI),
        ("tests/fixtures/sharecut_ux_demo/**", Scope.GUI),
        ("tests/**", Scope.OTHER),
        # This planner (and the glob it borrows), then scripts gui/web or the
        # frontend job runs.
        ("scripts/ci_plan.py", Scope.GUI),
        ("scripts/docs_sync.py", Scope.GUI),
        ("scripts/export_timeline_zoom.py", Scope.GUI),
        ("scripts/build_large_project_fixture.py", Scope.GUI),
        ("scripts/ux_demo_prepare_shares.py", Scope.GUI),
        ("scripts/**", Scope.OTHER),
        # `npm run cheatsheet:check` in the frontend job regenerates these.
        ("docs/daw-shortcuts.md", Scope.GUI),
        ("ux/pages/shortcuts.md", Scope.GUI),
        ("docs/**", Scope.OTHER),
        ("docs-site/**", Scope.OTHER),
        ("ux/**", Scope.OTHER),
        ("examples/**", Scope.OTHER),
        ("config/**", Scope.OTHER),
        (".github/workflows/test.yml", Scope.GUI),
        (".github/actions/**", Scope.GUI),
        (".github/**", Scope.OTHER),
        ("pyproject.toml", Scope.GUI),
        ("uv.lock", Scope.GUI),
        (".nvmrc", Scope.GUI),
        (".agents/**", Scope.OTHER),
        (".claude/**", Scope.OTHER),
        (".codex/**", Scope.OTHER),
        (".githooks/**", Scope.OTHER),
        (".impeccable/**", Scope.OTHER),
        (".editorconfig", Scope.OTHER),
        (".gitignore", Scope.OTHER),
        (".gitleaks.toml", Scope.OTHER),
        (".pre-commit-config.yaml", Scope.OTHER),
        ("AGENTS.md", Scope.OTHER),
        ("LICENSE", Scope.OTHER),
        ("Makefile", Scope.OTHER),
        ("README.md", Scope.OTHER),
        ("ROADMAP.md", Scope.OTHER),
        ("hatch_build.py", Scope.OTHER),
        ("install.sh", Scope.OTHER),
        ("lint-staged.config.mjs", Scope.OTHER),
    )
)


def rule_for(path: str) -> tuple[Glob, Scope] | None:
    """The first rule matching *path*, or None when no rule names it."""
    return next((rule for rule in PATH_RULES if rule[0].matches(path)), None)


def scope_of(path: str) -> Scope:
    rule = rule_for(path)
    return rule[1] if rule else Scope.GUI


@dataclass(frozen=True)
class E2eJob:
    name: str
    command: str
    browser: Literal["chromium", "webkit"]


def main_shards() -> list[E2eJob]:
    return [
        E2eJob(
            f"main-{i}of{MAIN_SHARDS}",
            f"npm run test:e2e -- --shard={i}/{MAIN_SHARDS}",
            "chromium",
        )
        for i in range(1, MAIN_SHARDS + 1)
    ]


def full_compat() -> list[E2eJob]:
    return [
        E2eJob(f"compat-{engine}", f"npm run test:e2e:compat -- --project={engine}", engine)
        for engine in ("chromium", "webkit")
    ]


def pr_compat() -> list[E2eJob]:
    """Every WebKit compat spec, split so PR wall time tracks the main shards."""
    return [
        E2eJob(
            f"compat-webkit-{i}of{PR_WEBKIT_SHARDS}",
            f"npm run test:e2e:compat -- --project=webkit --shard={i}/{PR_WEBKIT_SHARDS}",
            "webkit",
        )
        for i in range(1, PR_WEBKIT_SHARDS + 1)
    ]


@dataclass(frozen=True)
class CiPlan:
    gui: bool
    pytest: Literal["full", "web"]
    e2e: tuple[E2eJob, ...]

    def outputs(self) -> dict[str, str]:
        matrix = {"include": [vars(job) for job in self.e2e]}
        return {
            "gui": "true" if self.gui else "false",
            "pytest": self.pytest,
            "e2e-matrix": json.dumps(matrix, separators=(",", ":")),
        }


def plan(event: str, changed: Sequence[str]) -> CiPlan:
    """Pull requests run what their diff can reach; every other event runs everything."""
    if event != PULL_REQUEST:
        return CiPlan(gui=True, pytest="full", e2e=(*main_shards(), *full_compat()))
    gui = not changed or any(scope_of(path) is Scope.GUI for path in changed)
    web_only = bool(changed) and all(WEB.matches(path) for path in changed)
    return CiPlan(
        gui=gui,
        pytest="web" if web_only else "full",
        e2e=(*main_shards(), *pr_compat()) if gui else (),
    )


def web_tests(root: Path = ROOT) -> list[str]:
    """Repo-relative pytest files whose source names gui/web, sorted."""
    return sorted(
        path.relative_to(root).as_posix()
        for path in (root / "tests").rglob("test_*.py")
        if WEB_READER_RE.search(path.read_text(encoding="utf-8"))
    )


def changed_files(base: str, head: str, root: Path = ROOT) -> list[str]:
    """Paths changed on *head* since its merge base with *base*."""
    out = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", f"{base}...{head}"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [line for line in out.splitlines() if line]


def _print_lines(lines: Iterable[str]) -> None:
    for line in lines:
        print(line)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    plan_cmd = sub.add_parser("plan")
    plan_cmd.add_argument("--event", required=True)
    plan_cmd.add_argument("--base")
    plan_cmd.add_argument("--head")
    sub.add_parser("web-tests")
    args = parser.parse_args(argv)

    if args.command == "web-tests":
        _print_lines(web_tests())
        return 0
    changed: list[str] = []
    if args.event == PULL_REQUEST:
        if not (args.base and args.head):
            parser.error("pull_request needs --base and --head")
        changed = changed_files(args.base, args.head)
    result = plan(args.event, changed)
    _print_lines(f"{key}={value}" for key, value in result.outputs().items())
    print(
        f"{len(changed)} changed files; gui={result.gui} pytest={result.pytest} "
        f"e2e={[job.name for job in result.e2e]}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
