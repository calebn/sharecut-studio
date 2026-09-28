"""Document-plane transcript correction / suppress handlers."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from podcast_mcp.edits.transcript_correct import TranscriptTextChangedError
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.edit import EditService
from podcast_mcp.services.workspace import ProjectWorkspace

Handler = Callable[[ProjectWorkspace, dict[str, Any]], dict[str, Any]]


def _expected_text(p: dict[str, Any]) -> str | None:
    value = p.get("expected_text")
    return None if value is None else str(value)


@contextmanager
def _stale_text_is_conflict() -> Iterator[None]:
    """A correction whose words changed since the client read them is a 409 (#650).

    Runs inside ``DocumentSyncService.submit``'s ``ProjectWorkspace.transaction()``, so the
    check and the mutation are one critical section; a conflict raises before mutation,
    history, or the command log (same contract as ``set_envelope``).
    """
    try:
        yield
    except TranscriptTextChangedError as exc:
        raise DocumentConflictError(str(exc)) from exc


def correct_transcript_word(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    track_id = str(p["track_id"])
    word_index = int(p["word_index"])
    text = str(p["text"])
    with _stale_text_is_conflict():
        EditService(ws).correct_word(track_id, word_index, text, expected_text=_expected_text(p))
    return {"track_id": track_id, "word_index": word_index, "text": text}


def correct_transcript_phrase(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    track_id = str(p["track_id"])
    start_word_index = int(p["start_word_index"])
    end_word_index = int(p["end_word_index"])
    text = str(p["text"])
    with _stale_text_is_conflict():
        EditService(ws).correct_phrase(
            track_id, start_word_index, end_word_index, text, expected_text=_expected_text(p)
        )
    return {
        "track_id": track_id,
        "start_word_index": start_word_index,
        "end_word_index": end_word_index,
        "text": text,
    }


def set_transcript_word_suppressed(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).set_word_suppressed(
        track_id=str(p["track_id"]),
        word_index=int(p["word_index"]),
        suppressed=bool(p["suppressed"]),
    )


def set_transcript_words_ignored(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).set_words_ignored(
        track_id=str(p["track_id"]),
        start_word_index=int(p["start_word_index"]),
        end_word_index=int(p["end_word_index"]),
        ignored=bool(p["ignored"]),
    )


HANDLERS: dict[str, Handler] = {
    "CorrectTranscriptWord": correct_transcript_word,
    "CorrectTranscriptPhrase": correct_transcript_phrase,
    "SetTranscriptWordSuppressed": set_transcript_word_suppressed,
    "SetTranscriptWordsIgnored": set_transcript_words_ignored,
}
