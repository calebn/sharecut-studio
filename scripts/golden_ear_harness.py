#!/usr/bin/env python3
"""Blind A/B golden-ear harness (thin CLI over ``services.golden_ear``).

Usage (from repo root):

    make golden-ear ARGS='build --project tests/fixtures/aligned_dialogue --out /tmp/golden --limit 8'
    make golden-ear ARGS='score --dir /tmp/golden --answers listen/answers.csv'
    uv run python scripts/golden_ear_harness.py build --project … --out …   # untrusted args
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from podcast_mcp.services.golden_ear import (
    DEFAULT_LIMIT,
    LISTEN_DIRNAME,
    build_golden_ear,
    score_golden_ear,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    build = sub.add_parser("build", help="Propose on a relocated copy and write blinded pairs.")
    build.add_argument("--project", type=Path, required=True)
    build.add_argument("--out", type=Path, required=True)
    build.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    build.add_argument("--classes")
    build.add_argument("--seed", type=int, default=None)
    build.add_argument("--force", action="store_true")

    score = sub.add_parser("score", help="Score a filled answers.csv against key.json.")
    score.add_argument("--dir", type=Path, required=True)
    score.add_argument("--answers", type=Path, default=Path(LISTEN_DIRNAME) / "answers.csv")

    args = parser.parse_args(argv)
    if args.cmd == "build":
        result = build_golden_ear(
            args.project,
            args.out,
            limit=args.limit,
            classes=args.classes,
            seed=args.seed,
            force=args.force,
        )
        print(json.dumps(result, indent=2))
        return 0
    report = score_golden_ear(args.dir, args.answers)
    print(json.dumps(report, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
