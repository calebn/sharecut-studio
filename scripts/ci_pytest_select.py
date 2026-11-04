#!/usr/bin/env python3
"""Pick the pytest files a Python change can reach, by import graph.

Usage:
  python3 scripts/ci_pytest_select.py --base <sha> --head <sha>   # prints test paths, one per line
  python3 scripts/ci_pytest_select.py PATH...                      # same, for explicit changed paths

`ci_plan.py` runs this only for a pull request whose every changed file is Python source
(`src/podcast_mcp`, `src/podcast_relay`), a test file, or a path the web and docs readers
already own. Anything else runs the full suite. The selection is a safe superset:

* a test is selected when it imports (directly or through any chain of modules, scripts and
  test helpers) a changed file, or names the changed module as a dotted name or path;
* every test file that scans the source tree (budgets, boundaries, ratchets, generated
  artifacts) is selected for any source change, because a change reaches it without an import;
* a `conftest.py` joins the dependencies of every test under it.

Stdlib only. A file that fails to parse raises, and the caller falls back to the full suite.
"""

from __future__ import annotations

import argparse
import ast
import re
import subprocess
import sys
from collections import defaultdict, deque
from collections.abc import Iterable, Sequence
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_PREFIXES = ("src/podcast_mcp/", "src/podcast_relay/")
SCAN_ROOTS = ("src", "scripts", "tests")
DOTTED_RE = re.compile(r"\b(?:podcast_mcp|podcast_relay)(?:\.\w+)+")
SOURCE_PATH_RE = re.compile(r"\b(?:src/)?((?:podcast_mcp|podcast_relay)/[\w/.-]+\.py)\b")
# A script named by file name, by path, or as a quoted stem (load_script("x"), _run("x.py")).
SCRIPT_REF_RES = (re.compile(r"\b(\w+)\.py\b"), re.compile(r"""["'](\w+)["']"""))
# A test that walks the source tree sees a new or edited file without importing it.
TREE_WALK_RE = re.compile(r"\brglob\(|\.glob\(|\bos\.walk\(|\biterdir\(|\bwalk_packages\(")
TREE_ROOT_RE = re.compile(r"""\bsrc\b|\bSRC\b|podcast_mcp|podcast_relay""")


def is_source(path: str) -> bool:
    return path.startswith(SOURCE_PREFIXES)


def is_eligible(path: str) -> bool:
    """A changed path whose effect on tests the import graph can bound."""
    if not path.endswith(".py"):
        return False
    return is_source(path) or (path.startswith("tests/") and Path(path).name != "conftest.py")


def _is_test_file(relative: str) -> bool:
    return relative.startswith("tests/") and Path(relative).name.startswith("test_")


def _module_name(relative: str) -> str | None:
    """The dotted name Python imports *relative* as."""
    parts = list(Path(relative).with_suffix("").parts)
    if parts[:1] in (["src"], ["scripts"]):
        parts = parts[1:]
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts) if parts else None


class Graph:
    """Who imports whom across `src`, `scripts` and `tests`."""

    def __init__(self, root: Path = ROOT) -> None:
        self.root = root
        self.files: list[str] = sorted(
            path.relative_to(root).as_posix()
            for base in SCAN_ROOTS
            for path in (root / base).rglob("*.py")
            if "__pycache__" not in path.parts
        )
        self.scripts = {f for f in self.files if f.startswith("scripts/")}
        self.by_name: dict[str, set[str]] = defaultdict(set)
        for relative in self.files:
            name = _module_name(relative)
            if name:
                self.by_name[name].add(relative)
            if relative.startswith("tests/"):
                self.by_name[Path(relative).stem].add(relative)
        self.sources = {
            relative: (root / relative).read_text(encoding="utf-8") for relative in self.files
        }
        self.edges = {relative: self._edges(relative) for relative in self.files}
        self.reverse: dict[str, set[str]] = defaultdict(set)
        for owner, targets in self.edges.items():
            for target in targets:
                self.reverse[target].add(owner)

    def resolve(self, name: str) -> set[str]:
        """Files that importing *name* runs: the module and every parent package."""
        parts = name.split(".")
        found: set[str] = set()
        for end in range(1, len(parts) + 1):
            found |= self.by_name.get(".".join(parts[:end]), set())
        return found

    def _package_of(self, relative: str) -> list[str]:
        name = _module_name(relative)
        parts = name.split(".") if name else []
        return parts if relative.endswith("__init__.py") else parts[:-1]

    def _imported_names(self, relative: str, tree: ast.AST) -> set[str]:
        names: set[str] = set()
        package = self._package_of(relative)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    base = package[: max(len(package) - (node.level - 1), 0)]
                    prefix = ".".join([*base, *([node.module] if node.module else [])])
                else:
                    prefix = node.module or ""
                if prefix:
                    names.add(prefix)
                names.update(f"{prefix}.{a.name}" if prefix else a.name for a in node.names)
        return names

    def _edges(self, relative: str) -> set[str]:
        source = self.sources[relative]
        try:
            tree = ast.parse(source, filename=relative)
        except SyntaxError as error:
            raise ValueError(f"cannot parse {relative}: {error}") from error
        names = self._imported_names(relative, tree)
        names.update(match.group(0) for match in DOTTED_RE.finditer(source))
        edges: set[str] = set()
        for name in names:
            edges |= self.resolve(name)
        for match in SOURCE_PATH_RE.finditer(source):
            module = _module_name(f"src/{match.group(1)}")
            if module:
                edges |= self.resolve(module)
        for pattern in SCRIPT_REF_RES:
            for match in pattern.finditer(source):
                edges |= {f"scripts/{match.group(1)}.py"} & self.scripts
        if _is_test_file(relative):
            directory = Path(relative).parent
            while directory.as_posix() != ".":
                conftest = (directory / "conftest.py").as_posix()
                if conftest in self.sources:
                    edges.add(conftest)
                directory = directory.parent
        edges.discard(relative)
        return edges

    def importers_of(self, seeds: Iterable[str]) -> set[str]:
        """Every file that reaches a seed through imports, seeds included."""
        seen = set(seeds)
        queue = deque(seen)
        while queue:
            for owner in self.reverse.get(queue.popleft(), ()):
                if owner not in seen:
                    seen.add(owner)
                    queue.append(owner)
        return seen

    def tree_scanners(self) -> set[str]:
        """Tests that walk the source tree, so any source change can reach them."""
        return {
            relative
            for relative in self.files
            if _is_test_file(relative)
            and TREE_WALK_RE.search(self.sources[relative])
            and TREE_ROOT_RE.search(self.sources[relative])
        }

    def name_mentions(self, name: str) -> set[str]:
        """Files that spell the dotted *name* of a module, used for a deleted module."""
        pattern = re.compile(rf"(?<![\w.]){re.escape(name)}(?!\w)")
        return {relative for relative, source in self.sources.items() if pattern.search(source)}


def select_tests(changed: Sequence[str], root: Path = ROOT) -> list[str]:
    """Repo-relative test files the Python files in *changed* can reach, sorted."""
    graph = Graph(root)
    seeds: set[str] = set()
    for path in changed:
        if not path.endswith(".py"):
            continue
        if (root / path).exists():
            seeds.add(path)
        elif module := _module_name(path):
            seeds |= graph.name_mentions(module)
    selected = {f for f in graph.importers_of(seeds) if _is_test_file(f)}
    if any(is_source(path) for path in changed):
        selected |= graph.tree_scanners()
    return sorted(selected)


def _git_changed(base: str, head: str, root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", "-z", f"{base}...{head}", "--"],
        cwd=root,
        capture_output=True,
        check=True,
    ).stdout.decode("utf-8")
    return out[:-1].split("\0") if out else []


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("paths", nargs="*")
    parser.add_argument("--base")
    parser.add_argument("--head")
    args = parser.parse_args(argv)
    changed = list(args.paths)
    if args.base and args.head:
        changed += _git_changed(args.base, args.head, ROOT)
    for relative in select_tests(changed):
        print(relative)
    return 0


if __name__ == "__main__":
    sys.exit(main())
