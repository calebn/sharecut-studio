#!/usr/bin/env python3
"""Validate a public distribution profile and emit a Tauri config overlay."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


def main(argv: list[str] | None = None) -> int:
    from podcast_mcp.distribution import (
        DistributionProfileError,
        compact_product_name,
        default_distribution_profile_path,
        load_distribution_profile,
        tauri_distribution_overlay,
    )

    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", type=Path, default=default_distribution_profile_path())
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Validate the profile without writing a Tauri overlay.",
    )
    parser.add_argument(
        "--compact-product-name",
        action="store_true",
        help="Remove spaces for Linux packaging tools that cannot handle them.",
    )
    args = parser.parse_args(argv)
    try:
        profile = load_distribution_profile(args.profile)
    except DistributionProfileError as exc:
        parser.error(str(exc))
    if args.check_only:
        if args.output is not None:
            parser.error("--output cannot be used with --check-only")
        return 0
    if args.output is None:
        parser.error("--output is required unless --check-only is used")
    overlay = tauri_distribution_overlay(profile)
    if args.compact_product_name:
        compact = compact_product_name(profile)
        overlay["productName"] = compact
        overlay["app"]["windows"][0]["title"] = compact
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(overlay, indent=2) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
