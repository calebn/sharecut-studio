"""Opt-in forced-aligner model catalog, cache detection and download.

Sibling of ``whisper_models.py``: a small catalog of pinned Hugging Face
snapshots for the CTC forced-alignment pass (``engines/word_align.py``,
#714). Nothing here downloads on import or during a run — a run only ever
reads a local snapshot (``local_files_only=True``); ``bootstrap_word_aligner``
is the only network path, driven by ``podcast bootstrap --component
word-aligner``.

No lock of our own guards the shared snapshot cache: concurrent
``bootstrap`` runs and a pipeline resolving mid-download rely on
``snapshot_download``'s own file locking, and ``_has_required_files`` turns a
half-written snapshot into ``WordAlignerMissingError`` (Whisper's times kept),
as ``whisper_models.py`` does.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from podcast_mcp.util.hashing import sha256_file

DEFAULT_WORD_ALIGNER = "onnx-base"
WORD_ALIGNER_ENV = "PODCAST_MCP_WORD_ALIGNER_MODEL"


@dataclass(frozen=True)
class WordAlignerModel:
    id: str
    label: str
    size: str
    description: str
    hf_repo: str
    revision: str
    onnx_file: str
    onnx_sha256: str
    license: str
    languages: tuple[str, ...]

    @property
    def allow_patterns(self) -> list[str]:
        return ["vocab.json", "config.json", "preprocessor_config.json", self.onnx_file]

    def supports_language(self, language: str | None) -> bool:
        """True when this aligner can re-time a transcript in ``language`` (None means English)."""
        return (language or "en") in self.languages


WORD_ALIGNER_CATALOG: tuple[WordAlignerModel, ...] = (
    WordAlignerModel(
        id="onnx-base",
        label="wav2vec2 base (ONNX, English)",
        size="~360 MB",
        description="CTC forced aligner picked by the #641 word-boundary benchmark.",
        hf_repo="onnx-community/wav2vec2-base-960h-ONNX",
        revision="729c1a6730fb549c20a1c73a3d3f96f11020225e",
        onnx_file="onnx/model.onnx",
        onnx_sha256="00b7cc69516c1ab63c429e63a2b543e4d42bb77441ec5b98ee935de175b00de1",
        license="apache-2.0",
        languages=("en",),
    ),
)


class WordAlignerMissingError(RuntimeError):
    def __init__(self, model_id: str, detail: str = "") -> None:
        self.model_id = model_id
        suffix = f" ({detail})" if detail else ""
        super().__init__(
            f"Word aligner {model_id!r} is not downloaded{suffix}. "
            "Run: podcast bootstrap --component word-aligner"
        )


def word_aligner_model(model_id: str = DEFAULT_WORD_ALIGNER) -> WordAlignerModel:
    for model in WORD_ALIGNER_CATALOG:
        if model.id == model_id:
            return model
    ids = ", ".join(m.id for m in WORD_ALIGNER_CATALOG)
    raise ValueError(f"Unknown word aligner {model_id!r}. Choose from: {ids}")


def _has_required_files(root: Path, model: WordAlignerModel) -> bool:
    return (root / "vocab.json").is_file() and (root / model.onnx_file).is_file()


def verify_word_aligner_onnx(model_dir: Path, model: WordAlignerModel) -> None:
    """Fail closed when the snapshot's ONNX file is not the pinned bytes (corrupt or swapped)."""
    digest = sha256_file(model_dir / model.onnx_file)
    if digest != model.onnx_sha256:
        raise WordAlignerMissingError(
            model.id,
            f"{model.onnx_file} sha256 {digest[:12]} does not match the pin; "
            "re-download with --upgrade",
        )


# Serialises the cached check so overlapping status requests hash the ONNX once, not each.
_VERIFY_LOCK = threading.Lock()


@lru_cache(maxsize=8)
def _verify_onnx_cached(
    model_dir: Path, model: WordAlignerModel, _onnx_key: tuple[str, int, int]
) -> None:
    """``verify_word_aligner_onnx``, remembered per (model pin, resolved path, size, mtime_ns).

    Status polls (Pipeline config, bootstrap status) hash the ~360 MB snapshot once per
    process. Only successes are remembered, because lru_cache does not cache a raised
    error. A rewrite that keeps both size and mtime is not re-hashed here, but
    ``WordAligner.load`` and ``bootstrap_word_aligner`` call ``verify_word_aligner_onnx``
    uncached every time, so a stale status never loads a tampered file.
    """
    verify_word_aligner_onnx(model_dir, model)


def _verify_word_aligner_onnx_once(model_dir: Path, model: WordAlignerModel) -> None:
    onnx = (model_dir / model.onnx_file).resolve()
    st = onnx.stat()
    with _VERIFY_LOCK:
        _verify_onnx_cached(model_dir, model, (str(onnx), st.st_size, st.st_mtime_ns))


def word_aligner_override_dir() -> Path | None:
    """The ``PODCAST_MCP_WORD_ALIGNER_MODEL`` directory, or None when unset."""
    override = os.environ.get(WORD_ALIGNER_ENV)
    return Path(override).expanduser() if override else None


def resolve_word_aligner_dir(model_id: str = DEFAULT_WORD_ALIGNER) -> Path:
    """A local snapshot directory for ``model_id``; never downloads.

    Raises ``WordAlignerMissingError`` when no complete local snapshot exists.
    """
    model = word_aligner_model(model_id)

    override = word_aligner_override_dir()
    if override is not None:
        if _has_required_files(override, model):
            return override
        raise WordAlignerMissingError(
            model.id, f"{WORD_ALIGNER_ENV}={override} has no vocab.json or {model.onnx_file}"
        )

    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import LocalEntryNotFoundError

    from podcast_mcp.config import word_aligner_cache_dir

    try:
        path = Path(
            snapshot_download(
                model.hf_repo,
                revision=model.revision,
                allow_patterns=model.allow_patterns,
                cache_dir=str(word_aligner_cache_dir()),
                local_files_only=True,
            )
        )
    except LocalEntryNotFoundError as exc:
        raise WordAlignerMissingError(model.id) from exc
    if not _has_required_files(path, model):
        raise WordAlignerMissingError(model.id, "partial download")
    return path


def word_aligner_is_cached(model_id: str = DEFAULT_WORD_ALIGNER) -> bool:
    """A complete local snapshot; the pinned one (not an override) must also match its sha256."""
    try:
        path = resolve_word_aligner_dir(model_id)
        if word_aligner_override_dir() is None:
            _verify_word_aligner_onnx_once(path, word_aligner_model(model_id))
    except (WordAlignerMissingError, OSError):
        return False
    return True


def bootstrap_word_aligner(
    model_id: str = DEFAULT_WORD_ALIGNER, *, force: bool = False
) -> dict[str, Any]:
    """Download the pinned snapshot into the word-aligner cache. The only network path."""
    from huggingface_hub import snapshot_download

    from podcast_mcp.config import word_aligner_cache_dir

    model = word_aligner_model(model_id)
    # Intentional download path — the only snapshot_download without local_files_only=True.
    path = snapshot_download(
        model.hf_repo,
        revision=model.revision,
        allow_patterns=model.allow_patterns,
        cache_dir=str(word_aligner_cache_dir()),
        force_download=force,
    )
    verify_word_aligner_onnx(Path(path), model)
    return {"ok": True, "model": model.id, "path": str(path)}
