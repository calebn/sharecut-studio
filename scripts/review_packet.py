"""Build the issue-pipeline's shared review packet deterministically.

Every reviewer lens reads the same packet instead of re-exploring the diff, so it is
generated here (plain git commands, no model) and written to a file the lenses read,
rather than being retyped by an agent. See docs/contributing.md § Automated issue pipeline.

Usage: python3 scripts/review_packet.py --ref origin/<branch> --range <git-range> --out <file>
  # prints "<file> <chars> docs=<N>"
"""

from __future__ import annotations

import argparse
import posixpath
import re
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path

MAX_CHARS = 60_000
DIFF_CAP = 35_000
PER_SYMBOL_HITS = 20
PER_MODULE_HITS = 15
PER_DOC_REFS = 20
# AGENTS.md-style shorthand: `services/share.py` means src/podcast_mcp/services/share.py.
PACKAGE_PREFIX = "src/podcast_mcp/"
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

_BACKTICK_RE = re.compile(r"`([^`\s]+)`")
_MD_LINK_RE = re.compile(r"\]\(([^)\s#]+)")


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


def changed_docs(rng: str) -> list[str]:
    """Markdown docs the range adds or modifies. A deleted doc makes no claims to check."""
    out = git("diff", "--name-only", "--diff-filter=d", rng, "--", "*.md")
    return [line for line in out.splitlines() if line]


def tracked_paths(ref: str) -> frozenset[str]:
    """Every file at ``ref`` plus each of its parent directories (no trailing slash)."""
    paths: set[str] = set()
    for line in git("ls-tree", "-r", "--name-only", ref).splitlines():
        if not line:
            continue
        parts = line.split("/")
        paths.update("/".join(parts[:i]) for i in range(1, len(parts) + 1))
    return frozenset(paths)


def doc_references(rng: str, doc: str, tracked: frozenset[str]) -> list[str]:
    """Tracked paths that the doc's added lines name: backticked tokens (root-relative or
    shorthand under src/podcast_mcp/) and relative Markdown links, in first-seen order.

    review_packet.py runs from a git object and cannot import scripts/docs_sync.py, so
    this does not reuse docs_sync._resolve_prose_path. It is a smaller cousin of it that
    only has to point the docs lens at code."""
    refs: dict[str, None] = {}
    for line in git("diff", "-U0", rng, "--", doc).splitlines():
        if not line.startswith("+") or line.startswith("+++"):
            continue
        tokens = _BACKTICK_RE.findall(line)
        for target in _MD_LINK_RE.findall(line):
            if "://" in target or target.startswith("mailto:"):
                continue
            tokens.append(posixpath.normpath(posixpath.join(posixpath.dirname(doc), target)))
        for token in tokens:
            token = token.rstrip("/")
            for candidate in (token, PACKAGE_PREFIX + token):
                if not candidate.startswith("..") and candidate in tracked:
                    refs.setdefault(candidate)
                    break
    return list(refs)[:PER_DOC_REFS]


def docs_accuracy(ref: str, rng: str) -> list[str]:
    """The docs-accuracy lens's starting point: each changed doc and the code it names."""
    docs = changed_docs(rng)
    if not docs:
        return []
    tracked = tracked_paths(ref)
    lines: list[str] = []
    for doc in docs:
        refs = doc_references(rng, doc, tracked)
        lines.append(f"### {doc}\npaths named in added lines: {', '.join(refs) or '(none)'}")
    return lines


def docs_sync_findings(ref: str, rng: str) -> list[str]:
    """Docs-sync report for the PR, from the checker and contract at ``ref``.

    review_packet.py itself runs from a git object via process substitution
    (``.claude/workflows/issue-pipeline.js`` ~L534: ``python3 <(git show
    origin/<branch>:scripts/review_packet.py)``), so it cannot import a sibling module;
    the checker at ``ref`` is piped into ``python3 -`` the same way. A ref that predates
    the checker (no scripts/docs_sync.py at that commit) reports unavailable rather than
    failing the packet. The exit code is ignored: this section is advisory in the packet.
    """
    try:
        checker = git("show", f"{ref}:scripts/docs_sync.py")
    except subprocess.CalledProcessError:
        return ["(docs-sync unavailable at this ref)"]
    result = subprocess.run(
        [sys.executable, "-", "check", "--range", rng],
        input=checker,
        capture_output=True,
        text=True,
        check=False,
    )
    return (result.stdout or result.stderr).splitlines()


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
            section(
                "Changed docs (docs-accuracy lens)",
                docs_accuracy(ref, rng),
                empty="(no docs changed)",
            ),
            section(
                "Docs-sync rules (contracts/docs-sync.json)",
                docs_sync_findings(ref, rng),
                empty="(no rule fired)",
            ),
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
    # docs=<N> lets the issue pipeline skip the docs-accuracy lens when no doc changed.
    print(f"{args.out} {len(packet)} docs={len(changed_docs(args.range))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
