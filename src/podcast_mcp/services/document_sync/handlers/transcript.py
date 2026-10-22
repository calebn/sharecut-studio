"""Document-plane transcript correction / suppress handlers."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from podcast_mcp.edits.transcript_timing import WordTimingTarget
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TranscriptService

Handler = Callable[[ProjectWorkspace, dict[str, Any]], dict[str, Any]]


def _expected_text(p: dict[str, Any]) -> str | None:
    value = p.get("expected_text")
    return None if value is None else str(value)


def _source_id(p: dict[str, Any]) -> str | None:
    value = p.get("source_id")
    return None if value is None else str(value)


def replace_transcript_matches(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    count = TranscriptService(ws).replace_transcript_matches(
        str(p["search"]),
        str(p["replacement"]),
        str(p["preview_token"]),
        match_case=bool(p["match_case"]),
    )
    return {"replaced": count}


def correct_transcript_word(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    track_id = str(p["track_id"])
    word_index = int(p["word_index"])
    text = str(p["text"])
    TranscriptService(ws).correct_word(
        track_id, word_index, text, expected_text=_expected_text(p), source_id=_source_id(p)
    )
    return {
        "track_id": track_id,
        "source_id": _source_id(p),
        "word_index": word_index,
        "text": text,
    }


def correct_transcript_phrase(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    track_id = str(p["track_id"])
    start_word_index = int(p["start_word_index"])
    end_word_index = int(p["end_word_index"])
    text = str(p["text"])
    TranscriptService(ws).correct_phrase(
        track_id,
        start_word_index,
        end_word_index,
        text,
        expected_text=_expected_text(p),
        source_id=_source_id(p),
    )
    return {
        "track_id": track_id,
        "source_id": _source_id(p),
        "start_word_index": start_word_index,
        "end_word_index": end_word_index,
        "text": text,
    }


def set_transcript_word_suppressed(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TranscriptService(ws).set_word_suppressed(
        track_id=str(p["track_id"]),
        word_index=int(p["word_index"]),
        suppressed=bool(p["suppressed"]),
        expected_text=_expected_text(p),
        source_id=_source_id(p),
    )


def set_transcript_word_automatic(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TranscriptService(ws).set_word_automatic(
        track_id=str(p["track_id"]),
        word_index=int(p["word_index"]),
        expected_text=_expected_text(p),
        source_id=_source_id(p),
    )


def set_transcript_words_ignored(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TranscriptService(ws).set_words_ignored(
        track_id=str(p["track_id"]),
        start_word_index=int(p["start_word_index"]),
        end_word_index=int(p["end_word_index"]),
        ignored=bool(p["ignored"]),
        expected_text=_expected_text(p),
        source_id=_source_id(p),
    )


def set_transcript_word_timing(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TranscriptService(ws).set_word_timing(
        WordTimingTarget(**p["target"]), p["expected_token"], p["start"], p["end"]
    )


def apply_transcript_cleanup(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    track_id = str(p["track_id"])
    applied = TranscriptService(ws).apply_transcript_cleanup(
        track_id, words=p.get("words"), phrases=p.get("phrases")
    )
    return {"track_id": track_id, "applied": applied}


def verify_transcript(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    verified = TranscriptService(ws).verify_transcript(str(p["track_id"]), list(p["corrections"]))
    return {"verified": verified}


HANDLERS: dict[str, Handler] = {
    "SetTranscriptWordTiming": set_transcript_word_timing,
    "ReplaceTranscriptMatches": replace_transcript_matches,
    "CorrectTranscriptWord": correct_transcript_word,
    "ApplyTranscriptCleanup": apply_transcript_cleanup,
    "VerifyTranscript": verify_transcript,
    "CorrectTranscriptPhrase": correct_transcript_phrase,
    "SetTranscriptWordSuppressed": set_transcript_word_suppressed,
    "SetTranscriptWordAutomatic": set_transcript_word_automatic,
    "SetTranscriptWordsIgnored": set_transcript_words_ignored,
}
