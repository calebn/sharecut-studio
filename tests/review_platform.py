"""Shared skip markers for review-publication tests gated on platform support.

``podcast_mcp.edits.review_versions`` fails closed on platforms without safe,
descriptor-relative directory operations (Windows): staging, quarantine and
stale-cleanup paths all require ``_SAFE_STALE_CLEANUP_SUPPORTED`` /
``_SAFE_FAILED_CLEANUP_SUPPORTED``. Tests that exercise those paths import the
markers below instead of redefining them, so ``tests/test_project_commit_lock.py``
and ``tests/test_review_versions.py`` skip the same way on an unsupported platform.
"""

from __future__ import annotations

import pytest

from podcast_mcp.edits import review_versions

requires_safe_cleanup = pytest.mark.skipif(
    not review_versions._SAFE_STALE_CLEANUP_SUPPORTED,
    reason="descriptor-relative directory operations are unavailable",
)

requires_safe_failed_cleanup = pytest.mark.skipif(
    not review_versions._SAFE_FAILED_CLEANUP_SUPPORTED,
    reason="descriptor-relative directory operations are unavailable",
)
