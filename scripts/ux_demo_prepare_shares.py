#!/usr/bin/env python3
"""Publish a UX-demo review version and create guest share tokens for screenshots.

Writes:
  - PODCAST_SHARE_REGISTRY (default /tmp/podcast_ux_demo_shares.sqlite)
  - Token manifest for Playwright (default ux/assets/screens/.guest-tokens.json)

May mutate tests/fixtures/sharecut_ux_demo/episode.project.json (adds a review
version). Callers should restore the fixture after capture if needed.

Usage:
  python3 scripts/ux_demo_prepare_shares.py
  python3 scripts/ux_demo_prepare_shares.py --base-url http://127.0.0.1:8766
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "tests" / "fixtures" / "sharecut_ux_demo" / "episode.project.json"
DEFAULT_REGISTRY = Path("/tmp/podcast_ux_demo_shares.sqlite")
DEFAULT_TOKENS = ROOT / "ux" / "assets" / "screens" / ".guest-tokens.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project",
        type=Path,
        default=DEMO,
        help="Path to episode.project.json",
    )
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:8766",
        help="Public origin embedded in share URLs",
    )
    parser.add_argument(
        "--registry",
        dest="registry",
        type=Path,
        default=Path(os.environ.get("PODCAST_SHARE_REGISTRY", str(DEFAULT_REGISTRY))),
        help="Share registry sqlite path (exported as PODCAST_SHARE_REGISTRY)",
    )
    parser.add_argument(
        "--tokens-out",
        type=Path,
        default=DEFAULT_TOKENS,
    )
    args = parser.parse_args()

    if not args.project.is_file():
        print(f"missing project: {args.project}", file=sys.stderr)
        return 1

    os.environ["PODCAST_SHARE_REGISTRY"] = str(args.registry.resolve())

    from podcast_mcp.services import ProjectWorkspace, ReviewService
    from podcast_mcp.services.share import ShareService

    ws = ProjectWorkspace.open(args.project)
    existing = [
        v
        for v in (ws.project.review.versions if ws.project.review else [])
        if getattr(v, "label", None) == "UX demo review"
    ]
    if existing:
        ver_id = existing[0].id
    else:
        ver = ReviewService(ws).publish(label="UX demo review")
        ver_id = ver["id"]

    share_svc = ShareService(ws)
    review_app = share_svc.create(
        review_version_id=ver_id,
        public_base_url=args.base_url,
        capabilities=["play", "comment", "reply", "action"],
    )
    daw_view = share_svc.create(
        review_version_id=ver_id,
        public_base_url=args.base_url,
        capabilities=["play", "view", "comment", "suggest"],
    )

    manifest = {
        "share_registry": str(args.registry.resolve()),
        "project": str(args.project.resolve()),
        "review_version_id": ver_id,
        "review_app": {
            "token": review_app["token"],
            "url": review_app["url"],
            "guest_mode": review_app.get("guest_mode"),
            "capabilities": review_app.get("capabilities"),
        },
        "daw_guest": {
            "token": daw_view["token"],
            "url": daw_view["url"],
            "guest_mode": daw_view.get("guest_mode"),
            "capabilities": daw_view.get("capabilities"),
        },
    }
    args.tokens_out.parent.mkdir(parents=True, exist_ok=True)
    args.tokens_out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    print(f"\nWrote {args.tokens_out}", file=sys.stderr)
    print(f"PODCAST_SHARE_REGISTRY={args.registry.resolve()}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
