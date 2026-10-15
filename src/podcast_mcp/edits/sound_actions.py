"""One table: what kind of sound a tighten proposal is, and what we suggest doing.

Every detected non-speech sound or disfluency gets a plain-words label and one
suggested action (cut / shorten / lower / leave).  The defaults live in
``SOUND_ACTIONS``; adding a row is how a new kind gets its default.  The kind is
derived from the proposal's ``reason`` string (``tighten_reasons`` vocabulary), so
detection never has to know about actions.  Leaf module (imports only
``tighten_reasons``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from podcast_mcp.edits.tighten_reasons import (
    ACOUSTIC_FILLER_REASON,
    PAUSE_REASON_PREFIX,
    REPETITION_REASON_PREFIX,
    RESTART_REASON_PREFIX,
    is_likely_laugh_reason,
    is_possible_word_reason,
)

SuggestedAction = Literal["cut", "shorten", "lower", "leave"]
SUGGESTED_ACTIONS: tuple[SuggestedAction, ...] = ("cut", "shorten", "lower", "leave")


@dataclass(frozen=True)
class SoundAction:
    label: str
    action: SuggestedAction


# kind -> plain-words label and default action.  Kinds without a detector yet
# (backchannel, breath, mouth click, playful phrase) have rows so a detector only
# has to emit the kind.
SOUND_ACTIONS: dict[str, SoundAction] = {
    "filler": SoundAction("Filler word", "cut"),
    "pause": SoundAction("Long pause", "shorten"),
    "repetition": SoundAction("Repeated words", "cut"),
    "restart": SoundAction("False start", "cut"),
    "acoustic": SoundAction("Unclear sound", "leave"),
    "laugh": SoundAction("Laugh", "lower"),
    "possible_word": SoundAction("Possible missed word", "leave"),
    "backchannel": SoundAction("Backchannel", "lower"),
    "breath": SoundAction("Breath", "leave"),
    "mouth_click": SoundAction("Mouth click", "cut"),
    "playful_phrase": SoundAction("Playful phrase", "leave"),
}


def sound_kind(reason: str | None) -> str | None:
    """The ``SOUND_ACTIONS`` key for a tighten ``reason``, or None for other edits."""
    text = reason or ""
    if text.startswith(ACOUSTIC_FILLER_REASON):
        # A heard word outranks a laugh: "leave" is the safe default when both flags are set.
        if is_possible_word_reason(text):
            return "possible_word"
        if is_likely_laugh_reason(text):
            return "laugh"
        return "acoustic"
    if text.startswith("filler:"):
        return "filler"
    if text.startswith(PAUSE_REASON_PREFIX):
        return "pause"
    if text.startswith(REPETITION_REASON_PREFIX):
        return "repetition"
    if text.startswith(RESTART_REASON_PREFIX):
        return "restart"
    return None


def sound_label_and_action(reason: str | None) -> tuple[str, SuggestedAction] | None:
    """``(label, suggested action)`` for a tighten ``reason``, or None."""
    kind = sound_kind(reason)
    if kind is None:
        return None
    row = SOUND_ACTIONS[kind]
    return row.label, row.action


# Kinds the pipeline applies on its own setting, independent of ``tighten.enabled``: sounds
# that are not words.  Filler, pause, repetition and restart cuts stay behind the golden-ear
# bar (docs/filler-cut-quality.md) and apply only when ``tighten.enabled`` is on.
SPEECH_KINDS = frozenset({"filler", "pause", "repetition", "restart"})


def is_non_speech_sound(reason: str | None) -> bool:
    """True for a tighten proposal that is a sound, not a spoken word or pause."""
    kind = sound_kind(reason)
    return kind is not None and kind not in SPEECH_KINDS
