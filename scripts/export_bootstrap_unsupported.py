#!/usr/bin/env python3
"""Export / check tests/fixtures/bootstrap_status/unsupported.json.

The file is the body of ``GET /api/bootstrap/status`` as the real app answers it on a host that
cannot process audio (the iOS row). The web tests and Storybook stories read it instead of
building status rows by hand, so a row the engine reports differently fails here first.

Usage:
  python scripts/export_bootstrap_unsupported.py          # write the contract
  python scripts/export_bootstrap_unsupported.py --check  # fail if stale
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "fixtures" / "bootstrap_status" / "unsupported.json"


def payload() -> dict[str, Any]:
    sys.path.insert(0, str(ROOT / "src"))
    with tempfile.TemporaryDirectory() as scratch:
        os.environ["PODCAST_MCP_CACHE"] = str(Path(scratch) / "cache")
        os.environ["PODCAST_CONFIG_DIR"] = str(Path(scratch) / "config")
        os.environ["PODCAST_SESSION_TOKEN"] = "contract-token"
        for name in ("PODCAST_WHISPER_MODEL", "PODCAST_BOOTSTRAP_CDN_BASE"):
            os.environ.pop(name, None)
        from fastapi.testclient import TestClient

        from podcast_mcp.gui.server import create_app
        from podcast_mcp.util import host_platform

        with host_platform.using(host_platform.IOS):
            response = TestClient(create_app()).get(
                "/api/bootstrap/status", headers={"X-Podcast-Token": "contract-token"}
            )
        response.raise_for_status()
        return response.json()


def _dumps(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the contract is stale")
    args = parser.parse_args()
    text = _dumps(payload())
    if args.check:
        if not OUT.is_file() or OUT.read_text(encoding="utf-8") != text:
            print(
                f"{OUT.relative_to(ROOT)} is stale. "
                "Run: python scripts/export_bootstrap_unsupported.py",
                file=sys.stderr,
            )
            return 1
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
