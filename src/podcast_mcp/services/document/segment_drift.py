"""Each inserted segment judged against the library; read-only, nothing is journaled."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

from podcast_mcp.models.episode import ProjectUnreadableError, SegmentRef
from podcast_mcp.segments.drift import DriftVerdict, ReadFailure, classify
from podcast_mcp.segments.model import SegmentFile
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.segments.summary import drift_rows
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.coded_error import CodedError, CodedValueError

_ATTEMPTS = 3


class _Library:
    """The store as one drift call sees it: each version list and read is made once."""

    def __init__(self, store: SegmentStore) -> None:
        self._store = store
        self._versions: dict[str, Sequence[int]] = {}
        self._reads: dict[tuple[str, int], SegmentFile | ReadFailure] = {}

    def versions(self, segment_id: str) -> Sequence[int]:
        if segment_id not in self._versions:
            self._versions[segment_id] = self._store.versions(segment_id)
        return self._versions[segment_id]

    def read(self, segment_id: str, version: int) -> SegmentFile | ReadFailure:
        key = (segment_id, version)
        if key not in self._reads:
            try:
                self._reads[key] = self._store.read_version(segment_id, version)
            except CodedValueError as exc:
                self._reads[key] = ReadFailure(exc.code, str(exc))
            except OSError as exc:
                self._reads[key] = ReadFailure(
                    "segment_unreadable", f"The segment cannot be read: {exc.strerror or exc}."
                )
        return self._reads[key]

    def gone(self, segment_id: str, version: int) -> bool:
        return not (self._store.directory / segment_id / f"v{version}").exists()

    def forget(self, segment_id: str) -> None:
        self._versions.pop(segment_id, None)
        for key in [k for k in self._reads if k[0] == segment_id]:
            del self._reads[key]


def _verdict(library: _Library, ref: SegmentRef) -> DriftVerdict | None:
    """The verdict for one ref, or ``None`` when its segment cannot be listed (as ``scan()``)."""
    for attempt in range(_ATTEMPTS):
        last = attempt == _ATTEMPTS - 1
        try:
            versions = library.versions(ref.segment_id)
        except OSError:
            library.forget(ref.segment_id)
            if last:
                return None
            continue
        if not versions:
            return classify(ref, versions, None, None)
        newest = library.read(ref.segment_id, versions[-1])
        own = library.read(ref.segment_id, ref.version) if ref.version in versions else None
        vanished = [
            version
            for version, read in ((versions[-1], newest), (ref.version, own))
            if isinstance(read, ReadFailure) and library.gone(ref.segment_id, version)
        ]
        if vanished:
            library.forget(ref.segment_id)
            if last:
                return classify(ref, [], None, None)
            continue
        return classify(ref, versions, newest, own)
    raise AssertionError("unreachable")


def report_segment_drift(
    project_path: Path | str, store: SegmentStore | None = None
) -> list[dict[str, Any]]:
    """One row per distinct segment ref in the episode, judged against the library.

    The project is opened with ``adopt=False`` and never written. A segment whose version list
    cannot be read after three tries is left out, as ``scan()`` does.
    """
    library = _Library(store if store is not None else SegmentStore())
    try:
        workspace = ProjectWorkspace.open(project_path, adopt=False)
    except CodedError:
        raise
    except ValueError as exc:
        raise ProjectUnreadableError(
            "The project file is damaged and could not be read (unexpected contents). "
            "Restore it from a backup, or open a copy of the project."
        ) from exc
    clips_by_ref: dict[SegmentRef, list[str]] = {}
    for clip in workspace.project.clips:
        if clip.segment_ref is not None:
            clips_by_ref.setdefault(clip.segment_ref, []).append(clip.id)
    judged = ((ref, clip_ids, _verdict(library, ref)) for ref, clip_ids in clips_by_ref.items())
    return drift_rows((ref, clip_ids, verdict) for ref, clip_ids, verdict in judged if verdict)
