"""Model catalog names the CLI and GUI adapters use, re-exported from the engines.

Adapters do not import ``engines/``; they reach the Whisper and forced-aligner
catalogs through the ``services.pipeline`` facade instead.
"""

from __future__ import annotations

from podcast_mcp.engines.models.whisper import (
    DEFAULT_WHISPER_MODEL,
    WHISPER_MODEL_IDS,
    WhisperWeightsMissingError,
    bootstrap_whisper_model,
    persist_whisper_model,
    resolve_whisper_model,
    validate_whisper_model,
)
from podcast_mcp.engines.models.word_aligner import (
    DEFAULT_WORD_ALIGNER,
    bootstrap_word_aligner,
    word_aligner_is_cached,
)

__all__ = [
    "DEFAULT_WHISPER_MODEL",
    "DEFAULT_WORD_ALIGNER",
    "WHISPER_MODEL_IDS",
    "WhisperWeightsMissingError",
    "bootstrap_whisper_model",
    "bootstrap_word_aligner",
    "persist_whisper_model",
    "resolve_whisper_model",
    "validate_whisper_model",
    "word_aligner_is_cached",
]
