"""Relay semantic version and build identity."""

from __future__ import annotations

import os
from pathlib import Path


def _read_version_file(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


def read_relay_version() -> str:
    """Return the relay semver string.

    Preference order:
    1. ``PODCAST_RELAY_VERSION`` env (baked into Docker images)
    2. ``VERSION`` file next to this module (copied into the image)
    3. ``deploy/relay/VERSION`` from the repo root / CWD
    4. ``0.0.0-dev`` fallback (never raises)
    """
    env = (os.environ.get("PODCAST_RELAY_VERSION") or "").strip()
    if env:
        return env

    beside = Path(__file__).with_name("VERSION")
    found = _read_version_file(beside)
    if found:
        return found  # pragma: no cover - Docker image copies VERSION beside module

    # src/podcast_relay/version.py → parents[2] = repo root
    try:
        repo_root = Path(__file__).resolve().parents[2]
        found = _read_version_file(repo_root / "deploy" / "relay" / "VERSION")
        if found:
            return found
    except (IndexError, OSError):  # pragma: no cover
        pass

    found = _read_version_file(Path.cwd() / "deploy" / "relay" / "VERSION")
    if found:
        return found  # pragma: no cover - CWD layout when installed oddly

    return "0.0.0-dev"


def read_relay_git_sha() -> str | None:
    """Return the git SHA baked at image build, or None locally."""
    sha = (os.environ.get("PODCAST_RELAY_GIT_SHA") or "").strip()
    return sha or None
