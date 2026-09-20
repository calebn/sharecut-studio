#!/usr/bin/env python3
"""Verify contracts/caps.json stays in sync with FOSS extension feature ids + caps."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from podcast_mcp.edits.share_capabilities import ALL_CAPABILITIES
from podcast_mcp.extensions.features import (
    EXPERIMENTAL_FEATURE_IDS,
    STABLE_FEATURE_IDS,
)
from podcast_relay.protocol import PROTOCOL_VERSION


def main() -> int:
    data = json.loads((ROOT / "contracts" / "caps.json").read_text(encoding="utf-8"))
    errors: list[str] = []
    if set(data["capabilities"]) != set(ALL_CAPABILITIES):
        errors.append("capabilities mismatch")
    if set(data["stable_feature_ids"]) != set(STABLE_FEATURE_IDS):
        errors.append("stable_feature_ids mismatch")
    if set(data["experimental_feature_ids"]) != set(EXPERIMENTAL_FEATURE_IDS):
        errors.append("experimental_feature_ids mismatch")
    if int(data["relay_protocol_version"]) != int(PROTOCOL_VERSION):
        errors.append("relay_protocol_version mismatch")
    if errors:
        print("contract check failed:", ", ".join(errors), file=sys.stderr)
        return 1
    print("contracts/caps.json OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
