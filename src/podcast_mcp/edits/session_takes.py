"""The takes of a staged replace session: what the switcher lists and the write that picks one."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.insert_anchor import resolve_range
from podcast_mcp.edits.session_suggestions import (
    _check_take,
    _chosen_take,
    _require_pending,
    chosen_take_for_preview,
    find_session_suggestion,
    staged_span_s,
)
from podcast_mcp.models import EpisodeProject, SessionSuggestion, StagedTake, TranscriptWord
from podcast_mcp.util.coded_error import CodedError

SNIPPET_MAX_WORDS = 14
SNIPPET_MAX_CHARS = 120


def _take_words(project: EpisodeProject, takes: list[StagedTake]) -> list[TranscriptWord] | None:
    """The spoken words of a take's segments in order, or None when none are transcribed.

    A staged recording is transcribed only if something transcribed its source, so a take
    nobody has transcribed has no words to count, which is not the same as zero words.
    """
    found = False
    words: list[TranscriptWord] = []
    for take in sorted(takes, key=lambda item: (item.offset_s, item.segment_index)):
        for transcript in project.transcripts:
            if transcript.track_id == take.track_id and transcript.source_id == take.source_id:
                found = True
                words.extend(word for word in transcript.words if not word.suppressed)
    return words if found else None


def _snippet(words: list[TranscriptWord]) -> str:
    text = " ".join(word.text.strip() for word in words[:SNIPPET_MAX_WORDS]).strip()
    clipped = len(words) > SNIPPET_MAX_WORDS
    if len(text) > SNIPPET_MAX_CHARS:
        text, clipped = text[:SNIPPET_MAX_CHARS].rstrip(), True
    return f"{text}…" if clipped else text


def _track_rows(takes: list[StagedTake]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for track_id in sorted({take.track_id for take in takes}):
        mine = [take for take in takes if take.track_id == track_id]
        rows.append(
            {
                "track_id": track_id,
                "track_label": mine[0].track_label,
                "duration_s": staged_span_s((t.offset_s, t.duration_s) for t in mine),
                "segments": len(mine),
            }
        )
    return rows


def session_takes(project: EpisodeProject, suggestion_id: str) -> dict[str, Any]:
    """The takes of a staged session for a switcher, in take order.

    ``default`` is the take Accept places when none is named (``chosen_take_for_preview`` with
    no take), and ``chosen`` marks the one a person picked (``selected_take``), so the list,
    the preview and Accept name the same take. A take Accept would refuse carries that refusal
    (``refusal``) instead of being left out. An insert has one run of takes played in order, so
    it has nothing to pick: ``selectable`` is false and no take is default. ``selectable`` is
    also false for a session that is not pending (it is decided, and every take then reports
    ``acceptable: false`` with ``session_suggestion_not_pending``) and for a replace with a
    single take. A pick that no longer names a staged take (its recordings were deleted) is
    not reported.
    """
    row = find_session_suggestion(project, suggestion_id)
    indexes = sorted({take.take_index for take in row.takes})
    selected = row.selected_take if row.selected_take in indexes else None
    replace = row.kind == "replace"
    default = _chosen_take(row, None) if replace and indexes else None
    rows: list[dict[str, Any]] = []
    for index in indexes:
        takes = [take for take in row.takes if take.take_index == index]
        words = _take_words(project, takes)
        refusal = _refusal(project, row, index, replace=replace)
        rows.append(
            {
                "take_index": index,
                "duration_s": staged_span_s((t.offset_s, t.duration_s) for t in takes),
                "tracks": _track_rows(takes),
                "word_count": None if words is None else len(words),
                "speech_text": None if not words else _snippet(words),
                "chosen": replace and selected == index,
                "default": replace and default == index,
                "acceptable": refusal is None,
                "refusal": refusal,
            }
        )
    return {
        "suggestion_id": row.id,
        "kind": row.kind,
        "status": row.status,
        "selectable": replace and row.status == "pending" and len(indexes) > 1,
        "selected_take": selected if replace else None,
        "default_take": default,
        "takes": rows,
    }


def _refusal(
    project: EpisodeProject, row: SessionSuggestion, index: int, *, replace: bool
) -> dict[str, str] | None:
    try:
        _require_pending(row)
        if replace:
            _check_take(project, row, index)
    except CodedError as refused:
        return {"code": str(refused.code), "message": str(refused)}
    return None


def select_session_take(
    project: EpisodeProject, suggestion_id: str, take_index: int
) -> dict[str, Any]:
    """Make ``take_index`` the take Accept places for a pending replace; give Accept's refusals.

    Refuses a session that is not pending, an insert (``take_not_applicable``), an unknown
    take (``take_not_found``), a take Accept would refuse, and a range that has gone stale.
    """
    row = find_session_suggestion(project, suggestion_id)
    # An insert raises take_not_applicable here, so a take comes back for a replace only.
    chosen = chosen_take_for_preview(project, row, take_index)
    resolve_range(project, row)
    row.selected_take = chosen
    return {"suggestion": row.model_dump(mode="json"), "selected_take": chosen}
