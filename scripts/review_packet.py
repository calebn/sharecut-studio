"""Build the issue-pipeline's shared review packet deterministically.

Every reviewer lens reads the same packet instead of re-exploring the diff, so it is
generated here (plain git commands, no model) and written to a file the lenses read,
rather than being retyped by an agent. See docs/contributing.md § Automated issue pipeline.

Usage: python3 scripts/review_packet.py --ref origin/<branch> --range <git-range> --out <file>
"""

from __future__ import annotations

import argparse
import re
import subprocess
from collections.abc import Iterable
from pathlib import Path

MAX_CHARS = 60_000
DIFF_CAP = 35_000
PER_SYMBOL_HITS = 20
PER_MODULE_HITS = 15
DOMAIN_DIRS = (
    "src/podcast_mcp/services/",
    "src/podcast_mcp/edits/",
    "src/podcast_mcp/clips/",
    "src/podcast_mcp/pipeline/",
    "src/podcast_mcp/engines/",
)
ADAPTER_DIRS = (
    "src/podcast_mcp/cli/",
    "src/podcast_mcp/mcp/tools/",
    "src/podcast_mcp/gui/routes/",
    "gui/web/src/",
)

# Names introduced or changed on added lines (Python, TS/JS).
_SYMBOL_RES = (
    re.compile(r"^\+\s*(?:async\s+)?def\s+([A-Za-z_]\w*)"),
    re.compile(r"^\+\s*class\s+([A-Za-z_]\w*)"),
    re.compile(r"^\+\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"),
    re.compile(r"^\+\s*export\s+(?:const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)"),
)


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def changed_files(rng: str) -> list[str]:
    return [line for line in git("diff", "--name-only", rng).splitlines() if line]


def changed_symbols(diff: str) -> list[str]:
    seen: dict[str, None] = {}
    for line in diff.splitlines():
        for pattern in _SYMBOL_RES:
            match = pattern.match(line)
            if match and len(match.group(1)) > 2 and not match.group(1).startswith("test_"):
                seen.setdefault(match.group(1))
    return list(seen)


def grep(ref: str, *pattern_args: str, limit: int) -> list[str]:
    try:
        out = git("grep", "-n", *pattern_args, ref)
    except subprocess.CalledProcessError:  # no matches
        return []
    return [line.removeprefix(f"{ref}:") for line in out.splitlines()][:limit]


def module_name(path: str) -> str | None:
    if path.startswith("src/") and path.endswith(".py"):
        return path[len("src/") : -len(".py")].replace("/", ".").removesuffix(".__init__")
    return None


def importers(ref: str, path: str) -> list[str]:
    module = module_name(path)
    if module:
        parent, _, leaf = module.rpartition(".")
        return grep(
            ref,
            "-E",
            f"(import {re.escape(module)}\\b|from {re.escape(module)} import|from {re.escape(parent)} import .*\\b{leaf}\\b)",
            limit=PER_MODULE_HITS,
        )
    stem = Path(path).stem
    if path.startswith("gui/web/src/") and path.endswith((".ts", ".tsx")):
        return grep(
            ref,
            "-E",
            f"from ['\"][^'\"]*/{re.escape(stem)}['\"]",
            "--",
            "gui/web/src",
            limit=PER_MODULE_HITS,
        )
    return []


def related_tests(ref: str, files: Iterable[str]) -> list[str]:
    hits: dict[str, None] = {}
    for path in files:
        if path.startswith("tests/") or ".test." in path:
            hits.setdefault(f"{path} (changed)")
            continue
        module = module_name(path)
        needle = module or Path(path).stem
        for line in grep(ref, "-l", "-F", needle, "--", "tests", "gui/web/src", limit=10):
            if line.startswith("tests/") or ".test." in line:
                hits.setdefault(line)
    return list(hits)


def applicable_rules(files: Iterable[str]) -> list[str]:
    agents = Path("AGENTS.md")
    if not agents.exists():
        return []
    rows = [row for row in agents.read_text(encoding="utf-8").splitlines() if row.startswith("| ")]
    keys = {
        part for path in files for part in Path(path).parts[:3] if len(part) > 3 and "." not in part
    }
    keys |= {Path(path).stem for path in files if len(Path(path).stem) > 4}
    picked = [row for row in rows if any(key in row for key in keys)]
    return [row[:300] for row in picked[:15]]


def section(title: str, lines: list[str], empty: str = "(none)") -> str:
    return f"## {title}\n" + ("\n".join(lines) if lines else empty) + "\n"


def build(ref: str, rng: str) -> str:
    files = changed_files(rng)
    diff = git("diff", "-U30", rng)
    omitted = ""
    if len(diff) > DIFF_CAP:
        omitted = f"\n[diff truncated at {DIFF_CAP} chars; run `git diff {rng}` for the rest]\n"
        diff = diff[:DIFF_CAP]
    symbols = changed_symbols(git("diff", "-U0", rng))

    callers = []
    for sym in symbols:
        hits = grep(ref, "-w", "-F", sym, limit=PER_SYMBOL_HITS)
        callers.append(f"### {sym}\n" + ("\n".join(hits) if hits else "(no references)"))

    domain = [f for f in files if f.startswith(DOMAIN_DIRS) or f.startswith("gui/web/src/")]
    second_hop = [
        f"### importers of {f}\n" + ("\n".join(importers(ref, f)) or "(none)") for f in domain
    ]
    twins = []
    for f in domain:
        adapters = [hit for hit in importers(ref, f) if hit.startswith(ADAPTER_DIRS)]
        marked = [
            f"{hit}  [{'changed' if hit.split(':', 1)[0] in files else 'unchanged'}]"
            for hit in adapters
        ]
        if marked:
            twins.append(f"### {f}\n" + "\n".join(marked))

    packet = "".join(
        [
            section("Diff stat", git("diff", "--stat", rng).splitlines()),
            f"## Diff (with 30 lines of context)\n{diff}{omitted}\n",
            section("Callers and references", callers),
            section("Importers of changed modules (second hop)", second_hop),
            section("Twin paths (CLI / MCP / GUI adapters)", twins),
            section("Related tests", related_tests(ref, files)),
            section("Applicable repo rules (AGENTS.md rows)", applicable_rules(files)),
        ]
    )
    if len(packet) > MAX_CHARS:
        packet = packet[:MAX_CHARS] + f"\n[packet truncated at {MAX_CHARS} chars]\n"
    return packet


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", required=True, help="PR head ref, e.g. origin/<branch>")
    parser.add_argument("--range", required=True, help="git diff range to review")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    packet = build(args.ref, args.range)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(packet, encoding="utf-8")
    print(f"{args.out} {len(packet)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
