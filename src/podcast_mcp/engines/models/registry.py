"""The downloadable models ShareCut Studio offers: the one table setup, bootstrap and the CLI derive from.

Each row says how ready the model is (``problem``, never a download) and how to install it
(``install``, the only network path). ``setup`` is the tier: ``required`` gates first-run
readiness and ``recommended`` is installed by a bare ``podcast bootstrap``. Studio's Get ready card
downloads every model that is not installed, so a ``recommended`` row is in that bundle.
"""

from __future__ import annotations

import shutil
import stat
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.config.defaults import cache_dir, whisper_cache_dir, word_aligner_cache_dir
from podcast_mcp.engines.models import load_probe, whisper_cpp_models
from podcast_mcp.engines.models.speaker_ecapa import (
    SPEAKER_ECAPA_BOOTSTRAP,
    SPEAKER_ECAPA_ENV,
    SPEAKER_ECAPA_LABEL,
    SPEAKER_ECAPA_SIZE,
    SPEAKER_ECAPA_SIZE_BYTES,
    EcapaOnnx,
    SpeakerEcapaOverrideError,
    bootstrap_speaker_ecapa,
    speaker_ecapa_override,
    speaker_ecapa_override_restriction,
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
    WORD_ALIGNER_ENV,
    WordAlignerMissingError,
    WordAlignerOverrideError,
    WordAlignerPinMismatchError,
    bootstrap_word_aligner,
    resolve_word_aligner_dir,
    word_aligner_model,
    word_aligner_override_dir,
    word_aligner_problem,
)
from podcast_mcp.engines.onnx_session import OnnxOverrideUnsupportedError
from podcast_mcp.util.asset_sources import OnProgress, asset_entry
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.model_assets import (
    bootstrap_rnnoise_model,
    resolve_rnnoise_model,
    rnnoise_model_path,
    rnnoise_override,
    rnnoise_pin_mismatch,
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
    problem: Callable[[str | None, bool], ModelProblem | OnnxOverrideUnsupportedError | None]
    install: Callable[[str | None, bool, OnProgress | None], dict[str, Any]]
    location: Callable[[], Path]
    #: What Studio downloaded for the model, as paths to delete; raises ``ModelNotRemovable``
    #: when the model is a file the person supplied.
    downloaded: Callable[[str | None], list[Path]]
    #: Loads the model the way its consumer does; with ``probe_file`` (the ONNX file it opens),
    #: set only for the rows whose file can pass its pin and still not load (#1998).
    probe: Callable[[str | None], object] | None = None
    probe_file: Callable[[str | None], Path | None] | None = None
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
    if whisper_cpp_models.on_whisper_cpp_host():
        if whisper_cpp_models.is_installed(model):
            return None
        return ModelProblem(
            f"Whisper model {model!r} is not downloaded — choose Get for Transcription in "
            f"Models or run {whisper_bootstrap_command(model)}",
            whisper_bootstrap_command(model),
        )
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
    mismatch = rnnoise_pin_mismatch(rnnoise_model_path(), memoize=memoize)
    if mismatch is None:
        return None
    fix = "podcast bootstrap --component rnnoise --upgrade"
    return ModelProblem(
        f"RNNoise model does not match its pinned download ({mismatch}). Run: {fix}", fix, True
    )


def _rnnoise_install(
    variant: str | None, force: bool, on_progress: OnProgress | None
) -> dict[str, Any]:
    return {"ok": True, "path": str(bootstrap_rnnoise_model(force=force, on_progress=on_progress))}


def _word_aligner_problem(
    variant: str | None, memoize: bool
) -> ModelProblem | WordAlignerOverrideError | None:
    model = word_aligner_model(variant or DEFAULT_WORD_ALIGNER)
    found = word_aligner_problem(model.id, memoize=memoize)
    if found is None:
        return None
    if isinstance(found, WordAlignerOverrideError):
        return found
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


def _speaker_ecapa_problem(
    variant: str | None, memoize: bool
) -> ModelProblem | SpeakerEcapaOverrideError | None:
    if (restriction := speaker_ecapa_override_restriction()) is not None:
        return SpeakerEcapaOverrideError(restriction)
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
    if whisper_cpp_models.on_whisper_cpp_host():
        chosen = whisper_cpp_models.coerce(variant or "")
        return whisper_cpp_models.variant_for(chosen).size, whisper_cpp_models.size_bytes(chosen)
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


def _whisper_location() -> Path:
    return (
        whisper_cpp_models.whisper_cpp_cache_dir()
        if whisper_cpp_models.on_whisper_cpp_host()
        else whisper_cache_dir()
    )


def _whisper_downloaded(variant: str | None) -> list[Path]:
    if whisper_cpp_models.on_whisper_cpp_host():
        return [whisper_cpp_models.variant_path(resolve_whisper_model(requested=variant))]
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


def _word_aligner_probe(variant: str | None) -> object:
    from podcast_mcp.engines.word_align import WordAligner

    return WordAligner.load(variant or DEFAULT_WORD_ALIGNER)


def _word_aligner_probe_file(variant: str | None) -> Path | None:
    model = word_aligner_model(variant or DEFAULT_WORD_ALIGNER)
    try:
        return resolve_word_aligner_dir(model.id) / model.onnx_file
    except WordAlignerMissingError:
        return None


def _speaker_ecapa_probe(variant: str | None) -> object:
    return EcapaOnnx(speaker_ecapa_path())._load()


def _speaker_ecapa_probe_file(variant: str | None) -> Path | None:
    return speaker_ecapa_path()


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
        location=_whisper_location,
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
        probe=_word_aligner_probe,
        probe_file=_word_aligner_probe_file,
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
        probe=_speaker_ecapa_probe,
        probe_file=_speaker_ecapa_probe_file,
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
    model_id: str, variant: str | None = None, *, memoize: bool = True, check_load: bool = True
) -> dict[str, Any]:
    """One model's readiness (no download), from the registry row alone.

    ``state`` is ``installed`` when the row reports no problem. A pin mismatch is
    ``update_needed`` with an ``--upgrade`` fix as ``bootstrap``; any other problem is
    ``missing`` with ``hint`` and ``bootstrap``. A configured Intel ONNX
    override reports ``unsupported`` with a recovery hint, as does a pin-matching file that a
    loader or ``install_model`` found cannot load here (read from ``load_probe``, never loaded;
    ``check_load=False`` skips that check).
    """
    base = model_base(model_id, variant)
    spec = model_spec(model_id)
    problem = spec.problem(variant, memoize)
    if problem is None:
        probed = spec.probe_file(variant) if check_load and spec.probe_file is not None else None
        if probed is not None and (error := load_probe.failure(probed)):
            if model_id == "speaker-ecapa" and speaker_ecapa_override() is not None:
                override_env = SPEAKER_ECAPA_ENV
            elif model_id == "word-aligner" and word_aligner_override_dir() is not None:
                override_env = WORD_ALIGNER_ENV
            else:
                override_env = None
            fix = (
                f"fix the file or unset {override_env}"
                if override_env
                else f"Reinstall onnxruntime, or run {spec.fix_command} --upgrade to download it again"
            )
            hint = (
                f"{spec.label} is downloaded but cannot be loaded on this machine: "
                f"{error.removesuffix('.')}. {fix}"
            )
            return {**base, "state": "unsupported", "hint": hint}
        return {**base, "state": "installed"}
    if isinstance(problem, OnnxOverrideUnsupportedError):
        return {**base, "state": "unsupported", "hint": str(problem)}
    return {
        **base,
        "state": "update_needed" if problem.pin_mismatch else "missing",
        "hint": problem.hint,
        "bootstrap": problem.fix,
    }


def require_model(model_id: str, variant: str | None = None, *, memoize: bool = True) -> None:
    """Require a usable model without downloading it."""
    rec = model_record(model_id, variant, memoize=memoize, check_load=False)
    if rec["state"] == "unsupported":
        raise OnnxOverrideUnsupportedError(rec["hint"])
    if rec["state"] != "installed":
        raise ModelMissing.from_record(rec)


def _is_removal_link(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


def _managed_removal_path(anchor: Path, path: Path) -> Path:
    path = path.absolute()
    try:
        relative = path.relative_to(anchor)
    except ValueError:
        raise ModelNotRemovable(
            "This model is outside the managed cache, so Studio leaves it alone."
        ) from None
    if not relative.parts or ".." in relative.parts:
        raise ModelNotRemovable(
            "This model is outside the managed cache, so Studio leaves it alone."
        )
    current = anchor
    for part in relative.parts:
        current = current / part
        if _is_removal_link(current):
            raise ModelNotRemovable("This model is linked elsewhere, so Studio leaves it alone.")
    return path


def remove_model(model_id: str, variant: str | None = None) -> int:
    """Delete what Studio downloaded for ``model_id`` (one Whisper size for ``whisper``) and
    return its logical regular-file payload bytes, excluding snapshot links.
    A model that is not installed frees nothing; it is not an error.
    Raises ``ModelNotRemovable`` for a file the person supplied. Callers keep it away from a
    running download or job."""
    model_base(model_id, variant)
    anchor = cache_dir().absolute()
    if _is_removal_link(anchor):
        raise ModelNotRemovable("This model is linked elsewhere, so Studio leaves it alone.")
    paths = [
        _managed_removal_path(anchor, path) for path in model_spec(model_id).downloaded(variant)
    ]
    freed = 0
    for path in paths:
        if path.is_dir():
            freed += sum(
                f.stat().st_size for f in path.rglob("*") if f.is_file() and not f.is_symlink()
            )
            shutil.rmtree(path)
        elif path.is_file():
            freed += path.stat().st_size
            path.unlink()
    return freed
