"""The drift classifier: one segment ref against facts the caller read from the library.

A clip made by an insert carries ``(segment_id, version, content_sha256)``. Identity is the
content: version numbers can be reused after a hand delete or a remove and re-import.
Judged from ``segment.json`` and file sizes only, never audio hashes.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from podcast_mcp.models.episode import SegmentRef
from podcast_mcp.segments.model import SegmentFile

DriftState = Literal["current", "newer", "changed", "missing", "damaged"]


@dataclass(frozen=True)
class ReadFailure:
    """A stored version that could not be read, with the code the store raised."""

    code: str
    problem: str


@dataclass(frozen=True)
class DriftVerdict:
    state: DriftState
    library_version: int | None
    code: str | None = None
    problem: str | None = None


def classify(
    ref: SegmentRef,
    versions: Sequence[int],
    newest: SegmentFile | ReadFailure | None,
    own: SegmentFile | ReadFailure | None,
) -> DriftVerdict:
    """One ref against the library.

    ``versions`` is ``SegmentStore.versions()``, sorted, newest last. ``newest`` is the read of
    the last version and ``own`` the read of ``ref.version``; ``own`` is only consulted when
    ``versions`` lists ``ref.version``. ``library_version`` is the newest number, even when
    that version is the damaged one.
    """
    if not versions or newest is None:
        return DriftVerdict(
            "missing",
            None,
            "segment_unknown",
            f"There is no segment called {ref.segment_id}.",
        )
    latest = versions[-1]
    if isinstance(newest, ReadFailure):
        return DriftVerdict(
            "damaged", latest, newest.code, f"Version {latest} (newest): {newest.problem}"
        )
    listed = ref.version in versions
    if listed and isinstance(own, ReadFailure):
        return DriftVerdict(
            "damaged", latest, own.code, f"Version {ref.version} (the one used): {own.problem}"
        )
    if newest.content_sha256 == ref.content_sha256:
        return DriftVerdict("current", latest)
    if not listed or not isinstance(own, SegmentFile):
        return DriftVerdict(
            "missing",
            latest,
            "segment_unknown",
            f"Version {ref.version} is not in the library.",
        )
    if own.content_sha256 != ref.content_sha256:
        return DriftVerdict("changed", latest)
    return DriftVerdict("newer", latest)
