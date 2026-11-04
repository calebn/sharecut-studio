#!/usr/bin/env python3
"""Check the complete bootstrap mirror inventory without downloading model payloads.

Supply --base-url explicitly. See docs/setup.md for availability and integrity limits.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from podcast_mcp.util.asset_sources import PublicRequestError, public_request, validate_public_url

_METADATA_LIMIT = 256 * 1024
_OBJECT_LIMIT = 64
_DEFAULT_MANIFEST = Path(__file__).resolve().parents[1] / "contracts" / "bootstrap-assets.json"


class InventoryError(ValueError):
    def __init__(self, reason: str, *, asset: str | None = None, status: int | None = None) -> None:
        super().__init__(reason)
        self.asset = asset
        self.status = status


@dataclass(frozen=True)
class HttpAsset:
    name: str
    prefix: str
    filename: str


@dataclass(frozen=True)
class HfAsset:
    name: str
    prefix: str
    repo: str
    revision: str


Asset = HttpAsset | HfAsset


@dataclass(frozen=True)
class MirrorObject:
    asset: str
    path: str
    url: str


@dataclass(frozen=True)
class Revision:
    asset: str
    sha: str


@dataclass(frozen=True)
class CheckPlan:
    objects: tuple[MirrorObject, ...]
    revisions: tuple[Revision, ...]


def _safe_path(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise InventoryError("unsafe_path")
    parts = value.split("/")
    if any(
        part in {"", ".", ".."}
        or any(ord(char) <= 32 or ord(char) >= 127 or char in "\\%?#:" for char in part)
        for part in parts
    ):
        raise InventoryError("unsafe_path")
    return "/".join(quote(part, safe="-._~") for part in parts)


def _base_url(value: str) -> str:
    validate_public_url(value)
    parsed = urlsplit(value)
    path = parsed.path.rstrip("/")
    if path:
        canonical = _safe_path(unquote(path[1:]))
        if path != f"/{canonical}":
            raise InventoryError("invalid_base")
    return value.rstrip("/")


def _assets(manifest: object) -> tuple[Asset, ...]:
    if not isinstance(manifest, dict):
        raise InventoryError("invalid_manifest")
    entries = manifest.get("assets")
    if not isinstance(entries, dict) or not entries or len(entries) > _OBJECT_LIMIT:
        raise InventoryError("invalid_assets")
    assets: list[Asset] = []
    for name, meta in entries.items():
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", name):
            raise InventoryError("invalid_asset_id")
        if not isinstance(meta, dict):
            raise InventoryError("invalid_asset")
        if "cdn_prefix" not in meta:
            continue
        prefix = _safe_path(meta["cdn_prefix"])
        kind = meta.get("kind")
        if kind == "http":
            filename = meta.get("filename")
            if filename is None:
                upstream = meta.get("url")
                if not isinstance(upstream, str):
                    raise InventoryError("invalid_http_url")
                filename = unquote(urlsplit(upstream).path.rsplit("/", 1)[-1])
            filename = _safe_path(filename)
            if "/" in filename:
                raise InventoryError("invalid_filename")
            assets.append(HttpAsset(name, prefix, filename))
        elif kind == "huggingface":
            repo, revision = meta.get("repo"), meta.get("revision")
            if (
                not isinstance(repo, str)
                or not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9][A-Za-z0-9._-]*", repo)
                or len(repo) > 200
            ):
                raise InventoryError("invalid_repo")
            if (
                not isinstance(revision, str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}", revision)
                or any(part in {"", ".", ".."} for part in revision.split("/"))
            ):
                raise InventoryError("invalid_revision")
            assets.append(HfAsset(name, prefix, repo, revision))
        else:
            raise InventoryError("unknown_kind")
    if not assets:
        raise InventoryError("empty_inventory")
    return tuple(assets)


def _unique_json(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise InventoryError("duplicate_json_key")
        result[key] = value
    return result


def _inventory(asset: HfAsset, timeout: float) -> tuple[str, tuple[str, ...]]:
    repo = "/".join(quote(part, safe="") for part in asset.repo.split("/"))
    revision = quote(asset.revision, safe="")
    url = f"https://huggingface.co/api/models/{repo}/revision/{revision}"
    with public_request(url, method="GET", timeout=timeout) as response:
        if response.status != 200:
            raise InventoryError("metadata_status")
        payload = response.read(_METADATA_LIMIT + 1)
    if len(payload) > _METADATA_LIMIT:
        raise InventoryError("metadata_too_large")
    try:
        data = json.loads(payload, object_pairs_hook=_unique_json)
    except (ValueError, UnicodeError, RecursionError):
        raise InventoryError("invalid_metadata") from None
    if not isinstance(data, dict) or not isinstance(data.get("sha"), str):
        raise InventoryError("missing_revision_sha")
    sha = data["sha"]
    if not re.fullmatch(r"[0-9a-fA-F]{40}", sha):
        raise InventoryError("invalid_revision_sha")
    siblings = data.get("siblings")
    if not isinstance(siblings, list) or not siblings or len(siblings) > _OBJECT_LIMIT:
        raise InventoryError("incomplete_inventory")
    paths = []
    for sibling in siblings:
        if not isinstance(sibling, dict):
            raise InventoryError("invalid_sibling")
        paths.append(_safe_path(sibling.get("rfilename")))
    if len(set(paths)) != len(paths):
        raise InventoryError("duplicate_sibling")
    return sha.lower(), tuple(sorted(paths))


def _plan(base: str, assets: tuple[Asset, ...], timeout: float) -> CheckPlan:
    objects = []
    revisions = []
    for asset in assets:
        paths: tuple[str, ...]
        if isinstance(asset, HttpAsset):
            paths = (asset.filename,)
        else:
            try:
                sha, paths = _inventory(asset, timeout)
            except PublicRequestError as exc:
                raise InventoryError(exc.reason, asset=asset.name, status=exc.status) from None
            except InventoryError as exc:
                raise InventoryError(str(exc), asset=asset.name) from None
            revisions.append(Revision(asset.name, sha))
        for path in paths:
            key = f"{asset.prefix}/{path}"
            objects.append(MirrorObject(asset.name, key, f"{base}/{key}"))
        if len(objects) > _OBJECT_LIMIT:
            raise InventoryError("too_many_objects")
    if len({obj.path for obj in objects}) != len(objects):
        raise InventoryError("duplicate_object")
    return CheckPlan(tuple(objects), tuple(revisions))


def _timeout(value: str) -> float:
    try:
        timeout = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError("timeout must be a number in (0, 60]") from None
    if not math.isfinite(timeout) or not 0 < timeout <= 60:
        raise argparse.ArgumentTypeError("timeout must be a number in (0, 60]")
    return timeout


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="Explicit public HTTPS mirror base")
    parser.add_argument("--manifest", type=Path, default=_DEFAULT_MANIFEST)
    parser.add_argument(
        "--timeout", type=_timeout, default=10.0, help="Socket timeout, (0, 60] seconds"
    )
    args = parser.parse_args()
    try:
        base = _base_url(args.base_url)
        with args.manifest.open("rb") as handle:
            payload = handle.read(_METADATA_LIMIT + 1)
        if len(payload) > _METADATA_LIMIT:
            raise InventoryError("manifest_too_large")
        manifest = json.loads(payload, object_pairs_hook=_unique_json)
        assets = _assets(manifest)
        plan = _plan(base, assets, args.timeout)
    except (OSError, ValueError, RecursionError, PublicRequestError) as exc:
        reason = str(exc) if isinstance(exc, InventoryError) else "invalid_or_unresolved_inventory"
        if isinstance(exc, PublicRequestError):
            reason = exc.reason
        asset = exc.asset if isinstance(exc, InventoryError) else None
        status = exc.status if isinstance(exc, (InventoryError, PublicRequestError)) else None
        print(
            f"inventory asset={asset or 'none'} status={status if status is not None else 'none'} error={reason}"
        )
        print("summary inventory=unresolved checked=0")
        return 2
    for revision in plan.revisions:
        print(f"revision asset={revision.asset} sha={revision.sha}")
    unavailable = 0
    for obj in plan.objects:
        try:
            with public_request(obj.url, method="HEAD", timeout=args.timeout) as response:
                print(f"asset={obj.asset} path={obj.path} status={response.status} available")
        except PublicRequestError as exc:
            unavailable += 1
            status_text = str(exc.status) if exc.status is not None else "none"
            print(f"asset={obj.asset} path={obj.path} status={status_text} error={exc.reason}")
    print(
        f"summary checked={len(plan.objects)} available={len(plan.objects) - unavailable} unavailable={unavailable} integrity=unverified"
    )
    return 1 if unavailable else 0


if __name__ == "__main__":
    raise SystemExit(main())
