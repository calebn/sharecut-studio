"""Whisper model catalog, machine preference, and cache detection.

Product default is ``large-v3-turbo`` (lowest practical WER). Smaller sizes
remain selectable at setup so machines that cannot spare ~1.6 GB still work.
The catalog sizes (``WHISPER_MODEL_CATALOG``) are pinned to a Hugging Face
revision plus a per-file sha256 manifest (``WHISPER_PINS``, #728); other
``FASTER_WHISPER_SIZES`` stay unpinned.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import yaml

from podcast_mcp.util.model_manifest import (
    PinnedSnapshot,
    PinnedSnapshotMissingError,
    download_pinned_snapshot,
    manifest_mismatch,
    resolve_pinned_snapshot,
)

DEFAULT_WHISPER_MODEL = "large-v3-turbo"
WHISPER_BOOTSTRAP = "podcast bootstrap --component whisper"

# Official faster-whisper size ids (plus ``turbo`` alias).
FASTER_WHISPER_SIZES: frozenset[str] = frozenset(
    {
        "tiny",
        "tiny.en",
        "base",
        "base.en",
        "small",
        "small.en",
        "medium",
        "medium.en",
        "large-v1",
        "large-v2",
        "large-v3",
        "large-v3-turbo",
        "distil-large-v2",
        "distil-large-v3",
        "distil-medium.en",
        "distil-small.en",
        "turbo",
    }
)

_ALIASES: dict[str, str] = {
    "turbo": DEFAULT_WHISPER_MODEL,
    "large-v3-turbo": DEFAULT_WHISPER_MODEL,
}

# First-run / install picker. Default is first matching DEFAULT_WHISPER_MODEL.
WHISPER_MODEL_CATALOG: tuple[dict[str, str], ...] = (
    {
        "id": "tiny.en",
        "label": "Fastest (English)",
        "size": "~75 MB",
        "description": "Lowest accuracy. Drafts only.",
    },
    {
        "id": "base.en",
        "label": "Lightweight (English)",
        "size": "~150 MB",
        "description": "Smaller download; more ASR holes on overlapping speech.",
    },
    {
        "id": "small.en",
        "label": "Balanced (English)",
        "size": "~500 MB",
        "description": "Good laptop default if disk is tight.",
    },
    {
        "id": "medium.en",
        "label": "High quality (English)",
        "size": "~1.5 GB",
        "description": "Strong English WER; weaker on mixed-language episodes.",
    },
    {
        "id": "large-v3-turbo",
        "label": "Recommended",
        "size": "~1.6 GB",
        "description": "Lowest practical error for podcasts (multilingual). Default.",
    },
    {
        "id": "large-v3",
        "label": "Maximum accuracy",
        "size": "~3 GB",
        "description": "Slightly better than turbo; much slower and larger.",
    },
)

WHISPER_MODEL_IDS: tuple[str, ...] = tuple(item["id"] for item in WHISPER_MODEL_CATALOG)
WHISPER_SIZE_ENUM: tuple[str, ...] = tuple(sorted(FASTER_WHISPER_SIZES))

# Files shared across repos (identical bytes at each pinned revision). A sha256 on a line
# that also names a token (``tokenizer.json``) trips gitleaks' generic-api-key rule, so
# tokenizer pins live in parenthesised constants marked ``gitleaks:allow`` (#728).
_EN_TOKENIZER_SHA256 = (
    "929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df"  # gitleaks:allow
)
_EN_VOCABULARY_SHA256 = "ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf"
_V3_PREPROCESSOR_SHA256 = "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711"
_V3_VOCABULARY_SHA256 = "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1"
_V3_TURBO_TOKENIZER_SHA256 = (
    "297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd"  # gitleaks:allow
)
_V3_TOKENIZER_SHA256 = (
    "6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca"  # gitleaks:allow
)

# Pinned Hugging Face snapshots for the catalog sizes (#728): the repo faster-whisper
# resolves the size to, the commit that was ``main`` on 2026-09-28, and the sha256 of
# every file faster-whisper's download takes from it. Provenance: util/model_manifest.py.
# Sizes outside the catalog stay unpinned (faster-whisper's own download; presence check).
WHISPER_PINS: dict[str, PinnedSnapshot] = {
    "tiny.en": PinnedSnapshot(
        hf_repo="Systran/faster-whisper-tiny.en",
        revision="0d3d19a32d3338f10357c0889762bd8d64bbdeba",
        file_sha256=(
            ("config.json", "14b1b421a90349bc551b881461426b561a874049cb9e4c4864f2ca384f6a7cc5"),
            ("model.bin", "1a5afae06a4db91c975c9a9d78be5cc110ee4ea022ad57d55492e4550e936b2a"),
            ("tokenizer.json", _EN_TOKENIZER_SHA256),
            ("vocabulary.txt", _EN_VOCABULARY_SHA256),
        ),
    ),
    "base.en": PinnedSnapshot(
        hf_repo="Systran/faster-whisper-base.en",
        revision="3d3d5dee26484f91867d81cb899cfcf72b96be6c",
        file_sha256=(
            ("config.json", "f3bc3821e9fc76a27bae538e11ae5b677dcdd352b4600429ce7951d398569aeb"),
            ("model.bin", "2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef"),
            ("tokenizer.json", _EN_TOKENIZER_SHA256),
            ("vocabulary.txt", _EN_VOCABULARY_SHA256),
        ),
    ),
    "small.en": PinnedSnapshot(
        hf_repo="Systran/faster-whisper-small.en",
        revision="d1d751a5f8271d482d14ca55d9e2deeebbae577f",
        file_sha256=(
            ("config.json", "666a9605530ac1f61fa8177f3702b4dacec9966749e42610839fcc32661d5fae"),
            ("model.bin", "62b2a45b05ee59acb4a5341b33ee35e041395d378d418a18acfe4c9e768ee37a"),
            ("tokenizer.json", _EN_TOKENIZER_SHA256),
            ("vocabulary.txt", _EN_VOCABULARY_SHA256),
        ),
    ),
    "medium.en": PinnedSnapshot(
        hf_repo="Systran/faster-whisper-medium.en",
        revision="a29b04bd15381511a9af671baec01072039215e3",
        file_sha256=(
            ("config.json", "4a1848ebabe7938d9797c15a2e8e4ce1d36e6fd4a43d096ae5955257c67c7962"),
            ("model.bin", "11b220779aea4c6f3ce9d2549c8a95ea869ed84066864b999531ef53e594fe5b"),
            ("tokenizer.json", _EN_TOKENIZER_SHA256),
            ("vocabulary.txt", _EN_VOCABULARY_SHA256),
        ),
    ),
    "large-v3-turbo": PinnedSnapshot(
        hf_repo="mobiuslabsgmbh/faster-whisper-large-v3-turbo",
        revision="0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
        file_sha256=(
            ("config.json", "b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e"),
            ("preprocessor_config.json", _V3_PREPROCESSOR_SHA256),
            ("model.bin", "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da"),
            ("tokenizer.json", _V3_TURBO_TOKENIZER_SHA256),
            ("vocabulary.json", _V3_VOCABULARY_SHA256),
        ),
    ),
    "large-v3": PinnedSnapshot(
        hf_repo="Systran/faster-whisper-large-v3",
        revision="edaa852ec7e145841d8ffdb056a99866b5f0a478",
        file_sha256=(
            ("config.json", "a9306624f5ec14270a014b647e5c316b6e03a662c369758d1b90697a7b0655b9"),
            ("preprocessor_config.json", _V3_PREPROCESSOR_SHA256),
            ("model.bin", "69f74147e3334731bc3a76048724833325d2ec74642fb52620eda87352e3d4f1"),
            ("tokenizer.json", _V3_TOKENIZER_SHA256),
            ("vocabulary.json", _V3_VOCABULARY_SHA256),
        ),
    ),
}


def prefs_path() -> Path:
    from podcast_mcp.config import cache_dir

    return cache_dir() / "prefs.yaml"


def normalize_whisper_model(model: str) -> str:
    raw = (model or "").strip()
    if not raw:
        raise ValueError("Whisper model is empty")
    key = raw.lower()
    return _ALIASES.get(key, key)


def validate_whisper_model(model: str) -> str:
    """Return a canonical faster-whisper size or raise ValueError."""
    normalized = normalize_whisper_model(model)
    if normalized not in FASTER_WHISPER_SIZES:
        allowed = ", ".join(WHISPER_SIZE_ENUM)
        raise ValueError(f"Unknown Whisper model {model!r}. Choose from: {allowed}")
    return normalized


def _env_whisper_model() -> str | None:
    env = os.environ.get("PODCAST_WHISPER_MODEL")
    if not env or not env.strip():
        return None
    try:
        return validate_whisper_model(env)
    except ValueError:
        return None


def _prefs_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def read_whisper_model_pref() -> str | None:
    path = prefs_path()
    if not path.is_file():
        return None
    data = _prefs_mapping(path)
    value = data.get("whisper_model")
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return validate_whisper_model(value)
    except ValueError:
        return None


def persist_whisper_model(model: str) -> str:
    """Write the machine Whisper preference under the cache dir."""
    canonical = validate_whisper_model(model)
    path = prefs_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = _prefs_mapping(path)
    existing["whisper_model"] = canonical
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(
        yaml.safe_dump(existing, sort_keys=True, allow_unicode=True),
        encoding="utf-8",
    )
    os.replace(tmp, path)
    return canonical


def resolve_whisper_model(*, requested: str | None = None) -> str:
    """Precedence: explicit request → env → prefs.yaml → product default."""
    if requested is not None and str(requested).strip():
        return validate_whisper_model(requested)
    env = _env_whisper_model()
    if env:
        return env
    pref = read_whisper_model_pref()
    if pref:
        return pref
    return DEFAULT_WHISPER_MODEL


def apply_whisper_model_to_defaults(defaults: dict[str, Any]) -> dict[str, Any]:
    """Overlay env/prefs onto pipeline defaults; keep YAML when neither is set."""
    transcribe = defaults.setdefault("transcribe", {})
    if not isinstance(transcribe, dict):
        return defaults
    overlay = _env_whisper_model() or read_whisper_model_pref()
    if overlay:
        transcribe["model"] = overlay
    elif not transcribe.get("model"):
        transcribe["model"] = DEFAULT_WHISPER_MODEL
    return defaults


def whisper_bootstrap_command(model: str, *, upgrade: bool = False) -> str:
    """The CLI that downloads ``model``; ``upgrade`` re-downloads a pinned snapshot."""
    command = f"{WHISPER_BOOTSTRAP} --whisper-model {model}"
    return f"{command} --upgrade" if upgrade else command


class WhisperWeightsMissingError(RuntimeError):
    """Raised when a pipeline/transcribe run needs weights that are not on disk."""

    def __init__(self, model: str, message: str | None = None) -> None:
        self.model = model
        super().__init__(
            message
            or (
                f"Whisper model {model!r} is not downloaded. "
                f"Run: {whisper_bootstrap_command(model)} "
                "or use a downloaded model with "
                "podcast transcribe --model <model>."
            )
        )


class WhisperPinMismatchError(WhisperWeightsMissingError):
    """A downloaded pinned Whisper snapshot whose files are not the pinned bytes (#728)."""

    def __init__(self, model: str, detail: str) -> None:
        super().__init__(
            model,
            f"Whisper model {model!r} does not match its pinned download ({detail}). "
            f"Run: {whisper_bootstrap_command(model, upgrade=True)}",
        )


def cache_path_matches_model(posix: str, model: str) -> bool:
    """True when a faster-whisper cache path belongs to ``model`` (not a prefix)."""
    p = posix.lower().replace("\\", "/")
    m = normalize_whisper_model(model)
    if m == "large-v3" and "large-v3-turbo" in p:
        return False
    escaped = re.escape(m)
    return re.search(rf"(?:faster-whisper-|{re.escape('--')}){escaped}(?:/|$)", p) is not None


_WEIGHT_NAMES = frozenset({"model.bin", "model.safetensors"})


def _unpinned_weights_on_disk(model: str) -> bool:
    """True when a complete-looking faster-whisper weight file is on disk (unpinned sizes only).

    Requires ``model.bin`` or ``model.safetensors`` under a path that belongs to
    ``model`` so a partial Hugging Face download does not count as ready.
    """
    from podcast_mcp.config import whisper_cache_dir

    root = whisper_cache_dir()
    if not root.is_dir():
        return False
    return any(
        path.is_file()
        and path.name in _WEIGHT_NAMES
        and cache_path_matches_model(path.as_posix(), model)
        for path in root.rglob("*")
    )


def _pinned_snapshot_dir(model: str, pin: PinnedSnapshot) -> Path:
    """The complete local pinned snapshot for ``model``; never downloads."""
    from podcast_mcp.config import whisper_cache_dir

    try:
        return resolve_pinned_snapshot(pin, whisper_cache_dir())
    except PinnedSnapshotMissingError as exc:
        raise WhisperWeightsMissingError(model) from exc


def verify_whisper_snapshot(
    model_dir: Path, model: str, pin: PinnedSnapshot, *, memoize: bool = False
) -> None:
    """Fail closed when any pinned file is not the pinned bytes (corrupt or swapped)."""
    mismatch = manifest_mismatch(model_dir, pin.file_sha256, memoize=memoize)
    if mismatch is not None:
        raise WhisperPinMismatchError(model, mismatch)


def resolve_whisper_model_path(model: str) -> str:
    """What ``WhisperModel`` loads: the verified pinned snapshot dir (hashed uncached on
    every call) for a catalog size, else the size id. Raises WhisperWeightsMissingError."""
    canonical = validate_whisper_model(model)
    pin = WHISPER_PINS.get(canonical)
    if pin is None:
        return ensure_whisper_model_cached(canonical)
    path = _pinned_snapshot_dir(canonical, pin)
    try:
        verify_whisper_snapshot(path, canonical, pin)
    except OSError as exc:  # a pinned file vanished mid-check (e.g. a concurrent --upgrade)
        raise WhisperWeightsMissingError(canonical) from exc
    return str(path)


def whisper_model_problem(
    model: str, *, memoize: bool = False
) -> WhisperWeightsMissingError | None:
    """Why ``model`` is not ready to load (never downloads), or None when it is.

    Pinned sizes must match their manifest. ``memoize=True`` is for status polls only
    (see ``util/model_manifest.manifest_mismatch``); the run gate and bootstrap hash fresh.
    """
    canonical = validate_whisper_model(model)
    pin = WHISPER_PINS.get(canonical)
    if pin is None:
        return (
            None if _unpinned_weights_on_disk(canonical) else WhisperWeightsMissingError(canonical)
        )
    try:
        verify_whisper_snapshot(
            _pinned_snapshot_dir(canonical, pin), canonical, pin, memoize=memoize
        )
    except WhisperWeightsMissingError as exc:
        return exc
    except OSError:  # a pinned file vanished mid-check
        return WhisperWeightsMissingError(canonical)
    return None


def whisper_model_is_cached(model: str, *, memoize: bool = False) -> bool:
    """True when ``model`` can load offline: a pinned catalog size's snapshot matches its
    manifest; another size has a complete-looking weight file on disk."""
    return whisper_model_problem(model, memoize=memoize) is None


def ensure_whisper_model_cached(model: str, *, memoize: bool = False) -> str:
    """Return the canonical model id, or raise if weights are missing or mismatched."""
    canonical = validate_whisper_model(model)
    problem = whisper_model_problem(canonical, memoize=memoize)
    if problem is not None:
        raise problem
    return canonical


def bootstrap_whisper_model(model_size: str, *, force: bool = False) -> dict[str, Any]:
    """Download weights into the cache and persist the machine preference.

    A catalog size downloads its pinned snapshot and verifies every file; a cached
    snapshot that fails its pin is re-fetched once even without ``force``, and a mismatch
    that survives raises ``WhisperPinMismatchError``. Any other size uses faster-whisper's
    own unpinned download, where ``force`` has no effect.
    """
    from podcast_mcp.config import whisper_cache_dir

    canonical = validate_whisper_model(model_size)
    pin = WHISPER_PINS.get(canonical)
    if pin is None:
        from faster_whisper import WhisperModel

        # Intentional download path — the only WhisperModel construction without
        # local_files_only=True.
        WhisperModel(
            canonical,
            device="cpu",
            compute_type="int8",
            download_root=str(whisper_cache_dir()),
        )
    else:
        # Intentional download path: the only pinned Whisper download (never local_files_only).
        _, mismatch = download_pinned_snapshot(pin, whisper_cache_dir(), force=force)
        if mismatch is not None:
            raise WhisperPinMismatchError(canonical, mismatch)
    persist_error: str | None = None
    try:
        persist_whisper_model(canonical)
    except (OSError, yaml.YAMLError) as exc:
        persist_error = str(exc)
    return {
        "ok": True,
        "model": canonical,
        "cache": str(whisper_cache_dir()),
        "persist_error": persist_error,
    }


def catalog_payload() -> list[dict[str, Any]]:
    """Catalog rows for setup + Pipeline pickers, including on-disk ``cached``."""
    return [
        {
            **dict(item),
            "cached": whisper_model_is_cached(item["id"], memoize=True),
        }
        for item in WHISPER_MODEL_CATALOG
    ]
