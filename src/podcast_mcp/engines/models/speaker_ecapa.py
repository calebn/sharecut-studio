"""Pinned ONNX build of the SpeechBrain ECAPA speaker-embedding network (#1998).

Speaker recognition runs this export on ``onnxruntime`` (a core dependency); it is the only
speaker model. It is the ``embedding_model`` of
``speechbrain/spkrec-ecapa-voxceleb`` (Apache-2.0) at ``SOURCE_REVISION``, exported by
``scripts/export_ecapa_onnx.py``; ``engines/models/ecapa_features.py`` supplies the
filterbank features it consumes. Embeddings match the SpeechBrain torch pipeline (cosine 1.0).

Nothing downloads on import or during a run; ``bootstrap_speaker_ecapa`` is the only
network path (``podcast bootstrap --component speaker-ecapa``).
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp import settings
from podcast_mcp.config.defaults import models_dir
from podcast_mcp.engines.models.ecapa_features import ecapa_features
from podcast_mcp.util.asset_sources import (
    OnProgress,
    asset_entry,
    download_first_ok,
    ordered_http_urls,
)
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.model_manifest import manifest_mismatch

logger = logging.getLogger(__name__)

SPEAKER_ECAPA_ASSET = "speaker-ecapa"
SPEAKER_ECAPA_ENV = "PODCAST_MCP_SPEAKER_ECAPA_MODEL"
SPEAKER_ECAPA_BOOTSTRAP = "podcast bootstrap --component speaker-ecapa"
SPEAKER_ECAPA_LABEL = "Speaker recognition (ECAPA, ONNX)"
SPEAKER_ECAPA_SIZE = "~80 MB"
# 0.05 s at 16 kHz; the network's reflect-padded convolutions fail below about 700 samples.
MIN_SAMPLES = 800
SOURCE_REPO = "speechbrain/spkrec-ecapa-voxceleb"
SOURCE_REVISION = "0f99f2d0ebe89ac095bcc5903c4dd8f72b367286"


class SpeakerEcapaMissingError(RuntimeError):
    """The pinned model is absent, torn, or not the pinned bytes."""


def _pin() -> tuple[str, str]:
    meta = asset_entry(SPEAKER_ECAPA_ASSET)
    sha = str(meta.get("sha256") or "").lower()
    if not sha:
        raise SpeakerEcapaMissingError("speaker-ecapa has no sha256 pin in bootstrap-assets.json")
    return str(meta["filename"]), sha


def speaker_ecapa_override() -> Path | None:
    """A user-supplied ONNX file (``PODCAST_MCP_SPEAKER_ECAPA_MODEL``); it is not pin-checked."""
    value = settings.raw(SPEAKER_ECAPA_ENV)
    return Path(value).expanduser() if value else None


def speaker_ecapa_path() -> Path:
    if (override := speaker_ecapa_override()) is not None:
        return override
    filename, _ = _pin()
    return models_dir() / filename


def speaker_ecapa_problem(*, memoize: bool = False) -> str | None:
    """Why the model cannot be used (None when it is ready).

    ``memoize=True`` is for status polls and backend routing only: it hashes once per file
    state, so a same-size overwrite that keeps its mtime goes unseen. Bootstrap's skip check
    and the embedder's load hash uncached.
    """
    path = speaker_ecapa_path()
    if not path.is_file():
        return f"not downloaded; run {SPEAKER_ECAPA_BOOTSTRAP}"
    if speaker_ecapa_override() is not None:
        return None
    _, expected = _pin()
    if manifest_mismatch(path.parent, ((path.name, expected),), memoize=memoize) is not None:
        return f"does not match its pinned download; run {SPEAKER_ECAPA_BOOTSTRAP} --upgrade"
    return None


def bootstrap_speaker_ecapa(
    *, force: bool = False, on_progress: OnProgress | None = None
) -> dict[str, Any]:
    """Download and verify the pinned model; skips when it is already ready."""
    if speaker_ecapa_override() is not None:
        raise SpeakerEcapaMissingError(f"{SPEAKER_ECAPA_ENV} is set; unset it to download")
    filename, expected = _pin()
    path = speaker_ecapa_path()
    if not force and speaker_ecapa_problem() is None:
        return {"ok": True, "skipped": True, "reason": "cached", "path": str(path)}
    urls = ordered_http_urls(SPEAKER_ECAPA_ASSET, relative_path=filename)
    source = download_first_ok(urls, path, expected_sha256=expected, on_progress=on_progress)
    return {"ok": True, "path": str(path), "source": source}


class EcapaOnnx:
    """Embeds 16 kHz mono audio with the pinned ONNX model."""

    def __init__(self, model_path: Path | None = None) -> None:
        self._path = model_path
        self._session: Any = None
        self._lock = threading.Lock()

    def _load(self) -> Any:
        if self._session is not None:
            return self._session
        with self._lock:
            if self._session is None:
                path = self._path
                if path is None:
                    if (problem := speaker_ecapa_problem()) is not None:
                        raise SpeakerEcapaMissingError(f"{SPEAKER_ECAPA_LABEL} {problem}")
                    path = speaker_ecapa_path()
                import onnxruntime as ort

                options = ort.SessionOptions()
                options.log_severity_level = 3
                self._session = ort.InferenceSession(
                    str(path), sess_options=options, providers=["CPUExecutionProvider"]
                )
            return self._session

    def embed(self, samples: np.ndarray) -> np.ndarray:
        if np.size(samples) < MIN_SAMPLES:
            raise CodedValueError(
                f"audio too short to embed: {np.size(samples)} samples, need {MIN_SAMPLES}",
                code="audio_too_short",
            )
        session = self._load()
        feats = ecapa_features(samples)[None]
        out = session.run(None, {"features": feats})[0]
        return np.asarray(out, dtype=np.float32).reshape(-1)
