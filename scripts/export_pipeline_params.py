#!/usr/bin/env python3
"""Export / check the pipeline settings contract: contracts/pipeline-params.json.

The contract lists every setting `PARAM_FIELDS` exposes (path, type, default, read from
`.agents/defaults/pipeline.yaml`) and every other YAML leaf as unexposed, so adding, removing
or retyping a YAML key fails the check until the file is regenerated and the key's place
(exposed with a `_ParamSpec`, or deliberately unexposed) is a visible diff.

Usage:
  python scripts/export_pipeline_params.py          # write the contract
  python scripts/export_pipeline_params.py --check  # fail if stale
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "contracts" / "pipeline-params.json"


def _leaves(node: Any, prefix: str = "") -> Iterator[str]:
    if isinstance(node, dict) and node:
        for key, value in node.items():
            yield from _leaves(value, f"{prefix}.{key}" if prefix else str(key))
    else:
        yield prefix


def contract() -> dict[str, Any]:
    sys.path.insert(0, str(ROOT / "src"))
    from podcast_mcp.config.defaults import bundled_defaults
    from podcast_mcp.pipeline.meta import PARAM_FIELDS

    exposed = {f.path for f in PARAM_FIELDS}
    leaves = set(_leaves(bundled_defaults()))
    missing = sorted(exposed - leaves)
    if missing:
        raise SystemExit(f"PARAM_FIELDS names keys absent from pipeline.yaml: {missing}")
    return {
        "exposed": [
            {"path": f.path, "type": f.type, "default": f.default}
            for f in sorted(PARAM_FIELDS, key=lambda f: f.path)
        ],
        "unexposed": sorted(leaves - exposed),
    }


def _dumps(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the contract is stale")
    args = parser.parse_args()
    text = _dumps(contract())
    if args.check:
        if not OUT.is_file() or OUT.read_text(encoding="utf-8") != text:
            print(
                f"{OUT.relative_to(ROOT)} is stale. Run: python scripts/export_pipeline_params.py",
                file=sys.stderr,
            )
            return 1
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
