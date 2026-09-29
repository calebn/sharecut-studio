"""Forced-aligner model catalog, cache detection and download (download is opt-in).

Sibling of ``whisper_models.py``: a small catalog of pinned Hugging Face
snapshots for the CTC forced-alignment pass (``engines/word_align.py``,
#714). Nothing here downloads on import or during a run — a run only ever
reads a local snapshot (``local_files_only=True``); ``bootstrap_word_aligner``
is the only network path, driven by ``podcast bootstrap --component
word-aligner``. Every file in the snapshot is pinned by sha256
(``file_sha256``, see ``util/model_manifest.py``, #728), not just the ONNX.

No lock of our own guards the shared snapshot cache: concurrent
``bootstrap`` runs and a pipeline resolving mid-download rely on
``snapshot_download``'s own file locking, and ``missing_files`` turns a
half-written snapshot into ``WordAlignerMissingError`` (Whisper's times kept),
as ``whisper_models.py`` does.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from podcast_mcp.util.model_manifest import (
    FileManifest,
    PinnedSnapshot,
    PinnedSnapshotMissingError,
    download_pinned_snapshot,
    manifest_mismatch,
    resolve_pinned_snapshot,
)

DEFAULT_WORD_ALIGNER = "onnx-base"
WORD_ALIGNER_ENV = "PODCAST_MCP_WORD_ALIGNER_MODEL"
WORD_ALIGNER_BOOTSTRAP = "podcast bootstrap --component word-aligner"


@dataclass(frozen=True)
class WordAlignerModel:
    id: str
    label: str
    size: str
    description: str
    hf_repo: str
    revision: str
    onnx_file: str
    # every file the snapshot downloads, sha256 at `revision` (#728)
    file_sha256: FileManifest
    license: str
    languages: tuple[str, ...]

    @property
    def pin(self) -> PinnedSnapshot:
        """This model's snapshot pin, for the shared resolve/download helpers."""
        return PinnedSnapshot(self.hf_repo, self.revision, self.file_sha256)

    @property
    def allow_patterns(self) -> list[str]:
        return self.pin.allow_patterns

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
        file_sha256=(
            ("vocab.json", "4178db26b3c7570f6a47f14ac6a1c7b32950b8c2800fb097287e53776934f1c5"),
            ("config.json", "15c7cf6378153bdcb33fce27780ab9aae37fd154fbb674cacc3347992055d323"),
            (
                "preprocessor_config.json",
                "8cdfd65ff4115423185a1512bdae100e2e0cd744f5b322417429944aaafd0827",
            ),
            ("onnx/model.onnx", "00b7cc69516c1ab63c429e63a2b543e4d42bb77441ec5b98ee935de175b00de1"),
        ),
        license="apache-2.0",
        languages=("en",),
    ),
)


class WordAlignerMissingError(RuntimeError):
    def __init__(
        self,
        model_id: str,
        detail: str = "",
        *,
        problem: str = "is not downloaded",
        fix: str = WORD_ALIGNER_BOOTSTRAP,
    ) -> None:
        self.model_id = model_id
        suffix = f" ({detail})" if detail else ""
        super().__init__(f"Word aligner {model_id!r} {problem}{suffix}. Run: {fix}")


class WordAlignerPinMismatchError(WordAlignerMissingError):
    """A downloaded pinned snapshot whose files are not the pinned bytes (corrupt or swapped)."""

    def __init__(self, model_id: str, detail: str) -> None:
        super().__init__(
            model_id,
            detail,
            problem="does not match its pinned download",
            fix=f"{WORD_ALIGNER_BOOTSTRAP} --upgrade",
        )


def word_aligner_model(model_id: str = DEFAULT_WORD_ALIGNER) -> WordAlignerModel:
    for model in WORD_ALIGNER_CATALOG:
        if model.id == model_id:
            return model
    ids = ", ".join(m.id for m in WORD_ALIGNER_CATALOG)
    raise ValueError(f"Unknown word aligner {model_id!r}. Choose from: {ids}")


def _has_required_files(root: Path, model: WordAlignerModel) -> bool:
    return (root / "vocab.json").is_file() and (root / model.onnx_file).is_file()


def verify_word_aligner_snapshot(
    model_dir: Path, model: WordAlignerModel, *, memoize: bool = False
) -> None:
    """Fail closed when any pinned file in the snapshot is not the pinned bytes (#728)."""
    mismatch = manifest_mismatch(model_dir, model.file_sha256, memoize=memoize)
    if mismatch is not None:
        raise WordAlignerPinMismatchError(model.id, mismatch)


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

    from podcast_mcp.config import word_aligner_cache_dir

    try:
        return resolve_pinned_snapshot(model.pin, word_aligner_cache_dir())
    except PinnedSnapshotMissingError as exc:
        raise WordAlignerMissingError(model.id, exc.detail) from exc


def word_aligner_installed(model_id: str = DEFAULT_WORD_ALIGNER) -> bool:
    """A complete local snapshot (or override dir) exists for ``model_id``; never downloads.

    The presence check behind the ``transcribe.forced_alignment.enabled`` default (#780).
    It does not hash the snapshot (that takes seconds for the 360 MB ONNX), so a corrupt
    pinned snapshot still counts as installed here: ``WordAligner.load`` verifies the pin
    and the run reports that failure with the ``--upgrade`` hint. Status polls and
    ``podcast doctor`` use ``word_aligner_problem`` for the verified answer.
    """
    try:
        resolve_word_aligner_dir(model_id)
    except (WordAlignerMissingError, OSError):
        return False
    return True


def word_aligner_problem(
    model_id: str = DEFAULT_WORD_ALIGNER, *, memoize: bool = False
) -> WordAlignerMissingError | None:
    """Why ``model_id`` is not ready (never downloads), or None when it is.

    The pinned snapshot (not an override dir) must match its manifest. ``memoize=True``
    (status polls only) hashes an unchanged file once per process; bootstrap's skip check
    and load hash fresh.
    """
    model = word_aligner_model(model_id)
    try:
        path = resolve_word_aligner_dir(model.id)
        if word_aligner_override_dir() is None:
            verify_word_aligner_snapshot(path, model, memoize=memoize)
    except WordAlignerMissingError as exc:
        return exc
    except OSError as exc:  # a pinned file vanished mid-check
        return WordAlignerMissingError(model.id, str(exc))
    return None


def word_aligner_is_cached(model_id: str = DEFAULT_WORD_ALIGNER, *, memoize: bool = False) -> bool:
    """A complete local snapshot; the pinned one must also match every file's sha256."""
    return word_aligner_problem(model_id, memoize=memoize) is None


def bootstrap_word_aligner(
    model_id: str = DEFAULT_WORD_ALIGNER, *, force: bool = False
) -> dict[str, Any]:
    """Download the pinned snapshot into the word-aligner cache. The only network path.

    A cached snapshot that fails its pin is re-fetched once even without ``force``.
    """
    from podcast_mcp.config import word_aligner_cache_dir

    model = word_aligner_model(model_id)
    # Intentional download path: the only word-aligner download (never local_files_only).
    path, mismatch = download_pinned_snapshot(model.pin, word_aligner_cache_dir(), force=force)
    if mismatch is not None:
        raise WordAlignerPinMismatchError(model.id, mismatch)
    return {"ok": True, "model": model.id, "path": str(path)}
