#!/usr/bin/env python3
"""Write or check the build-time owner CDN base (contracts/owner-cdn.json)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from podcast_mcp.util.atomic_file import atomic_write
from podcast_mcp.util.owner_cdn import BASE_ENV, GENERATED_NAME, clean_base, is_owner_host

TARGET = Path(__file__).resolve().parents[1] / "contracts" / GENERATED_NAME


def _stored_base() -> str | None:
    try:
        return clean_base(json.loads(TARGET.read_text(encoding="utf-8")).get("base"))
    except (OSError, ValueError, AttributeError):
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    write = commands.add_parser("write", help="Record the base the build embeds")
    write.add_argument("--base", required=True)
    commands.add_parser("clear", help="Remove a recorded base so no stale one reaches the build")
    check = commands.add_parser("check", help="Validate the recorded base")
    check.add_argument("--require", action="store_true", help="Fail when no base is recorded")
    args = parser.parse_args(argv)
    if args.command == "write":
        base = clean_base(args.base)
        if base is None:
            print(f"{BASE_ENV} must be an HTTPS origin on a public host", file=sys.stderr)
            return 1
        payload = (json.dumps({"base": base}) + "\n").encode()
        atomic_write(TARGET, lambda handle: handle.write(payload), mode=0o644)
        print(f"Recorded owner CDN base {base}")
        return 0
    if args.command == "clear":
        TARGET.unlink(missing_ok=True)
        return 0
    stored = _stored_base()
    if TARGET.exists() and stored is None:
        print(f"{TARGET} does not hold a usable HTTPS base", file=sys.stderr)
        return 1
    if args.require and stored is None:
        print(
            f"this build embeds no owner CDN base: set {BASE_ENV} to the CDN origin "
            "before building, or unset PODCAST_REQUIRE_OWNER_CDN for a source build",
            file=sys.stderr,
        )
        return 1
    if args.require and stored is not None and not is_owner_host(stored):
        print(
            f"{BASE_ENV} must name the documented owner CDN host for an official build, not {stored}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
