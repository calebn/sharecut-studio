from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptWord
from podcast_mcp.util.text import collapse_whitespace, has_meaningful_text

T = TypeVar("T")


def run_user_transcript_edit(
    project: EpisodeProject, track_id: str, edit: Callable[[EpisodeProject], T]
) -> T:
    """Run a person's or agent's edit on ``track_id``'s transcript and flag it ``user_edited``.

    Flags only the transcript the edit functions resolve (``transcript_for_track``) and only
    when its words changed. Automated passes (precorrect, reconcile, speaker attribution,
    audio-quality and bleed suppression) call the edit functions directly and stay unflagged:
    re-running the pipeline re-derives them.
    """
    tr = project.transcript_for_track(track_id)
    before = list(tr.words) if tr is not None else []
    result = edit(project)
    after = project.transcript_for_track(track_id)
    if after is not None and after.words != before:
        after.user_edited = True
    return result


class TranscriptTextChangedError(ValueError):
    """A correction's word indices no longer hold the text the client saw (#650)."""


def require_word_text(
    project: EpisodeProject,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    expected_text: str | None,
) -> None:
    """Raise ``TranscriptTextChangedError`` unless words ``start..end`` still read ``expected_text``.

    ``None`` skips the check. Whitespace is collapsed on both sides; case and punctuation
    must match. A missing transcript or out-of-range indices are left to the correction
    itself, which raises its usual ``ValueError``.
    """
    if expected_text is None:
        return
    tr = project.transcript_for_track(track_id)
    if tr is None or not 0 <= start_word_index <= end_word_index < len(tr.words):
        return
    current = " ".join(w.text for w in tr.words[start_word_index : end_word_index + 1])
    if collapse_whitespace(current) == collapse_whitespace(expected_text):
        return
    span = (
        f"word {start_word_index}"
        if start_word_index == end_word_index
        else f"words {start_word_index}-{end_word_index}"
    )
    raise TranscriptTextChangedError(
        f"Transcript {span} on track {track_id!r} changed since this correction started, "
        "so it was not applied. Re-read the transcript and redo the correction."
    )


def correct_word(
    project: EpisodeProject,
    track_id: str,
    word_index: int,
    new_text: str,
) -> None:
    _correct_word(project, track_id, word_index, new_text)
    rebuild_combined(project)


def _correct_word(project: EpisodeProject, track_id: str, word_index: int, new_text: str) -> None:
    tr = project.transcript_for_track(track_id)
    if not tr:
        raise ValueError(f"no transcript for track {track_id!r}")
    if word_index < 0 or word_index >= len(tr.words):
        raise ValueError(f"word_index out of range: {word_index}")
    if not has_meaningful_text(new_text):
        raise ValueError("correction text must not be empty")
    w = tr.words[word_index]
    tr.words[word_index] = w.model_copy(update={"text": new_text, "confidence": 1.0})


def correct_phrase(
    project: EpisodeProject,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    new_text: str,
) -> None:
    _correct_phrase(project, track_id, start_word_index, end_word_index, new_text)
    rebuild_combined(project)


def _correct_phrase(
    project: EpisodeProject,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    new_text: str,
) -> None:
    tr = project.transcript_for_track(track_id)
    if not tr:
        raise ValueError(f"no transcript for track {track_id!r}")
    if start_word_index < 0 or end_word_index >= len(tr.words):
        raise ValueError("word index range out of bounds")
    if end_word_index < start_word_index:
        raise ValueError("end_word_index must be >= start_word_index")

    old_words = tr.words[start_word_index : end_word_index + 1]
    t0 = old_words[0].start
    t1 = old_words[-1].end
    span = max(1e-6, t1 - t0)
    tokens = new_text.split()
    if not tokens:
        tr.words = tr.words[:start_word_index] + tr.words[end_word_index + 1 :]
        return

    step = span / len(tokens)
    replacement: list[TranscriptWord] = []
    for i, tok in enumerate(tokens):
        s = t0 + i * step
        e = t0 + (i + 1) * step if i < len(tokens) - 1 else t1
        replacement.append(TranscriptWord(text=tok, start=s, end=e, confidence=1.0))
    tr.words = tr.words[:start_word_index] + replacement + tr.words[end_word_index + 1 :]


def set_word_suppressed(
    project: EpisodeProject,
    track_id: str,
    word_index: int,
    suppressed: bool,
) -> dict:
    """Toggle suppressed on one per-track word and rebuild combined transcript."""
    tr = project.transcript_for_track(track_id)
    if not tr:
        raise ValueError(f"no transcript for track {track_id!r}")
    if word_index < 0 or word_index >= len(tr.words):
        raise ValueError(f"word_index out of range: {word_index}")
    w = tr.words[word_index]
    tr.words[word_index] = w.model_copy(update={"suppressed": bool(suppressed)})
    rebuild_combined(project)
    return {
        "track_id": track_id,
        "word_index": word_index,
        "suppressed": tr.words[word_index].suppressed,
        "text": tr.words[word_index].text,
    }


def set_words_ignored(
    project: EpisodeProject,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    ignored: bool,
) -> dict:
    """Toggle ``ignored`` on ``[start_word_index, end_word_index]`` (#633).

    Text-and-audio hide, not text-only suppression: the combined transcript is not
    rebuilt, since ignored words stay in the transcript text (only muted at render).

    Resolves the transcript with ``transcript_for_track`` — the track-level one
    ``gui/mapper.py`` maps ``word_index`` from. Render (``IgnoredWordRegions``)
    applies a transcript's ignored spans only to clips whose ``source_id``
    resolves to it via ``transcript_for_source``, so an extra source's clip on a
    multi-source track is never muted by another source's word times.
    """
    tr = project.transcript_for_track(track_id)
    if not tr:
        raise ValueError(f"no transcript for track {track_id!r}")
    if start_word_index < 0 or end_word_index >= len(tr.words):
        raise ValueError("word index range out of bounds")
    if end_word_index < start_word_index:
        raise ValueError("end_word_index must be >= start_word_index")

    changed = 0
    for i in range(start_word_index, end_word_index + 1):
        w = tr.words[i]
        if w.ignored != ignored:
            tr.words[i] = w.model_copy(update={"ignored": ignored})
            changed += 1
    return {
        "track_id": track_id,
        "start_word_index": start_word_index,
        "end_word_index": end_word_index,
        "ignored": ignored,
        "changed": changed,
    }


DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.7


def transcript_word_record(transcript: Transcript, index: int) -> dict[str, Any]:
    """Identity and timing of one word for review lists (source-media seconds)."""
    w = transcript.words[index]
    return {
        "track_id": transcript.track_id,
        "source_id": transcript.source_id,
        "word_index": index,
        "text": w.text,
        "start": w.start,
        "end": w.end,
    }


def list_low_confidence(
    project: EpisodeProject,
    threshold: float = DEFAULT_LOW_CONFIDENCE_THRESHOLD,
) -> list[dict]:
    out: list[dict] = []
    for tr in project.transcripts:
        for i, w in enumerate(tr.words):
            conf = w.confidence if w.confidence is not None else 1.0
            if conf >= threshold:
                continue
            ctx_before = " ".join(x.text for x in tr.words[max(0, i - 3) : i])
            ctx_after = " ".join(x.text for x in tr.words[i + 1 : min(len(tr.words), i + 4)])
            out.append(
                {
                    **transcript_word_record(tr, i),
                    "confidence": conf,
                    "context_before": ctx_before,
                    "context_after": ctx_after,
                }
            )
    return out


def verify_words(
    project: EpisodeProject,
    track_id: str,
    corrections: list[dict],
) -> int:
    """Batch correct: each entry {word_index, text}."""
    return apply_transcript_corrections(
        project,
        track_id,
        words=corrections,
    )


def apply_transcript_corrections(
    project: EpisodeProject,
    track_id: str,
    *,
    words: list[dict] | None = None,
    phrases: list[dict] | None = None,
) -> int:
    """Apply word and phrase fixes on one track in a single mutation.

    Indices refer to the transcript **at batch start**. Words run first (highest
    ``word_index`` first), then phrases (highest ``start_word_index`` first).
    Each entry: words ``{word_index, text}``; phrases
    ``{start_word_index, end_word_index, text}``.
    """
    count = 0
    for item in sorted(
        words or [],
        key=lambda x: int(x["word_index"]),
        reverse=True,
    ):
        _correct_word(project, track_id, int(item["word_index"]), str(item["text"]))
        count += 1
    for item in sorted(
        phrases or [],
        key=lambda x: int(x["start_word_index"]),
        reverse=True,
    ):
        _correct_phrase(
            project,
            track_id,
            int(item["start_word_index"]),
            int(item["end_word_index"]),
            str(item["text"]),
        )
        count += 1
    if count:
        rebuild_combined(project)
    return count
