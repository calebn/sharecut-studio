#!/usr/bin/env python3
"""Assemble or extend the Tauri updater ``latest.json`` static feed.

Each platform build contributes one entry (bundle URL plus the contents of its
``.sig`` file).  Runs merge into an existing feed, so the Intel CI leg, the
arm64 leg and Windows can be added independently.  Signatures are public
minisign signatures; the tool never prints them.

Example::

    scripts/build_update_feed.py --version 0.2.0 \\
        --base-url https://cdn.example.test/desktop/0.2.0 \\
        --platform darwin-aarch64=Studio.app.tar.gz \\
        --merge latest.json --output latest.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

# Tauri 2 updater artifacts (bundle.createUpdaterArtifacts = true).
PLATFORM_SUFFIXES: dict[str, tuple[str, ...]] = {
    "darwin-aarch64": (".app.tar.gz",),
    "darwin-x86_64": (".app.tar.gz",),
    "windows-x86_64": ("-setup.exe",),
    "linux-x86_64": (".AppImage",),
}
_SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
_SIGNATURE_MAX_BYTES = 16 * 1024
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class FeedError(ValueError):
    """The feed inputs are unsafe or incomplete."""


def normalize_version(raw: str) -> str:
    version = raw.strip().removeprefix("v")
    if not _SEMVER.fullmatch(version):
        raise FeedError(f"version {raw!r} is not a semantic version")
    return version


def normalize_base_url(raw: str) -> str:
    parsed = urlparse(raw.strip())
    if parsed.scheme != "https" or not parsed.hostname:
        raise FeedError("base URL must be an absolute https:// URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise FeedError("base URL must not contain credentials, a query, or a fragment")
    return raw.strip().rstrip("/")


def read_signature(sig_path: Path) -> str:
    if not sig_path.is_file():
        raise FeedError(f"signature file not found: {sig_path}")
    if sig_path.stat().st_size > _SIGNATURE_MAX_BYTES:
        raise FeedError(f"signature file is too large: {sig_path}")
    text = sig_path.read_text(encoding="utf-8").strip()
    if not text:
        raise FeedError(f"signature file is empty: {sig_path}")
    if _CONTROL.search(text):
        raise FeedError(f"signature file must be a single line of text: {sig_path}")
    return text


def platform_entry(target: str, bundle: Path, base_url: str) -> dict[str, str]:
    suffixes = PLATFORM_SUFFIXES[target]
    if not bundle.name.endswith(suffixes):
        raise FeedError(f"{target} bundle must end with {' or '.join(suffixes)}: {bundle.name}")
    if not bundle.is_file() or bundle.stat().st_size == 0:
        raise FeedError(f"bundle file missing or empty: {bundle}")
    signature = read_signature(bundle.with_name(bundle.name + ".sig"))
    return {"signature": signature, "url": f"{base_url}/{quote(bundle.name)}"}


def parse_platform_args(values: list[str]) -> dict[str, Path]:
    parsed: dict[str, Path] = {}
    for value in values:
        target, sep, path = value.partition("=")
        if not sep or not path:
            raise FeedError(f"--platform expects TARGET=BUNDLE, got {value!r}")
        if target not in PLATFORM_SUFFIXES:
            raise FeedError(
                f"unknown platform {target!r}; use one of {', '.join(PLATFORM_SUFFIXES)}"
            )
        if target in parsed:
            raise FeedError(f"platform given twice: {target}")
        parsed[target] = Path(path)
    return parsed


def load_feed(path: Path) -> dict[str, Any]:
    try:
        feed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FeedError(f"cannot read existing feed {path}: {exc}") from exc
    if not isinstance(feed, dict) or not isinstance(feed.get("platforms"), dict):
        raise FeedError(f"existing feed {path} is not a Tauri updater feed")
    return feed


def validate_feed(feed: dict[str, Any]) -> None:
    normalize_version(str(feed.get("version", "")))
    platforms = feed.get("platforms")
    if not isinstance(platforms, dict) or not platforms:
        raise FeedError("feed needs at least one platform")
    for target, entry in platforms.items():
        if target not in PLATFORM_SUFFIXES:
            raise FeedError(f"unknown platform in feed: {target}")
        url = str(entry.get("url", "")) if isinstance(entry, dict) else ""
        signature = str(entry.get("signature", "")) if isinstance(entry, dict) else ""
        if urlparse(url).scheme != "https":
            raise FeedError(f"{target} url must be https")
        if not signature.strip() or _CONTROL.search(signature):
            raise FeedError(f"{target} signature must be non-empty single-line text")


def build_feed(
    *,
    version: str,
    base_url: str,
    bundles: dict[str, Path],
    existing: dict[str, Any] | None = None,
    notes: str | None = None,
    pub_date: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    version = normalize_version(version)
    base = normalize_base_url(base_url)
    feed: dict[str, Any] = {"platforms": {}}
    if existing is not None:
        if normalize_version(str(existing.get("version", ""))) != version:
            raise FeedError(
                f"existing feed is version {existing.get('version')!r}, not {version!r}; "
                "start a new feed for a new version"
            )
        feed.update({k: existing[k] for k in ("notes", "pub_date") if k in existing})
        feed["platforms"] = dict(existing["platforms"])
    feed["version"] = version
    if notes is not None:
        feed["notes"] = notes
    feed.setdefault("notes", "")
    if pub_date is not None:
        feed["pub_date"] = pub_date
    if "pub_date" not in feed:
        feed["pub_date"] = (now or datetime.now(UTC)).strftime("%Y-%m-%dT%H:%M:%SZ")
    for target, bundle in bundles.items():
        feed["platforms"][target] = platform_entry(target, bundle, base)
    feed["platforms"] = dict(sorted(feed["platforms"].items()))
    validate_feed(feed)
    return {
        "version": feed["version"],
        "notes": feed["notes"],
        "pub_date": feed["pub_date"],
        "platforms": feed["platforms"],
    }


def _check_rfc3339(value: str) -> str:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise FeedError(f"pub_date must be RFC 3339: {value!r}") from exc
    return value


def write_atomic(path: Path, feed: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=path.parent, prefix=".latest-", suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(feed, indent=2) + "\n")
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--version", required=True, help="Release version (semver).")
    parser.add_argument("--base-url", required=True, help="https:// directory holding the bundles.")
    parser.add_argument(
        "--platform",
        action="append",
        default=[],
        metavar="TARGET=BUNDLE",
        help=f"Add an entry; BUNDLE.sig must exist. TARGET: {', '.join(PLATFORM_SUFFIXES)}.",
    )
    parser.add_argument("--merge", type=Path, help="Existing latest.json to extend.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--notes", help="Release notes text.")
    parser.add_argument("--notes-file", type=Path, help="Read release notes from a file.")
    parser.add_argument("--pub-date", help="RFC 3339 publication time (default: kept, else now).")
    args = parser.parse_args(argv)
    try:
        if args.notes is not None and args.notes_file is not None:
            raise FeedError("use --notes or --notes-file, not both")
        notes = args.notes
        if args.notes_file is not None:
            notes = args.notes_file.read_text(encoding="utf-8").strip()
        bundles = parse_platform_args(args.platform)
        if not bundles and args.merge is None:
            raise FeedError("give at least one --platform or --merge")
        feed = build_feed(
            version=args.version,
            base_url=args.base_url,
            bundles=bundles,
            existing=load_feed(args.merge) if args.merge else None,
            notes=notes,
            pub_date=_check_rfc3339(args.pub_date) if args.pub_date else None,
        )
        write_atomic(args.output, feed)
    except (FeedError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"wrote {args.output} (version {feed['version']})")
    for target, entry in feed["platforms"].items():
        print(f"  {target}: {entry['url']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
