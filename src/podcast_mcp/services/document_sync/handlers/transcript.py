"""Document-plane transcript correction / suppress handlers."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from podcast_mcp.services.edit import EditService
from podcast_mcp.services.workspace import ProjectWorkspace

Handler = Callable[[ProjectWorkspace, dict[str, Any]], dict[str, Any]]


def _expected_text(p: dict[str, Any]) -> str | None:
    value = p.get("expected_text")
    return None if value is None else str(value)


def correct_transcript_word(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    track_id = str(p["track_id"])
    word_index = int(p["word_index"])
    text = str(p["text"])
    EditService(ws).correct_word(track_id, word_index, text, expected_text=_expected_text(p))
    return {"track_id": track_id, "word_index": word_index, "text": text}


def correct_transcript_phrase(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    track_id = str(p["track_id"])
    start_word_index = int(p["start_word_index"])
    end_word_index = int(p["end_word_index"])
    text = str(p["text"])
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
        expected_text=_expected_text(p),
    )


def set_transcript_word_automatic(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).set_word_automatic(
        track_id=str(p["track_id"]),
        word_index=int(p["word_index"]),
        expected_text=_expected_text(p),
    )


def set_transcript_words_ignored(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).set_words_ignored(
        track_id=str(p["track_id"]),
        start_word_index=int(p["start_word_index"]),
        end_word_index=int(p["end_word_index"]),
        ignored=bool(p["ignored"]),
        expected_text=_expected_text(p),
    )


HANDLERS: dict[str, Handler] = {
    "CorrectTranscriptWord": correct_transcript_word,
    "CorrectTranscriptPhrase": correct_transcript_phrase,
    "SetTranscriptWordSuppressed": set_transcript_word_suppressed,
    "SetTranscriptWordAutomatic": set_transcript_word_automatic,
    "SetTranscriptWordsIgnored": set_transcript_words_ignored,
}
