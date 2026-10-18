#!/usr/bin/env python3
"""Fail when a commit on the PR branch does not start with a Conventional Commit type.

Merges are rebase-only, so every PR commit lands on main as written and release-please
reads them to pick the next version. A commit it cannot parse is silently ignored.

Usage: check_conventional_commits.py BASE...HEAD
"""

from __future__ import annotations

import re
import subprocess
import sys

TYPES = "feat|fix|perf|revert|docs|test|refactor|chore|ci|build|style"
SUBJECT = re.compile(rf"^(?:{TYPES})(?:\([^)\s][^)]*\))?!?: \S")
RELEASE_AS = re.compile(r"^Release-As:", re.MULTILINE | re.IGNORECASE)
EXEMPT = re.compile(r'^(?:Revert "|fixup! |squash! )')


def bad_subjects(range_spec: str) -> list[str]:
    out = subprocess.run(
        ["git", "log", "--no-merges", "--format=%h %s%x00%b%x1e", range_spec],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    bad = []
    for entry in out.split("\x1e"):
        head, _, body = entry.strip("\n").partition("\x00")
        if not head:
            continue
        sha, _, subject = head.partition(" ")
        if not SUBJECT.match(subject) and not EXEMPT.match(subject):
            bad.append(f"{sha} {subject}")
        elif RELEASE_AS.search(body):
            bad.append(
                f"{sha} {subject} (Release-As footer: versions are bumped by the release PR only)"
            )
    return bad


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    bad = bad_subjects(argv[1])
    if bad:
        print(
            "These commits need a Conventional Commit subject "
            f"(<{TYPES}>(scope)!: summary):\n  " + "\n  ".join(bad),
            file=sys.stderr,
        )
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
