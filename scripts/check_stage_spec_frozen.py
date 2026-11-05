#!/usr/bin/env python3
"""Fail when a change edits the stage design specs without the owner's approval.

docs/design/stages/ is the design, not a description of the code. A gap between
the two goes on the spec-deviation list. An edit is allowed only when a commit in
the range carries `Stage-Spec-Approved: <the owner's message or decision>`.

Usage: python3 scripts/check_stage_spec_frozen.py [--range origin/main...HEAD]
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys

FROZEN = "docs/design/stages/"
_APPROVAL = re.compile(r"^Stage-Spec-Approved:[ \t]*\S.*$", re.M)


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def violations(rng: str) -> list[str]:
    touched = [p for p in _git("diff", "--name-only", rng).splitlines() if p.startswith(FROZEN)]
    if not touched or _APPROVAL.search(_git("log", "--format=%B", rng)):
        return []
    return touched


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--range", default="origin/main...HEAD")
    bad = violations(parser.parse_args().range)
    for path in bad:
        print(f"{path}: the stage specs are the design; do not edit them to match the code")
    if bad:
        print(
            "Put the gap on the spec-deviation list. If the owner approved this edit, add a "
            "`Stage-Spec-Approved: <owner message or decision>` trailer to a commit."
        )
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
