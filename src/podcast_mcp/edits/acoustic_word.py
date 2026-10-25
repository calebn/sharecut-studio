"""Does a proposed acoustic span hold a word the transcript missed?

An acoustic gap run is voiced audio the transcript has no word for. Most are hesitations,
laughs and backchannels, but some are real words the ASR dropped, and cutting those loses
speech. The test is the recogniser itself: the span, taken alone with a little silence
either side, goes through the project's own Whisper model. A word that comes back flags the
proposal ``possible_word``; it is still proposed, because detection labels and never hides
(``docs/filler-cut-quality.md`` § Non-speech sounds).

Shape tests (voiced length, spectral motion) cannot tell a drawn-out "Then" from "umm", and
a backchannel moves as much as a word does, so they are not used. The model hears the
difference.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from typing import Any

import numpy as np

from podcast_mcp.edits.tighten_reasons import (
    POSSIBLE_WORD_FLAG,
    is_acoustic_filler_reason,
    is_possible_word_reason,
)
from podcast_mcp.engines.models.whisper import WhisperWeightsMissingError
from podcast_mcp.models import EditDecision
from podcast_mcp.util.model_missing import ModelMissing
from podcast_mcp.util.progress import (
    CancelledProgress,
    raise_if_cancel_requested,
    resolve_progress_task,
)
from podcast_mcp.util.project_state import current_cancel_check

WHISPER_SAMPLE_RATE = 16_000
# Silence either side of the span: a model given a bare burst hears its edges as clicks.
SPAN_PAD_SEC = 0.3
# Keeps the model from tidying a hesitation away and lets it write the sound it hears.
DISFLUENCY_PROMPT = "Umm, uh, hmm. Uh, um, mm-hmm. Uhh."

# Sounds a model writes down that are not words: hesitations, laughs, backchannels, breaths.
_NON_WORD = re.compile(
    r"^(u+h+|u+m+|h+m+|m+|m+h+m+|a+h+|o+h+|e+h+|(h+a+h*)+|(h+e+h*)+|uh-?huh|mm-?hmm|huh)$"
)

SpanTranscriber = Callable[[np.ndarray, str | None], str]


def heard_a_word(text: str) -> bool:
    """True when ``text`` holds a token that is not a hesitation, laugh or backchannel."""
    for token in text.replace("...", " ").split():
        letters = re.sub(r"[^a-z-]", "", token.lower()).strip("-")
        if letters and not _NON_WORD.match(letters):
            return True
    return False


def span_heard_a_word(
    samples: np.ndarray, transcribe: SpanTranscriber, language: str | None
) -> bool:
    """Whether ``transcribe`` writes a word for 16 kHz ``samples`` padded with silence."""
    pad = np.zeros(round(SPAN_PAD_SEC * WHISPER_SAMPLE_RATE), dtype=np.float32)
    padded = np.concatenate([pad, samples.astype(np.float32), pad])
    return heard_a_word(transcribe(padded, language))


def flag_possible_words(
    decisions: list[EditDecision],
    window: Callable[[str, float, float], np.ndarray | None],
    transcribe: SpanTranscriber,
    languages: Mapping[str, str | None],
    skip_counts: dict[str, int] | None = None,
) -> int:
    """Add ``:possible_word`` to each acoustic decision whose span the model hears as a word.

    ``window(track_id, start, end)`` returns the track's 16 kHz samples, or ``None`` when
    there are none to read; ``languages`` maps each track to its transcript's language.
    A non-missing decode error on one span increments ``word_probe:failed`` on
    ``skip_counts`` and leaves the rest of the loop to finish. Returns how many
    decisions were flagged.
    """
    counts = skip_counts if skip_counts is not None else {}
    to_hear: list[tuple[EditDecision, np.ndarray]] = []
    for decision in decisions:
        if not is_acoustic_filler_reason(decision.reason):
            continue
        if is_possible_word_reason(decision.reason):
            continue
        samples = window(decision.track_id, decision.start, decision.end)
        if samples is None or samples.size == 0:
            continue
        to_hear.append((decision, samples))
    if not to_hear:
        return 0

    flagged = 0
    with resolve_progress_task(
        "word-probe",
        "Listening for missed words",
        total=len(to_hear),
    ) as task:
        task.set_phase("span", "Hearing acoustic runs…")
        for decision, samples in to_hear:
            raise_if_cancel_requested(current_cancel_check())
            try:
                heard = span_heard_a_word(samples, transcribe, languages.get(decision.track_id))
            except (WhisperWeightsMissingError, ModelMissing):
                raise
            except CancelledProgress:
                raise
            except Exception:
                counts["word_probe:failed"] = counts.get("word_probe:failed", 0) + 1
            else:
                if heard:
                    decision.reason = f"{decision.reason}:{POSSIBLE_WORD_FLAG}"
                    flagged += 1
            task.advance(1)
    return flagged


def whisper_span_transcriber(defaults: dict[str, Any]) -> SpanTranscriber:
    """A transcriber over the project's configured Whisper model, loaded on first use."""
    from podcast_mcp.engines.models.whisper import DEFAULT_WHISPER_MODEL
    from podcast_mcp.engines.transcribe import TranscriptionEngine

    model = (defaults.get("transcribe") or {}).get("model", DEFAULT_WHISPER_MODEL)
    # The span check compares short phrases against a threshold: keep it on the CPU until
    # GPU output is proven equivalent there (#2248).
    engine = TranscriptionEngine(model_size=model, device="cpu", defaults=defaults)

    def transcribe(samples: np.ndarray, language: str | None) -> str:
        return engine.transcribe_samples(
            samples, language=language or "en", initial_prompt=DISFLUENCY_PROMPT
        )

    return transcribe
