#!/usr/bin/env python3
"""Check that every shipped version agrees and stays below 1.0.0.

release-please bumps the version files together on the release PR. This guard fails
when one of them drifts, and when the version reaches 1.0.0 before the owner decides to.
To go 1.0, change ``MAX_MAJOR`` in this file on purpose.
"""

from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAX_MAJOR = 0
_SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def _cargo_lock_version(path: Path, package: str) -> str:
    for entry in tomllib.loads(path.read_text())["package"]:
        if entry["name"] == package:
            return entry["version"]
    raise KeyError(package)


def versions(root: Path = ROOT) -> dict[str, str]:
    desktop = root / "gui" / "desktop"
    tauri = desktop / "src-tauri"
    init = (root / "src" / "podcast_mcp" / "__init__.py").read_text()
    module = re.search(r'^__version__ = "([^"]+)"', init, re.MULTILINE)
    package_lock = json.loads((desktop / "package-lock.json").read_text())
    return {
        "pyproject.toml": tomllib.loads((root / "pyproject.toml").read_text())["project"][
            "version"
        ],
        "src/podcast_mcp/__init__.py": module.group(1) if module else "<missing>",
        "gui/desktop/package.json": json.loads((desktop / "package.json").read_text())["version"],
        "gui/desktop/package-lock.json": package_lock["version"],
        'gui/desktop/package-lock.json packages[""]': package_lock["packages"][""]["version"],
        "gui/desktop/src-tauri/Cargo.toml": tomllib.loads((tauri / "Cargo.toml").read_text())[
            "package"
        ]["version"],
        "gui/desktop/src-tauri/Cargo.lock": _cargo_lock_version(tauri / "Cargo.lock", "sharecut"),
        "gui/desktop/src-tauri/tauri.conf.json": json.loads(
            (tauri / "tauri.conf.json").read_text()
        )["version"],
        ".release-please-manifest.json": json.loads(
            (root / ".release-please-manifest.json").read_text()
        )["."],
    }


def problems(found: dict[str, str]) -> list[str]:
    out: list[str] = []
    if len(set(found.values())) > 1:
        width = max(map(len, found))
        out.append(
            "versions disagree:\n" + "\n".join(f"  {k:<{width}}  {v}" for k, v in found.items())
        )
    for where, version in found.items():
        match = _SEMVER.fullmatch(version)
        if not match:
            out.append(
                f"{where}: {version!r} is not plain MAJOR.MINOR.PATCH (installers reject suffixes)"
            )
        elif int(match.group(1)) > MAX_MAJOR:
            out.append(
                f"{where}: {version} is past the 0.x cap; going to 1.0 is a deliberate change to MAX_MAJOR"
            )
    return out


def main() -> int:
    found = versions()
    errors = problems(found)
    for error in errors:
        print(error, file=sys.stderr)
    if not errors:
        print(f"version {next(iter(found.values()))}: all {len(found)} locations agree")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
