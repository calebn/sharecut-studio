from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any, TypeVar

from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptWord
from podcast_mcp.util.coded_error import CodedError, CodedValueError
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


class TranscriptTextChangedError(CodedError, ValueError):
    """A correction's word indices no longer hold the text the client saw (#650)."""

    code = "transcript_changed"


def require_word_text(
    project: EpisodeProject,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    expected_text: str | None,
) -> None:
    """Raise ``TranscriptTextChangedError`` unless words ``start..end`` still read ``expected_text``.

    ``None`` skips the check. Whitespace is collapsed on both sides; case and punctuation
    must match. A transcript or index range that no longer exists also raises (the caller's
    view is stale); a malformed range (negative start, end before start) is left to the
    guarded edit, which raises its usual ``ValueError``.
    """
    if expected_text is None:
        return
    if start_word_index < 0 or end_word_index < start_word_index:
        return  # malformed request, not staleness: the guarded edit raises its usual ValueError
    tr = project.transcript_for_track(track_id)
    if tr is not None and end_word_index < len(tr.words):
        current = " ".join(w.text for w in tr.words[start_word_index : end_word_index + 1])
        if collapse_whitespace(current) == collapse_whitespace(expected_text):
            return
    if start_word_index == end_word_index:
        span, pronoun = f"word {start_word_index}", "it"
    else:
        span, pronoun = f"words {start_word_index}-{end_word_index}", "them"
    raise TranscriptTextChangedError(
        f"Transcript {span} on track {track_id!r} changed since you read {pronoun}, "
        "so the edit was not applied. Re-read the transcript and try again."
    )


def _require_transcript(project: EpisodeProject, track_id: str) -> Transcript:
    transcript = project.transcript_for_track(track_id)
    if transcript is None:
        raise CodedValueError(f"no transcript for track {track_id!r}", code="transcript_not_found")
    return transcript


def _require_word_index(tr: Transcript, word_index: int) -> None:
    if word_index < 0 or word_index >= len(tr.words):
        raise CodedValueError(
            f"word_index out of range: {word_index}", code="word_index_out_of_range"
        )


def _require_word_range(tr: Transcript, start_word_index: int, end_word_index: int) -> None:
    if start_word_index < 0 or end_word_index >= len(tr.words):
        raise CodedValueError("word index range out of bounds", code="word_index_out_of_range")
    if end_word_index < start_word_index:
        raise CodedValueError("end_word_index must be >= start_word_index", code="invalid_range")


def correct_word(
    project: EpisodeProject,
    track_id: str,
    word_index: int,
    new_text: str,
) -> None:
    correct_transcript_word(_require_transcript(project, track_id), word_index, new_text)
    rebuild_combined(project)


def correct_transcript_word(
    tr: Transcript,
    word_index: int,
    new_text: str,
    *,
    keep_evidence: bool = False,
) -> None:
    _require_word_index(tr, word_index)
    if not has_meaningful_text(new_text):
        raise CodedValueError("correction text must not be empty", code="empty_text")
    w = tr.words[word_index]
    update: dict[str, object] = {"text": new_text, "confidence": 1.0}
    if new_text != w.text and not keep_evidence:
        # A person's or agent's correction invalidates the score the aligner gave the old text
        # (#195); automated precorrect rewrites (keep_evidence) keep it, since the audio is unchanged.
        update.update(alignment_score=None, suspect_hallucination=False)
    tr.words[word_index] = w.model_copy(update=update)


def correct_phrase(
    project: EpisodeProject,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    new_text: str,
) -> None:
    correct_transcript_phrase(
        _require_transcript(project, track_id), start_word_index, end_word_index, new_text
    )
    rebuild_combined(project)


def correct_transcript_phrase(
    tr: Transcript,
    start_word_index: int,
    end_word_index: int,
    new_text: str,
    *,
    keep_evidence: bool = False,
) -> None:
    _require_word_range(tr, start_word_index, end_word_index)

    old_words = tr.words[start_word_index : end_word_index + 1]
    replacement = build_phrase_replacement(
        old_words,
        new_text,
        keep_evidence=keep_evidence,
    )
    tr.words = tr.words[:start_word_index] + replacement + tr.words[end_word_index + 1 :]


def build_phrase_replacement(
    old_words: Sequence[TranscriptWord],
    new_text: str,
    *,
    keep_evidence: bool = False,
    preserve_audibility_lock: bool = False,
) -> list[TranscriptWord]:
    t0 = old_words[0].start
    t1 = old_words[-1].end
    span = max(1e-6, t1 - t0)
    tokens = new_text.split()
    if not tokens:
        return []

    score: float | None = None
    flag = False
    if keep_evidence:
        scores = [w.alignment_score for w in old_words if w.alignment_score is not None]
        score = min(scores) if scores else None
        flag = any(w.suspect_hallucination for w in old_words)

    locked = preserve_audibility_lock and any(word.audibility_locked for word in old_words)
    timed, snaps = _carried_timing(old_words)
    step = span / len(tokens)
    replacement: list[TranscriptWord] = []
    for i, tok in enumerate(tokens):
        s = t0 + i * step
        e = t0 + (i + 1) * step if i < len(tokens) - 1 else t1
        replacement.append(
            TranscriptWord(
                text=tok,
                start=s,
                end=e,
                confidence=1.0,
                alignment_score=score,
                suspect_hallucination=flag,
                audibility_locked=locked,
                timing_edited=timed,
                snapped_from=snaps.get(s),
            )
        )
    return replacement


def _carried_timing(old_words: Sequence[TranscriptWord]) -> tuple[bool, dict[float, float]]:
    """What a rebuilt phrase keeps of its words' timing provenance (#1059).

    The rebuilt words split the old words' span, so the span is a person's when any old
    word's timing was (``timing_edited``): every rebuilt word carries the mark and none
    carries a snap, since ``align_tracks`` never moves a person's start. Otherwise an old
    word's ``snapped_from`` moves to the rebuilt word that starts where it starts (the
    first rebuilt word always starts on the first old word), keyed here by that start, so
    the next ``align_tracks`` run can still put the start back. A snapped word with no
    rebuilt word on its start loses the snap with its start.
    """
    if any(word.timing_edited for word in old_words):
        return True, {}
    return False, {w.start: w.snapped_from for w in old_words if w.snapped_from is not None}


def set_word_suppressed(
    project: EpisodeProject,
    track_id: str,
    word_index: int,
    suppressed: bool,
) -> dict:
    """Toggle suppressed on one per-track word and rebuild combined transcript.

    A direct call locks the word (#768): later reconcile passes leave it alone
    instead of recomputing audibility over the decision.
    """
    tr = _require_transcript(project, track_id)
    _require_word_index(tr, word_index)
    w = tr.words[word_index]
    tr.words[word_index] = w.model_copy(
        update={"suppressed": bool(suppressed), "audibility_locked": True}
    )
    rebuild_combined(project)
    return {
        "track_id": track_id,
        "word_index": word_index,
        "suppressed": tr.words[word_index].suppressed,
        "text": tr.words[word_index].text,
    }


def set_word_automatic(
    project: EpisodeProject,
    track_id: str,
    word_index: int,
) -> dict:
    """Clear ``audibility_locked`` on one word; ``suppressed`` is untouched (#824).

    Returns the word to automatic: the next reconcile pass (acoustic or text-match)
    computes its target the same as any word that was never locked, instead of
    honoring the stale explicit decision forever. Does not rebuild the combined
    transcript: ``suppressed`` does not change here, only its later reconcile.
    """
    tr = _require_transcript(project, track_id)
    _require_word_index(tr, word_index)
    w = tr.words[word_index]
    tr.words[word_index] = w.model_copy(update={"audibility_locked": False})
    return {
        "track_id": track_id,
        "word_index": word_index,
        "suppressed": tr.words[word_index].suppressed,
        "audibility_locked": tr.words[word_index].audibility_locked,
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
    tr = _require_transcript(project, track_id)
    _require_word_range(tr, start_word_index, end_word_index)

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
    keep_evidence: bool = False,
) -> int:
    """Apply word and phrase fixes on one track in a single mutation.

    Indices refer to the transcript **at batch start**. Words run first (highest
    ``word_index`` first), then phrases (highest ``start_word_index`` first).
    Each entry: words ``{word_index, text}``; phrases
    ``{start_word_index, end_word_index, text}``.

    ``keep_evidence`` (automated precorrect passes) keeps each word's ``alignment_score``
    and ``suspect_hallucination`` when its text changes; a phrase's new words get the
    lowest old score and the flag if any old word had it. Person/agent corrections leave
    it False and drop the stale evidence.
    """
    count = 0
    for item in sorted(
        words or [],
        key=lambda x: int(x["word_index"]),
        reverse=True,
    ):
        correct_transcript_word(
            _require_transcript(project, track_id),
            int(item["word_index"]),
            str(item["text"]),
            keep_evidence=keep_evidence,
        )
        count += 1
    for item in sorted(
        phrases or [],
        key=lambda x: int(x["start_word_index"]),
        reverse=True,
    ):
        correct_transcript_phrase(
            _require_transcript(project, track_id),
            int(item["start_word_index"]),
            int(item["end_word_index"]),
            str(item["text"]),
            keep_evidence=keep_evidence,
        )
        count += 1
    if count:
        rebuild_combined(project)
    return count
