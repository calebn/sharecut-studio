"""Score audition_context v2 hypotheses against by-construction defects.

Usage (from repo root):

    uv run python scripts/eval_audition_context.py --workspace /tmp/audition-defects
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from podcast_mcp.edits.audition_eval import (
    DEFAULT_CASES,
    build_defect_project,
    score_labeled_windows,
)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_THRESHOLDS = ROOT / "tests/fixtures/audition_context_eval_thresholds.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path("/tmp/audition-defects"),
        help="Directory to write the injected fixture into",
    )
    parser.add_argument(
        "--thresholds",
        type=Path,
        default=DEFAULT_THRESHOLDS,
        help="JSON map of code → min_precision / min_recall",
    )
    args = parser.parse_args(argv)

    project = build_defect_project(args.workspace)
    report = score_labeled_windows(project, DEFAULT_CASES, detail="summary")
    print(json.dumps(report, indent=2))

    if not args.thresholds.is_file():
        print(f"no thresholds file at {args.thresholds}", file=sys.stderr)
        return 0
    gates = json.loads(args.thresholds.read_text(encoding="utf-8"))
    failed = False
    for code, stats in report["per_code"].items():
        gate = gates.get(code) or {}
        min_p = float(gate.get("min_precision", 0.0))
        min_r = float(gate.get("min_recall", 0.0))
        if stats["precision"] < min_p or stats["recall"] < min_r:
            print(
                f"FAIL {code}: precision={stats['precision']:.2f} "
                f"recall={stats['recall']:.2f} (need P>={min_p} R>={min_r})",
                file=sys.stderr,
            )
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
