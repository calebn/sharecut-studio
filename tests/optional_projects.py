"""Resolve optional external episode projects without machine-specific paths.

Benchmarks that need a full local session (e.g. sibling ``podcast-cleanup-test``)
must not hard-code ``/Users/...``. Prefer:

1. ``PODCAST_CLEANUP_TEST_PROJECT`` — path to ``episode.project.json`` (or its dir)
2. Sibling checkout: ``<repo-parent>/podcast-cleanup-test/episode.project.json``
"""

from __future__ import annotations

import os
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]


def cleanup_test_project() -> Path | None:
    """Return ``podcast-cleanup-test`` episode JSON if available, else ``None``."""
    override = os.environ.get("PODCAST_CLEANUP_TEST_PROJECT")
    if override:
        path = Path(override).expanduser()
        if path.is_dir():
            path = path / "episode.project.json"
        path = path.resolve()
        return path if path.is_file() else None
    sibling = _REPO_ROOT.parent / "podcast-cleanup-test" / "episode.project.json"
    return sibling if sibling.is_file() else None
