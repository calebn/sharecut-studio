"""Shared skip markers for review-publication tests gated on platform support.

``podcast_mcp.edits.review_versions`` fails closed on platforms without safe,
descriptor-relative directory operations (Windows): staging, quarantine and
stale-cleanup paths all require ``_SAFE_STALE_CLEANUP_SUPPORTED`` /
``_SAFE_FAILED_CLEANUP_SUPPORTED``. Tests that exercise those paths import the
markers below instead of redefining them, so ``tests/test_project_commit_lock.py``
and ``tests/test_review_versions.py`` skip the same way on an unsupported platform.
Modules that import the markers also wrap run_unmarked_test_as_unsupported_platform
in an autouse fixture, so an unmarked test runs as it would on Windows on every
platform.
"""

from __future__ import annotations

import pytest

from podcast_mcp.edits import review_versions

# Import-time values: the autouse helper below patches the module flags per test.
REVIEW_STALE_CLEANUP_SUPPORTED = review_versions._SAFE_STALE_CLEANUP_SUPPORTED
REVIEW_FAILED_CLEANUP_SUPPORTED = review_versions._SAFE_FAILED_CLEANUP_SUPPORTED

requires_safe_cleanup = pytest.mark.skipif(
    not REVIEW_STALE_CLEANUP_SUPPORTED,
    reason="descriptor-relative directory operations are unavailable",
)

requires_safe_failed_cleanup = pytest.mark.skipif(
    not REVIEW_FAILED_CLEANUP_SUPPORTED,
    reason="descriptor-relative directory operations are unavailable",
)

_PLATFORM_MARKS = (requires_safe_cleanup.mark, requires_safe_failed_cleanup.mark)


def run_unmarked_test_as_unsupported_platform(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Force publication support off for a test that carries neither platform marker.

    An unmarked test must be portable, because on Windows it runs with both flags False.
    Forcing them off everywhere makes a test that reaches review staging without
    ``requires_safe_failed_cleanup`` fail on POSIX machines too, not only on
    ``desktop.yml``'s ``project-commit-lock-windows`` job.
    """
    if any(mark in _PLATFORM_MARKS for mark in request.node.iter_markers(name="skipif")):
        return
    monkeypatch.setattr(review_versions, "_SAFE_STALE_CLEANUP_SUPPORTED", False)
    monkeypatch.setattr(review_versions, "_SAFE_FAILED_CLEANUP_SUPPORTED", False)
