"""The downloadable models ShareCut Studio offers: the one table setup, bootstrap and the CLI derive from.

Each row says how ready the model is (``problem``, never a download) and how to install it
(``install``, the only network path). ``setup`` is the tier: ``required`` gates first-run
readiness, ``recommended`` is installed by a bare ``podcast bootstrap``, ``offered`` only when
named or with ``--component all``.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.config.defaults import whisper_cache_dir, word_aligner_cache_dir
from podcast_mcp.engines.models.speaker_ecapa import (
    SPEAKER_ECAPA_BOOTSTRAP,
    SPEAKER_ECAPA_LABEL,
    SPEAKER_ECAPA_SIZE,
    bootstrap_speaker_ecapa,
    speaker_ecapa_path,
    speaker_ecapa_problem,
)
from podcast_mcp.engines.models.whisper import (
    WHISPER_BOOTSTRAP,
    WhisperPinMismatchError,
    bootstrap_whisper_model,
    resolve_whisper_model,
    whisper_bootstrap_command,
    whisper_model_problem,
)
from podcast_mcp.engines.models.word_aligner import (
    DEFAULT_WORD_ALIGNER,
    WORD_ALIGNER_BOOTSTRAP,
    WordAlignerPinMismatchError,
    bootstrap_word_aligner,
    word_aligner_model,
    word_aligner_problem,
)
from podcast_mcp.util.asset_sources import OnProgress
from podcast_mcp.util.model_assets import (
    bootstrap_rnnoise_model,
    resolve_rnnoise_model,
    rnnoise_model_path,
)

SetupTier = Literal["required", "recommended", "offered"]


@dataclass(frozen=True)
class ModelProblem:
    hint: str
    fix: str
    pin_mismatch: bool = False


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str
    purpose: str
    size: str
    setup: SetupTier
    problem: Callable[[str | None, bool], ModelProblem | None]
    install: Callable[[str | None, bool, OnProgress | None], dict[str, Any]]
    location: Callable[[], Path]
    default_variant: str | None = None

    @property
    def fix_command(self) -> str:
        return f"podcast bootstrap --component {self.id}"


def _whisper_problem(variant: str | None, memoize: bool) -> ModelProblem | None:
    model = resolve_whisper_model(requested=variant)
    found = whisper_model_problem(model, memoize=memoize)
    if found is None:
        return None
    if isinstance(found, WhisperPinMismatchError):
        return ModelProblem(str(found), whisper_bootstrap_command(model, upgrade=True), True)
    return ModelProblem(
        f"Whisper model {model!r} is not downloaded — pick Download in the Pipeline tab "
        f"or run {whisper_bootstrap_command(model)}",
        WHISPER_BOOTSTRAP,
    )


def _whisper_install(
    variant: str | None, force: bool, on_progress: OnProgress | None
) -> dict[str, Any]:
    result = bootstrap_whisper_model(
        resolve_whisper_model(requested=variant), force=force, on_progress=on_progress
    )
    return {**result, "path": result["cache"]}


def _rnnoise_problem(variant: str | None, memoize: bool) -> ModelProblem | None:
    try:
        resolve_rnnoise_model()
    except FileNotFoundError as exc:
        return ModelProblem(str(exc), "podcast bootstrap --component rnnoise")
    return None


def _rnnoise_install(
    variant: str | None, force: bool, on_progress: OnProgress | None
) -> dict[str, Any]:
    return {"ok": True, "path": str(bootstrap_rnnoise_model(force=force, on_progress=on_progress))}


def _word_aligner_problem(variant: str | None, memoize: bool) -> ModelProblem | None:
    model = word_aligner_model(variant or DEFAULT_WORD_ALIGNER)
    found = word_aligner_problem(model.id, memoize=memoize)
    if found is None:
        return None
    if isinstance(found, WordAlignerPinMismatchError):
        return ModelProblem(str(found), f"{WORD_ALIGNER_BOOTSTRAP} --upgrade", True)
    return ModelProblem(
        f"{model.label} ({model.size}) is not downloaded; Precise word boundaries is "
        "unavailable and words keep Whisper's times until it is. Download it next to "
        "that field in the Pipeline tab",
        WORD_ALIGNER_BOOTSTRAP,
    )


def _word_aligner_install(
    variant: str | None, force: bool, on_progress: OnProgress | None
) -> dict[str, Any]:
    model_id = variant or DEFAULT_WORD_ALIGNER
    if not force and word_aligner_problem(model_id) is None:
        return {"ok": True, "skipped": True, "reason": "cached", "model": model_id}
    return bootstrap_word_aligner(model_id, force=force, on_progress=on_progress)


def _speaker_ecapa_problem(variant: str | None, memoize: bool) -> ModelProblem | None:
    found = speaker_ecapa_problem()
    if found is None:
        return None
    return ModelProblem(f"{SPEAKER_ECAPA_LABEL} {found}", SPEAKER_ECAPA_BOOTSTRAP)


def _speaker_ecapa_install(
    variant: str | None, force: bool, on_progress: OnProgress | None
) -> dict[str, Any]:
    return bootstrap_speaker_ecapa(force=force, on_progress=on_progress)


_WORD_ALIGNER = word_aligner_model(DEFAULT_WORD_ALIGNER)

MODELS: tuple[ModelSpec, ...] = (
    ModelSpec(
        id="whisper",
        label="Whisper speech model",
        purpose="transcription",
        size="~75 MB to ~3 GB",
        setup="required",
        problem=_whisper_problem,
        install=_whisper_install,
        location=whisper_cache_dir,
    ),
    ModelSpec(
        id="rnnoise",
        label="RNNoise noise reduction",
        purpose="noise reduction",
        size="~0.3 MB",
        setup="recommended",
        problem=_rnnoise_problem,
        install=_rnnoise_install,
        location=rnnoise_model_path,
    ),
    ModelSpec(
        id="word-aligner",
        label=_WORD_ALIGNER.label,
        purpose="precise word boundaries",
        size=_WORD_ALIGNER.size,
        setup="offered",
        problem=_word_aligner_problem,
        install=_word_aligner_install,
        location=word_aligner_cache_dir,
        default_variant=DEFAULT_WORD_ALIGNER,
    ),
    ModelSpec(
        id="speaker-ecapa",
        label=SPEAKER_ECAPA_LABEL,
        purpose="speaker recognition and split",
        size=SPEAKER_ECAPA_SIZE,
        setup="offered",
        problem=_speaker_ecapa_problem,
        install=_speaker_ecapa_install,
        location=speaker_ecapa_path,
    ),
)

_BY_ID = {spec.id: spec for spec in MODELS}


def model_spec(model_id: str) -> ModelSpec:
    return _BY_ID[model_id]


def models_for(*tiers: SetupTier) -> tuple[ModelSpec, ...]:
    return tuple(spec for spec in MODELS if spec.setup in tiers)
