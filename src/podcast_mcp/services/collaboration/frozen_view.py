"""The frozen review view: Viewer and Commenter guests see the timeline they hear (#3605).

``ReviewService.publish`` freezes a guest-sanitized ProjectView beside ``mix.wav`` as
``timeline.json`` (``review_versions.version_timeline_snapshot`` reads it). This module
decides who is served it, slices it by projection, and shapes the document-plane frames
a frozen guest may still receive. Editors and the host stay live. A version without a
readable snapshot is served live, so this never fails a guest.
"""

from __future__ import annotations

import os
import threading
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from typing import Any

from podcast_mcp.services.collaboration.review_versions import (
    TIMELINE_SNAPSHOT_FORMAT,
    TIMELINE_SNAPSHOT_NAME,
    review_artifacts_dir,
    version_timeline_snapshot,
)
from podcast_mcp.services.collaboration.share_capabilities import (
    ReviewRole,
    review_role_for_capabilities,
)
from podcast_mcp.services.document_sync import ViewProjection
from podcast_mcp.util.coded_error import CodedPermissionError

FROZEN_CODE = "frozen_review_view"

_FROZEN_ROLES = frozenset({ReviewRole.VIEWER, ReviewRole.COMMENTER})

# Keys the snapshot never holds: comments are live, history is the live head.
_LIVE_ONLY_KEYS = ("comments", "history")

# One table: ProjectView keys a projection takes from the frozen view. ``FULL`` and
# ``SHELL`` take everything; DETAIL carries hydration flags only (guest audience).
_FRESHNESS = ("tracks", "render_status")
PROJECTION_KEYS: Mapping[ViewProjection, tuple[str, ...]] = {
    ViewProjection.TRACKS: ("tracks",),
    ViewProjection.CLIPS: ("clips", *_FRESHNESS),
    ViewProjection.FX: ("effects_by_track", *_FRESHNESS),
    ViewProjection.ENVELOPES: ("envelopes", *_FRESHNESS),
    ViewProjection.MIX: _FRESHNESS,
    ViewProjection.TRANSCRIPT_AUDIO: ("clips", *_FRESHNESS),
}

_NO_WORDS_HYDRATION = {"transcript_words": False, "history_groups": False}

# What a frozen guest's document event keeps: sequence, comments and head bookkeeping.
# Never ``project``, ``patch``, ``delta`` or the guest delta that rides beside them.
_EVENT_SNAPSHOT_KEYS = (
    "server_seq",
    "comments",
    "active_version_id",
    "history",
    "file",
    "file_before",
    "resync",
)

_CACHE_SIZE = 8
_cache: OrderedDict[tuple[str, str], tuple[tuple[int, int, int], dict[str, Any]]] = OrderedDict()
_cache_lock = threading.Lock()


def build_timeline_snapshot(dumped: dict[str, Any]) -> dict[str, Any]:
    """The sidecar body for a FULL guest-audience dump: sanitized, superset of words."""
    from podcast_mcp.services.collaboration.share import sanitize_guest_project_view
    from podcast_mcp.services.collaboration.share_capabilities import GuestWords

    view = sanitize_guest_project_view(dumped, words=GuestWords.SELECTABLE)
    for key in _LIVE_ONLY_KEYS:
        view.pop(key, None)
    return {
        "format": TIMELINE_SNAPSHOT_FORMAT,
        "timeline_duration_sec": float(view.get("timeline_duration_sec") or 0.0),
        "view": view,
    }


def is_frozen_role(caps: Sequence[str] | None) -> bool:
    return review_role_for_capabilities(list(caps or [])) in _FROZEN_ROLES


def _stat_key(path: Any) -> tuple[int, int, int] | None:
    try:
        st = os.stat(path, follow_symlinks=False)
    except OSError:
        return None
    return st.st_ino, st.st_mtime_ns, st.st_size


def frozen_snapshot_for(row: Mapping[str, Any], ws: Any) -> dict[str, Any] | None:
    """The frozen timeline this share row is served, or None for live.

    Only Viewer and Commenter links, and only for a version that holds a readable
    snapshot. Never raises. The returned dict is shared: callers must not mutate it.
    """
    if not is_frozen_role(row.get("capabilities")):
        return None
    version_id = str(row.get("review_version_id") or "")
    if not version_id:
        return None
    project = ws.project
    path = review_artifacts_dir(project) / version_id / TIMELINE_SNAPSHOT_NAME
    key = _stat_key(path)
    if key is None:
        return None
    cache_key = (str(path), version_id)
    with _cache_lock:
        hit = _cache.get(cache_key)
        if hit is not None and hit[0] == key:
            _cache.move_to_end(cache_key)
            return hit[1]
    snapshot = version_timeline_snapshot(project, version_id)
    if snapshot is None:
        return None
    with _cache_lock:
        _cache[cache_key] = (key, snapshot)
        _cache.move_to_end(cache_key)
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return snapshot


def refuse_if_frozen(row: Mapping[str, Any], ws: Any, what: str) -> None:
    """Refuse a live-timeline action for a guest who is served the frozen version."""
    if frozen_snapshot_for(row, ws) is not None:
        raise CodedPermissionError(
            f"{what} is not available on a published version; ask the host for the latest.",
            code=FROZEN_CODE,
        )


def frozen_duration_sec(snapshot: Mapping[str, Any]) -> float | None:
    value = snapshot.get("timeline_duration_sec")
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def _without_words(transcript: Any) -> Any:
    if not isinstance(transcript, dict) or not isinstance(transcript.get("utterances"), list):
        return transcript
    return {
        **transcript,
        "utterances": [
            {k: v for k, v in u.items() if k != "words"} if isinstance(u, dict) else u
            for u in transcript["utterances"]
        ],
    }


def wants_live_history(projection: ViewProjection) -> bool:
    return projection in (ViewProjection.FULL, ViewProjection.SHELL)


def wants_live_comments(projection: ViewProjection) -> bool:
    return projection in (ViewProjection.FULL, ViewProjection.SHELL, ViewProjection.COMMENTS)


def frozen_projection(snapshot: Mapping[str, Any], projection: ViewProjection) -> dict[str, Any]:
    """The frozen slice for *projection*; ``comments`` and ``history`` are the caller's.

    Mirrors ``dump_project_projection`` for a guest: patches carry only their own keys.
    """
    view: Mapping[str, Any] = snapshot["view"]
    if projection is ViewProjection.FULL:
        return dict(view)
    if projection is ViewProjection.SHELL:
        out = dict(view)
        out["transcript"] = _without_words(out.get("transcript"))
        meta = dict(out.get("meta") or {})
        meta["hydration"] = dict(_NO_WORDS_HYDRATION)
        out["meta"] = meta
        return out
    if projection is ViewProjection.COMMENTS:
        return {}
    if projection in (ViewProjection.DETAIL, ViewProjection.TRANSCRIPT_AUDIO):
        out = {"meta": {"hydration": dict(_NO_WORDS_HYDRATION)}}
    else:
        out = {}
    for key in PROJECTION_KEYS.get(projection, ()):
        if key in view:
            out[key] = view[key]
    return out


def frozen_document_snapshot(
    snapshot: Mapping[str, Any], projection: str, comments_snapshot: Mapping[str, Any]
) -> dict[str, Any]:
    """A ``document_snapshot`` whose project or patch is the frozen view.

    *comments_snapshot* is the live ``comments`` projection (sequence, comments, history
    wire), so command sequencing and live comments keep working.
    """
    out = dict(comments_snapshot)
    history = out.get("history") if isinstance(out.get("history"), dict) else {}
    view: Mapping[str, Any] = snapshot["view"]
    if projection == ViewProjection.DETAIL.value:
        out["patch"] = {
            "transcript": view.get("transcript"),
            "history": history,
            "meta": {"hydration": {"transcript_words": True, "history_groups": True}},
        }
        return out
    shape = ViewProjection.FULL if projection == ViewProjection.FULL.value else ViewProjection.SHELL
    project = frozen_projection(snapshot, shape)
    project["history"] = history
    project["comments"] = out.get("comments", [])
    out["project"] = project
    return out


def frozen_guest_event(event: Mapping[str, Any]) -> dict[str, Any]:
    """A live document event reduced for a frozen guest (WS pump).

    The live ``project``, ``patch`` and ``delta`` (and the guest delta beside them) are
    dropped whole; sequence, comments and head bookkeeping stay.
    """
    out = {k: v for k, v in event.items() if k != "_guest_snapshot"}
    snap = out.get("snapshot")
    if isinstance(snap, dict):
        out["snapshot"] = {k: snap[k] for k in _EVENT_SNAPSHOT_KEYS if k in snap}
    return out
