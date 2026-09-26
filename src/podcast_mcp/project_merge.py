"""Three-way merge of saved episode projects.

Long jobs (a pipeline run, an export) work on their own copy of the project for
minutes. When they save, ``ProjectWorkspace.save_merged`` merges the job's
changes (base -> ours) with what other writers committed meanwhile
(base -> theirs) instead of overwriting them.
"""

from __future__ import annotations

from typing import Any

from podcast_mcp.models import EpisodeProject

# Lists of objects merge item by item when every item carries one of these keys
# (first match wins) as strings, unique within each list. Other lists (e.g.
# transcript words) merge as one value, so changes on both sides conflict.
_IDENTITY_KEYS: tuple[tuple[str, ...], ...] = (("id",), ("track_id", "parameter"), ("track_id",))
_HISTORY = "history"
# Conflict path: one side undid/redid past the checkpoint state while the other recorded.
HISTORY_LINEAGE_CONFLICT = "history.lineage"
# Conflict path: both sides moved the undo cursor (undo/redo) to different entries.
HISTORY_CURSOR_CONFLICT = "history.cursor"
_UNDO_REDO_CONFLICTS = frozenset({HISTORY_LINEAGE_CONFLICT, HISTORY_CURSOR_CONFLICT})


class _Missing:
    def __repr__(self) -> str:
        return "<missing>"


_MISSING: Any = _Missing()


class ProjectMergeConflict(RuntimeError):
    """Another writer changed a value this job changed too; nothing was saved."""

    def __init__(self, paths: list[str]) -> None:
        self.paths = paths
        shown = ", ".join(paths[:5])
        if len(paths) > 5:
            shown += f" and {len(paths) - 5} more"
        what = (
            "an undo or redo changed the project"
            if _UNDO_REDO_CONFLICTS.intersection(paths)
            else "project changed"
        )
        super().__init__(f"{what} while this job ran, conflicting at {shown}; re-run it")


def project_merge_data(project: EpisodeProject) -> dict[str, Any]:
    """The project as merge input: the JSON shape it is saved in."""
    return project.model_dump(mode="json", by_alias=True)


def merge_project_data(
    base: dict[str, Any], ours: dict[str, Any], theirs: dict[str, Any]
) -> dict[str, Any]:
    """Merge ``ours`` and ``theirs``, both changed from ``base``; raise on a conflict."""
    conflicts: list[str] = []
    rest = [{k: v for k, v in side.items() if k != _HISTORY} for side in (base, ours, theirs)]
    merged = _merge(rest[0], rest[1], rest[2], "", conflicts)
    history = _merge_history(
        base.get(_HISTORY) or {}, ours.get(_HISTORY) or {}, theirs.get(_HISTORY) or {}, conflicts
    )
    if conflicts:
        raise ProjectMergeConflict(conflicts)
    merged[_HISTORY] = history
    return merged


def _merge(base: Any, ours: Any, theirs: Any, path: str, conflicts: list[str]) -> Any:
    if ours == theirs or theirs == base:
        return ours
    if ours == base:
        return theirs
    if isinstance(base, dict) and isinstance(ours, dict) and isinstance(theirs, dict):
        return _merge_dicts(base, ours, theirs, path, conflicts)
    if isinstance(base, list) and isinstance(ours, list) and isinstance(theirs, list):
        key = _identity_key(base, ours, theirs)
        if key is not None:
            return _merge_keyed_lists(base, ours, theirs, key, path, conflicts)
    conflicts.append(path or "(project)")
    return ours


def _merge_dicts(base, ours, theirs, path, conflicts) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in [*ours, *(k for k in theirs if k not in ours)]:
        value = _merge(
            base.get(key, _MISSING),
            ours.get(key, _MISSING),
            theirs.get(key, _MISSING),
            f"{path}.{key}" if path else key,
            conflicts,
        )
        if value is not _MISSING:
            out[key] = value
    return out


def _identity_key(*lists: list[Any]) -> tuple[str, ...] | None:
    for key in _IDENTITY_KEYS:
        if all(_keyed_uniquely(items, key) for items in lists):
            return key
    return None


def _keyed_uniquely(items: list[Any], key: tuple[str, ...]) -> bool:
    seen: set[tuple[str, ...]] = set()
    for item in items:
        if not isinstance(item, dict) or not all(isinstance(item.get(k), str) for k in key):
            return False
        ident = tuple(item[k] for k in key)
        if ident in seen:
            return False
        seen.add(ident)
    return True


def _merge_keyed_lists(base, ours, theirs, key, path, conflicts) -> list[Any]:
    def index(items: list[dict[str, Any]]) -> dict[tuple[str, ...], dict[str, Any]]:
        return {tuple(item[k] for k in key): item for item in items}

    b, o, t = index(base), index(ours), index(theirs)
    # Keep theirs' order (e.g. a track reorder) unless this job reordered too.
    ours_kept_order = [i for i in o if i in b] == [i for i in b if i in o]
    primary, secondary = (t, o) if ours_kept_order else (o, t)
    out: list[Any] = []
    for ident in [*primary, *(i for i in secondary if i not in primary)]:
        value = _merge(
            b.get(ident, _MISSING),
            o.get(ident, _MISSING),
            t.get(ident, _MISSING),
            f"{path}[{'/'.join(ident)}]",
            conflicts,
        )
        if value is not _MISSING:
            out.append(value)
    return out


def _cursor_id(history: dict[str, Any]) -> str | None:
    entries = history.get("entries") or []
    cursor = history.get("cursor", -1)
    return entries[cursor]["id"] if 0 <= cursor < len(entries) else None


def _descends_from_base(base: dict[str, Any], side: dict[str, Any]) -> bool:
    """True when ``side``'s current state still builds on base's: base's cursor entry
    is kept and sits at or before ``side``'s cursor (no undo past it, no truncation)."""
    base_id = _cursor_id(base)
    if base_id is None:
        return True
    ids = [e["id"] for e in side.get("entries") or []]
    return base_id in ids and ids.index(base_id) <= side.get("cursor", -1)


def _merge_history(base, ours, theirs, conflicts) -> dict[str, Any]:
    """Union both sides' undo entries; new ones go after the shared ones, oldest first.

    The cursor lands on the newest entry when either side added one (the caller
    records the merged state right after); otherwise it follows whichever side
    moved it.

    Conflicts (``history.lineage``) when one side added entries while the other undid
    past, or truncated, the base cursor entry.
    """
    base_entries = base.get("entries") or []
    base_ids = {e["id"] for e in base_entries}
    ours_added = any(e["id"] not in base_ids for e in ours.get("entries") or [])
    theirs_added = any(e["id"] not in base_ids for e in theirs.get("entries") or [])
    if (ours_added and not _descends_from_base(base, theirs)) or (
        theirs_added and not _descends_from_base(base, ours)
    ):
        # One side undid/redid back past the base state while the other recorded on
        # top of it: interleaving the entries would put undone edits back in the lineage.
        conflicts.append(HISTORY_LINEAGE_CONFLICT)
    entries = _merge(
        base_entries,
        ours.get("entries") or [],
        theirs.get("entries") or [],
        "history.entries",
        conflicts,
    )
    kept = [e for e in entries if e["id"] in base_ids]
    new = sorted(
        (e for e in entries if e["id"] not in base_ids), key=lambda e: e.get("created_at") or ""
    )
    entries = kept + new
    if new:
        cursor = len(entries) - 1
    else:
        chosen = _merge(
            _cursor_id(base),
            _cursor_id(ours),
            _cursor_id(theirs),
            HISTORY_CURSOR_CONFLICT,
            conflicts,
        )
        ids = [e["id"] for e in entries]
        cursor = ids.index(chosen) if chosen in ids else len(entries) - 1
    return {**ours, "entries": entries, "cursor": cursor}
