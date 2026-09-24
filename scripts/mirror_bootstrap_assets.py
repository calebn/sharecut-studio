#!/usr/bin/env python3
"""Mirror pinned bootstrap assets to S3-compatible object storage/CDN (or a local directory).

Does not run on user machines. Operator / CI bumps pins in
``contracts/bootstrap-assets.json`` then runs this script.

Examples::

    # Dry-run: print planned keys
    python scripts/mirror_bootstrap_assets.py --dry-run

    # Write into a local mirror tree (then sync to object storage yourself)
    python scripts/mirror_bootstrap_assets.py --out-dir /tmp/sharecut-assets

Env:
  PODCAST_BOOTSTRAP_CDN_BASE — optional public base URL recorded in output manifest
  PODCAST_OBJECT_STORE_* — if set with --upload, uses util.object_store (private funnel CI)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from podcast_mcp.util.asset_sources import download_first_ok
from podcast_mcp.util.hashing import sha256_file


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _download(url: str, dest: Path, *, timeout: float = 120.0) -> None:
    download_first_ok([url], dest, timeout=timeout)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=_repo_root() / "contracts" / "bootstrap-assets.json",
    )
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--upload",
        action="store_true",
        help="Upload when PODCAST_OBJECT_STORE_* is configured (funnel CI).",
    )
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    assets = manifest.get("assets") or {}
    out_dir = args.out_dir or (_repo_root() / "build" / "bootstrap-mirror")
    planned: list[dict[str, str]] = []

    for name, meta in assets.items():
        kind = meta.get("kind")
        prefix = meta["cdn_prefix"]
        if kind == "http":
            url = meta["url"]
            filename = meta.get("filename") or Path(url).name
            dest = out_dir / prefix / filename
            planned.append({"name": name, "url": url, "dest": str(dest)})
            if args.dry_run:
                continue
            print(f"fetch {name} → {dest}")
            _download(url, dest)
            planned[-1]["sha256"] = sha256_file(dest)
        elif kind == "huggingface":
            planned.append(
                {
                    "name": name,
                    "action": "manual_or_huggingface_hub",
                    "repo": meta.get("repo", ""),
                    "revision": meta.get("revision", ""),
                    "cdn_prefix": prefix,
                    "note": meta.get("notes", ""),
                }
            )
            if not args.dry_run:
                print(
                    f"skip {name}: use huggingface_hub snapshot_download "
                    f"for {meta.get('repo')}@{meta.get('revision')} → {prefix}/"
                )
        elif kind == "static-ffmpeg":
            planned.append(
                {
                    "name": name,
                    "action": "manual_static_ffmpeg",
                    "cdn_prefix": prefix,
                    "note": meta.get("notes", ""),
                }
            )
            if not args.dry_run:
                print(f"skip {name}: place platform ffmpeg/ffprobe under {prefix}/")
        else:
            print(f"unknown kind {kind!r} for {name}", file=sys.stderr)
            return 2

    summary_path = out_dir / "mirror-summary.json"
    if not args.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(planned, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {summary_path}")
    else:
        print(json.dumps(planned, indent=2))

    if args.upload:
        print(
            "--upload: wire object-store put_object in private funnel CI "
            "(not enabled in FOSS tree to avoid leaking credentials).",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
