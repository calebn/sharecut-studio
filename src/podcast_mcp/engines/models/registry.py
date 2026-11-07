"""The downloadable models ShareCut Studio offers: the one table setup, bootstrap and the CLI derive from.

Each row says how ready the model is (``problem``, never a download) and how to install it
(``install``, the only network path). ``setup`` is the tier: ``required`` gates first-run
readiness and ``recommended`` is installed by a bare ``podcast bootstrap``. Studio's Get ready card
downloads every model that is not installed, so a ``recommended`` row is in that bundle.
"""

from __future__ import annotations

import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.config.defaults import whisper_cache_dir, word_aligner_cache_dir
from podcast_mcp.engines.models.speaker_ecapa import (
    SPEAKER_ECAPA_BOOTSTRAP,
    SPEAKER_ECAPA_LABEL,
    SPEAKER_ECAPA_SIZE,
    SPEAKER_ECAPA_SIZE_BYTES,
    bootstrap_speaker_ecapa,
    speaker_ecapa_override,
    speaker_ecapa_path,
    speaker_ecapa_problem,
)
from podcast_mcp.engines.models.whisper import (
    WHISPER_MODEL_CATALOG,
    WHISPER_PINS,
    WHISPER_SIZE_BYTES,
    WhisperPinMismatchError,
    bootstrap_whisper_model,
    cache_path_matches_model,
    resolve_whisper_model,
    validate_whisper_model,
    whisper_bootstrap_command,
    whisper_model_problem,
)
from podcast_mcp.engines.models.word_aligner import (
    DEFAULT_WORD_ALIGNER,
    WORD_ALIGNER_BOOTSTRAP,
    WordAlignerPinMismatchError,
    bootstrap_word_aligner,
    word_aligner_model,
    word_aligner_override_dir,
    word_aligner_problem,
)
from podcast_mcp.util.asset_sources import OnProgress, asset_entry
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.model_assets import (
    bootstrap_rnnoise_model,
    resolve_rnnoise_model,
    rnnoise_model_path,
    rnnoise_override,
)
from podcast_mcp.util.model_missing import ModelMissing

SetupTier = Literal["required", "recommended"]


class ModelNotRemovable(CodedValueError):
    """Studio cannot remove this model: its files are not ones Studio downloaded."""

    code = "model_not_removable"


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
    #: What Studio downloaded for the model, as paths to delete; raises ``ModelNotRemovable``
    #: when the model is a file the person supplied.
    downloaded: Callable[[str | None], list[Path]]
    install_without_preference: (
        Callable[[str | None, bool, OnProgress | None], dict[str, Any]] | None
    ) = None
    default_variant: str | None = None
    variant_sizes: Callable[[str | None], tuple[str | None, int | None]] = field(
        default=lambda variant: (None, None)
    )

    def size_label(self, variant: str | None = None) -> str:
        return self.variant_sizes(variant)[0] or self.size

    def size_bytes(self, variant: str | None = None) -> int | None:
        return self.variant_sizes(variant)[1]

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
        f"Whisper model {model!r} is not downloaded — choose Get for Transcription in Models "
        f"or run {whisper_bootstrap_command(model)}",
        whisper_bootstrap_command(model),
    )


def _whisper_install(
    variant: str | None, force: bool, on_progress: OnProgress | None
) -> dict[str, Any]:
    result = bootstrap_whisper_model(
        resolve_whisper_model(requested=variant), force=force, on_progress=on_progress
    )
    return {**result, "path": result["cache"]}


def _whisper_install_without_preference(
    variant: str | None, force: bool, on_progress: OnProgress | None
) -> dict[str, Any]:
    result = bootstrap_whisper_model(
        resolve_whisper_model(requested=variant),
        force=force,
        on_progress=on_progress,
        persist=False,
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
        "unavailable and words keep Whisper's times until it is. Choose Get on "
        "the Word timing row in Models",
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
    found = speaker_ecapa_problem(memoize=memoize)
    if found is None:
        return None
    if speaker_ecapa_path().is_file():
        return ModelProblem(
            f"{SPEAKER_ECAPA_LABEL} {found}", f"{SPEAKER_ECAPA_BOOTSTRAP} --upgrade", True
        )
    return ModelProblem(f"{SPEAKER_ECAPA_LABEL} {found}", SPEAKER_ECAPA_BOOTSTRAP)


def _speaker_ecapa_install(
    variant: str | None, force: bool, on_progress: OnProgress | None
) -> dict[str, Any]:
    return bootstrap_speaker_ecapa(force=force, on_progress=on_progress)


def _whisper_sizes(variant: str | None) -> tuple[str | None, int | None]:
    for item in WHISPER_MODEL_CATALOG:
        if item["id"] == variant:
            return item["size"], WHISPER_SIZE_BYTES.get(item["id"])
    return None, None


def _rnnoise_sizes(variant: str | None) -> tuple[str | None, int | None]:
    try:
        pinned = asset_entry("rnnoise").get("size_bytes")
    except Exception:  # a bad manifest must not break a status read: show the generic size
        return None, None
    return None, pinned if isinstance(pinned, int) else None


def _whisper_downloaded(variant: str | None) -> list[Path]:
    model = validate_whisper_model(resolve_whisper_model(requested=variant))
    root = whisper_cache_dir()
    if root.is_symlink():
        raise ModelNotRemovable("The model cache is linked elsewhere, so Studio leaves it alone.")
    pin = WHISPER_PINS.get(model)
    if pin is not None:
        return [root / f"models--{pin.hf_repo.replace('/', '--')}"]
    return [entry for entry in root.iterdir() if cache_path_matches_model(f"{entry.name}/", model)]


def _rnnoise_downloaded(variant: str | None) -> list[Path]:
    if rnnoise_override() is not None:
        raise ModelNotRemovable(
            "Noise reduction is a file you supplied, so Studio leaves it alone."
        )
    return [rnnoise_model_path()]


def _word_aligner_downloaded(variant: str | None) -> list[Path]:
    if word_aligner_override_dir() is not None:
        raise ModelNotRemovable(
            "The word aligner is a directory you supplied, so Studio leaves it alone."
        )
    model = word_aligner_model(variant or DEFAULT_WORD_ALIGNER)
    root = word_aligner_cache_dir()
    if root.is_symlink():
        raise ModelNotRemovable("The model cache is linked elsewhere, so Studio leaves it alone.")
    return [root / f"models--{model.hf_repo.replace('/', '--')}"]


def _speaker_ecapa_downloaded(variant: str | None) -> list[Path]:
    if speaker_ecapa_override() is not None:
        raise ModelNotRemovable(
            "The speaker model is a file you supplied, so Studio leaves it alone."
        )
    return [speaker_ecapa_path()]


_WORD_ALIGNER = word_aligner_model(DEFAULT_WORD_ALIGNER)


def _word_aligner_sizes(variant: str | None) -> tuple[str | None, int | None]:
    model = word_aligner_model(variant or DEFAULT_WORD_ALIGNER)
    return model.size, model.size_bytes


def _speaker_ecapa_sizes(variant: str | None) -> tuple[str | None, int | None]:
    return None, SPEAKER_ECAPA_SIZE_BYTES


MODELS: tuple[ModelSpec, ...] = (
    ModelSpec(
        id="whisper",
        label="Whisper speech model",
        purpose="transcription",
        size="~75 MB to ~3 GB",
        setup="required",
        problem=_whisper_problem,
        install=_whisper_install,
        install_without_preference=_whisper_install_without_preference,
        location=whisper_cache_dir,
        downloaded=_whisper_downloaded,
        variant_sizes=_whisper_sizes,
    ),
    ModelSpec(
        id="rnnoise",
        label="Noise reduction (RNNoise)",
        purpose="noise reduction",
        size="~0.3 MB",
        setup="recommended",
        problem=_rnnoise_problem,
        install=_rnnoise_install,
        location=rnnoise_model_path,
        downloaded=_rnnoise_downloaded,
        variant_sizes=_rnnoise_sizes,
    ),
    ModelSpec(
        id="word-aligner",
        label=_WORD_ALIGNER.label,
        purpose="precise word boundaries",
        size=_WORD_ALIGNER.size,
        setup="recommended",
        problem=_word_aligner_problem,
        install=_word_aligner_install,
        location=word_aligner_cache_dir,
        downloaded=_word_aligner_downloaded,
        default_variant=DEFAULT_WORD_ALIGNER,
        variant_sizes=_word_aligner_sizes,
    ),
    ModelSpec(
        id="speaker-ecapa",
        label=SPEAKER_ECAPA_LABEL,
        purpose="speaker recognition and split",
        size=SPEAKER_ECAPA_SIZE,
        setup="recommended",
        problem=_speaker_ecapa_problem,
        install=_speaker_ecapa_install,
        location=speaker_ecapa_path,
        variant_sizes=_speaker_ecapa_sizes,
        downloaded=_speaker_ecapa_downloaded,
    ),
)

_BY_ID = {spec.id: spec for spec in MODELS}


def model_spec(model_id: str) -> ModelSpec:
    return _BY_ID[model_id]


def models_for(*tiers: SetupTier) -> tuple[ModelSpec, ...]:
    return tuple(spec for spec in MODELS if spec.setup in tiers)


def model_base(model_id: str, variant: str | None = None) -> dict[str, Any]:
    spec = model_spec(model_id)
    model = variant or spec.default_variant or spec.id
    return {
        "id": spec.id,
        "model": model,
        "label": spec.label,
        "purpose": spec.purpose,
        "tier": spec.setup,
        "size": spec.size_label(model),
        "size_bytes": spec.size_bytes(model),
    }


def model_record(
    model_id: str, variant: str | None = None, *, memoize: bool = True
) -> dict[str, Any]:
    """One model's readiness (no download), from the registry row alone.

    ``state`` is ``installed`` when the row reports no problem. A pin mismatch is
    ``update_needed`` with an ``--upgrade`` fix as ``bootstrap``; any other problem is
    ``missing`` with ``hint`` and ``bootstrap``.
    """
    base = model_base(model_id, variant)
    problem = model_spec(model_id).problem(variant, memoize)
    if problem is None:
        return {**base, "state": "installed"}
    return {
        **base,
        "state": "update_needed" if problem.pin_mismatch else "missing",
        "hint": problem.hint,
        "bootstrap": problem.fix,
    }


def require_model(model_id: str, variant: str | None = None, *, memoize: bool = True) -> None:
    """Raise ``ModelMissing`` unless the model is installed; never downloads."""
    rec = model_record(model_id, variant, memoize=memoize)
    if rec["state"] != "installed":
        raise ModelMissing.from_record(rec)


def remove_model(model_id: str, variant: str | None = None) -> int:
    """Delete what Studio downloaded for ``model_id`` (one Whisper size for ``whisper``) and
    return its logical regular-file payload bytes, excluding snapshot links.
    A model that is not installed frees nothing; it is not an error.
    Raises ``ModelNotRemovable`` for a file the person supplied. Callers keep it away from a
    running download or job."""
    model_base(model_id, variant)
    freed = 0
    for path in model_spec(model_id).downloaded(variant):
        if path.is_symlink():
            raise ModelNotRemovable("This model is linked elsewhere, so Studio leaves it alone.")
        if path.is_dir():
            freed += sum(
                f.stat().st_size for f in path.rglob("*") if f.is_file() and not f.is_symlink()
            )
            shutil.rmtree(path)
        elif path.is_file():
            freed += path.stat().st_size
            path.unlink()
    return freed
