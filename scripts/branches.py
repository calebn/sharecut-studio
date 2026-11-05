#!/usr/bin/env python3
"""The branch names CI and the local gates share: read from config/branches.json.

Usage: python3 scripts/branches.py base|release|required-jobs
`SHARECUT_BASE_BRANCH` overrides the base branch. Stdlib only.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

CONFIG = Path(__file__).resolve().parent.parent / "config" / "branches.json"
BASE_ENV = "SHARECUT_BASE_BRANCH"


@dataclass(frozen=True)
class Branches:
    base: str
    release: str
    required_jobs: tuple[str, ...]


def load(path: Path = CONFIG) -> Branches:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return Branches(
        base=raw["base"], release=raw["release"], required_jobs=tuple(raw["required_jobs"])
    )


def base() -> str:
    return os.environ.get(BASE_ENV) or load().base


def release() -> str:
    return load().release


def required_jobs() -> tuple[str, ...]:
    return load().required_jobs


def main(argv: list[str]) -> int:
    commands = {
        "base": base,
        "release": release,
        "required-jobs": lambda: "\n".join(required_jobs()),
    }
    if len(argv) != 2 or argv[1] not in commands:
        print(__doc__, file=sys.stderr)
        return 2
    print(commands[argv[1]]())
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
