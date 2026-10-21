"""Pinned ONNX build of the SpeechBrain ECAPA speaker-embedding network (#1998).

The packaged app has no torch, so speaker recognition runs this export on
``onnxruntime`` (a core dependency). It is the ``embedding_model`` of
``speechbrain/spkrec-ecapa-voxceleb`` (Apache-2.0) at ``SOURCE_REVISION``, exported by
``scripts/export_ecapa_onnx.py``; ``engines/models/ecapa_features.py`` supplies the
filterbank features it consumes. Embeddings match the torch pipeline (cosine 1.0, see the
parity test), so profiles enrolled with the torch backend keep matching.

Nothing downloads on import or during a run; ``bootstrap_speaker_ecapa`` is the only
network path (``podcast bootstrap --component speaker-ecapa``).
"""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp import settings
from podcast_mcp.config.defaults import models_dir
from podcast_mcp.engines.models.ecapa_features import ecapa_features
from podcast_mcp.util.asset_sources import asset_entry, download_first_ok, ordered_http_urls
from podcast_mcp.util.hashing import sha256_file

logger = logging.getLogger(__name__)

SPEAKER_ECAPA_ASSET = "speaker-ecapa"
SPEAKER_ECAPA_ENV = "PODCAST_MCP_SPEAKER_ECAPA_MODEL"
SPEAKER_ECAPA_BOOTSTRAP = "podcast bootstrap --component speaker-ecapa"
SPEAKER_ECAPA_LABEL = "Speaker recognition (ECAPA, ONNX)"
SPEAKER_ECAPA_SIZE = "~80 MB"
SPEAKER_ECAPA_LICENSE = "apache-2.0"
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


@lru_cache(maxsize=4)
def _sha_of(path: str, mtime_ns: int, size: int) -> str:
    return sha256_file(Path(path))


def speaker_ecapa_problem() -> str | None:
    """Why the model cannot be used (None when it is ready). Hashes once per file state."""
    path = speaker_ecapa_path()
    try:
        stat = path.stat()
    except OSError:
        return f"not downloaded; run {SPEAKER_ECAPA_BOOTSTRAP}"
    if speaker_ecapa_override() is not None:
        return None
    _, expected = _pin()
    if _sha_of(str(path), stat.st_mtime_ns, stat.st_size) != expected:
        return f"does not match its pinned download; run {SPEAKER_ECAPA_BOOTSTRAP} --upgrade"
    return None


def bootstrap_speaker_ecapa(*, force: bool = False) -> dict[str, Any]:
    """Download and verify the pinned model; skips when it is already ready."""
    if speaker_ecapa_override() is not None:
        raise SpeakerEcapaMissingError(f"{SPEAKER_ECAPA_ENV} is set; unset it to download")
    filename, expected = _pin()
    path = speaker_ecapa_path()
    if not force and speaker_ecapa_problem() is None:
        return {"ok": True, "skipped": True, "reason": "cached", "path": str(path)}
    urls = ordered_http_urls(SPEAKER_ECAPA_ASSET, relative_path=filename)
    if not urls:
        raise SpeakerEcapaMissingError(
            f"no download source: set PODCAST_BOOTSTRAP_CDN_BASE or place the file at {path}"
        )
    source = download_first_ok(urls, path, expected_sha256=expected)
    return {"ok": True, "path": str(path), "source": source}


class EcapaOnnx:
    """Embeds 16 kHz mono audio with the pinned ONNX model."""

    def __init__(self, model_path: Path | None = None) -> None:
        self._path = model_path
        self._session: Any = None

    def _load(self) -> Any:
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
        session = self._load()
        feats = ecapa_features(samples)[None]
        out = session.run(None, {"features": feats})[0]
        return np.asarray(out, dtype=np.float32).reshape(-1)
