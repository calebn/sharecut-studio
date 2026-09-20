from __future__ import annotations

from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.models import EpisodeProject, TranscriptWord


def correct_word(
    project: EpisodeProject,
    track_id: str,
    word_index: int,
    new_text: str,
) -> None:
    tr = project.transcript_for_track(track_id)
    if not tr:
        raise ValueError(f"no transcript for track {track_id!r}")
    if word_index < 0 or word_index >= len(tr.words):
        raise ValueError(f"word_index out of range: {word_index}")
    w = tr.words[word_index]
    tr.words[word_index] = w.model_copy(update={"text": new_text, "confidence": 1.0})
    rebuild_combined(project)


def correct_phrase(
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
        rebuild_combined(project)
        return

    step = span / len(tokens)
    replacement: list[TranscriptWord] = []
    for i, tok in enumerate(tokens):
        s = t0 + i * step
        e = t0 + (i + 1) * step if i < len(tokens) - 1 else t1
        replacement.append(TranscriptWord(text=tok, start=s, end=e, confidence=1.0))
    tr.words = tr.words[:start_word_index] + replacement + tr.words[end_word_index + 1 :]
    rebuild_combined(project)


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


def list_low_confidence(
    project: EpisodeProject,
    threshold: float = 0.7,
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
                    "track_id": tr.track_id,
                    "word_index": i,
                    "text": w.text,
                    "confidence": conf,
                    "start": w.start,
                    "end": w.end,
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
        correct_word(project, track_id, int(item["word_index"]), str(item["text"]))
        count += 1
    for item in sorted(
        phrases or [],
        key=lambda x: int(x["start_word_index"]),
        reverse=True,
    ):
        correct_phrase(
            project,
            track_id,
            int(item["start_word_index"]),
            int(item["end_word_index"]),
            str(item["text"]),
        )
        count += 1
    return count
