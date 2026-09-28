"""Opt-in forced-aligner model catalog, cache detection and download.

Sibling of ``whisper_models.py``: a small catalog of pinned Hugging Face
snapshots for the CTC forced-alignment pass (``engines/word_align.py``,
#714). Nothing here downloads on import or during a run — a run only ever
reads a local snapshot (``local_files_only=True``); ``bootstrap_word_aligner``
is the only network path, driven by ``podcast bootstrap --component
word-aligner``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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
    license: str
    languages: tuple[str, ...]

    @property
    def allow_patterns(self) -> list[str]:
        return ["vocab.json", "config.json", "preprocessor_config.json", self.onnx_file]


WORD_ALIGNER_CATALOG: tuple[WordAlignerModel, ...] = (
    WordAlignerModel(
        id="onnx-base",
        label="wav2vec2 base (ONNX, English)",
        size="~360 MB",
        description="CTC forced aligner picked by the #641 word-boundary benchmark.",
        hf_repo="onnx-community/wav2vec2-base-960h-ONNX",
        revision="729c1a6730fb549c20a1c73a3d3f96f11020225e",
        onnx_file="onnx/model.onnx",
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


def resolve_word_aligner_dir(model_id: str = DEFAULT_WORD_ALIGNER) -> Path:
    """A local snapshot directory for ``model_id``; never downloads.

    Raises ``WordAlignerMissingError`` when no complete local snapshot exists.
    """
    model = word_aligner_model(model_id)

    override = os.environ.get(WORD_ALIGNER_ENV)
    if override:
        path = Path(override).expanduser()
        if _has_required_files(path, model):
            return path
        raise WordAlignerMissingError(
            model.id, f"{WORD_ALIGNER_ENV}={path} has no vocab.json or {model.onnx_file}"
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
    try:
        resolve_word_aligner_dir(model_id)
    except WordAlignerMissingError:
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
    return {"ok": True, "model": model.id, "path": str(path)}
