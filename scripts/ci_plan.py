#!/usr/bin/env python3
"""Decide which `test.yml` jobs a run needs: the one authority the workflow reads.

Usage:
  python3 scripts/ci_plan.py plan --event pull_request --base <sha> --head <sha>
  python3 scripts/ci_plan.py plan --event push          # main, nightly, dispatch: everything
  python3 scripts/ci_plan.py subset-tests web|docs      # pytest files that read that scope
  python3 scripts/ci_plan.py required-checks [--check]   # the required-checks table in the docs

`plan` prints `key=value` lines for `$GITHUB_OUTPUT`: `gui` (run Vitest and the
browser suites), `pytest` (`full`, `web`, `docs` or `release`), `release-only`
(digit `1` proves a release update), `e2e-matrix` (the browser jobs), and seven
`skip-native-*` proofs from `ci_native` (digit `1` skips a native family; `0` runs it).
`REQUIRED_CHECKS` is the one list of required status contexts: `required-checks` renders
it into docs/testing.md and docs/contributing.md, the merge gate reads it, and
`tests/test_ci_plan.py` diffs it against `make ci-body` and the workflows.
Stdlib only, so CI runs it before installing anything.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
import sys
import tomllib
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Literal

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from ci_native import NativeSelection, select_native
from path_vocab import Glob
from version_policy import problems

ROOT = Path(__file__).resolve().parents[1]
PULL_REQUEST = "pull_request"
# A pytest file that names gui/web reads it (source, config, generated copies).
WEB_READER_RE = re.compile(r"""gui/web|["']gui["']\s*(?:/|,)\s*["']web["']""")
# A pytest file that names a docs path reads it, in "docs/x.md" or "docs" / "x.md" form.
DOCS_READER_RE = re.compile(
    r"""(?<![\w.-])(?:docs|ux|docs-site)/"""
    r"""|(?<![\w/.-])(?:README|ROADMAP|AGENTS)\.md"""
    r"""|\.agents/skills"""
    r"""|["'](?:docs|ux|docs-site)["']\s*[/,]"""
    r"""|/\s*["'](?:docs|ux|docs-site)["']"""
    r"""|["']\.agents["']"""
)
SCRIPT_REF_RES = (
    re.compile(r"""load_script\(\s*["'](\w+)["']"""),
    re.compile(r"""scripts/(\w+)\.py"""),
    re.compile(r"""["']scripts["']\s*/\s*["'](\w+)\.py["']"""),
    re.compile(r"""^\s*(?:from|import)\s+(\w+)""", re.MULTILINE),
)
MAIN_SHARDS = 4
PR_WEBKIT_SHARDS = 2


@dataclass(frozen=True)
class Subset:
    """A pull request whose every path matches *owns* needs only the pytest files reading them."""

    owns: tuple[Glob, ...]
    reader: re.Pattern[str]

    def covers(self, changed: Sequence[str]) -> bool:
        return bool(changed) and all(any(g.matches(path) for g in self.owns) for path in changed)


SubsetName = Literal["web", "docs"]
SUBSETS: dict[SubsetName, Subset] = {
    "web": Subset((Glob.parse("gui/web/**"),), WEB_READER_RE),
    "docs": Subset(
        tuple(
            Glob.parse(pattern)
            for pattern in (
                "docs/**",
                "docs-site/**",
                "ux/**",
                ".agents/skills/**",
                "README.md",
                "ROADMAP.md",
                "AGENTS.md",
            )
        ),
        DOCS_READER_RE,
    ),
}


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
        # and extension routes, project I/O and history, the `podcast gui` CLI.
        ("src/podcast_mcp/gui/**", Scope.GUI),
        ("src/podcast_mcp/services/**", Scope.GUI),
        ("src/podcast_mcp/models/**", Scope.GUI),
        ("src/podcast_mcp/mcp/**", Scope.GUI),
        ("src/podcast_mcp/extensions/**", Scope.GUI),
        ("src/podcast_mcp/project/**", Scope.GUI),
        ("src/podcast_mcp/config/**", Scope.GUI),
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
        ("contracts/test-wait-allowlist.json", Scope.OTHER),
        ("contracts/**", Scope.GUI),
        ("schemas/**", Scope.GUI),
        ("deploy/brand/**", Scope.GUI),
        ("deploy/**", Scope.OTHER),
        # The projects the browser suites open.
        ("tests/fixtures/aligned_dialogue/**", Scope.GUI),
        ("tests/fixtures/sharecut_ux_demo/**", Scope.GUI),
        ("tests/fixtures/document_delta/**", Scope.GUI),
        ("tests/fixtures/gain_curve/**", Scope.GUI),
        ("tests/**", Scope.OTHER),
        # This planner (and the glob it borrows), then scripts gui/web or the
        # frontend job runs.
        ("scripts/ci_plan.py", Scope.GUI),
        ("scripts/docs_sync.py", Scope.GUI),
        ("scripts/path_vocab.py", Scope.GUI),
        ("scripts/export_capabilities_copy.py", Scope.GUI),
        ("scripts/export_timeline_zoom.py", Scope.GUI),
        ("scripts/export_limit_contracts.py", Scope.GUI),
        ("scripts/build_brand_assets.py", Scope.GUI),
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
        ("config/distribution.dev.json", Scope.GUI),
        ("config/**", Scope.OTHER),
        (".github/workflows/test.yml", Scope.GUI),
        (".github/actions/**", Scope.GUI),
        (".github/**", Scope.OTHER),
        ("pyproject.toml", Scope.GUI),
        ("uv.lock", Scope.GUI),
        (".nvmrc", Scope.GUI),
        (".agents/defaults/**", Scope.GUI),
        (".agents/**", Scope.OTHER),
        (".cursor/**", Scope.OTHER),
        (".claude/**", Scope.OTHER),
        (".codex/**", Scope.OTHER),
        (".githooks/**", Scope.OTHER),
        (".impeccable/**", Scope.OTHER),
        (".editorconfig", Scope.OTHER),
        (".gitignore", Scope.OTHER),
        (".gitleaks.toml", Scope.OTHER),
        (".pre-commit-config.yaml", Scope.OTHER),
        (".release-please-manifest.json", Scope.OTHER),
        ("AGENTS.md", Scope.OTHER),
        ("CHANGELOG.md", Scope.OTHER),
        ("LICENSE", Scope.OTHER),
        ("Makefile", Scope.OTHER),
        ("README.md", Scope.OTHER),
        ("release-please-config.json", Scope.OTHER),
        ("ROADMAP.md", Scope.OTHER),
        ("hatch_build.py", Scope.OTHER),
        ("install.sh", Scope.OTHER),
        ("lint-staged.config.mjs", Scope.OTHER),
    )
)


@dataclass(frozen=True)
class RequiredCheck:
    """A status context that must be SUCCESS on the PR head before a merge."""

    name: str
    workflow: str
    job: str
    runs: str
    local: tuple[str, ...]


# `local` lists the `make ci-body` targets that mirror the check; none for a CI-only check.
REQUIRED_CHECKS: tuple[RequiredCheck, ...] = (
    RequiredCheck(
        "pytest",
        "test.yml",
        "pytest",
        "Lint, format, types, project compatibility, commit lint, version policy, the Python suite with the "
        "95% coverage floor and the docs-sync gate. Plans its own scope, so it never skips.",
        ("lint-py", "format-py-check", "typecheck", "generated-check", "docs-sync", "test"),
    ),
    RequiredCheck(
        "frontend",
        "test.yml",
        "frontend",
        "Aggregate over the planner and `frontend-suite` (lint, format, types, Vitest with "
        "axe, build). Succeeds when the plan orders the workload and it passes, or the plan "
        "orders none and it skipped.",
        ("test-web",),
    ),
    RequiredCheck(
        "frontend-e2e",
        "test.yml",
        "frontend-e2e",
        "Aggregate over the planner and the Playwright shards (`frontend-e2e-suites`), with "
        "the same fail-closed contract as `frontend`.",
        ("test-web-e2e",),
    ),
    RequiredCheck(
        "gitleaks-history",
        "secret-scan.yml",
        "gitleaks",
        "Secret scan over the full git history. Runs on every PR.",
        (),
    ),
)
REQUIRED_CHECKS_BEGIN = "<!-- ci-plan:required-checks -->"
REQUIRED_CHECKS_END = "<!-- /ci-plan:required-checks -->"
REQUIRED_CHECKS_DOCS = ("docs/testing.md", "docs/contributing.md")


def render_required_checks() -> str:
    rows = [
        "| Required check | Workflow | What it covers | Local mirror |",
        "|---|---|---|---|",
    ]
    for check in REQUIRED_CHECKS:
        local = " ".join(f"`make {target}`" for target in check.local) or "none (CI only)"
        rows.append(f"| `{check.name}` | `{check.workflow}` | {check.runs} | {local} |")
    return "\n".join(rows)


def embedded_required_checks(text: str) -> str | None:
    """The text between the markers in *text*, or None when a marker is missing."""
    start = text.find(REQUIRED_CHECKS_BEGIN)
    end = text.find(REQUIRED_CHECKS_END)
    if start < 0 or end < start:
        return None
    return text[start + len(REQUIRED_CHECKS_BEGIN) : end].strip("\n")


def embed_required_checks(text: str) -> str:
    """*text* with the table between its markers replaced by the current one."""
    if embedded_required_checks(text) is None:
        raise ValueError(f"missing {REQUIRED_CHECKS_BEGIN} / {REQUIRED_CHECKS_END} markers")
    start = text.index(REQUIRED_CHECKS_BEGIN) + len(REQUIRED_CHECKS_BEGIN)
    end = text.index(REQUIRED_CHECKS_END)
    return f"{text[:start]}\n{render_required_checks()}\n{text[end:]}"


def sync_required_checks_docs(root: Path = ROOT, *, write: bool) -> list[str]:
    """Docs whose embedded table is stale. With *write*, rewrite them."""
    stale = []
    for relative in REQUIRED_CHECKS_DOCS:
        path = root / relative
        text = path.read_text(encoding="utf-8")
        if embedded_required_checks(text) == render_required_checks():
            continue
        stale.append(relative)
        if write:
            path.write_text(embed_required_checks(text), encoding="utf-8")
    return stale


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


RELEASE_BRANCH = "release-please--branches--main--components--podcast-mcp"
_RELEASE_FIELDS = {
    "pyproject.toml": (("project", "version"),),
    ".release-please-manifest.json": ((".",),),
    "src/podcast_mcp/__init__.py": (("__version__",),),
    "uv.lock": (("package", "@podcast-mcp", "version"),),
    "gui/desktop/package.json": (("version",),),
    "gui/desktop/package-lock.json": (("version",), ("packages", "", "version")),
    "gui/desktop/src-tauri/Cargo.toml": (("package", "version"),),
    "gui/desktop/src-tauri/Cargo.lock": (("package", "@sharecut", "version"),),
    "gui/desktop/src-tauri/tauri.conf.json": (("version",),),
}
RELEASE_PATHS = frozenset((*_RELEASE_FIELDS, "CHANGELOG.md"))
RELEASE_TESTS = (
    "tests/test_ci_plan.py",
    "tests/test_release_ci_plan.py",
    "tests/test_version_policy.py",
)


@dataclass(frozen=True)
class ReleaseProof:
    merge_base: str
    head: str
    version: str


@dataclass(frozen=True)
class FullRelease:
    reason: str


def _json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key}")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> Any:
    raise ValueError(f"invalid JSON constant {value}")


def _release_document(path: str, text: str) -> tuple[Any, list[str]]:
    if path.endswith(".py"):
        tree = ast.parse(text)
        names = [n for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id == "__version__"]
        assignments = [
            n
            for n in tree.body
            if isinstance(n, ast.Assign)
            and len(n.targets) == 1
            and isinstance(n.targets[0], ast.Name)
            and n.targets[0].id == "__version__"
            and isinstance(n.value, ast.Constant)
            and isinstance(n.value.value, str)
        ]
        if len(names) != 1 or len(assignments) != 1:
            raise ValueError("expected a sole literal __version__ assignment")
        value = assignments[0].value
        assert isinstance(value, ast.Constant)
        assert isinstance(value.value, str)
        literal = re.compile(r'^(__version__ = ")([^"\n]+)(")', re.MULTILINE)
        matches = list(literal.finditer(text))
        if len(matches) != 1 or matches[0].group(2) != value.value:
            raise ValueError("unsupported __version__ syntax")
        match = matches[0]
        return text[: match.start(2)] + "<version>" + text[match.end(2) :], [value.value]
    if path.endswith(".json"):
        data = json.loads(
            text, object_pairs_hook=_json_object, parse_constant=_reject_json_constant
        )
    else:
        data = tomllib.loads(text)
    found = []
    for selector in _RELEASE_FIELDS[path]:
        owner = data
        for key in selector[:-1]:
            if key.startswith("@"):
                packages = [entry for entry in owner if entry["name"] == key[1:]]
                if len(packages) != 1:
                    raise ValueError("ambiguous lockfile package")
                owner = packages[0]
                if key == "@podcast-mcp" and owner["source"] != {"editable": "."}:
                    raise ValueError("uv project is not local")
                if key == "@sharecut" and ("source" in owner or "checksum" in owner):
                    raise ValueError("Cargo project is not local")
            else:
                owner = owner[key]
        value = owner[selector[-1]]
        if not isinstance(value, str):
            raise ValueError("version must be a string")
        found.append(value)
        owner[selector[-1]] = "<version>"
    return data, found


def _version_text_only(
    before: str, after: str, old: str, new: str, expected_version_field_count: int
) -> bool:
    parts = before.split(old)
    states = {(0, 0)}
    for part in parts[:-1]:
        next_states: set[tuple[int, int]] = set()
        for offset, changed in states:
            if not after.startswith(part, offset):
                continue
            offset += len(part)
            if after.startswith(old, offset):
                next_states.add((offset + len(old), changed))
            if changed < expected_version_field_count and after.startswith(new, offset):
                next_states.add((offset + len(new), changed + 1))
        if not next_states:
            return False
        states = next_states
    return any(
        changed == expected_version_field_count
        and offset + len(parts[-1]) == len(after)
        and after.startswith(parts[-1], offset)
        for offset, changed in states
    )


def _git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=root,
        capture_output=True,
        check=True,
    ).stdout.decode("utf-8")


def classify_release(
    base: str | None,
    head: str | None,
    *,
    head_ref: str | None,
    head_repository: str | None,
    base_repository: str | None,
    base_ref: str | None,
    root: Path = ROOT,
) -> ReleaseProof | FullRelease:
    """Prove the exact known release from immutable Git objects, or explain full fallback."""
    if not (base and head and head_repository and base_repository):
        return FullRelease("missing release identity")
    if head_ref != RELEASE_BRANCH or base_ref != "main" or head_repository != base_repository:
        return FullRelease("unexpected release branch, target, or repository")
    try:
        head_sha = _git(
            root, "rev-parse", "--verify", "--end-of-options", f"{head}^{{commit}}"
        ).strip()
        base_sha = _git(
            root, "rev-parse", "--verify", "--end-of-options", f"{base}^{{commit}}"
        ).strip()
        merge_bases = _git(root, "merge-base", "--all", base_sha, head_sha).splitlines()
        if len(merge_bases) != 1:
            return FullRelease("ambiguous merge base")
        merge_base = merge_bases[0]
        entries = (
            _git(root, "diff", "--raw", "--no-abbrev", "--no-renames", "-z", merge_base, head_sha)
            .rstrip("\0")
            .split("\0")
        )
        if len(entries) != 2 * len(RELEASE_PATHS):
            return FullRelease("release must modify exactly the ten known paths")
        blobs = {}
        for header, path in zip(entries[::2], entries[1::2], strict=True):
            old_mode, new_mode, old_blob, new_blob, status = header.removeprefix(":").split()
            if old_mode != "100644" or new_mode != "100644" or status != "M":
                return FullRelease("release requires modified regular files with unchanged modes")
            blobs[path] = (old_blob, new_blob)
        if set(blobs) != RELEASE_PATHS:
            return FullRelease("unexpected release paths")
        old_versions: dict[str, str] = {}
        new_versions: dict[str, str] = {}
        texts = []
        for path, selectors in _RELEASE_FIELDS.items():
            before, after = (_git(root, "cat-file", "blob", sha) for sha in blobs[path])
            old_data, old_values = _release_document(path, before)
            new_data, new_values = _release_document(path, after)
            if old_data != new_data:
                return FullRelease(f"non-version content changed in {path}")
            for index, (old, new) in enumerate(zip(old_values, new_values, strict=True)):
                old_versions[f"{path}:{index}"] = old
                new_versions[f"{path}:{index}"] = new
            texts.append((before, after, len(selectors)))
        if problems(old_versions) or problems(new_versions):
            return FullRelease("incoherent or unsupported release versions")
        old = next(iter(old_versions.values()))
        new = next(iter(new_versions.values()))
        canonical = r"0\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
        if not all(re.fullmatch(canonical, value) for value in (old, new)):
            return FullRelease("release requires canonical plain 0.x versions")
        if tuple(map(int, new.split("."))) <= tuple(map(int, old.split("."))):
            return FullRelease("release version must increase")
        if not all(
            _version_text_only(before, after, old, new, count) for before, after, count in texts
        ):
            return FullRelease("release changes bytes outside known version literals")
        return ReleaseProof(merge_base, head_sha, new)
    except (
        OSError,
        subprocess.CalledProcessError,
        ValueError,
        KeyError,
        TypeError,
        AttributeError,
        SyntaxError,
        RecursionError,
    ) as error:
        return FullRelease(f"release proof unavailable: {type(error).__name__}")


@dataclass(frozen=True)
class CiPlan:
    gui: bool
    pytest: Literal["full", "web", "docs", "release"]
    e2e: tuple[E2eJob, ...]
    release_only: bool = False
    native: NativeSelection = field(default_factory=NativeSelection)

    def outputs(self) -> dict[str, str]:
        matrix = {"include": [vars(job) for job in self.e2e]}
        return {
            "gui": "true" if self.gui else "false",
            "release-only": "1" if self.release_only else "0",
            "pytest": self.pytest,
            "e2e-matrix": json.dumps(matrix, separators=(",", ":")),
            **self.native.outputs(),
        }


def plan(
    event: str,
    changed: Sequence[str],
    *,
    release: ReleaseProof | FullRelease | None = None,
    head_ref: str | None = None,
) -> CiPlan:
    """Pull requests run what their diff can reach; every other event runs everything."""
    if event != PULL_REQUEST:
        return CiPlan(gui=True, pytest="full", e2e=(*main_shards(), *full_compat()))
    if isinstance(release, ReleaseProof):
        return CiPlan(
            gui=False,
            pytest="release",
            e2e=(),
            release_only=True,
            native=NativeSelection(frozenset()),
        )
    if isinstance(release, FullRelease) or (head_ref or "").startswith("release-please"):
        return CiPlan(gui=True, pytest="full", e2e=(*main_shards(), *pr_compat()))
    gui = not changed or any(scope_of(path) is Scope.GUI for path in changed)
    scope: Literal["full", "web", "docs"] = next(
        (name for name, subset in SUBSETS.items() if subset.covers(changed)), "full"
    )
    return CiPlan(
        gui=gui,
        pytest=scope,
        e2e=(*main_shards(), *pr_compat()) if gui else (),
        native=select_native(changed),
    )


def _script_readers(root: Path, reader: re.Pattern[str]) -> set[str]:
    """Names of scripts/*.py whose source matches *reader*, or that import such a script."""
    sources = {
        path.stem: path.read_text(encoding="utf-8") for path in (root / "scripts").glob("*.py")
    }
    readers = {name for name, source in sources.items() if reader.search(source)}
    while grown := {
        name
        for name, source in sources.items()
        if name not in readers and _referenced_scripts(source, sources) & readers
    }:
        readers |= grown
    return readers


def _referenced_scripts(source: str, scripts: Iterable[str]) -> set[str]:
    named = {name for ref in SCRIPT_REF_RES for name in ref.findall(source)}
    return named & set(scripts)


def subset_tests(scope: Literal["web", "docs", "release"], root: Path = ROOT) -> list[str]:
    """Repo-relative pytest files that read *scope*, directly or through a script, sorted."""
    if scope == "release":
        return list(RELEASE_TESTS)
    reader = SUBSETS[scope].reader
    script_readers = _script_readers(root, reader)
    selected = []
    for path in (root / "tests").rglob("test_*.py"):
        source = path.read_text(encoding="utf-8")
        if reader.search(source) or _referenced_scripts(source, script_readers):
            selected.append(path.relative_to(root).as_posix())
    return sorted(selected)


def changed_files(base: str, head: str, root: Path = ROOT) -> list[str]:
    """Paths changed on *head* since its merge base with *base*."""
    out = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", "-z", f"{base}...{head}", "--"],
        cwd=root,
        capture_output=True,
        check=True,
    ).stdout.decode("utf-8")
    if out and not out.endswith("\0"):
        raise ValueError("unterminated changed path")
    return out[:-1].split("\0") if out else []


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
    plan_cmd.add_argument("--head-ref")
    plan_cmd.add_argument("--head-repository")
    plan_cmd.add_argument("--base-repository")
    plan_cmd.add_argument("--base-ref")
    subset_cmd = sub.add_parser("subset-tests")
    subset_cmd.add_argument("scope", choices=[*sorted(SUBSETS), "release"])
    required_cmd = sub.add_parser("required-checks")
    required_cmd.add_argument("--check", action="store_true", help="fail instead of writing")
    args = parser.parse_args(argv)

    if args.command == "required-checks":
        stale = sync_required_checks_docs(write=not args.check)
        for relative in stale:
            verb = "stale" if args.check else "rewrote"
            print(f"{relative}: required-checks table {verb}", file=sys.stderr)
        return 1 if stale and args.check else 0

    if args.command == "subset-tests":
        _print_lines(subset_tests(args.scope))
        return 0
    changed: list[str] = []
    release: ReleaseProof | FullRelease | None = None
    if args.event == PULL_REQUEST:
        try:
            if args.base and args.head:
                changed = changed_files(args.base, args.head)
            else:
                release = FullRelease("missing diff identity")
        except (OSError, subprocess.CalledProcessError, UnicodeError, ValueError):
            release = FullRelease("changed paths unavailable")
        if release is None and (args.head_ref or "").startswith("release-please"):
            release = classify_release(
                args.base,
                args.head,
                head_ref=args.head_ref,
                head_repository=args.head_repository,
                base_repository=args.base_repository,
                base_ref=args.base_ref,
            )
    result = plan(args.event, changed, release=release, head_ref=args.head_ref)
    if isinstance(release, FullRelease):
        print(f"full fallback: {release.reason}", file=sys.stderr)
    _print_lines(f"{key}={value}" for key, value in result.outputs().items())
    print(
        f"{len(changed)} changed files; gui={result.gui} pytest={result.pytest} "
        f"e2e={[job.name for job in result.e2e]}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
