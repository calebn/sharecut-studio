"""Model catalog names the CLI and GUI adapters use, re-exported from the engines.

Adapters do not import ``engines/``; they reach the Whisper and forced-aligner
catalogs through the ``services.pipeline`` facade instead.
"""

from __future__ import annotations

from podcast_mcp.engines.models.registry import MODELS, models_for
from podcast_mcp.engines.models.whisper import (
    DEFAULT_WHISPER_MODEL,
    WHISPER_MODEL_IDS,
    WhisperWeightsMissingError,
    persist_whisper_model,
    resolve_whisper_model,
    validate_whisper_model,
)

__all__ = [
    "DEFAULT_WHISPER_MODEL",
    "MODELS",
    "WHISPER_MODEL_IDS",
    "WhisperWeightsMissingError",
    "models_for",
    "persist_whisper_model",
    "resolve_whisper_model",
    "validate_whisper_model",
]
